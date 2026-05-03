import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SfCliService, SObjectDescribe, normalizeSObjectApiName } from './sfCliService';
import { LocalProjectScanner } from './localProjectScanner';
import { SOQL_FALLBACK_OBJECTS } from './soqlCatalog';
import { extractFromObject, extractSelectFields } from './soqlParser';

export type CacheSourceState = 'none' | 'local-fallback' | 'org';

interface PlaceholderCacheData {
    objects: Record<string, { fields: string[] }>;
}

/**
 * Resolves per-org metadata from disk/CLI cache sources with strict source states.
 * Local project scanning is used only for one-time local-fallback cache bootstrap.
 */
export class MetadataProvider {
    private sfCli: SfCliService;
    private localScanner: LocalProjectScanner;
    private outputChannel: vscode.OutputChannel;
    private globalStoragePath: string;
    private objectListCache: { value: string[]; expiresAt: number } | undefined;

    constructor(sfCli: SfCliService, outputChannel: vscode.OutputChannel, globalStoragePath: string) {
        this.sfCli = sfCli;
        this.localScanner = new LocalProjectScanner(outputChannel);
        this.outputChannel = outputChannel;
        this.globalStoragePath = globalStoragePath;
    }

    private getCacheMaxAgeMs(): number | undefined {
        const expiryDays = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<number>('cacheExpiryDays', 0);
        if (expiryDays <= 0) {
            return undefined;
        }
        return expiryDays * 24 * 60 * 60 * 1000;
    }

    /**
     * Get object list from selected-org cache, then CLI, then fallback list.
     */
    async getObjectList(): Promise<string[]> {
        if (this.objectListCache && Date.now() < this.objectListCache.expiresAt) {
            return this.objectListCache.value;
        }

        // Try disk-cached object list first
        let orgObjects = this.loadObjectListFromDisk();
        if (!orgObjects) {
            orgObjects = await this.sfCli.getObjectList();
            if (orgObjects.length > 0) {
                this.saveObjectListToDisk(orgObjects);
                this.setCurrentOrgCacheSourceState('org');
            }
        }

        if (!orgObjects || orgObjects.length === 0) {
            for (const name of SOQL_FALLBACK_OBJECTS) {
                orgObjects.push(name);
            }
        }

        const list = Array.from(new Set(orgObjects)).sort();
        this.objectListCache = {
            value: list,
            expiresAt: Date.now() + 30_000,
        };
        return list;
    }

    private loadObjectListFromDisk(): string[] | undefined {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return undefined; }
        const filePath = path.join(cacheDir, '_objectList.json');
        if (!fs.existsSync(filePath)) { return undefined; }
        try {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            const maxAgeMs = this.getCacheMaxAgeMs();
            if (maxAgeMs !== undefined && data._cachedAt && Date.now() - data._cachedAt > maxAgeMs) {
                return undefined; // expired
            }
            return data.objects;
        } catch { return undefined; }
    }

    private saveObjectListToDisk(objects: string[]) {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return; }
        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(
                path.join(cacheDir, '_objectList.json'),
                JSON.stringify({ objects, _cachedAt: Date.now() }),
                'utf-8'
            );
        } catch { /* ignore */ }
    }

    /** Describe an SObject via in-memory cache, disk cache, then live org. */
    async describeSObject(objectName: string): Promise<SObjectDescribe | undefined> {
        const normalizedName = normalizeSObjectApiName(objectName);
        if (!normalizedName) {
            this.outputChannel.appendLine(`Rejected invalid object name for describe: "${objectName}"`);
            return undefined;
        }

        // 1. Check in-memory cache (inside SfCliService)
        const cached = this.sfCli.getCachedDescribe(normalizedName);
        if (cached) {
            return cached;
        }

        // 2. Check disk cache
        const diskCached = this.loadFromDiskCache(normalizedName);
        if (diskCached) {
            this.sfCli.setCachedDescribe(normalizedName, diskCached);
            return diskCached;
        }

        // 3. Try live CLI describe
        const live = await this.sfCli.describeSObject(normalizedName);
        if (live) {
            this.saveToDiskCache(normalizedName, live);
            this.setCurrentOrgCacheSourceState('org');
            this.removePlaceholderObject(normalizedName);
            return live;
        }

        return undefined;
    }

    // ── disk cache ─────────────────────────────────────────────────────

    private getCacheDir(): string | undefined {
        const org = this.sfCli.getCurrentOrg();
        if (!org) { return undefined; }
        return path.join(this.getCacheRootDir(), this.sanitizeOrgCacheKey(org.alias));
    }

    private getCacheRootDir(): string {
        return path.join(this.globalStoragePath, 'cache');
    }

    private sanitizeOrgCacheKey(name: string): string {
        return name.replace(/[^a-zA-Z0-9_.-]/g, '_');
    }

    /**
     * Returns a quick cache status summary for the currently selected org.
     * "hasCache" means at least one object describe file or an object-list snapshot exists.
     */
    getCurrentOrgCacheStatus(): { hasCache: boolean; hasObjectList: boolean; objectFileCount: number; source: CacheSourceState } {
        const cacheDir = this.getCacheDir();
        if (!cacheDir || !fs.existsSync(cacheDir)) {
            return { hasCache: false, hasObjectList: false, objectFileCount: 0, source: 'none' };
        }

        let hasObjectList = false;
        let objectFileCount = 0;
        try {
            const files = fs.readdirSync(cacheDir, { withFileTypes: true });
            for (const entry of files) {
                if (!entry.isFile()) { continue; }
                if (entry.name === '_objectList.json') {
                    hasObjectList = true;
                    continue;
                }
                if (entry.name === '_cacheSource.json' || entry.name === '_placeholders.json') {
                    continue;
                }
                if (entry.name.endsWith('.json')) {
                    objectFileCount++;
                }
            }
        } catch {
            return { hasCache: false, hasObjectList: false, objectFileCount: 0, source: 'none' };
        }

        return {
            hasCache: hasObjectList || objectFileCount > 0,
            hasObjectList,
            objectFileCount,
            source: this.getCurrentOrgCacheSourceState(),
        };
    }

    getCurrentOrgCacheSourceState(): CacheSourceState {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return 'none'; }
        const filePath = path.join(cacheDir, '_cacheSource.json');
        if (!fs.existsSync(filePath)) {
            // Backward compatibility: existing caches created before source-state
            // tracking are treated as org cache.
            return this.hasOrgStyleCacheFiles(cacheDir) ? 'org' : 'none';
        }
        try {
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (content.source === 'org' || content.source === 'local-fallback') {
                return content.source;
            }
            return this.hasOrgStyleCacheFiles(cacheDir) ? 'org' : 'none';
        } catch {
            return this.hasOrgStyleCacheFiles(cacheDir) ? 'org' : 'none';
        }
    }

    setCurrentOrgCacheSourceState(source: Exclude<CacheSourceState, 'none'>) {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return; }
        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            fs.writeFileSync(
                path.join(cacheDir, '_cacheSource.json'),
                JSON.stringify({ source, updatedAt: Date.now() }, null, 2),
                'utf-8'
            );
        } catch (err: any) {
            this.outputChannel.appendLine(`Error writing cache source state: ${err.message}`);
        }
    }

    private hasOrgStyleCacheFiles(cacheDir: string): boolean {
        try {
            const files = fs.readdirSync(cacheDir);
            return files.some(name =>
                name === '_objectList.json' ||
                (name.endsWith('.json') && name !== '_cacheSource.json' && name !== '_placeholders.json')
            );
        } catch {
            return false;
        }
    }

    /**
     * Lists other org cache directories that appear to contain usable cache files.
     * Returned values are cache directory keys (sanitized org aliases).
     */
    listOtherCachedOrgKeys(): string[] {
        const root = this.getCacheRootDir();
        if (!fs.existsSync(root)) { return []; }

        const currentOrg = this.sfCli.getCurrentOrg();
        const currentKey = currentOrg ? this.sanitizeOrgCacheKey(currentOrg.alias) : undefined;

        try {
            const dirs = fs.readdirSync(root, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
                .filter(name => name !== currentKey);

            return dirs.filter(name => {
                const dirPath = path.join(root, name);
                try {
                    const files = fs.readdirSync(dirPath);
                    return files.some(f =>
                        f === '_objectList.json' ||
                        (f.endsWith('.json') && f !== '_cacheSource.json' && f !== '_placeholders.json')
                    );
                } catch {
                    return false;
                }
            });
        } catch {
            return [];
        }
    }

    /**
     * Copies cached metadata files from another org cache directory into the current org cache directory.
     * Existing files are preserved and not overwritten.
     */
    bootstrapCurrentOrgCacheFrom(otherOrgKey: string): number {
        const sourceKey = this.sanitizeOrgCacheKey(otherOrgKey);
        const destDir = this.getCacheDir();
        if (!destDir) { return 0; }

        const root = path.resolve(this.getCacheRootDir());
        const sourceDir = path.resolve(root, sourceKey);
        const resolvedDest = path.resolve(destDir);
        if (!sourceDir.startsWith(root + path.sep) || !resolvedDest.startsWith(root + path.sep)) {
            return 0;
        }
        if (!fs.existsSync(sourceDir) || !fs.statSync(sourceDir).isDirectory()) {
            return 0;
        }
        if (sourceDir === resolvedDest) {
            return 0;
        }

        fs.mkdirSync(resolvedDest, { recursive: true });
        let copied = 0;

        for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
            if (!entry.isFile()) { continue; }
            if (!entry.name.endsWith('.json')) { continue; }

            const src = path.join(sourceDir, entry.name);
            const dst = path.join(resolvedDest, entry.name);
            if (fs.existsSync(dst)) { continue; }
            try {
                fs.copyFileSync(src, dst);
                copied++;
            } catch {
                // Ignore per-file copy failures and continue.
            }
        }

        if (copied > 0) {
            this.setCurrentOrgCacheSourceState('org');
            this.clearPlaceholders();
            this.objectListCache = undefined;
        }

        return copied;
    }

    bootstrapCurrentOrgCacheFromLocalProject(): number {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return 0; }

        const localObjectNames = this.localScanner.getLocalObjectNames();
        if (localObjectNames.length === 0) { return 0; }

        fs.mkdirSync(cacheDir, { recursive: true });
        let saved = 0;
        const objectList = new Set<string>(this.loadObjectListFromDisk() || []);
        for (const objectName of localObjectNames) {
            const describe = this.localScanner.describeFromLocal(objectName);
            if (!describe) { continue; }
            this.saveToDiskCache(objectName, describe);
            objectList.add(describe.name);
            saved++;
        }
        this.saveObjectListToDisk(Array.from(objectList));
        this.setCurrentOrgCacheSourceState('local-fallback');
        this.objectListCache = undefined;
        return saved;
    }

    async reconcileSuccessfulQuery(query: string): Promise<void> {
        const objectName = extractFromObject(query);
        if (!objectName) { return; }
        const normalized = normalizeSObjectApiName(objectName);
        if (!normalized) { return; }

        const current = await this.describeSObject(normalized);
        this.addObjectToDiskObjectList(normalized);
        const selectedFields = this.extractSimpleProjectedFieldRoots(query);

        if (!current) {
            this.markPlaceholderObject(normalized, selectedFields);
            return;
        }

        const cachedFields = new Set(current.fields.map(f => f.name.toLowerCase()));
        const missingFields = selectedFields.filter(
            fieldName => !cachedFields.has(fieldName.toLowerCase())
        );
        if (missingFields.length > 0) {
            // Describe succeeded but cached fields don't include all query fields;
            // keep minimal marker so we can surface incomplete cache state.
            this.markPlaceholderObject(normalized, missingFields);
        } else {
            this.removePlaceholderObject(normalized);
        }
    }

    private extractSimpleProjectedFieldRoots(query: string): string[] {
        const selectedFields = extractSelectFields(query)
            .map(v => v.trim())
            .filter(v => v.length > 0 && !v.startsWith('('));
        return selectedFields
            .map(fieldExpr => fieldExpr.split('.')[0].trim())
            .filter(fieldName => /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName))
            .filter(fieldName => !/^(COUNT|AVG|SUM|MIN|MAX|COUNT_DISTINCT|FIELDS)$/i.test(fieldName));
    }

    private getPlaceholderFilePath(): string | undefined {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return undefined; }
        return path.join(cacheDir, '_placeholders.json');
    }

    private readPlaceholders(): PlaceholderCacheData {
        const filePath = this.getPlaceholderFilePath();
        if (!filePath || !fs.existsSync(filePath)) {
            return { objects: {} };
        }
        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (!parsed || typeof parsed !== 'object' || typeof parsed.objects !== 'object') {
                return { objects: {} };
            }
            return parsed as PlaceholderCacheData;
        } catch {
            return { objects: {} };
        }
    }

    private writePlaceholders(data: PlaceholderCacheData) {
        const filePath = this.getPlaceholderFilePath();
        if (!filePath) { return; }
        try {
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
        } catch (err: any) {
            this.outputChannel.appendLine(`Error writing placeholder cache: ${err.message}`);
        }
    }

    private markPlaceholderObject(objectName: string, fields: string[]) {
        const normalized = normalizeSObjectApiName(objectName);
        if (!normalized) { return; }
        const data = this.readPlaceholders();
        const key = normalized.toLowerCase();
        const current = data.objects[key]?.fields || [];
        const merged = Array.from(new Set([
            ...current,
            ...fields.filter(f => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f)).map(f => f.trim())
        ]));
        data.objects[key] = { fields: merged };
        this.writePlaceholders(data);
    }

    private removePlaceholderObject(objectName: string) {
        const key = objectName.toLowerCase();
        const data = this.readPlaceholders();
        if (data.objects[key]) {
            delete data.objects[key];
            this.writePlaceholders(data);
        }
    }

    private clearPlaceholders() {
        const filePath = this.getPlaceholderFilePath();
        if (!filePath || !fs.existsSync(filePath)) { return; }
        try {
            fs.unlinkSync(filePath);
        } catch {
            // Ignore placeholder cleanup failure
        }
    }

    private loadFromDiskCache(objectName: string): SObjectDescribe | undefined {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return undefined; }

        const filePath = this.getSafeObjectCachePath(cacheDir, objectName);
        if (!filePath) { return undefined; }
        if (!fs.existsSync(filePath)) { return undefined; }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const cached = JSON.parse(content);

            // Check freshness when configured by the user.
            const maxAgeMs = this.getCacheMaxAgeMs();
            if (maxAgeMs !== undefined && cached._cachedAt) {
                const age = Date.now() - cached._cachedAt;
                if (age > maxAgeMs) {
                    this.outputChannel.appendLine(`Cache expired for ${objectName}`);
                    return undefined;
                }
            }

            delete cached._cachedAt;
            return cached as SObjectDescribe;
        } catch (err: any) {
            this.outputChannel.appendLine(`Error reading cache for ${objectName}: ${err.message}`);
            return undefined;
        }
    }

    private saveToDiskCache(objectName: string, describe: SObjectDescribe) {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return; }
        const filePath = this.getSafeObjectCachePath(cacheDir, objectName);
        if (!filePath) {
            this.outputChannel.appendLine(`Skipping cache write for invalid object name: "${objectName}"`);
            return;
        }

        try {
            fs.mkdirSync(cacheDir, { recursive: true });
            const data = { ...describe, _cachedAt: Date.now() };
            fs.writeFileSync(
                filePath,
                JSON.stringify(data, null, 2),
                'utf-8'
            );
            this.addObjectToDiskObjectList(describe.name || objectName);
        } catch (err: any) {
            this.outputChannel.appendLine(`Error writing cache for ${objectName}: ${err.message}`);
        }
    }

    clearSingleDiskCache(objectName: string) {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return; }
        const filePath = this.getSafeObjectCachePath(cacheDir, objectName);
        if (!filePath) { return; }
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    private addObjectToDiskObjectList(objectName: string) {
        const normalizedName = normalizeSObjectApiName(objectName);
        if (!normalizedName) { return; }
        const existing = this.loadObjectListFromDisk() || [];
        if (existing.some(name => name.toLowerCase() === normalizedName.toLowerCase())) {
            return;
        }
        this.saveObjectListToDisk([...existing, normalizedName]);
        this.objectListCache = undefined;
    }

    /**
     * Check if an object is already cached on disk and not expired.
     */
    private isOnDisk(objectName: string): boolean {
        const cacheDir = this.getCacheDir();
        if (!cacheDir) { return false; }
        const filePath = this.getSafeObjectCachePath(cacheDir, objectName);
        if (!filePath) { return false; }
        if (!fs.existsSync(filePath)) { return false; }
        const maxAgeMs = this.getCacheMaxAgeMs();
        if (maxAgeMs === undefined) {
            return true;
        }
        try {
            const stat = fs.statSync(filePath);
            const age = Date.now() - stat.mtimeMs;
            return age < maxAgeMs;
        } catch { return false; }
    }

    /**
     * Sync all object metadata from the org to disk cache.
     * Skips objects already cached on disk.
     */
    async syncAllMetadata(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<number> {
        this.prepareForOrgSync();
        const objectNames = await this.sfCli.getObjectList();
        const toSync = objectNames.filter(n => !this.isOnDisk(n));
        const skipped = objectNames.length - toSync.length;
        const total = toSync.length;
        let synced = 0;
        const batchSize = 20;

        this.outputChannel.appendLine(
            `Syncing metadata: ${total} objects to fetch, ${skipped} already cached (batch size ${batchSize})`
        );

        if (skipped > 0) {
            progress.report({ message: `Skipped ${skipped} already cached` });
        }

        for (let i = 0; i < total; i += batchSize) {
            if (token.isCancellationRequested) { break; }

            const batch = toSync.slice(i, i + batchSize);
            progress.report({
                message: `${batch[0]} ... (${i + 1}-${Math.min(i + batchSize, total)}/${total}, ${skipped} skipped)`,
                increment: (batchSize / (total || 1)) * 100,
            });

            const results = await Promise.allSettled(
                batch.map(async (name) => {
                    const describe = await this.sfCli.describeSObject(name);
                    if (describe) {
                        this.saveToDiskCache(name, describe);
                        return true;
                    }
                    return false;
                })
            );

            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) { synced++; }
            }
        }

        this.outputChannel.appendLine(`Sync complete: ${synced} fetched, ${skipped} skipped (cached)`);
        this.setCurrentOrgCacheSourceState('org');
        this.clearPlaceholders();
        this.objectListCache = undefined;
        return synced + skipped;
    }

    /**
     * Sync only the most commonly used standard objects.
     */
    async syncCommonMetadata(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<number> {
        this.prepareForOrgSync();
        const commonObjects = [
            'Account', 'Contact', 'Lead', 'Opportunity', 'Case',
            'Task', 'Event', 'User', 'Profile', 'UserRole',
            'Campaign', 'CampaignMember', 'Contract', 'Order', 'OrderItem',
            'Product2', 'Pricebook2', 'PricebookEntry', 'Quote', 'QuoteLineItem',
            'Asset', 'Solution', 'ContentDocument', 'ContentVersion', 'ContentDocumentLink',
            'Attachment', 'Note', 'FeedItem', 'FeedComment',
            'Group', 'GroupMember', 'PermissionSet', 'PermissionSetAssignment',
            'RecordType', 'BusinessProcess',
            'EmailMessage', 'EmailTemplate',
            'Report', 'Dashboard',
            'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent',
            'CustomObject__c', 'FieldDefinition', 'EntityDefinition',
            'OpportunityLineItem', 'OpportunityContactRole',
            'AccountContactRelation', 'ContactPointEmail', 'ContactPointPhone',
        ];

        // Also include any custom objects from the org
        const allObjects = await this.sfCli.getObjectList();
        const customObjects = allObjects.filter(n => n.endsWith('__c'));
        const toSync = [...new Set([...commonObjects, ...customObjects])]
            .filter(n => allObjects.includes(n) || customObjects.includes(n))
            .filter(n => !this.isOnDisk(n));

        const total = toSync.length;
        let synced = 0;
        const batchSize = 20;

        this.outputChannel.appendLine(`Syncing ${total} common + custom objects...`);

        for (let i = 0; i < total; i += batchSize) {
            if (token.isCancellationRequested) { break; }

            const batch = toSync.slice(i, i + batchSize);
            progress.report({
                message: `${batch[0]} ... (${i + 1}-${Math.min(i + batchSize, total)}/${total})`,
                increment: (batchSize / (total || 1)) * 100,
            });

            const results = await Promise.allSettled(
                batch.map(async (name) => {
                    const describe = await this.sfCli.describeSObject(name);
                    if (describe) {
                        this.saveToDiskCache(name, describe);
                        return true;
                    }
                    return false;
                })
            );

            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) { synced++; }
            }
        }

        this.outputChannel.appendLine(`Common sync complete: ${synced}/${total} objects cached`);
        this.setCurrentOrgCacheSourceState('org');
        this.clearPlaceholders();
        this.objectListCache = undefined;
        return synced;
    }

    /**
     * Clear the disk cache for the current org.
     */
    clearDiskCache() {
        const cacheDir = this.getCacheDir();
        if (!cacheDir || !fs.existsSync(cacheDir)) { return; }

        try {
            fs.rmSync(cacheDir, { recursive: true, force: true });
            this.outputChannel.appendLine(`Cleared cache at ${cacheDir}`);
        } catch (err: any) {
            this.outputChannel.appendLine(`Error clearing cache: ${err.message}`);
        }
        this.objectListCache = undefined;
    }

    private prepareForOrgSync() {
        const sourceState = this.getCurrentOrgCacheSourceState();
        if (sourceState === 'local-fallback') {
            const cacheDir = this.getCacheDir();
            if (cacheDir && fs.existsSync(cacheDir)) {
                try {
                    fs.rmSync(cacheDir, { recursive: true, force: true });
                    this.outputChannel.appendLine(`Removed local-fallback cache before org sync: ${cacheDir}`);
                } catch (err: any) {
                    this.outputChannel.appendLine(`Failed to clear local-fallback cache before org sync: ${err.message}`);
                }
            }
        }
    }

    private getSafeObjectCachePath(cacheDir: string, objectName: string): string | undefined {
        const normalizedName = normalizeSObjectApiName(objectName);
        if (!normalizedName) { return undefined; }

        const resolvedDir = path.resolve(cacheDir);
        const candidate = path.resolve(resolvedDir, `${normalizedName}.json`);
        if (!candidate.startsWith(resolvedDir + path.sep)) {
            this.outputChannel.appendLine(`Rejected out-of-bounds cache path for object: "${objectName}"`);
            return undefined;
        }
        return candidate;
    }
}

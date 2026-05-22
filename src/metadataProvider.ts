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

interface SyncRunStats {
    fetched: number;
    alreadyCached: number;
    failed: number;
    timedOut: number;
    candidateCount: number;
    attempted: number;
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
    private lastSurfacedObjectListError: string | undefined;

    constructor(sfCli: SfCliService, outputChannel: vscode.OutputChannel, globalStoragePath: string) {
        this.sfCli = sfCli;
        this.localScanner = new LocalProjectScanner(outputChannel);
        this.outputChannel = outputChannel;
        this.globalStoragePath = globalStoragePath;
    }

    private surfaceObjectListErrorOnce() {
        const err = this.sfCli.getLastObjectListError();
        if (!err) { return; }
        // Only re-notify when the error message changes; otherwise stay quiet so
        // we don't spam the user on every keystroke that triggers autocomplete.
        if (err === this.lastSurfacedObjectListError) { return; }
        this.lastSurfacedObjectListError = err;
        vscode.window.showWarningMessage(
            `SOQL Editor: Could not load object list from org (autocomplete may be limited). ${err}`
        );
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

    private getSyncConcurrency(): number {
        const configured = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<number>('syncConcurrency', 4);
        if (!Number.isFinite(configured)) {
            return 4;
        }
        const normalized = Math.floor(configured);
        if (normalized < 1 || normalized > 10) {
            return 4;
        }
        return normalized;
    }

    private getDescribeTimeoutMs(): number {
        const configured = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<number>('describeTimeoutMs', 20000);
        if (!Number.isFinite(configured)) {
            return 20000;
        }
        const normalized = Math.floor(configured);
        return Math.min(120000, Math.max(5000, normalized));
    }

    private getDescribeRetryCount(): number {
        const configured = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<number>('describeRetryCount', 1);
        if (!Number.isFinite(configured)) {
            return 1;
        }
        const normalized = Math.floor(configured);
        return Math.min(3, Math.max(0, normalized));
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
            } else {
                // Surface CLI failure once so the user understands why autocomplete
                // is showing only the static fallback list instead of org-specific
                // objects. Subsequent calls within the cache window stay silent.
                this.surfaceObjectListErrorOnce();
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
        const root = this.getCacheRootDir();
        const usernameKey = this.sanitizeOrgCacheKey(org.username || org.alias);
        const candidate = path.join(root, usernameKey);

        // Backward-compat: if no cache exists under the (preferred) username key,
        // but one exists under the alias key, return the alias dir so existing
        // caches keep working without a manual migration.
        if (org.alias && org.alias !== org.username && !fs.existsSync(candidate)) {
            const aliasDir = path.join(root, this.sanitizeOrgCacheKey(org.alias));
            if (fs.existsSync(aliasDir)) {
                return aliasDir;
            }
        }
        return candidate;
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
        const currentKeys = new Set<string>();
        if (currentOrg?.username) { currentKeys.add(this.sanitizeOrgCacheKey(currentOrg.username)); }
        if (currentOrg?.alias) { currentKeys.add(this.sanitizeOrgCacheKey(currentOrg.alias)); }

        try {
            const dirs = fs.readdirSync(root, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => d.name)
                .filter(name => !currentKeys.has(name));

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
    ): Promise<SyncRunStats> {
        this.prepareForOrgSync();
        const objectNames = await this.sfCli.getObjectList();
        if (objectNames.length === 0) {
            this.outputChannel.appendLine(
                'syncAllMetadata: sf sobject list returned no objects. Check `sf org display`, auth, and network, then retry.'
            );
            return {
                fetched: 0,
                alreadyCached: 0,
                failed: 0,
                timedOut: 0,
                candidateCount: 0,
                attempted: 0,
            };
        }
        const toSync = objectNames.filter(n => !this.isOnDisk(n));
        const skipped = objectNames.length - toSync.length;
        const workers = this.getSyncConcurrency();
        const timeoutMs = this.getDescribeTimeoutMs();
        const retryCount = this.getDescribeRetryCount();

        this.outputChannel.appendLine(
            `Syncing metadata: ${toSync.length} objects to fetch, ${skipped} already cached (workers ${workers}, timeout ${timeoutMs}ms, retries ${retryCount})`
        );
        this.outputChannel.appendLine(`sync workers: ${workers}`);

        if (skipped > 0) {
            progress.report({ message: `Skipped ${skipped} already cached` });
        }

        const runStats = await this.syncObjectsWithWorkers(toSync, progress, token, {
            alreadyCached: skipped,
            candidateCount: objectNames.length,
        });

        this.outputChannel.appendLine(
            `Sync complete: fetched ${runStats.fetched}, cached ${runStats.alreadyCached}, timed out ${runStats.timedOut}, failed ${runStats.failed}`
        );
        this.setCurrentOrgCacheSourceState('org');
        this.clearPlaceholders();
        this.objectListCache = undefined;
        return runStats;
    }

    /**
     * Sync only the most commonly used standard objects.
     */
    async syncCommonMetadata(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<SyncRunStats> {
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

        // Use full getObjectList() (disk → CLI → SOQL_FALLBACK_OBJECTS) so a failed
        // `sf sobject list` does not collapse to zero candidates.
        const allObjects = await this.getObjectList();
        const customObjects = allObjects.filter(n => n.endsWith('__c'));
        const candidates = [...new Set([...commonObjects, ...customObjects])].filter(n =>
            allObjects.includes(n)
        );
        const alreadyCached = candidates.filter(n => this.isOnDisk(n)).length;
        const toSync = candidates.filter(n => !this.isOnDisk(n));
        const workers = this.getSyncConcurrency();
        const timeoutMs = this.getDescribeTimeoutMs();
        const retryCount = this.getDescribeRetryCount();

        this.outputChannel.appendLine(
            `Syncing ${toSync.length} common + custom objects (${alreadyCached} already on disk, ${candidates.length} candidates; workers ${workers}, timeout ${timeoutMs}ms, retries ${retryCount})`
        );
        this.outputChannel.appendLine(`sync workers: ${workers}`);

        const runStats = await this.syncObjectsWithWorkers(toSync, progress, token, {
            alreadyCached,
            candidateCount: candidates.length,
        });

        this.outputChannel.appendLine(
            `Common sync complete: fetched ${runStats.fetched}, cached ${runStats.alreadyCached}, timed out ${runStats.timedOut}, failed ${runStats.failed}`
        );
        this.setCurrentOrgCacheSourceState('org');
        this.clearPlaceholders();
        this.objectListCache = undefined;
        return runStats;
    }

    private async syncObjectsWithWorkers(
        objectNames: string[],
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken,
        base: { alreadyCached: number; candidateCount: number }
    ): Promise<SyncRunStats> {
        const total = objectNames.length;
        const workerCount = Math.min(this.getSyncConcurrency(), Math.max(total, 1));
        const timeoutMs = this.getDescribeTimeoutMs();
        const retryCount = this.getDescribeRetryCount();

        let index = 0;
        let completed = 0;
        let fetched = 0;
        let failed = 0;
        let timedOut = 0;
        const failedNames: string[] = [];

        const updateProgress = (name: string) => {
            progress.report({
                message: `${name} ... (${Math.min(completed + 1, total)}/${total}, ${base.alreadyCached} skipped)`,
                increment: total > 0 ? (1 / total) * 100 : 100,
            });
        };

        const worker = async () => {
            while (!token.isCancellationRequested) {
                const current = index++;
                if (current >= total) {
                    return;
                }
                const name = objectNames[current];
                updateProgress(name);
                const result = await this.describeWithRetry(name, timeoutMs, retryCount);
                completed++;
                if (result.ok) {
                    this.saveToDiskCache(name, result.describe);
                    fetched++;
                    continue;
                }
                if (result.reason === 'timeout') {
                    timedOut++;
                } else {
                    failed++;
                }
                failedNames.push(name);
            }
        };

        await Promise.all(Array.from({ length: workerCount }, async () => worker()));
        this.logFailedObjects(failedNames);

        return {
            fetched,
            alreadyCached: base.alreadyCached,
            failed,
            timedOut,
            candidateCount: base.candidateCount,
            attempted: total,
        };
    }

    private async describeWithRetry(
        objectName: string,
        timeoutMs: number,
        retryCount: number
    ): Promise<
        | { ok: true; describe: SObjectDescribe }
        | { ok: false; reason: 'timeout' | 'error'; message?: string }
    > {
        let lastReason: 'timeout' | 'error' = 'error';
        let lastMessage = '';

        for (let attempt = 0; attempt <= retryCount; attempt++) {
            const detailed = await this.sfCli.describeSObjectDetailed(objectName, { timeoutMs });
            if (detailed.describe) {
                return { ok: true, describe: detailed.describe };
            }
            lastReason = detailed.reason || 'error';
            lastMessage = detailed.errorMessage || '';

            const transient = lastReason === 'timeout' || /ETIMEDOUT|ECONN|EAI_AGAIN|ENOTFOUND/i.test(lastMessage);
            const shouldRetry = attempt < retryCount && transient;
            if (!shouldRetry) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }

        this.outputChannel.appendLine(
            `Sync describe failed for ${objectName}: ${lastReason}${lastMessage ? ` (${lastMessage})` : ''}`
        );
        return { ok: false, reason: lastReason, message: lastMessage };
    }

    private logFailedObjects(names: string[]) {
        if (names.length === 0) {
            return;
        }
        const sample = names.slice(0, 10).join(', ');
        const suffix = names.length > 10 ? ` ... (+${names.length - 10} more)` : '';
        this.outputChannel.appendLine(`Sync failures (${names.length}): ${sample}${suffix}`);
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
                    this.objectListCache = undefined;
                    this.sfCli.clearCache();
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

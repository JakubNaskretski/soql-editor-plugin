import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { SfCliService, SObjectDescribe, SObjectField, normalizeSObjectApiName } from './sfCliService';
import { LocalProjectScanner } from './localProjectScanner';
import { SOQL_FALLBACK_OBJECTS } from './soqlCatalog';

/**
 * Resolves SObject metadata from multiple sources.
 *
 * Object list (`getObjectList`): short-lived in-memory cache, then merge of
 * (org names from disk `_objectList.json` or `sf sobject list`) with local
 * SFDX object folder names; if empty, falls back to `SOQL_FALLBACK_OBJECTS`.
 *
 * Per-object describe (`describeSObject`): (1) in-memory cache in SfCliService,
 * (2) disk cache JSON per org, (3) live `sf sobject describe`, (4) local project
 * only if describe fails. When (1)–(3) succeed, local field XML is merged on top
 * so workspace changes override the cached/org describe for matching field names.
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
     * Get object list -- merges local project objects + org objects.
     * Caches the org object list to disk for fast startup.
     */
    async getObjectList(): Promise<string[]> {
        if (this.objectListCache && Date.now() < this.objectListCache.expiresAt) {
            return this.objectListCache.value;
        }
        const localObjects = this.localScanner.getLocalObjectNames();

        // Try disk-cached object list first
        let orgObjects = this.loadObjectListFromDisk();
        if (!orgObjects) {
            orgObjects = await this.sfCli.getObjectList();
            if (orgObjects.length > 0) {
                this.saveObjectListToDisk(orgObjects);
            }
        }

        const merged = new Set<string>(orgObjects);
        for (const name of localObjects) {
            merged.add(name);
        }
        if (merged.size === 0) {
            for (const name of SOQL_FALLBACK_OBJECTS) {
                merged.add(name);
            }
        }

        const list = Array.from(merged).sort();
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

    /**
     * Describe an SObject — tries cache/local first, then CLI.
     * Merges local project fields on top of the full describe.
     */
    async describeSObject(objectName: string): Promise<SObjectDescribe | undefined> {
        const normalizedName = normalizeSObjectApiName(objectName);
        if (!normalizedName) {
            this.outputChannel.appendLine(`Rejected invalid object name for describe: "${objectName}"`);
            return undefined;
        }

        // 1. Check in-memory cache (inside SfCliService)
        const cached = this.sfCli.getCachedDescribe(normalizedName);
        if (cached) {
            return this.mergeWithLocal(cached);
        }

        // 2. Check disk cache
        const diskCached = this.loadFromDiskCache(normalizedName);
        if (diskCached) {
            this.sfCli.setCachedDescribe(normalizedName, diskCached);
            return this.mergeWithLocal(diskCached);
        }

        // 3. Try live CLI describe
        const live = await this.sfCli.describeSObject(normalizedName);
        if (live) {
            this.saveToDiskCache(normalizedName, live);
            return this.mergeWithLocal(live);
        }

        // 4. Fall back to local project only (e.g., offline or object not yet deployed)
        const local = this.localScanner.describeFromLocal(normalizedName);
        return local;
    }

    /**
     * Merge local project field definitions on top of a full describe.
     * Local fields override existing fields (they reflect your latest code).
     */
    private mergeWithLocal(describe: SObjectDescribe): SObjectDescribe {
        const local = this.localScanner.describeFromLocal(describe.name);
        if (!local) { return describe; }

        const fieldMap = new Map<string, SObjectField>();
        for (const f of describe.fields) {
            fieldMap.set(f.name.toLowerCase(), f);
        }
        // Local fields override — these are from your source code
        for (const f of local.fields) {
            fieldMap.set(f.name.toLowerCase(), f);
        }

        return {
            ...describe,
            fields: Array.from(fieldMap.values()),
        };
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
    getCurrentOrgCacheStatus(): { hasCache: boolean; hasObjectList: boolean; objectFileCount: number } {
        const cacheDir = this.getCacheDir();
        if (!cacheDir || !fs.existsSync(cacheDir)) {
            return { hasCache: false, hasObjectList: false, objectFileCount: 0 };
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
                if (entry.name.endsWith('.json')) {
                    objectFileCount++;
                }
            }
        } catch {
            return { hasCache: false, hasObjectList: false, objectFileCount: 0 };
        }

        return {
            hasCache: hasObjectList || objectFileCount > 0,
            hasObjectList,
            objectFileCount,
        };
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
                    return files.some(f => f === '_objectList.json' || f.endsWith('.json'));
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

        return copied;
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
        return synced + skipped;
    }

    /**
     * Sync only the most commonly used standard objects.
     */
    async syncCommonMetadata(
        progress: vscode.Progress<{ message?: string; increment?: number }>,
        token: vscode.CancellationToken
    ): Promise<number> {
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

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetadataProvider } from './metadataProvider';
import { SObjectDescribe } from './sfCliService';

const vscodeMockState = {
    cacheExpiryDays: 0,
    syncConcurrency: 4,
    describeTimeoutMs: 20000,
    describeRetryCount: 1,
};

vi.mock('vscode', () => {
    return {
        workspace: {
            getConfiguration: () => ({
                get: (key: string, defaultValue: number) =>
                    (vscodeMockState as Record<string, number | undefined>)[key] ?? defaultValue,
            }),
            workspaceFolders: [],
        },
    };
});

interface FakeSfCli {
    getCurrentOrg: () => { alias: string; username: string; instanceUrl: string; isDefault: boolean };
    getCachedDescribe: (name: string) => SObjectDescribe | undefined;
    setCachedDescribe: (name: string, describe: SObjectDescribe) => void;
    describeSObject: (name: string) => Promise<SObjectDescribe | undefined>;
    describeSObjectDetailed: (name: string, options?: { timeoutMs?: number }) => Promise<{
        describe?: SObjectDescribe;
        reason?: 'timeout' | 'error';
        errorMessage?: string;
    }>;
    getObjectList: () => Promise<string[]>;
    getLastObjectListError: () => string | undefined;
    clearCache: () => void;
}

function makeDescribe(name: string, fields: string[]): SObjectDescribe {
    return {
        name,
        label: name,
        fields: fields.map(field => ({
            name: field,
            label: field,
            type: 'string',
            referenceTo: [],
            relationshipName: null,
            picklistValues: [],
            nillable: true,
            updateable: true,
            createable: true,
        })),
        childRelationships: [],
    };
}

function createProvider(opts?: {
    alias?: string;
    objectList?: string[];
    describes?: Record<string, SObjectDescribe>;
}) {
    const alias = opts?.alias || 'dev-org';
    const describes = new Map<string, SObjectDescribe>(
        Object.entries(opts?.describes || {}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const inMemoryDescribe = new Map<string, SObjectDescribe>();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soql-md-provider-'));
    const outputChannel = { appendLine: vi.fn() };

    const username = `${alias}@example.com`;
    const sfCli: FakeSfCli = {
        getCurrentOrg: () => ({ alias, username, instanceUrl: '', isDefault: true }),
        getCachedDescribe: (name: string) => inMemoryDescribe.get(name.toLowerCase()),
        setCachedDescribe: (name: string, describe: SObjectDescribe) => {
            inMemoryDescribe.set(name.toLowerCase(), describe);
        },
        describeSObject: vi.fn(async (name: string) => describes.get(name.toLowerCase())),
        describeSObjectDetailed: vi.fn(async (name: string) => ({ describe: describes.get(name.toLowerCase()) })),
        getObjectList: vi.fn(async () => opts?.objectList || []),
        getLastObjectListError: vi.fn(() => undefined),
        clearCache: vi.fn(),
    };

    const provider = new MetadataProvider(sfCli as any, outputChannel as any, tmpRoot);
    // Cache dir is keyed by username (stable identifier); falls back to alias for
    // backward compatibility, but tests should use the username-derived path.
    const sanitizedUsername = username.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const cacheDir = path.join(tmpRoot, 'cache', sanitizedUsername);
    return { provider, sfCli, tmpRoot, cacheDir };
}

afterEach(() => {
    vscodeMockState.cacheExpiryDays = 0;
    vscodeMockState.syncConcurrency = 4;
    vscodeMockState.describeTimeoutMs = 20000;
    vscodeMockState.describeRetryCount = 1;
});

describe('MetadataProvider (org-first cache strategy)', () => {
    it('reuses an alias-keyed cache directory when no username-keyed one exists', () => {
        const alias = 'legacy-org';
        const { provider, tmpRoot } = createProvider({ alias });
        // Pre-existing cache under the alias key (how older installs stored it).
        const legacyDir = path.join(tmpRoot, 'cache', alias);
        fs.mkdirSync(legacyDir, { recursive: true });
        fs.writeFileSync(
            path.join(legacyDir, '_objectList.json'),
            JSON.stringify({ objects: ['LegacyObj'], _cachedAt: Date.now() }),
            'utf-8'
        );

        const status = provider.getCurrentOrgCacheStatus();
        expect(status.hasObjectList).toBe(true);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('infers org cache source for legacy cache dirs without _cacheSource.json', () => {
        const { provider, cacheDir, tmpRoot } = createProvider();
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, '_objectList.json'),
            JSON.stringify({ objects: ['Account'], _cachedAt: Date.now() }),
            'utf-8'
        );

        expect(provider.getCurrentOrgCacheSourceState()).toBe('org');
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('does not scan local project paths during getObjectList runtime path', async () => {
        const { provider, cacheDir, tmpRoot } = createProvider();
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, '_objectList.json'),
            JSON.stringify({ objects: ['Account'], _cachedAt: Date.now() }),
            'utf-8'
        );

        const localScannerSpy = {
            getLocalObjectNames: vi.fn(() => ['ShouldNotBeUsed']),
            describeFromLocal: vi.fn(),
        };
        (provider as any).localScanner = localScannerSpy;

        const objects = await provider.getObjectList();
        expect(objects).toContain('Account');
        expect(localScannerSpy.getLocalObjectNames).not.toHaveBeenCalled();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('builds static local-fallback cache on explicit bootstrap', () => {
        const { provider, cacheDir, tmpRoot } = createProvider();
        const localDescribe = makeDescribe('LocalOnly__c', ['Id', 'Name']);
        (provider as any).localScanner = {
            getLocalObjectNames: () => ['LocalOnly__c'],
            describeFromLocal: (name: string) => (name === 'LocalOnly__c' ? localDescribe : undefined),
        };

        const count = provider.bootstrapCurrentOrgCacheFromLocalProject();
        expect(count).toBe(1);
        expect(provider.getCurrentOrgCacheSourceState()).toBe('local-fallback');

        const objectList = JSON.parse(fs.readFileSync(path.join(cacheDir, '_objectList.json'), 'utf-8'));
        expect(objectList.objects).toContain('LocalOnly__c');
        expect(fs.existsSync(path.join(cacheDir, 'LocalOnly__c.json'))).toBe(true);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('reconcileSuccessfulQuery records placeholder for fields missing from cached describe', async () => {
        const { provider, cacheDir, tmpRoot } = createProvider({
            describes: { account: makeDescribe('Account', ['Id']) },
        });
        fs.mkdirSync(cacheDir, { recursive: true });
        provider.setCurrentOrgCacheSourceState('org');

        await provider.reconcileSuccessfulQuery('SELECT Id, Name FROM Account');

        const placeholders = JSON.parse(fs.readFileSync(path.join(cacheDir, '_placeholders.json'), 'utf-8'));
        expect(placeholders.objects.account.fields).toContain('Name');

        const objectList = JSON.parse(fs.readFileSync(path.join(cacheDir, '_objectList.json'), 'utf-8'));
        expect(objectList.objects).toContain('Account');
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('reconcileSuccessfulQuery clears placeholder when fields are fully known', async () => {
        const { provider, cacheDir, tmpRoot } = createProvider({
            describes: { account: makeDescribe('Account', ['Id', 'Name']) },
        });
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(
            path.join(cacheDir, '_placeholders.json'),
            JSON.stringify({ objects: { account: { fields: ['Name'] } } }, null, 2),
            'utf-8'
        );

        await provider.reconcileSuccessfulQuery('SELECT Id, Name FROM Account');

        const placeholders = JSON.parse(fs.readFileSync(path.join(cacheDir, '_placeholders.json'), 'utf-8'));
        expect(placeholders.objects.account).toBeUndefined();
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('syncCommonMetadata uses getObjectList fallback when sf sobject list is empty', async () => {
        const { provider, cacheDir, tmpRoot } = createProvider({
            objectList: [],
            describes: { account: makeDescribe('Account', ['Id', 'Name']) },
        });

        const progress = { report: vi.fn() };
        const token = { isCancellationRequested: false };
        const r = await provider.syncCommonMetadata(progress as any, token as any);

        expect(r.candidateCount).toBeGreaterThan(0);
        expect(r.fetched).toBeGreaterThan(0);
        expect(fs.existsSync(path.join(cacheDir, 'Account.json'))).toBe(true);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('syncAllMetadata upgrades local-fallback state to org and clears placeholders', async () => {
        const { provider, cacheDir, tmpRoot } = createProvider({
            objectList: ['Account'],
            describes: { account: makeDescribe('Account', ['Id', 'Name']) },
        });

        fs.mkdirSync(cacheDir, { recursive: true });
        provider.setCurrentOrgCacheSourceState('local-fallback');
        fs.writeFileSync(
            path.join(cacheDir, '_placeholders.json'),
            JSON.stringify({ objects: { account: { fields: ['Name'] } } }, null, 2),
            'utf-8'
        );
        fs.writeFileSync(
            path.join(cacheDir, '_objectList.json'),
            JSON.stringify({ objects: ['LocalOnly__c'], _cachedAt: Date.now() }),
            'utf-8'
        );

        const progress = { report: vi.fn() };
        const token = { isCancellationRequested: false };
        const synced = await provider.syncAllMetadata(progress as any, token as any);

        expect(synced.fetched + synced.alreadyCached).toBeGreaterThan(0);
        expect(provider.getCurrentOrgCacheSourceState()).toBe('org');
        expect(fs.existsSync(path.join(cacheDir, '_placeholders.json'))).toBe(false);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it('syncCommonMetadata applies configured timeout and worker defaults', async () => {
        vscodeMockState.syncConcurrency = Number.NaN;
        vscodeMockState.describeTimeoutMs = 15000;
        const { provider, sfCli, tmpRoot } = createProvider({
            objectList: ['Account'],
            describes: { account: makeDescribe('Account', ['Id']) },
        });

        const progress = { report: vi.fn() };
        const token = { isCancellationRequested: false };
        await provider.syncCommonMetadata(progress as any, token as any);

        expect((sfCli.describeSObjectDetailed as any).mock.calls[0][1].timeoutMs).toBe(15000);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });
});

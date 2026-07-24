import { beforeEach, describe, expect, it, vi } from 'vitest';

// sfCliService imports 'vscode' at module load. A functional EventEmitter is
// needed because the service wires `onLog = emitter.event` and `emitter.fire()`
// on every CLI invocation.
vi.mock('vscode', () => ({
    EventEmitter: class {
        event = () => ({ dispose() {} });
        fire() {}
        dispose() {}
    },
}));

// Stub the CLI shell-out so openRecord can be exercised without a real `sf`.
vi.mock('child_process', () => ({ execFile: vi.fn() }));

// Partial-mock the kit: planSpawn defaults to the REAL implementation (so on
// this non-Windows test runner every existing test below sees the same
// identity passthrough it always has), but a single test can override one
// call with mockReturnValueOnce/mockImplementationOnce to simulate the
// Windows .cmd-rewrite plans without needing to fake process.platform.
vi.mock('./kit/sfCli', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./kit/sfCli')>();
    return { ...actual, planSpawn: vi.fn(actual.planSpawn) };
});

import { execFile } from 'child_process';
import { normalizeSObjectApiName } from './sobjectName';
import { parseSoqlQueryError, SfCliService, OrgInfo } from './sfCliService';
import { planSpawn } from './kit/sfCli';

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;
const planSpawnMock = vi.mocked(planSpawn);

function makeService() {
    return new SfCliService({ appendLine: vi.fn() } as any);
}

const TEST_ORG: OrgInfo = {
    alias: 'dev',
    username: 'dev@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    isDefault: true,
};

describe('normalizeSObjectApiName', () => {
    it('accepts valid api names', () => {
        expect(normalizeSObjectApiName('Account')).toBe('Account');
        expect(normalizeSObjectApiName('Custom_Object__c')).toBe('Custom_Object__c');
        expect(normalizeSObjectApiName(' ns__Object__mdt ')).toBe('ns__Object__mdt');
    });

    it('rejects unsafe or malformed names', () => {
        expect(normalizeSObjectApiName('../Account')).toBeUndefined();
        expect(normalizeSObjectApiName('Account;rm -rf /')).toBeUndefined();
        expect(normalizeSObjectApiName('')).toBeUndefined();
        expect(normalizeSObjectApiName('1BadStart')).toBeUndefined();
    });
});

describe('parseSoqlQueryError', () => {
    it('extracts field, position and explanation from an INVALID_FIELD error', () => {
        const raw =
            "\nSELECT Naem FROM Account\n       ^\nERROR at Row:1:Column:8\n" +
            "No such column 'Naem' on entity 'Account'. If you are attempting to use a custom field, " +
            "be sure to append the '__c' after the custom field name.";
        const e = parseSoqlQueryError(raw, 'INVALID_FIELD');
        expect(e.line).toBe(1);
        expect(e.column).toBe(8);
        expect(e.code).toBe('INVALID_FIELD');
        expect(e.message).toContain("No such column 'Naem' on entity 'Account'");
        expect(e.message.startsWith('INVALID_FIELD:')).toBe(true);
        expect(e.message).toContain('(line 1, column 8)');
        // The full caret/echo detail is preserved for display.
        expect(e.detail).toContain('SELECT Naem FROM Account');
        expect(e.detail).toContain('^');
    });

    it('extracts the unexpected token and position from a MALFORMED_QUERY error', () => {
        const raw =
            "\nSELECT Id FROM Account WHERE\n                            ^\n" +
            "ERROR at Row:1:Column:29\nunexpected token: '<EOF>'";
        const e = parseSoqlQueryError(raw, 'MALFORMED_QUERY');
        expect(e.line).toBe(1);
        expect(e.column).toBe(29);
        expect(e.message).toContain("unexpected token: '<EOF>'");
        expect(e.message).toContain('(line 1, column 29)');
    });

    it('handles errors with no position block', () => {
        const e = parseSoqlQueryError("sObject type 'Acount' is not supported.", 'INVALID_TYPE');
        expect(e.line).toBeUndefined();
        expect(e.column).toBeUndefined();
        expect(e.message).toBe("INVALID_TYPE: sObject type 'Acount' is not supported.");
        expect(e.detail).toBeUndefined();
    });

    it('does not double-prefix when the message already starts with the code', () => {
        const e = parseSoqlQueryError("MALFORMED_QUERY: unexpected token 'FORM'", 'MALFORMED_QUERY');
        expect(e.message).toBe("MALFORMED_QUERY: unexpected token 'FORM'");
    });

    it('falls back to a generic message for empty input', () => {
        expect(parseSoqlQueryError('', undefined).message).toBe('Query failed');
    });
});

describe('SfCliService.openRecord', () => {
    beforeEach(() => {
        execFileMock.mockReset();
        // Default: the CLI succeeds and invokes its callback with empty output.
        execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, '', ''));
    });

    it('opens the record through the CLI frontdoor session (sf org open --path)', async () => {
        const svc = makeService();
        svc.setCurrentOrg(TEST_ORG);

        const ok = await svc.openRecord('001000000000001');

        expect(ok).toBe(true);
        expect(execFileMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][1]).toEqual([
            'org', 'open',
            '--path', '/001000000000001',
            '--target-org', 'dev@example.com',
        ]);
    });

    it('accepts an 18-character record id', async () => {
        const svc = makeService();
        svc.setCurrentOrg(TEST_ORG);

        const ok = await svc.openRecord('001000000000001AAA');

        expect(ok).toBe(true);
        expect(execFileMock.mock.calls[0][1]).toContain('/001000000000001AAA');
    });

    it('rejects a malformed record id without shelling out', async () => {
        const svc = makeService();
        svc.setCurrentOrg(TEST_ORG);

        const ok = await svc.openRecord('../etc/passwd');

        expect(ok).toBe(false);
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns false when no org is selected', async () => {
        const svc = makeService();

        const ok = await svc.openRecord('001000000000001');

        expect(ok).toBe(false);
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('returns false (so the caller can fall back) when the CLI fails', async () => {
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(new Error('No authorization information found'), '', '')
        );
        const svc = makeService();
        svc.setCurrentOrg(TEST_ORG);

        const ok = await svc.openRecord('001000000000001');

        expect(ok).toBe(false);
    });
});

describe('SfCliService.getObjectList', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('returns string names from a well-formed envelope', async () => {
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(null, JSON.stringify({ status: 0, result: ['Account', 'Contact'] }), '')
        );
        const svc = makeService();
        await expect(svc.getObjectList()).resolves.toEqual(['Account', 'Contact']);
        expect(svc.getLastObjectListError()).toBeUndefined();
    });

    it('rejects a malformed envelope shape instead of caching it', async () => {
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(null, JSON.stringify({ status: 0, result: { bogus: true } }), '')
        );
        const svc = makeService();
        await expect(svc.getObjectList()).resolves.toEqual([]);
        expect(svc.getLastObjectListError()).toContain('unexpected payload');
    });

    it('drops non-string entries from the object list', async () => {
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(null, JSON.stringify({ status: 0, result: ['Account', 42, null, 'Contact'] }), '')
        );
        const svc = makeService();
        await expect(svc.getObjectList()).resolves.toEqual(['Account', 'Contact']);
    });
});

describe('SfCliService.listOrgs', () => {
    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('skips the per-org connection probe so a flaky org is not dropped', async () => {
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(null, JSON.stringify({ result: { nonScratchOrgs: [] } }), '')
        );
        const svc = makeService();

        await svc.listOrgs();

        expect(execFileMock.mock.calls[0][1]).toEqual(['org', 'list', '--skip-connection-status', '--json']);
    });

    it('collapses one authenticated username repeated across CLI result buckets', async () => {
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(null, JSON.stringify({
                result: {
                    nonScratchOrgs: [{
                        username: 'builder@inzorg.example',
                        instanceUrl: 'https://inzorg.example',
                        isDefaultUsername: true,
                    }],
                    sandboxes: [{
                        alias: 'inzorg-thesis',
                        username: 'builder@inzorg.example',
                    }],
                },
            }), '')
        );
        const svc = makeService();

        await expect(svc.listOrgs()).resolves.toEqual([{
            alias: 'inzorg-thesis',
            username: 'builder@inzorg.example',
            instanceUrl: 'https://inzorg.example',
            isDefault: true,
        }]);
    });
});

describe('SfCliService.describeSObject org-switch cache guard', () => {
    const describeJson = JSON.stringify({
        status: 0,
        result: { name: 'Account', label: 'Account', fields: [], childRelationships: [] },
    });

    beforeEach(() => {
        execFileMock.mockReset();
    });

    it('does not cache a describe under the new org when the org switched mid-describe', async () => {
        const svc = makeService();
        svc.setCurrentOrg(TEST_ORG); // org A
        const OTHER: OrgInfo = { alias: 'other', username: 'other@example.com', instanceUrl: '', isDefault: false };
        execFileMock.mockImplementation((_file, _args, _opts, cb) => {
            // A switch to another org lands before the describe resolves.
            svc.setCurrentOrg(OTHER);
            cb(null, describeJson, '');
        });

        const result = await svc.describeSObject('Account');

        expect(result?.name).toBe('Account'); // the original caller still gets the data
        expect(svc.getCachedDescribe('Account')).toBeUndefined(); // but it is not cached under org B
    });

    it('caches a describe when the org is unchanged', async () => {
        const svc = makeService();
        svc.setCurrentOrg(TEST_ORG);
        execFileMock.mockImplementation((_file, _args, _opts, cb) => cb(null, describeJson, ''));

        await svc.describeSObject('Account');

        expect(svc.getCachedDescribe('Account')?.name).toBe('Account');
    });
});

describe('SfCliService.runCliAsync Windows spawn-plan wiring', () => {
    // Node refuses to execFile a `.cmd`/`.bat` launcher with shell:false (EINVAL)
    // even via an absolute path, so runCliAsync must run the resolved sf command
    // through planSpawn and execute WHATEVER it returns — never the raw resolved
    // path directly. These tests fake planSpawn's return value (rather than
    // process.platform) to prove that wiring without depending on the host OS.
    beforeEach(() => {
        execFileMock.mockReset();
        execFileMock.mockImplementation((_file, _args, _opts, cb) =>
            cb(null, JSON.stringify({ result: { nonScratchOrgs: [] } }), '')
        );
        planSpawnMock.mockClear();
    });

    it('execFiles the node/run.js bypass planSpawn returns, not the raw .cmd path', async () => {
        planSpawnMock.mockReturnValueOnce({
            command: 'node',
            args: ['C:\\Program Files\\sf\\bin\\run.js', 'org', 'list', '--skip-connection-status', '--json'],
        });
        const svc = makeService();

        await svc.listOrgs();

        expect(planSpawnMock).toHaveBeenCalledTimes(1);
        expect(execFileMock.mock.calls[0][0]).toBe('node');
        expect(execFileMock.mock.calls[0][1]).toEqual([
            'C:\\Program Files\\sf\\bin\\run.js', 'org', 'list', '--skip-connection-status', '--json',
        ]);
    });

    it('threads windowsVerbatimArguments from the cmd.exe fallback plan into the execFile options', async () => {
        planSpawnMock.mockReturnValueOnce({
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', '"C:\\Program Files\\sf\\bin\\sf.cmd" org list --skip-connection-status --json'],
            windowsVerbatimArguments: true,
        });
        const svc = makeService();

        await svc.listOrgs();

        expect(execFileMock.mock.calls[0][0]).toBe('cmd.exe');
        expect(execFileMock.mock.calls[0][2]).toMatchObject({ windowsVerbatimArguments: true });
    });

    it('rejects instead of shelling out when planSpawn refuses an unsafe argument', async () => {
        const { SfCliError } = await import('./kit/sfCli');
        planSpawnMock.mockImplementationOnce(() => {
            throw new SfCliError('Cannot pass this argument through cmd.exe safely: bad"arg');
        });
        const svc = makeService();

        await expect(svc.listOrgs()).rejects.toThrow(/bad"arg/);
        expect(execFileMock).not.toHaveBeenCalled();
    });
});

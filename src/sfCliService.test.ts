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

import { execFile } from 'child_process';
import { normalizeSObjectApiName } from './sobjectName';
import { parseSoqlQueryError, SfCliService, OrgInfo } from './sfCliService';

const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

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

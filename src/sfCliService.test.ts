import { describe, expect, it, vi } from 'vitest';

// sfCliService imports 'vscode' at module load; the parser under test is pure,
// so a minimal mock is enough to let the import resolve.
vi.mock('vscode', () => ({ EventEmitter: class {} }));

import { normalizeSObjectApiName } from './sobjectName';
import { parseSoqlQueryError } from './sfCliService';

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

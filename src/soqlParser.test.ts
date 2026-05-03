import { describe, expect, it } from 'vitest';
import { extractFromObject, extractScopedFromInfo, extractSelectFields, getQueryContext } from './soqlParser';

describe('extractFromObject', () => {
    it('extracts simple object names', () => {
        const query = 'SELECT Id, Name FROM Account WHERE Name != null';
        expect(extractFromObject(query)).toBe('Account');
    });

    it('returns undefined when FROM is absent', () => {
        expect(extractFromObject('SELECT Id, Name')).toBeUndefined();
    });
});

describe('extractScopedFromInfo', () => {
    it('resolves top-level FROM object', () => {
        const query = 'SELECT Id FROM Account WHERE Name != null';
        const info = extractScopedFromInfo(query, query.length);
        expect(info?.fromName).toBe('Account');
        expect(info?.depth).toBe(0);
    });

    it('resolves child relationship FROM inside subquery scope', () => {
        const query = 'SELECT Id, (SELECT LastName FROM Contacts WHERE LastName != null) FROM Account';
        const cursor = query.indexOf('LastName != null') + 6;
        const info = extractScopedFromInfo(query, cursor);
        expect(info?.fromName).toBe('Contacts');
        expect(info?.depth).toBe(1);
    });
});

describe('extractSelectFields', () => {
    it('splits simple comma-separated fields', () => {
        const query = 'SELECT Id, Name, Owner.Name FROM Account';
        expect(extractSelectFields(query)).toEqual(['Id', 'Name', 'Owner.Name']);
    });

    it('does not split commas inside function arguments', () => {
        const query = "SELECT FORMAT(CreatedDate, 'yyyy,MM'), Name FROM Account";
        expect(extractSelectFields(query)).toEqual(["FORMAT(CreatedDate, 'yyyy,MM')", 'Name']);
    });

    it('does not split commas inside subquery fields', () => {
        const query = 'SELECT Id, (SELECT LastName, Email FROM Contacts), Name FROM Account';
        expect(extractSelectFields(query)).toEqual(['Id', '(SELECT LastName, Email FROM Contacts)', 'Name']);
    });
});

describe('getQueryContext', () => {
    it('detects FROM object typing', () => {
        const query = 'SELECT Id FROM Con';
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'from_object', partial: 'Con' });
    });

    it('detects ORDER BY direction context', () => {
        const query = 'SELECT Id FROM Account ORDER BY Name D';
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'order_direction', partial: 'D' });
    });

    it('detects WITH clause context', () => {
        const query = 'SELECT Id FROM Account WITH SEC';
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'with_clause', partial: 'SEC' });
    });

    it('detects FOR clause context', () => {
        const query = 'SELECT Id FROM Account FOR UP';
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'for_clause', partial: 'UP' });
    });

    it('detects tail clause after completed WHERE value', () => {
        const query = "SELECT Id FROM Account WHERE Name = 'Acme' G";
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'tail_clause', partial: 'G' });
    });

    it('keeps WHERE field context after AND', () => {
        const query = "SELECT Id FROM Account WHERE Name = 'Acme' AND ";
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'where_field', partial: '' });
    });

    it('keeps WHERE field context while typing field after AND', () => {
        const query = "SELECT Id FROM Account WHERE Name = 'Acme' AND Na";
        const ctx = getQueryContext(query, query.length);
        expect(ctx).toEqual({ type: 'where_field', partial: 'Na' });
    });
});

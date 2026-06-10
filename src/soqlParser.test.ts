import { describe, expect, it } from 'vitest';
import {
    extractFromObject,
    extractScopedFromInfo,
    extractSelectFields,
    getQueryContext,
    validateSoqlStructure,
} from './soqlParser';

describe('extractFromObject', () => {
    it('extracts simple object names', () => {
        const query = 'SELECT Id, Name FROM Account WHERE Name != null';
        expect(extractFromObject(query)).toBe('Account');
    });

    it('returns undefined when FROM is absent', () => {
        expect(extractFromObject('SELECT Id, Name')).toBeUndefined();
    });

    it('returns the outer object when the SELECT contains a subquery', () => {
        const query = 'SELECT Id, (SELECT Id FROM Contacts) FROM Account';
        expect(extractFromObject(query)).toBe('Account');
    });

    it('ignores FROM-like text inside string literals', () => {
        const query = "SELECT Id FROM Account WHERE Name = 'FROM Contacts'";
        expect(extractFromObject(query)).toBe('Account');
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

describe('validateSoqlStructure', () => {
    const messages = (q: string) => validateSoqlStructure(q).map(e => e.message);

    it('returns no errors for a well-formed query', () => {
        expect(messages('SELECT Id, Name FROM Account WHERE Name != null')).toEqual([]);
    });

    it('flags missing FROM clause', () => {
        expect(messages('SELECT Id, Name')).toContain('Missing FROM clause');
    });

    it('flags empty SELECT clause', () => {
        expect(messages('SELECT FROM Account')).toContain('Empty SELECT clause');
    });

    it('flags missing comma between SELECT fields', () => {
        const errs = messages('SELECT Id Name FROM Account');
        expect(errs.some(m => m.startsWith('Missing comma between SELECT fields'))).toBe(true);
    });

    it('points the missing-comma diagnostic at the actual offending slot, not the first match', () => {
        // The third slot ("Name Name") is the broken one; the first slot is a
        // standalone "Name". A naive indexOf-based offset would point at the
        // first occurrence instead of the third.
        const q = 'SELECT Name, Other, Name Name FROM Account';
        const errs = validateSoqlStructure(q);
        const missingComma = errs.find(e => e.message.startsWith('Missing comma between SELECT fields'));
        expect(missingComma).toBeDefined();
        // The third slot ("Name Name") starts at column 20 (0-indexed).
        expect(missingComma!.startCol).toBe(q.indexOf('Name Name'));
    });

    it('still flags missing FROM even when other errors are present', () => {
        // Unmatched paren + missing FROM — both should be reported.
        const errs = messages('SELECT (Id, Name');
        expect(errs).toContain('Missing FROM clause');
        expect(errs.some(m => m.startsWith('Unmatched'))).toBe(true);
    });

    it('does not falsely flag function calls / subqueries as missing commas', () => {
        expect(messages('SELECT Id, FORMAT(CreatedDate) FROM Account')).toEqual([]);
        expect(messages('SELECT Id, (SELECT Id FROM Contacts) FROM Account')).toEqual([]);
    });

    it('flags invalid operator runs in WHERE', () => {
        expect(messages("SELECT Id FROM Account WHERE Name !- 'x'"))
            .toContain("Invalid operator '!-'");
        expect(messages('SELECT Id FROM Account WHERE Name => 1'))
            .toContain("Invalid operator '=>'");
        expect(messages('SELECT Id FROM Account WHERE Name =! 1'))
            .toContain("Invalid operator '=!'");
        expect(messages('SELECT Id FROM Account WHERE Amount == 100'))
            .toContain("Use '=' instead of '==' in SOQL");
    });

    it('does not flag valid SOQL operators', () => {
        const errs = messages(
            'SELECT Id FROM Account WHERE Name != null AND Amount >= 100 AND Type <> \'Other\' AND Other <= 1'
        );
        expect(errs).toEqual([]);
    });

    it('does not flag field aliases in aggregate queries as missing commas', () => {
        // "StageName s" is a legal alias when the query has a top-level GROUP BY.
        const errs = messages(
            'SELECT StageName s, COUNT(Id) c FROM Opportunity GROUP BY StageName'
        );
        expect(errs.some(m => m.startsWith('Missing comma between SELECT fields'))).toBe(false);
    });

    it('still flags three-token slots in aggregate queries', () => {
        const errs = messages(
            'SELECT StageName s Amount, COUNT(Id) FROM Opportunity GROUP BY StageName'
        );
        expect(errs.some(m => m.startsWith('Missing comma between SELECT fields'))).toBe(true);
    });

    it('does not treat GROUP BY function names as grouped field heads', () => {
        // CALENDAR_YEAR is a function NAME, not a grouped field — a SELECT slot
        // starting with it must still be flagged as a missing comma.
        const errs = messages(
            'SELECT CALENDAR_YEAR Name, COUNT(Id) FROM Opportunity GROUP BY CALENDAR_YEAR(CloseDate)'
        );
        expect(errs.some(m => m.startsWith('Missing comma between SELECT fields'))).toBe(true);
    });

    it('still flags a genuine missing comma in an aggregate query (non-grouped head)', () => {
        // "Id Name" is not an alias — Id is not in the GROUP BY list, so an
        // aggregate query must not exempt it from the missing-comma check.
        const errs = messages(
            'SELECT Id Name, COUNT(Id) FROM Account GROUP BY StageName'
        );
        expect(errs.some(m => m.startsWith('Missing comma between SELECT fields'))).toBe(true);
    });

    it('detects aliased duplicates (SELECT Id, Id alias FROM ...)', () => {
        const errs = messages('SELECT Id, Id alias FROM Account');
        expect(errs.some(m => m.startsWith('Duplicate field: Id'))).toBe(true);
    });

    it('ignores LIMIT-like text inside string literals when counting clauses', () => {
        const errs = messages("SELECT Id FROM Account WHERE Name LIKE '(LIMIT 5)' LIMIT 10");
        expect(errs.some(m => m.startsWith('Duplicate LIMIT'))).toBe(false);
    });

    it('detects duplicate top-level clauses', () => {
        expect(messages('SELECT Id FROM Account LIMIT 10 LIMIT 20'))
            .toContain('Duplicate LIMIT clause');
    });

    it('detects duplicate fields that appear after a subquery in the SELECT list', () => {
        // Regression: the old SELECT/FROM regex truncated the clause at the
        // subquery's FROM, so duplicates after the subquery went undetected.
        const errs = messages('SELECT Id, (SELECT Id FROM Contacts), Name, Name FROM Account');
        expect(errs.some(m => m.startsWith('Duplicate field: Name'))).toBe(true);
    });

    it('does not flag TYPEOF polymorphic expressions', () => {
        const q = 'SELECT TYPEOF What WHEN Account THEN Phone WHEN Lead THEN Company ELSE Name END FROM Event';
        expect(messages(q)).toEqual([]);
    });

    it('does not flag a closed string literal that ends in a backslash', () => {
        // SOQL: WHERE Path = 'C:\' AND IsActive = true  (the \\ is one escaped backslash)
        const errs = messages("SELECT Id FROM Account WHERE Path = 'C:\\\\' AND Name != null");
        expect(errs).not.toContain('Unclosed string literal');
    });

    it('does not flag HAVING that appears inside a string literal', () => {
        const errs = messages("SELECT Id FROM Account WHERE Name LIKE '%HAVING%'");
        expect(errs).not.toContain('HAVING requires a GROUP BY clause');
    });

    it('flags a non-numeric LIMIT and accepts a valid LIMIT/OFFSET', () => {
        expect(messages('SELECT Id FROM Account LIMIT abc'))
            .toContain('LIMIT requires a non-negative integer');
        expect(messages('SELECT Id FROM Account LIMIT 10 OFFSET 5')).toEqual([]);
    });

    it('points each duplicate at its own occurrence (3+ duplicates)', () => {
        const q = 'SELECT Id, Id, Id FROM Account';
        const dups = validateSoqlStructure(q).filter(e => e.message === 'Duplicate field: Id');
        expect(dups.length).toBe(2);
        // The two duplicates must land on different columns (2nd and 3rd occurrence).
        expect(new Set(dups.map(d => d.startCol)).size).toBe(2);
    });
});

describe('getQueryContext — subquery & multi-clause awareness', () => {
    it('offers SELECT fields after a child subquery in the field list', () => {
        const query = 'SELECT Id, (SELECT Id FROM Contacts), Nam';
        expect(getQueryContext(query, query.length)).toEqual({ type: 'select_fields', partial: 'Nam' });
    });

    it('still offers SELECT fields after a subquery when an outer FROM follows', () => {
        const query = 'SELECT Id, (SELECT Id FROM Contacts), Name FROM Account';
        const cursor = query.indexOf('Name'); // cursor before "Name", still in the SELECT list
        expect(getQueryContext(query, cursor).type).toBe('select_fields');
    });

    it('offers field names (not just ASC/DESC) for the second ORDER BY field', () => {
        const query = 'SELECT Id FROM Account ORDER BY Name, Crea';
        expect(getQueryContext(query, query.length)).toEqual({ type: 'order_by', partial: 'Crea' });
    });

    it('offers direction after a completed second ORDER BY field', () => {
        const query = 'SELECT Id FROM Account ORDER BY Name, CreatedDate ';
        expect(getQueryContext(query, query.length).type).toBe('order_direction');
    });

    it('treats INCLUDES as an operator (multi-select picklist value context)', () => {
        const query = 'SELECT Id FROM Account WHERE Type INCLUDES ';
        expect(getQueryContext(query, query.length)).toEqual({ type: 'where_value', field: 'Type', partial: '' });
    });

    it('resolves the field next to the cursor in a multi-condition WHERE', () => {
        const query = 'SELECT Id FROM Opportunity WHERE Amount > 100 AND StageName = ';
        expect(getQueryContext(query, query.length)).toEqual({ type: 'where_value', field: 'StageName', partial: '' });
    });

    it('keeps the relationship prefix on the WHERE value field', () => {
        const query = 'SELECT Id FROM Contact WHERE Account.Industry = ';
        expect(getQueryContext(query, query.length)).toEqual({ type: 'where_value', field: 'Account.Industry', partial: '' });
    });
});

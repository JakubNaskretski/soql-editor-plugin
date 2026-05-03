import { describe, expect, it } from 'vitest';
import { applyLimit, buildCountQuery, hasLimitClause, shouldPromptForCount } from './querySafety';

describe('query safety helpers', () => {
    it('detects LIMIT clauses', () => {
        expect(hasLimitClause('SELECT Id FROM Account LIMIT 10')).toBe(true);
        expect(hasLimitClause('SELECT Id FROM Account')).toBe(false);
    });

    it('ignores LIMIT inside subqueries when checking outer LIMIT', () => {
        // Outer query has no LIMIT — the subquery LIMIT must not bypass the COUNT preflight.
        const q = 'SELECT Id, (SELECT Id FROM Contacts LIMIT 1) FROM Account';
        expect(hasLimitClause(q)).toBe(false);
    });

    it('ignores the literal text "limit" inside string literals', () => {
        const q = "SELECT Id FROM Account WHERE Name = 'limit 200'";
        expect(hasLimitClause(q)).toBe(false);
    });

    it('builds COUNT query from main query', () => {
        const query = 'SELECT Id, Name FROM Account WHERE Name != null ORDER BY Name DESC';
        expect(buildCountQuery(query)).toBe('SELECT COUNT() FROM Account WHERE Name != null');
    });

    it('builds a valid COUNT query even when the SELECT contains a subquery', () => {
        const query = 'SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Name != null';
        expect(buildCountQuery(query)).toBe('SELECT COUNT() FROM Account WHERE Name != null');
    });

    it('strips top-level GROUP BY / OFFSET when building COUNT', () => {
        const query = 'SELECT Type, COUNT(Id) FROM Account WHERE IsDeleted = false GROUP BY Type OFFSET 10';
        expect(buildCountQuery(query)).toBe('SELECT COUNT() FROM Account WHERE IsDeleted = false');
    });

    it('applies LIMIT without leaving trailing semicolon artifacts', () => {
        expect(applyLimit('SELECT Id FROM Account;', 200)).toBe('SELECT Id FROM Account LIMIT 200');
    });

    it('replaces an existing top-level LIMIT instead of appending a second one', () => {
        expect(applyLimit('SELECT Id FROM Account LIMIT 10', 50))
            .toBe('SELECT Id FROM Account LIMIT 50');
    });

    it('does not touch a subquery LIMIT when the outer query has none', () => {
        const q = 'SELECT Id, (SELECT Id FROM Contacts LIMIT 1) FROM Account';
        // Outer LIMIT is appended at the end; the subquery LIMIT 1 stays intact.
        expect(applyLimit(q, 200))
            .toBe('SELECT Id, (SELECT Id FROM Contacts LIMIT 1) FROM Account LIMIT 200');
    });

    it('only prompts when row count is large or unknown', () => {
        expect(shouldPromptForCount(10)).toBe(false);
        expect(shouldPromptForCount(5001)).toBe(true);
        expect(shouldPromptForCount('?')).toBe(true);
    });

    it('uses configured warning threshold when provided', () => {
        expect(shouldPromptForCount(100, 50)).toBe(true);
        expect(shouldPromptForCount(100, 500)).toBe(false);
    });
});

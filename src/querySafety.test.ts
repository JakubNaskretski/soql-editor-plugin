import { describe, expect, it } from 'vitest';
import { applyLimit, buildCountQuery, hasLimitClause, shouldPromptForCount } from './querySafety';

describe('query safety helpers', () => {
    it('detects LIMIT clauses', () => {
        expect(hasLimitClause('SELECT Id FROM Account LIMIT 10')).toBe(true);
        expect(hasLimitClause('SELECT Id FROM Account')).toBe(false);
    });

    it('builds COUNT query from main query', () => {
        const query = 'SELECT Id, Name FROM Account WHERE Name != null ORDER BY Name DESC';
        expect(buildCountQuery(query)).toBe('SELECT COUNT() FROM Account WHERE Name != null');
    });

    it('applies LIMIT without leaving trailing semicolon artifacts', () => {
        expect(applyLimit('SELECT Id FROM Account;', 200)).toBe('SELECT Id FROM Account LIMIT 200');
    });

    it('only prompts when row count is large or unknown', () => {
        expect(shouldPromptForCount(10)).toBe(false);
        expect(shouldPromptForCount(5001)).toBe(true);
        expect(shouldPromptForCount('?')).toBe(true);
    });
});

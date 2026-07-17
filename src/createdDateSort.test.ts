import { describe, expect, it } from 'vitest';
import { injectCreatedDateSort } from './createdDateSort';

describe('injectCreatedDateSort', () => {
    it('appends to a plain query', () => {
        const r = injectCreatedDateSort('SELECT Id FROM Account');
        expect(r.applied).toBe(true);
        expect(r.query).toBe('SELECT Id FROM Account ORDER BY CreatedDate DESC');
    });

    it('appends after a WHERE clause and strips a trailing semicolon', () => {
        const r = injectCreatedDateSort("SELECT Id FROM Case WHERE Status = 'New' ;");
        expect(r.applied).toBe(true);
        expect(r.query).toBe("SELECT Id FROM Case WHERE Status = 'New' ORDER BY CreatedDate DESC");
    });

    it('inserts before a top-level LIMIT', () => {
        const r = injectCreatedDateSort('SELECT Id FROM Account LIMIT 10');
        expect(r.applied).toBe(true);
        expect(r.query).toBe('SELECT Id FROM Account ORDER BY CreatedDate DESC LIMIT 10');
    });

    it('inserts before the earliest of LIMIT/OFFSET/FOR', () => {
        const r = injectCreatedDateSort('SELECT Id FROM Account LIMIT 10 OFFSET 5 FOR VIEW');
        expect(r.query).toBe('SELECT Id FROM Account ORDER BY CreatedDate DESC LIMIT 10 OFFSET 5 FOR VIEW');
    });

    it('ignores a LIMIT inside a select-list subquery and appends at the end', () => {
        const r = injectCreatedDateSort('SELECT Id, (SELECT Id FROM Contacts LIMIT 3) FROM Account');
        expect(r.applied).toBe(true);
        expect(r.query).toBe('SELECT Id, (SELECT Id FROM Contacts LIMIT 3) FROM Account ORDER BY CreatedDate DESC');
    });

    it('skips when the outer query already has ORDER BY', () => {
        const r = injectCreatedDateSort('SELECT Id FROM Account ORDER BY Name');
        expect(r.applied).toBe(false);
        expect(r.reason).toContain('ORDER BY');
        expect(r.query).toBe('SELECT Id FROM Account ORDER BY Name');
    });

    it('applies when ORDER BY exists only inside a subquery', () => {
        const r = injectCreatedDateSort('SELECT Id, (SELECT Id FROM Contacts ORDER BY LastName) FROM Account');
        expect(r.applied).toBe(true);
        expect(r.query.endsWith('ORDER BY CreatedDate DESC')).toBe(true);
    });

    it('skips GROUP BY queries', () => {
        const r = injectCreatedDateSort('SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName');
        expect(r.applied).toBe(false);
        expect(r.reason).toContain('GROUP BY');
    });

    it('skips bare COUNT() queries', () => {
        const r = injectCreatedDateSort('SELECT COUNT() FROM Account');
        expect(r.applied).toBe(false);
        expect(r.reason).toContain('COUNT');
    });

    it('skips aggregate selects like SUM(Amount)', () => {
        const r = injectCreatedDateSort('SELECT SUM(Amount) FROM Opportunity');
        expect(r.applied).toBe(false);
        expect(r.reason).toContain('SUM');
    });

    it('skips aggregates wrapped in formatting functions', () => {
        expect(injectCreatedDateSort('SELECT FORMAT(SUM(Amount)) FROM Opportunity').applied).toBe(false);
        expect(injectCreatedDateSort('SELECT convertCurrency(MAX(Amount)) FROM Opportunity').applied).toBe(false);
    });

    it('skips FOR UPDATE queries (ORDER BY not allowed) but still inserts before FOR VIEW', () => {
        const locked = injectCreatedDateSort('SELECT Id FROM Account FOR UPDATE');
        expect(locked.applied).toBe(false);
        expect(locked.reason).toContain('FOR UPDATE');

        const view = injectCreatedDateSort('SELECT Id FROM Account FOR VIEW');
        expect(view.applied).toBe(true);
        expect(view.query).toBe('SELECT Id FROM Account ORDER BY CreatedDate DESC FOR VIEW');
    });

    it('does not mistake Count__c fields or keywords in string literals for aggregates', () => {
        const r = injectCreatedDateSort("SELECT Count__c FROM Thing__c WHERE Name = 'order by limit'");
        expect(r.applied).toBe(true);
        expect(r.query.endsWith('ORDER BY CreatedDate DESC')).toBe(true);
    });

    it('handles keyword phrases split across whitespace/newlines', () => {
        const r = injectCreatedDateSort('SELECT Id FROM Account\nORDER\n  BY Name');
        expect(r.applied).toBe(false);
    });

    it('skips non-queries', () => {
        const r = injectCreatedDateSort('not soql at all');
        expect(r.applied).toBe(false);
        expect(r.query).toBe('not soql at all');
    });
});

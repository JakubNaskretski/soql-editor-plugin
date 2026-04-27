import { describe, expect, it } from 'vitest';
import { extractFromObject, extractSelectFields } from './soqlParser';

describe('extractFromObject', () => {
    it('extracts simple object names', () => {
        const query = 'SELECT Id, Name FROM Account WHERE Name != null';
        expect(extractFromObject(query)).toBe('Account');
    });

    it('returns undefined when FROM is absent', () => {
        expect(extractFromObject('SELECT Id, Name')).toBeUndefined();
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

import { describe, expect, it } from 'vitest';
import { normalizeSObjectApiName } from './sobjectName';

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

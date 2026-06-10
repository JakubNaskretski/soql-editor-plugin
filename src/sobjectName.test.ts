import { describe, expect, it } from 'vitest';
import { normalizeSObjectApiName } from './sobjectName';

describe('normalizeSObjectApiName', () => {
    it('accepts standard SObject names', () => {
        for (const name of ['Account', 'Contact', 'EntityDefinition', 'OpportunityLineItem']) {
            expect(normalizeSObjectApiName(name)).toBe(name);
        }
    });

    it('accepts underscore-segmented names', () => {
        expect(normalizeSObjectApiName('My_Object_Name')).toBe('My_Object_Name');
    });

    it('accepts custom suffixes', () => {
        expect(normalizeSObjectApiName('My_Custom__c')).toBe('My_Custom__c');
        expect(normalizeSObjectApiName('Foo__mdt')).toBe('Foo__mdt');
        expect(normalizeSObjectApiName('Bar__e')).toBe('Bar__e');
        expect(normalizeSObjectApiName('Baz__x')).toBe('Baz__x');
        expect(normalizeSObjectApiName('Qux__b')).toBe('Qux__b');
    });

    it('accepts a single namespace prefix', () => {
        expect(normalizeSObjectApiName('ns__Foo__c')).toBe('ns__Foo__c');
        expect(normalizeSObjectApiName('ns__My_Thing__mdt')).toBe('ns__My_Thing__mdt');
    });

    it('accepts a managed-package namespace containing an underscore', () => {
        // Salesforce namespace prefixes may contain single underscores
        // (e.g. Vlocity's `vlocity_cmt`); the describe gate must not reject them.
        expect(normalizeSObjectApiName('vlocity_cmt__Order__c')).toBe('vlocity_cmt__Order__c');
        expect(normalizeSObjectApiName('vlocity_cmt__OmniProcess__c')).toBe('vlocity_cmt__OmniProcess__c');
        expect(normalizeSObjectApiName('vlocity_cmt__My_Thing__mdt')).toBe('vlocity_cmt__My_Thing__mdt');
        // ...but the underscore-bearing namespace must still reject __r.
        expect(normalizeSObjectApiName('vlocity_cmt__Account__r')).toBeUndefined();
    });

    it('accepts system suffixes without a namespace', () => {
        for (const name of [
            'MyObj__Share', 'MyObj__History', 'MyObj__Feed', 'MyObj__Tag',
            'Knowledge__kav', 'MyModel__dlm', 'MyObj__hd',
        ]) {
            expect(normalizeSObjectApiName(name)).toBe(name);
        }
    });

    it('accepts namespaced system-suffix objects (namespace + body + suffix)', () => {
        // A suffix whitelist used to parse these as a double namespace and
        // reject them, so e.g. a managed package's __Share/__History tables and
        // every Data Cloud DMO (ssot namespace) could never be described.
        for (const name of [
            'ns__MyObj__Share', 'ns__MyObj__History', 'ns__MyObj__Feed',
            'ns__Article__kav', 'ssot__Individual__dlm', 'ns__MyObj__hd',
            'vlocity_cmt__OrderItem__Share', 'vlocity_cmt__OrderItem__History',
        ]) {
            expect(normalizeSObjectApiName(name)).toBe(name);
        }
    });

    it('rejects the relationship suffix __r', () => {
        expect(normalizeSObjectApiName('Account__r')).toBeUndefined();
        expect(normalizeSObjectApiName('My_Custom__r')).toBeUndefined();
    });

    it('rejects multiple namespace separators', () => {
        expect(normalizeSObjectApiName('ns1__ns2__Foo__c')).toBeUndefined();
        expect(normalizeSObjectApiName('Foo__Bar__Baz__c')).toBeUndefined();
    });

    it('rejects path-traversal-ish characters', () => {
        expect(normalizeSObjectApiName('../Account')).toBeUndefined();
        expect(normalizeSObjectApiName('Account/Other')).toBeUndefined();
        expect(normalizeSObjectApiName('Account\\Other')).toBeUndefined();
    });

    it('rejects empty / whitespace input', () => {
        expect(normalizeSObjectApiName('')).toBeUndefined();
        expect(normalizeSObjectApiName('   ')).toBeUndefined();
    });

    it('rejects names starting with digit', () => {
        expect(normalizeSObjectApiName('1Account')).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
        expect(normalizeSObjectApiName('  Account  ')).toBe('Account');
    });
});

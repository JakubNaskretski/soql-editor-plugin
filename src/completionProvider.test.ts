import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => {
    class CompletionItem {
        label: string;
        kind: number;
        detail?: string;
        insertText: any;
        sortText?: string;
        documentation?: any;
        command?: any;
        constructor(label: string, kind: number) {
            this.label = label;
            this.kind = kind;
            this.insertText = label;
        }
    }
    class MarkdownString {
        value: string;
        constructor(value: string) {
            this.value = value;
        }
    }
    class SnippetString {
        value: string;
        constructor(value: string) {
            this.value = value;
        }
    }
    return {
        CompletionItem,
        MarkdownString,
        SnippetString,
        CompletionItemKind: {
            Class: 1,
            Field: 2,
            Reference: 3,
            Snippet: 4,
            EnumMember: 5,
            Keyword: 6,
            Operator: 7,
            Function: 8,
            Value: 9,
        },
    };
});

import { SoqlCompletionProvider } from './completionProvider';

describe('SoqlCompletionProvider', () => {
    let provider: SoqlCompletionProvider;
    let metadata: any;

    beforeEach(() => {
        metadata = {
            getObjectList: vi.fn(async () => ['Account', 'Contact', 'Lead']),
            describeSObject: vi.fn(async () => ({
                fields: [
                    { name: 'Id', label: 'Id', type: 'id', nillable: false, referenceTo: [], relationshipName: undefined, picklistValues: [] },
                    { name: 'AccountId', label: 'Account ID', type: 'reference', nillable: true, referenceTo: ['Account'], relationshipName: 'Account', picklistValues: [] },
                    { name: 'Name', label: 'Name', type: 'string', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [] },
                ],
                childRelationships: [],
            })),
        };
        provider = new SoqlCompletionProvider(metadata);
    });

    it('suggests Contact for FROM Con', async () => {
        const document = {
            getText: () => 'SELECT Id FROM Con',
            offsetAt: () => 18,
        } as any;
        const position = {} as any;
        const items = await provider.provideCompletionItems(document, position, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        expect(labels).toContain('Contact');
    });

    it('suggests ORDER BY direction helpers', async () => {
        const document = {
            getText: () => 'SELECT Id FROM Account ORDER BY Name D',
            offsetAt: () => 37,
        } as any;
        const position = {} as any;
        const items = await provider.provideCompletionItems(document, position, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        expect(labels).toContain('DESC');
    });

    it('uses fallback objects when metadata returns none', async () => {
        metadata.getObjectList = vi.fn(async () => []);
        provider = new SoqlCompletionProvider(metadata);
        const document = {
            getText: () => 'SELECT Id FROM ',
            offsetAt: () => 15,
        } as any;
        const items = await provider.provideCompletionItems(document, {} as any, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        expect(labels).toContain('Contact');
    });

    it('offers picklist values for a relationship-qualified WHERE field', async () => {
        // Contact has AccountId → Account; Account.Industry is a picklist. The
        // WHERE value should resolve through the relationship to Account's field.
        metadata.describeSObject = vi.fn(async (name: string) => {
            if (name.toLowerCase() === 'account') {
                return {
                    fields: [
                        { name: 'Industry', label: 'Industry', type: 'picklist', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [{ label: 'Technology', value: 'Technology' }] },
                    ],
                    childRelationships: [],
                };
            }
            return {
                fields: [
                    { name: 'Id', label: 'Id', type: 'id', nillable: false, referenceTo: [], relationshipName: undefined, picklistValues: [] },
                    { name: 'AccountId', label: 'Account ID', type: 'reference', nillable: true, referenceTo: ['Account'], relationshipName: 'Account', picklistValues: [] },
                ],
                childRelationships: [],
            };
        });
        provider = new SoqlCompletionProvider(metadata);
        const text = 'SELECT Id FROM Contact WHERE Account.Industry = ';
        const document = { getText: () => text, offsetAt: () => text.length } as any;
        const items = await provider.provideCompletionItems(document, {} as any, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        expect(labels).toContain('Technology');
    });

    it('ranks relationship traversal with its foreign-key field', async () => {
        const document = {
            getText: () => 'SELECT Acc FROM Contact',
            offsetAt: () => 10,
        } as any;
        const items = await provider.provideCompletionItems(document, {} as any, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        const accountIdIdx = labels.indexOf('AccountId');
        const accountRelIdx = labels.indexOf('Account.');
        expect(accountIdIdx).toBeGreaterThanOrEqual(0);
        expect(accountRelIdx).toBe(accountIdIdx + 1);
    });

    it('completes fields of the target object after a relationship dot', async () => {
        // `SELECT Account.Na` on Contact must resolve the Account hop and offer
        // Account's Name — previously the dotted partial matched nothing.
        const text = 'SELECT Account.Na FROM Contact';
        const document = { getText: () => text, offsetAt: () => 17 } as any;
        const items = await provider.provideCompletionItems(document, {} as any, {} as any, {} as any);
        const named = items.find((i: any) => i.label === 'Name');
        expect(named).toBeDefined();
        // Only the segment after the dot is inserted (VS Code's word range
        // never spans the dot).
        expect(named!.insertText).toBe('Name');
    });

    it('suggests child relationship names (not SObject names) in a subquery FROM', async () => {
        metadata.describeSObject = vi.fn(async () => ({
            name: 'Account',
            fields: [],
            childRelationships: [
                { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' },
            ],
        }));
        provider = new SoqlCompletionProvider(metadata);
        const text = 'SELECT Id, (SELECT Id FROM Con) FROM Account';
        const document = { getText: () => text, offsetAt: () => 30 } as any;
        const items = await provider.provideCompletionItems(document, {} as any, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        expect(labels).toContain('Contacts');
    });

    it('prefers User over Group when traversing a polymorphic Owner lookup', async () => {
        metadata.describeSObject = vi.fn(async (name: string) => {
            const key = name.toLowerCase();
            if (key === 'user') {
                return {
                    name: 'User',
                    fields: [
                        { name: 'UserType', label: 'User Type', type: 'picklist', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [{ label: 'Standard', value: 'Standard' }] },
                    ],
                    childRelationships: [],
                };
            }
            if (key === 'group') {
                return { name: 'Group', fields: [], childRelationships: [] };
            }
            return {
                name: 'Case',
                fields: [
                    { name: 'OwnerId', label: 'Owner ID', type: 'reference', nillable: false, referenceTo: ['Group', 'User'], relationshipName: 'Owner', picklistValues: [] },
                ],
                childRelationships: [],
            };
        });
        provider = new SoqlCompletionProvider(metadata);
        const text = 'SELECT Id FROM Case WHERE Owner.UserType = ';
        const document = { getText: () => text, offsetAt: () => text.length } as any;
        const items = await provider.provideCompletionItems(document, {} as any, {} as any, {} as any);
        const labels = items.map((i: any) => i.label);
        // referenceTo is [Group, User]; picking referenceTo[0] would resolve
        // Group (no UserType) and the picklist value would be missing.
        expect(labels).toContain('Standard');
    });

    it('hides non-filterable fields in WHERE but keeps them in SELECT', async () => {
        metadata.describeSObject = vi.fn(async () => ({
            name: 'Account',
            fields: [
                { name: 'Description', label: 'Description', type: 'textarea', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [], filterable: false },
                { name: 'DescCode', label: 'Desc Code', type: 'string', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [] },
            ],
            childRelationships: [],
        }));
        provider = new SoqlCompletionProvider(metadata);

        const whereText = 'SELECT Id FROM Account WHERE Desc';
        const whereDoc = { getText: () => whereText, offsetAt: () => whereText.length } as any;
        const whereItems = await provider.provideCompletionItems(whereDoc, {} as any, {} as any, {} as any);
        const whereLabels = whereItems.map((i: any) => i.label);
        expect(whereLabels).toContain('DescCode');
        expect(whereLabels).not.toContain('Description');

        const selectText = 'SELECT Desc FROM Account';
        const selectDoc = { getText: () => selectText, offsetAt: () => 11 } as any;
        const selectItems = await provider.provideCompletionItems(selectDoc, {} as any, {} as any, {} as any);
        const selectLabels = selectItems.map((i: any) => i.label);
        expect(selectLabels).toContain('Description');
    });
});

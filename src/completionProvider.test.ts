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
});

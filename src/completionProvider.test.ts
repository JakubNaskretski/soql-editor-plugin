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
        range?: any;
        constructor(label: string, kind: number) {
            this.label = label;
            this.kind = kind;
            this.insertText = label;
        }
    }
    class CompletionList {
        items: any[];
        isIncomplete: boolean;
        constructor(items: any[], isIncomplete: boolean) {
            this.items = items;
            this.isIncomplete = isIncomplete;
        }
    }
    class Range {
        constructor(public start: any, public end: any) {}
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
        CompletionList,
        Range,
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

// Positions are plain offsets here (positionAt is the identity), so a range's
// start/end can be compared with offsets directly.
const rangeOf = (item: any) => item.range as { start: number; end: number };

function doc(text: string, offset: number) {
    return { getText: () => text, offsetAt: () => offset, positionAt: (o: number) => o } as any;
}

describe('SoqlCompletionProvider', () => {
    let provider: SoqlCompletionProvider;
    let metadata: any;

    async function complete(text: string, offset: number = text.length) {
        return provider.provideCompletionItems(doc(text, offset), offset as any, { isCancellationRequested: false } as any, {} as any);
    }
    async function labels(text: string, offset: number = text.length): Promise<string[]> {
        return (await complete(text, offset)).items.map((i: any) => i.label);
    }

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
        expect(await labels('SELECT Id FROM Con')).toContain('Contact');
    });

    it('suggests ORDER BY direction helpers', async () => {
        expect(await labels('SELECT Id FROM Account ORDER BY Name D')).toContain('DESC');
    });

    it('uses fallback objects when metadata returns none', async () => {
        metadata.getObjectList = vi.fn(async () => []);
        provider = new SoqlCompletionProvider(metadata);
        expect(await labels('SELECT Id FROM ')).toContain('Contact');
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
        expect(await labels('SELECT Id FROM Contact WHERE Account.Industry = ')).toContain('Technology');
    });

    it('inserts a bare picklist value inside an open quote, replacing the typed text since the quote', async () => {
        metadata.describeSObject = vi.fn(async () => ({
            fields: [
                { name: 'Industry', label: 'Industry', type: 'picklist', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [{ label: 'Technology', value: 'Technology' }] },
            ],
            childRelationships: [],
        }));
        provider = new SoqlCompletionProvider(metadata);
        const text = "SELECT Id FROM Account WHERE Industry = 'Tec";
        const { items } = await complete(text);
        expect(items.map((i: any) => i.label)).toEqual(['Technology']);
        expect(items[0].insertText).toBe('Technology');
        expect(rangeOf(items[0]).start).toBe(text.indexOf("'") + 1);
        expect(rangeOf(items[0]).end).toBe(text.length);
    });

    it('ranks relationship traversal with its foreign-key field', async () => {
        const found = await labels('SELECT Acc FROM Contact', 10);
        const accountIdIdx = found.indexOf('AccountId');
        const accountRelIdx = found.indexOf('Account.');
        expect(accountIdIdx).toBeGreaterThanOrEqual(0);
        expect(accountRelIdx).toBe(accountIdIdx + 1);
    });

    it('completes fields of the target object after a relationship dot, replacing only the last segment', async () => {
        // `SELECT Account.Na` on Contact must resolve the Account hop and offer
        // Account's Name. The item's range must cover only `Na`: the SOQL
        // wordPattern spans dots, so without an explicit range VS Code filtered
        // every bare field label against `Account.Na` and showed nothing.
        const text = 'SELECT Account.Na FROM Contact';
        const { items } = await complete(text, 17);
        const named = items.find((i: any) => i.label === 'Name');
        expect(named).toBeDefined();
        expect(named!.insertText).toBe('Name');
        expect(rangeOf(named).start).toBe(15);
        expect(rangeOf(named).end).toBe(17);
    });

    it('returns an incomplete list so VS Code re-queries on every keystroke', async () => {
        // Field lists are capped/gated on the partial; a complete (client-side
        // refiltered) list emptied and cancelled the session when typing in front
        // of an existing field, e.g. `SELECT Id, Cr▌Name`.
        const text = 'SELECT Id, CrName FROM Account';
        const list = await complete(text, 13);
        expect(list.isIncomplete).toBe(true);
        expect(list.items.every((i: any) => i.range.start === 11 && i.range.end === 13)).toBe(true);
    });

    it('replaces the identifier before the caret for keyword completions without a query context', async () => {
        const { items } = await complete('SEL');
        const select = items.find((i: any) => i.label === 'SELECT');
        expect(select).toBeDefined();
        expect(rangeOf(select).start).toBe(0);
        expect(rangeOf(select).end).toBe(3);
    });

    it('replaces the digits of a LIMIT value', async () => {
        const text = 'SELECT Id FROM Account LIMIT 1';
        const { items } = await complete(text);
        expect(items.map((i: any) => i.label)).toContain('10');
        expect(rangeOf(items[0]).start).toBe(text.length - 1);
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
        expect(await labels('SELECT Id, (SELECT Id FROM Con) FROM Account', 30)).toContain('Contacts');
    });

    it('resolves a doubly nested subquery through each parent scope', async () => {
        // Account → Contacts (Contact) → Tasks (Task). The old resolver re-read the
        // scope at the parent's SELECT index, which is the GRANDPARENT scope, so it
        // looked for a `Tasks` relationship on Account and described "Tasks".
        const describes: Record<string, any> = {
            account: { name: 'Account', fields: [], childRelationships: [{ childSObject: 'Contact', relationshipName: 'Contacts' }] },
            contact: { name: 'Contact', fields: [], childRelationships: [{ childSObject: 'Task', relationshipName: 'Tasks' }] },
            task: { name: 'Task', fields: [{ name: 'Subject', label: 'Subject', type: 'string', nillable: true, referenceTo: [], relationshipName: undefined, picklistValues: [] }], childRelationships: [] },
        };
        metadata.describeSObject = vi.fn(async (name: string) => describes[name.toLowerCase()]);
        provider = new SoqlCompletionProvider(metadata);
        const text = 'SELECT Id, (SELECT Id, (SELECT Su FROM Tasks) FROM Contacts) FROM Account';
        expect(await labels(text, text.indexOf('Su') + 2)).toContain('Subject');
        expect(metadata.describeSObject.mock.calls.map((c: any[]) => c[0])).not.toContain('Tasks');
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
        // referenceTo is [Group, User]; picking referenceTo[0] would resolve
        // Group (no UserType) and the picklist value would be missing.
        expect(await labels('SELECT Id FROM Case WHERE Owner.UserType = ')).toContain('Standard');
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

        const whereLabels = await labels('SELECT Id FROM Account WHERE Desc');
        expect(whereLabels).toContain('DescCode');
        expect(whereLabels).not.toContain('Description');

        expect(await labels('SELECT Desc FROM Account', 11)).toContain('Description');
    });
});

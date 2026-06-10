import { describe, expect, it, vi } from 'vitest';

// panelSuggestions has no direct vscode dependency, but its MetadataProvider
// import chain loads modules that import 'vscode' at module level.
vi.mock('vscode', () => ({}));

import { getSuggestions } from './panelSuggestions';

function makeMetadata(describes: Record<string, any>) {
    return {
        getObjectList: vi.fn(async () => Object.keys(describes)),
        describeSObject: vi.fn(async (name: string) => describes[name.toLowerCase()]),
    } as any;
}

describe('panel getSuggestions — object-type coverage', () => {
    it('prefers User over Group when resolving a polymorphic Owner path', async () => {
        const metadata = makeMetadata({
            case: {
                name: 'Case',
                fields: [
                    { name: 'OwnerId', label: 'Owner ID', type: 'reference', nillable: false, referenceTo: ['Group', 'User'], relationshipName: 'Owner', picklistValues: [] },
                ],
                childRelationships: [],
            },
            user: {
                name: 'User',
                fields: [
                    { name: 'UserType', label: 'User Type', type: 'picklist', nillable: true, referenceTo: [], relationshipName: null, picklistValues: [{ label: 'Standard', value: 'Standard' }] },
                ],
                childRelationships: [],
            },
            group: { name: 'Group', fields: [], childRelationships: [] },
        });

        const text = 'SELECT Id FROM Case WHERE Owner.UserType = ';
        const suggestions = await getSuggestions(text, text.length, metadata);
        expect(suggestions.map(s => s.label)).toContain('Standard');
    });

    it('hides non-sortable fields in ORDER BY but keeps sortable ones', async () => {
        const metadata = makeMetadata({
            account: {
                name: 'Account',
                fields: [
                    { name: 'Name', label: 'Name', type: 'string', nillable: true, referenceTo: [], relationshipName: null, picklistValues: [] },
                    { name: 'Notes', label: 'Notes', type: 'textarea', nillable: true, referenceTo: [], relationshipName: null, picklistValues: [], sortable: false },
                ],
                childRelationships: [],
            },
        });

        const text = 'SELECT Id FROM Account ORDER BY N';
        const suggestions = await getSuggestions(text, text.length, metadata);
        const labels = suggestions.map(s => s.label);
        expect(labels).toContain('Name');
        expect(labels).not.toContain('Notes');
    });

    it('keeps capability-flagged fields in SELECT (flags only gate clause usage)', async () => {
        const metadata = makeMetadata({
            account: {
                name: 'Account',
                fields: [
                    { name: 'Name', label: 'Name', type: 'string', nillable: true, referenceTo: [], relationshipName: null, picklistValues: [] },
                    { name: 'Notes', label: 'Notes', type: 'textarea', nillable: true, referenceTo: [], relationshipName: null, picklistValues: [], sortable: false, filterable: false },
                ],
                childRelationships: [],
            },
        });

        const text = 'SELECT N FROM Account';
        const suggestions = await getSuggestions(text, 8, metadata);
        const labels = suggestions.map(s => s.label);
        expect(labels).toContain('Name');
        expect(labels).toContain('Notes');
    });
});

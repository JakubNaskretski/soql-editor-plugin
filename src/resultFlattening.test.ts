import { describe, expect, it } from 'vitest';
import { flattenRecordForDisplay } from './resultFlattening';

describe('flattenRecordForDisplay', () => {
    it('flattens nested parent relationship objects into dotted keys', () => {
        const record = {
            Id: '001000000000001AAA',
            Name: 'Acme',
            Owner: {
                attributes: { type: 'User', url: '/services/data/vXX.X/sobjects/User/005...' },
                Name: 'Alice Admin',
                Manager: {
                    attributes: { type: 'User', url: '/services/data/vXX.X/sobjects/User/005...' },
                    Name: 'Marty Manager',
                },
            },
        };

        expect(flattenRecordForDisplay(record)).toEqual({
            Id: '001000000000001AAA',
            Name: 'Acme',
            'Owner.Name': 'Alice Admin',
            'Owner.Manager.Name': 'Marty Manager',
        });
    });

    it('keeps child subquery payloads as compact json', () => {
        const record = {
            Name: 'Acme',
            Contacts: {
                totalSize: 2,
                done: true,
                records: [
                    { attributes: { type: 'Contact' }, LastName: 'Doe' },
                    { attributes: { type: 'Contact' }, LastName: 'Roe' },
                ],
            },
        };

        const flattened = flattenRecordForDisplay(record);
        expect(flattened.Name).toBe('Acme');
        expect(flattened.Contacts).toContain('"totalSize":2');
        expect(flattened.Contacts).toContain('"records"');
        expect(flattened).not.toHaveProperty('Contacts.records.0.LastName');
    });

    it('normalizes null/undefined and handles empty nested objects', () => {
        const record = {
            Parent: {},
            Owner: undefined,
            ParentOwner: null,
        };

        expect(flattenRecordForDisplay(record)).toEqual({
            Parent: '{}',
            Owner: 'null',
            ParentOwner: 'null',
        });
    });
});

import { describe, expect, it } from 'vitest';
import { tabIndexForRunId, RoutableTab } from './tabRouting';

const tabs = (...ids: number[]): RoutableTab[] => ids.map(id => ({ id }));

describe('tabIndexForRunId', () => {
    it('finds the tab index by stable id', () => {
        expect(tabIndexForRunId(tabs(10, 11, 12), 11)).toBe(1);
        expect(tabIndexForRunId(tabs(10, 11, 12), 10)).toBe(0);
        expect(tabIndexForRunId(tabs(10, 11, 12), 12)).toBe(2);
    });

    it('is robust to array reordering — routes by id, not position', () => {
        // Tab that started the run was id 12; it is now at index 0 after a close.
        expect(tabIndexForRunId(tabs(12, 10), 12)).toBe(0);
    });

    it('returns -1 when the originating tab was closed (id gone)', () => {
        expect(tabIndexForRunId(tabs(10, 12), 11)).toBe(-1);
    });

    it('returns -1 for an unstamped message (undefined / null run id)', () => {
        expect(tabIndexForRunId(tabs(10, 11), undefined)).toBe(-1);
        // null guarded too (JSON round-trips can null-ify a missing field).
        expect(tabIndexForRunId(tabs(10, 11), null as unknown as undefined)).toBe(-1);
    });

    it('returns -1 on an empty tab list', () => {
        expect(tabIndexForRunId([], 10)).toBe(-1);
    });
});

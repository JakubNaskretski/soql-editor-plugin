import { describe, expect, it } from 'vitest';
import {
    HISTORY_LIMIT,
    pushHistoryEntry,
    sanitizeHistory,
    QueryHistoryStore,
    QueryHistoryEntry,
    HistoryMemento,
} from './queryHistory';

describe('pushHistoryEntry', () => {
    it('prepends a new query most-recent-first', () => {
        const a = pushHistoryEntry([], 'SELECT Id FROM Account', 1);
        const b = pushHistoryEntry(a, 'SELECT Id FROM Contact', 2);
        expect(b.map(e => e.query)).toEqual([
            'SELECT Id FROM Contact',
            'SELECT Id FROM Account',
        ]);
        expect(b[0].ts).toBe(2);
    });

    it('trims the stored query but keeps internal whitespace', () => {
        const out = pushHistoryEntry([], '  SELECT Id,\n Name FROM Account  ', 1);
        expect(out[0].query).toBe('SELECT Id,\n Name FROM Account');
    });

    it('ignores a whitespace-only query (returns a copy of the list)', () => {
        const existing: QueryHistoryEntry[] = [{ query: 'SELECT Id FROM Account', ts: 1 }];
        const out = pushHistoryEntry(existing, '   \n ', 2);
        expect(out).toEqual(existing);
        expect(out).not.toBe(existing); // pure — new array
    });

    it('de-duplicates a repeat by moving it to the front with the new ts', () => {
        let h = pushHistoryEntry([], 'SELECT Id FROM Account', 1);
        h = pushHistoryEntry(h, 'SELECT Id FROM Contact', 2);
        h = pushHistoryEntry(h, 'SELECT Id FROM Account', 3); // repeat of the first
        expect(h.map(e => e.query)).toEqual([
            'SELECT Id FROM Account',
            'SELECT Id FROM Contact',
        ]);
        expect(h[0].ts).toBe(3);
        expect(h.length).toBe(2); // no duplicate entry
    });

    it('treats a trimmed repeat as a duplicate of the trimmed original', () => {
        let h = pushHistoryEntry([], 'SELECT Id FROM Account', 1);
        h = pushHistoryEntry(h, '  SELECT Id FROM Account  ', 2);
        expect(h.length).toBe(1);
        expect(h[0].ts).toBe(2);
    });

    it('caps the history at the limit (drops the oldest)', () => {
        let h: QueryHistoryEntry[] = [];
        for (let i = 0; i < HISTORY_LIMIT + 10; i++) {
            h = pushHistoryEntry(h, `SELECT Id FROM Obj${i}`, i);
        }
        expect(h.length).toBe(HISTORY_LIMIT);
        // Most recent is the last pushed; the oldest survivors are trimmed off.
        expect(h[0].query).toBe(`SELECT Id FROM Obj${HISTORY_LIMIT + 9}`);
        expect(h.some(e => e.query === 'SELECT Id FROM Obj0')).toBe(false);
    });

    it('does not mutate the input array', () => {
        const existing: QueryHistoryEntry[] = [{ query: 'A', ts: 1 }];
        const out = pushHistoryEntry(existing, 'B', 2);
        expect(existing).toEqual([{ query: 'A', ts: 1 }]);
        expect(out).not.toBe(existing);
    });
});

describe('sanitizeHistory', () => {
    it('returns [] for non-array input', () => {
        expect(sanitizeHistory(undefined)).toEqual([]);
        expect(sanitizeHistory(null)).toEqual([]);
        expect(sanitizeHistory({ query: 'x', ts: 1 })).toEqual([]);
    });

    it('drops malformed entries and keeps well-formed ones', () => {
        const raw = [
            { query: 'SELECT Id FROM Account', ts: 5 },
            { query: 'no ts' },
            { ts: 3 },
            { query: 42, ts: 1 },
            null,
            'nope',
            { query: 'SELECT Id FROM Contact', ts: 6 },
        ];
        expect(sanitizeHistory(raw)).toEqual([
            { query: 'SELECT Id FROM Account', ts: 5 },
            { query: 'SELECT Id FROM Contact', ts: 6 },
        ]);
    });
});

// In-memory Memento double for the store.
function fakeMemento(): HistoryMemento & { store: Map<string, unknown> } {
    const store = new Map<string, unknown>();
    return {
        store,
        get<T>(key: string): T | undefined { return store.get(key) as T | undefined; },
        update(key: string, value: unknown): Thenable<void> {
            if (value === undefined) { store.delete(key); } else { store.set(key, value); }
            return Promise.resolve();
        },
    };
}

describe('QueryHistoryStore', () => {
    it('keeps history independent per org', async () => {
        const store = new QueryHistoryStore(fakeMemento());
        await store.add('a@example.com', 'SELECT Id FROM Account', 1);
        await store.add('b@example.com', 'SELECT Id FROM Contact', 2);
        expect(store.list('a@example.com').map(e => e.query)).toEqual(['SELECT Id FROM Account']);
        expect(store.list('b@example.com').map(e => e.query)).toEqual(['SELECT Id FROM Contact']);
    });

    it('does not record without an org or with an empty query', async () => {
        const store = new QueryHistoryStore(fakeMemento());
        await store.add(undefined, 'SELECT Id FROM Account', 1);
        await store.add('a@example.com', '   ', 1);
        expect(store.list(undefined)).toEqual([]);
        expect(store.list('a@example.com')).toEqual([]);
    });

    it('persists and clears', async () => {
        const store = new QueryHistoryStore(fakeMemento());
        await store.add('a@example.com', 'SELECT Id FROM Account', 1);
        expect(store.list('a@example.com').length).toBe(1);
        await store.clear('a@example.com');
        expect(store.list('a@example.com')).toEqual([]);
    });

    it('honours a custom limit', async () => {
        const store = new QueryHistoryStore(fakeMemento(), 2);
        await store.add('a@example.com', 'q1', 1);
        await store.add('a@example.com', 'q2', 2);
        await store.add('a@example.com', 'q3', 3);
        expect(store.list('a@example.com').map(e => e.query)).toEqual(['q3', 'q2']);
    });
});

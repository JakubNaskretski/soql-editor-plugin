import { describe, expect, it, vi } from 'vitest';

// queryExecutor imports 'vscode'; the helper under test is pure, so a minimal
// mock lets the import resolve without instantiating the class.
vi.mock('vscode', () => ({}));

import { lineColumnToOffset } from './queryExecutor';

describe('lineColumnToOffset', () => {
    it('maps a single-line position (1-based) to a 0-based offset', () => {
        const q = 'SELECT Naem FROM Account';
        // Salesforce reports the bad field "Naem" at Row:1:Column:8 → the 'N'.
        const offset = lineColumnToOffset(q, 1, 8);
        expect(offset).toBe(7);
        expect(q[offset]).toBe('N');
        expect(q.slice(offset, offset + 4)).toBe('Naem');
    });

    it('accounts for preceding lines (and their newlines)', () => {
        const q = 'SELECT Id,\n       Naem\nFROM Account';
        // "Naem" is on line 2, starting at column 8.
        const offset = lineColumnToOffset(q, 2, 8);
        expect(q.slice(offset, offset + 4)).toBe('Naem');
    });

    it('clamps a column past the end of the text', () => {
        const q = 'SELECT Id';
        expect(lineColumnToOffset(q, 1, 999)).toBe(q.length);
    });

    it('clamps a line past the end of the text', () => {
        const q = 'SELECT Id\nFROM Account';
        const offset = lineColumnToOffset(q, 99, 1);
        expect(offset).toBeLessThanOrEqual(q.length);
    });

    it('treats column 1 as offset 0 on line 1', () => {
        expect(lineColumnToOffset('SELECT Id', 1, 1)).toBe(0);
    });
});

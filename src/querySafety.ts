/** Guardrails for large-query execution and LIMIT/COUNT helpers. */
import { findKeywordHits, extractTopLevelFromObject } from './soqlParser';

export const AUTO_EXECUTE_COUNT_THRESHOLD = 5000;

/**
 * True only when the OUTER (depth-0) query has a LIMIT clause.
 * Subquery LIMITs and the literal text "limit" inside string literals are
 * intentionally ignored — they do not bound the outer query.
 */
export function hasLimitClause(query: string): boolean {
    const hits = findKeywordHits(query, 'LIMIT').filter(h => h.depth === 0);
    if (hits.length === 0) { return false; }
    return hits.some(h => /^\s*\d+/.test(query.slice(h.index + h.length)));
}

/**
 * Build a COUNT() preflight query for the OUTER query only.
 * - Replaces the top-level SELECT field list with `SELECT COUNT()`
 * - Strips top-level ORDER BY / GROUP BY / OFFSET (invalid with COUNT())
 * - Preserves WHERE and any subqueries used in WHERE filters
 *
 * Returns null when the outer query has no recognizable FROM clause.
 */
export function buildCountQuery(query: string): string | null {
    const fromHits = findKeywordHits(query, 'FROM').filter(h => h.depth === 0);
    if (fromHits.length === 0) { return null; }
    const selectHits = findKeywordHits(query, 'SELECT').filter(h => h.depth === 0);
    if (selectHits.length === 0) { return null; }

    // Use the first top-level SELECT/FROM pair.
    const selectHit = selectHits[0];
    const fromHit = fromHits.find(h => h.index > selectHit.index);
    if (!fromHit) { return null; }

    // Capture from FROM up to the first top-level clause that COUNT() can't keep.
    const stripStarters = ['ORDER BY', 'GROUP BY', 'OFFSET'];
    let tailEnd = query.length;
    for (const phrase of stripStarters) {
        const phraseHits = findKeywordHits(query, phrase).filter(h => h.depth === 0 && h.index > fromHit.index);
        if (phraseHits.length > 0) {
            tailEnd = Math.min(tailEnd, phraseHits[0].index);
        }
    }

    const fromTail = query.slice(fromHit.index + fromHit.length, tailEnd)
        .trim()
        .replace(/\s*;?\s*$/, '');
    if (!fromTail) { return null; }
    return `SELECT COUNT() FROM ${fromTail}`;
}

/**
 * Apply a LIMIT to the outer query. If a top-level LIMIT already exists,
 * its numeric value is replaced; otherwise LIMIT is appended at the end.
 * Subquery LIMITs are never modified.
 */
export function applyLimit(query: string, limit: number): string {
    const trimmed = query.replace(/\s*;?\s*$/, '');
    const hits = findKeywordHits(trimmed, 'LIMIT').filter(h => h.depth === 0);
    if (hits.length > 0) {
        const last = hits[hits.length - 1];
        const after = trimmed.slice(last.index + last.length);
        const numberMatch = after.match(/^\s*\d+/);
        if (numberMatch) {
            const before = trimmed.slice(0, last.index + last.length);
            const rest = after.slice(numberMatch[0].length);
            return `${before} ${limit}${rest}`;
        }
    }
    return `${trimmed} LIMIT ${limit}`;
}

export function shouldPromptForCount(totalRows: unknown, threshold: number = AUTO_EXECUTE_COUNT_THRESHOLD): boolean {
    const rowCount = typeof totalRows === 'number' ? totalRows : parseInt(String(totalRows), 10);
    if (Number.isNaN(rowCount)) { return true; }
    return rowCount > threshold;
}

// Re-export so existing callers that imported from querySafety keep working.
export { extractTopLevelFromObject };

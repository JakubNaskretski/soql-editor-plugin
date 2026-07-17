/**
 * Opt-in "Newest first" execution modifier: inject `ORDER BY CreatedDate DESC`
 * into the outer query when it is legal to do so. The editor text and query
 * history are never rewritten — this applies to the executed string only.
 */
import { findKeywordHits } from './soqlParser';

export interface CreatedDateSortResult {
    query: string;
    applied: boolean;
    /** Set when not applied — surfaced in the panel console so the checkbox
     *  never silently does nothing. */
    reason?: string;
}

const ORDER_BY_CLAUSE = 'ORDER BY CreatedDate DESC';

/** Aggregate calls that make an un-grouped `ORDER BY CreatedDate` illegal. */
const AGGREGATE_FNS = ['COUNT', 'COUNT_DISTINCT', 'SUM', 'AVG', 'MIN', 'MAX'];

export function injectCreatedDateSort(query: string): CreatedDateSortResult {
    const skip = (reason: string): CreatedDateSortResult => ({ query, applied: false, reason });

    const selectHits = findKeywordHits(query, 'SELECT').filter(h => h.depth === 0);
    const fromHits = findKeywordHits(query, 'FROM').filter(h => h.depth === 0);
    const selectHit = selectHits[0];
    const fromHit = selectHit && fromHits.find(h => h.index > selectHit.index);
    if (!selectHit || !fromHit) { return skip('no outer SELECT … FROM found'); }

    if (findKeywordHits(query, 'ORDER BY').some(h => h.depth === 0)) {
        return skip('the query has its own ORDER BY');
    }
    if (findKeywordHits(query, 'GROUP BY').some(h => h.depth === 0)) {
        return skip('aggregate query (GROUP BY)');
    }
    // Aggregate anywhere in the OUTER select list — including wrapped forms like
    // FORMAT(SUM(Amount)) at depth ≥ 1: Salesforce rejects an ORDER BY on a
    // non-grouped field there. An aggregate inside a child-relationship subquery
    // would match too, but those are invalid SOQL regardless, so skipping loses
    // nothing.
    for (const fn of AGGREGATE_FNS) {
        const isAggregateCall = findKeywordHits(query, fn).some(h =>
            h.index > selectHit.index + selectHit.length
            && h.index < fromHit.index
            && /^\s*\(/.test(query.slice(h.index + h.length))
        );
        if (isAggregateCall) { return skip(`aggregate query (${fn})`); }
    }

    // FOR UPDATE locks row order and prohibits ORDER BY outright.
    if (findKeywordHits(query, 'FOR UPDATE').some(h => h.depth === 0)) {
        return skip('FOR UPDATE query (ORDER BY is not allowed)');
    }

    // ORDER BY belongs before any top-level LIMIT / OFFSET / FOR clause.
    // Subquery clauses sit at depth ≥ 1 and never match here.
    let insertAt = -1;
    for (const phrase of ['LIMIT', 'OFFSET', 'FOR']) {
        const hit = findKeywordHits(query, phrase).find(h => h.depth === 0 && h.index > fromHit.index);
        if (hit && (insertAt === -1 || hit.index < insertAt)) { insertAt = hit.index; }
    }

    if (insertAt === -1) {
        return { query: `${query.replace(/\s*;?\s*$/, '')} ${ORDER_BY_CLAUSE}`, applied: true };
    }
    return {
        query: `${query.slice(0, insertAt).trimEnd()} ${ORDER_BY_CLAUSE} ${query.slice(insertAt)}`,
        applied: true,
    };
}

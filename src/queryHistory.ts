/**
 * Per-org SOQL query history: a bounded, most-recent-first ring buffer persisted
 * in the extension's globalState.
 *
 * The reducer (`pushHistoryEntry`) is a pure function over the entry array so it
 * can be unit tested without vscode; `QueryHistoryStore` is the thin
 * globalState-backed wrapper the extension actually uses. History is keyed per
 * org username — different orgs keep independent histories, and a run with no
 * org selected is not recorded.
 */

/** One recorded query with the epoch-millis timestamp of its last run. */
export interface QueryHistoryEntry {
    query: string;
    /** Epoch millis when this query was last executed (updated on a repeat run). */
    ts: number;
}

/** Maximum entries retained per org. Older entries fall off the end. */
export const HISTORY_LIMIT = 50;

/**
 * Return a new history array with `query` recorded at the front.
 *
 * - Whitespace-only queries are ignored (the original list is returned).
 * - The stored form is the query trimmed of surrounding whitespace; internal
 *   whitespace is preserved.
 * - A repeat of an existing query (case-sensitive, post-trim) is de-duplicated:
 *   its single entry moves to the front with the new timestamp rather than
 *   adding a duplicate.
 * - The result is capped to `limit` (most recent kept).
 *
 * Pure — does not mutate `existing`.
 */
export function pushHistoryEntry(
    existing: readonly QueryHistoryEntry[],
    query: string,
    ts: number,
    limit: number = HISTORY_LIMIT
): QueryHistoryEntry[] {
    const trimmed = query.trim();
    if (!trimmed) { return [...existing]; }
    const deduped = existing.filter(e => e.query !== trimmed);
    const next: QueryHistoryEntry[] = [{ query: trimmed, ts }, ...deduped];
    return next.slice(0, Math.max(0, limit));
}

/** Coerce an unknown persisted value into a clean entry array (defensive read).
 *  Drops anything that isn't a `{ query: string, ts: number }` shape so a
 *  corrupt globalState value can't crash callers that iterate the history. */
export function sanitizeHistory(raw: unknown): QueryHistoryEntry[] {
    if (!Array.isArray(raw)) { return []; }
    const out: QueryHistoryEntry[] = [];
    for (const item of raw) {
        if (
            item && typeof item === 'object' &&
            typeof (item as QueryHistoryEntry).query === 'string' &&
            typeof (item as QueryHistoryEntry).ts === 'number'
        ) {
            out.push({ query: (item as QueryHistoryEntry).query, ts: (item as QueryHistoryEntry).ts });
        }
    }
    return out;
}

/** Minimal globalState surface used by the store (subset of vscode.Memento). */
export interface HistoryMemento {
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): Thenable<void>;
}

/**
 * globalState-backed per-org history store. Keyed as
 * `soqlEditor.queryHistory.v1.<orgUsername>` so orgs never share history and a
 * key rename can't collide with the old flat key.
 */
export class QueryHistoryStore {
    private static readonly KEY_PREFIX = 'soqlEditor.queryHistory.v1.';

    constructor(private readonly memento: HistoryMemento, private readonly limit: number = HISTORY_LIMIT) {}

    private keyFor(orgUsername: string): string {
        return QueryHistoryStore.KEY_PREFIX + orgUsername;
    }

    /** Most-recent-first history for an org (empty when none / no org). */
    list(orgUsername: string | undefined): QueryHistoryEntry[] {
        if (!orgUsername) { return []; }
        return sanitizeHistory(this.memento.get(this.keyFor(orgUsername)));
    }

    /** Record a run of `query` against `orgUsername`. No-op without an org or a
     *  non-empty query. Returns the updated list. */
    async add(orgUsername: string | undefined, query: string, ts: number = Date.now()): Promise<QueryHistoryEntry[]> {
        if (!orgUsername || !query.trim()) { return this.list(orgUsername); }
        const next = pushHistoryEntry(this.list(orgUsername), query, ts, this.limit);
        await this.memento.update(this.keyFor(orgUsername), next);
        return next;
    }

    /** Clear an org's history. */
    async clear(orgUsername: string | undefined): Promise<void> {
        if (!orgUsername) { return; }
        await this.memento.update(this.keyFor(orgUsername), undefined);
    }
}

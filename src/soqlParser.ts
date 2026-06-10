import { SOQL_ALL_KEYWORDS } from './soqlCatalog';

/**
 * Minimal SOQL parser — extracts structural tokens from a SOQL query
 * to support autocomplete and validation.
 */

export interface ParsedQuery {
    selectFields: string[];
    fromObject: string | undefined;
    whereClause: string | undefined;
    /** Position info for contextual completions */
    context: QueryContext;
}

export interface ScopedFromInfo {
    fromName: string;
    depth: number;
    selectIndex: number;
    fromIndex: number;
}

export type QueryContext =
    | { type: 'select_fields'; partial: string }
    | { type: 'from_object'; partial: string }
    | { type: 'where_field'; partial: string }
    | { type: 'where_operator'; field: string; partial: string }
    | { type: 'where_value'; field: string; partial: string }
    | { type: 'order_by'; partial: string }
    | { type: 'order_direction'; partial: string }
    | { type: 'nulls_order'; partial: string }
    | { type: 'group_by'; partial: string }
    | { type: 'having'; partial: string }
    | { type: 'limit_value'; partial: string }
    | { type: 'offset_value'; partial: string }
    | { type: 'with_clause'; partial: string }
    | { type: 'for_clause'; partial: string }
    | { type: 'tail_clause'; partial: string }
    | { type: 'unknown' };

const KEYWORDS = new Set(SOQL_ALL_KEYWORDS.map(k => k.toUpperCase()));

/**
 * Determine what context the cursor is in within the SOQL query.
 */
export function getQueryContext(text: string, offset: number): QueryContext {
    const before = text.substring(0, offset).toUpperCase();
    const beforeRaw = text.substring(0, offset);

    // Get the partial word being typed
    const partialMatch = beforeRaw.match(/[a-zA-Z_][a-zA-Z0-9_.]*$/);
    const partial = partialMatch ? partialMatch[0] : '';

    // Check FOR clause
    if (/FOR\s+[A-Z_]*$/i.test(before)) {
        return { type: 'for_clause', partial };
    }

    // Check WITH clause
    if (/WITH\s+[A-Z_]*$/i.test(before)) {
        return { type: 'with_clause', partial };
    }

    // Check OFFSET value
    if (/OFFSET\s+\d*$/i.test(before)) {
        return { type: 'offset_value', partial };
    }

    // Check LIMIT value
    if (/LIMIT\s+\d*$/i.test(before)) {
        return { type: 'limit_value', partial };
    }

    // Check ORDER BY null ordering
    if (/ORDER\s+BY\s+[^)]*\s+NULLS\s+[A-Z]*$/i.test(before)) {
        return { type: 'nulls_order', partial };
    }

    // Check ORDER BY direction vs. field. ORDER BY can sort on several fields
    // (`ORDER BY Name, CreatedDate DESC`), so only the CURRENT sort segment
    // (after the last comma) decides: a completed field token + whitespace means
    // we're choosing ASC/DESC; otherwise we're still typing a field name.
    const orderTail = beforeRaw.match(/ORDER\s+BY\s+([^)]*)$/i)?.[1];
    if (orderTail !== undefined) {
        const segment = orderTail.split(',').pop() ?? orderTail;
        if (/^\s*[\w.]+\s+[A-Za-z]*$/.test(segment)) {
            return { type: 'order_direction', partial };
        }
        return { type: 'order_by', partial };
    }

    // Check GROUP BY
    if (/GROUP\s+BY\s+[^)]*$/i.test(before)) {
        return { type: 'group_by', partial };
    }

    // Check HAVING clause — suggest aggregate functions and fields
    if (/HAVING\s+[^)]*$/i.test(before)) {
        return { type: 'having', partial };
    }

    // Check WHERE clause — are we after an operator (typing a value)?
    // Anchor to the CURRENT condition (everything after the last top-level
    // WHERE/AND/OR), so a multi-condition clause resolves the field next to the
    // cursor instead of the first field in the WHERE clause.
    const lastConditionStart = findLastConditionStart(beforeRaw);
    if (lastConditionStart >= 0) {
        const condition = beforeRaw.slice(lastConditionStart);
        // field <op> value. Operator alternation orders multi-char and word
        // operators before their prefixes (INCLUDES before IN, >= before >) and
        // word-bounds the word operators so `IN` doesn't match inside `INCLUDES`.
        const opMatch = condition.match(
            /^\s*([A-Za-z_][\w.]*)\s*(<=|>=|<>|!=|=|<|>|\bLIKE\b|\bNOT\s+IN\b|\bINCLUDES\b|\bEXCLUDES\b|\bIN\b)\s*([\s\S]*)$/i
        );
        if (opMatch) {
            const fieldName = opMatch[1];
            const valuePart = opMatch[3] ?? '';
            const hasTrailingWhitespace = /\s$/.test(beforeRaw);
            const hasStartedValue = valuePart.trim().length > 0;
            const valueTrimmedEnd = valuePart.replace(/\s+$/, '');
            const startedNextWord = /\s+[A-Za-z_]*$/.test(valueTrimmedEnd);
            // If the value is complete and the cursor moved to the next token,
            // fall through to the clause/field transition checks below.
            if (!((hasTrailingWhitespace && hasStartedValue) || startedNextWord)) {
                return { type: 'where_value', field: fieldName, partial };
            }
        }
    }

    // Check WHERE clause — field typed, waiting for operator (e.g. "WHERE Name ▌")
    const whereOpMatch = before.match(/(?:WHERE|AND|OR)\s+(\w[\w.]*)\s+([A-Z]*)$/i);
    if (whereOpMatch) {
        const fieldName = whereOpMatch[1];
        const opPartial = whereOpMatch[2] || '';
        // Only trigger if the word after the field is not a known operator already completed
        const completedOps = new Set(['=', '!=', '<>', '<', '>', '<=', '>=', 'LIKE', 'IN']);
        if (!completedOps.has(opPartial.toUpperCase())) {
            return { type: 'where_operator', field: fieldName, partial: opPartial };
        }
    }

    // Check WHERE clause — just after WHERE/AND/OR keyword, starting a new condition
    if (/(?:WHERE|AND|OR)\s*$/i.test(beforeRaw)) {
        return { type: 'where_field', partial };
    }

    // Check WHERE clause — typing the field token of a new condition
    if (/(?:WHERE|AND|OR)\s+[A-Za-z_][A-Za-z0-9_.]*$/i.test(beforeRaw)) {
        return { type: 'where_field', partial };
    }

    // Check FROM — typing object name
    if (/FROM\s+\w*$/i.test(before)) {
        return { type: 'from_object', partial };
    }

    // Check SELECT field list (subquery-aware). Must run before the generic
    // tail_clause check below, which would otherwise swallow cursor positions
    // that follow a subquery's FROM in the outer SELECT list
    // (e.g. `SELECT Id, (SELECT Id FROM Contacts), Nam▌`).
    if (isInSelectClause(text, offset)) {
        return { type: 'select_fields', partial };
    }

    // Clause transitions in tail position
    if (/\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY)\b[\s\S]*$/i.test(before) && /\s+[A-Z_]*$/.test(before)) {
        return { type: 'tail_clause', partial };
    }

    // Fallback SELECT detection for malformed/in-progress queries with no FROM yet.
    if (/SELECT\s+[^]*$/i.test(before) && !/\bFROM\b/i.test(before)) {
        return { type: 'select_fields', partial };
    }

    return { type: 'unknown' };
}

/**
 * True when `offset` sits inside a SELECT field list — i.e. after the SELECT
 * keyword of its current query scope and at/before that scope's FROM (or that
 * scope has no FROM yet). Subquery-aware via parenthesis depth, so it correctly
 * recognizes the outer SELECT list even after a closed child subquery.
 */
function isInSelectClause(text: string, offset: number): boolean {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    const depth = getQueryDepthAtOffset(text, safeOffset);
    const tokens = scanSelectFromTokens(text);
    const selectTok = findCurrentSelectToken(tokens, safeOffset, depth);
    if (!selectTok || selectTok.index >= safeOffset) {
        return false;
    }
    const fromTok = tokens.find(
        t => t.keyword === 'FROM' && t.depth === selectTok.depth && t.index > selectTok.index
    );
    return !fromTok || safeOffset <= fromTok.index;
}

/**
 * Extract the FROM object from a SOQL query string.
 *
 * Subquery-aware: walks the token stream and returns the first FROM at the
 * outermost depth (matching the top-level SELECT). Falls back to the first
 * regex-matched FROM only if no top-level FROM is found, which preserves
 * the previous loose behavior for malformed/in-progress queries.
 */
export function extractFromObject(text: string): string | undefined {
    const top = extractTopLevelFromObject(text);
    if (top) { return top; }
    const match = text.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i);
    return match ? match[1] : undefined;
}

/**
 * Return the FROM object name at depth 0 (outside any parentheses/strings).
 * Returns undefined when no top-level FROM token exists.
 */
export function extractTopLevelFromObject(text: string): string | undefined {
    const tokens = scanSelectFromTokens(text);
    const fromAtDepth0 = tokens.find(t => t.keyword === 'FROM' && t.depth === 0);
    if (!fromAtDepth0) { return undefined; }
    return readIdentifierAfter(text, fromAtDepth0.index + 'FROM'.length);
}

/**
 * Resolve the FROM token for the query scope active at the cursor offset.
 * This is subquery-aware by tracking parenthesis depth.
 */
export function extractScopedFromInfo(text: string, offset: number): ScopedFromInfo | undefined {
    const safeOffset = Math.max(0, Math.min(offset, text.length));
    const tokens = scanSelectFromTokens(text);
    const currentDepth = getQueryDepthAtOffset(text, safeOffset);

    const selectToken = findCurrentSelectToken(tokens, safeOffset, currentDepth);
    if (!selectToken) {
        return undefined;
    }
    const fromToken = tokens.find(t =>
        t.keyword === 'FROM' &&
        t.depth === selectToken.depth &&
        t.index > selectToken.index
    );
    if (!fromToken) {
        return undefined;
    }
    const fromName = readIdentifierAfter(text, fromToken.index + 4);
    if (!fromName) {
        return undefined;
    }
    return {
        fromName,
        depth: selectToken.depth,
        selectIndex: selectToken.index,
        fromIndex: fromToken.index,
    };
}

function readIdentifierAfter(text: string, index: number): string | undefined {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) {
        i++;
    }
    const m = text.slice(i).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    return m ? m[1] : undefined;
}

/**
 * Returns true when the single-quote at `quoteIndex` is escaped by a preceding
 * backslash. Counts the run of consecutive backslashes — the quote is escaped
 * only when that count is odd, so an escaped backslash before a closing quote
 * (e.g. the `'` in `'C:\\'`) correctly terminates the string.
 */
function isEscapedQuote(text: string, quoteIndex: number): boolean {
    let backslashes = 0;
    let j = quoteIndex - 1;
    while (j >= 0 && text[j] === '\\') {
        backslashes++;
        j--;
    }
    return backslashes % 2 === 1;
}

/**
 * Return the offset just past the last WHERE/AND/OR keyword in `text`
 * (string-literal aware, any paren depth), or -1 if none. Used to isolate the
 * current WHERE condition so value/field context is resolved relative to the
 * cursor rather than the first condition in the clause.
 */
function findLastConditionStart(text: string): number {
    const hits = [
        ...findKeywordHits(text, 'WHERE'),
        ...findKeywordHits(text, 'AND'),
        ...findKeywordHits(text, 'OR'),
    ];
    let last = -1;
    for (const h of hits) {
        const end = h.index + h.length;
        if (end > last) { last = end; }
    }
    return last;
}

export function getQueryDepthAtOffset(text: string, offset: number): number {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < offset && i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && !isEscapedQuote(text, i)) {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (ch === '(') {
            depth++;
        } else if (ch === ')' && depth > 0) {
            depth--;
        }
    }
    return depth;
}

function findCurrentSelectToken(
    tokens: Array<{ keyword: 'SELECT' | 'FROM'; index: number; depth: number }>,
    offset: number,
    depth: number
): { keyword: 'SELECT' | 'FROM'; index: number; depth: number } | undefined {
    const sameDepthList = tokens.filter(t => t.keyword === 'SELECT' && t.index < offset && t.depth === depth);
    const sameDepth = sameDepthList.length > 0 ? sameDepthList[sameDepthList.length - 1] : undefined;
    if (sameDepth) {
        return sameDepth;
    }
    // Fallback for cases where cursor sits exactly on/near scope boundaries.
    const anyDepth = tokens.filter(t => t.keyword === 'SELECT' && t.index < offset);
    return anyDepth.length > 0 ? anyDepth[anyDepth.length - 1] : undefined;
}

/**
 * Find positions of a single keyword (or multi-word phrase like "ORDER BY")
 * outside of string literals, with parenthesis depth tracking.
 */
export interface KeywordHit {
    /** Index into the original text where the match starts. */
    index: number;
    /** Length of the matched text in the original string (handles arbitrary whitespace runs). */
    length: number;
    /** Parenthesis depth at the start of the match (0 = top level). */
    depth: number;
}

export function findKeywordHits(text: string, phrase: string): KeywordHit[] {
    const hits: KeywordHit[] = [];
    const upper = text.toUpperCase();
    const target = phrase.toUpperCase().trim();
    const parts = target.split(/\s+/);
    let depth = 0;
    let inString = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && !isEscapedQuote(text, i)) {
            inString = !inString;
            continue;
        }
        if (inString) { continue; }
        if (ch === '(') { depth++; continue; }
        if (ch === ')') { depth = Math.max(0, depth - 1); continue; }

        if (!isWordTokenAt(upper, i, parts[0])) { continue; }

        // Multi-word phrase: walk forward past whitespace between parts.
        let cursor = i + parts[0].length;
        let matched = true;
        for (let p = 1; p < parts.length; p++) {
            while (cursor < text.length && /\s/.test(text[cursor])) { cursor++; }
            if (!isWordTokenAt(upper, cursor, parts[p])) {
                matched = false;
                break;
            }
            cursor += parts[p].length;
        }
        if (!matched) { continue; }

        hits.push({ index: i, length: cursor - i, depth });
        i = cursor - 1;
    }

    return hits;
}

function scanSelectFromTokens(text: string): Array<{ keyword: 'SELECT' | 'FROM'; index: number; depth: number }> {
    const tokens: Array<{ keyword: 'SELECT' | 'FROM'; index: number; depth: number }> = [];
    let depth = 0;
    let inString = false;
    const upper = text.toUpperCase();

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && !isEscapedQuote(text, i)) {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }

        if (ch === '(') {
            depth++;
            continue;
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }

        if (isWordTokenAt(upper, i, 'SELECT')) {
            tokens.push({ keyword: 'SELECT', index: i, depth });
            i += 'SELECT'.length - 1;
            continue;
        }
        if (isWordTokenAt(upper, i, 'FROM')) {
            tokens.push({ keyword: 'FROM', index: i, depth });
            i += 'FROM'.length - 1;
            continue;
        }
    }
    return tokens;
}

function isWordTokenAt(textUpper: string, index: number, token: string): boolean {
    if (!textUpper.startsWith(token, index)) {
        return false;
    }
    const prev = index > 0 ? textUpper[index - 1] : ' ';
    const next = index + token.length < textUpper.length ? textUpper[index + token.length] : ' ';
    return !/[A-Z0-9_]/.test(prev) && !/[A-Z0-9_]/.test(next);
}

/**
 * Extract SELECT field list from a SOQL query string.
 *
 * Returns only non-empty trimmed slots — leading/trailing commas and double
 * commas (`SELECT Id, , Name`) silently drop the empty slot. Callers that
 * need to distinguish "2 fields" from "2 fields + empty trailing slot" should
 * use {@link validateSoqlStructure}, which reports trailing/leading commas as
 * separate diagnostics.
 */
export function extractSelectFields(text: string): string[] {
    const selectMatch = /\bSELECT\b/i.exec(text);
    if (!selectMatch || selectMatch.index === undefined) { return []; }

    const selectStart = selectMatch.index + selectMatch[0].length;
    const fromIndex = findTopLevelFromIndex(text, selectStart);
    if (fromIndex < 0) { return []; }

    const selectClause = text.slice(selectStart, fromIndex);
    return splitTopLevelCsv(selectClause);
}

function findTopLevelFromIndex(text: string, start: number): number {
    let depth = 0;
    let inString = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && !isEscapedQuote(text, i)) {
            inString = !inString;
            continue;
        }
        if (inString) { continue; }

        if (ch === '(') {
            depth++;
            continue;
        }
        if (ch === ')' && depth > 0) {
            depth--;
            continue;
        }
        if (depth > 0) { continue; }

        if ((ch === 'f' || ch === 'F') && text.slice(i, i + 4).toUpperCase() === 'FROM') {
            const prev = i > 0 ? text[i - 1] : ' ';
            const next = i + 4 < text.length ? text[i + 4] : ' ';
            if (!/[A-Za-z0-9_]/.test(prev) && !/[A-Za-z0-9_]/.test(next)) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Like {@link splitTopLevelCsv} but returns offset metadata for each slot so
 * callers can report accurate error positions even when several slots share
 * the same text (e.g. `SELECT Name, Name Name FROM ...`).
 *
 * `start` is the offset (into the input string) of the first non-whitespace
 * character of the slot, or the comma position if the slot is empty.
 */
function splitTopLevelCsvWithOffsets(input: string): { value: string; start: number }[] {
    const parts: { value: string; start: number }[] = [];
    let current = '';
    let depth = 0;
    let inString = false;
    let slotStart = 0;
    let slotStartedAt = -1; // offset of first non-whitespace in current slot

    const finalizeSlot = (atIndex: number) => {
        const value = current.trim();
        const start = slotStartedAt >= 0 ? slotStartedAt : atIndex;
        parts.push({ value, start });
        current = '';
        slotStartedAt = -1;
    };

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "'" && !isEscapedQuote(input, i)) {
            inString = !inString;
            if (slotStartedAt < 0) { slotStartedAt = i; }
            current += ch;
            continue;
        }
        if (!inString) {
            if (ch === '(') { depth++; if (slotStartedAt < 0) { slotStartedAt = i; } current += ch; continue; }
            if (ch === ')' && depth > 0) { depth--; current += ch; continue; }
            if (ch === ',' && depth === 0) {
                finalizeSlot(i);
                slotStart = i + 1;
                continue;
            }
        }
        if (slotStartedAt < 0 && !/\s/.test(ch)) { slotStartedAt = i; }
        current += ch;
    }
    finalizeSlot(slotStart);
    return parts;
}

/**
 * Replace each string literal in `text` with same-length spaces so that
 * downstream scans never accidentally match SOQL syntax inside string content.
 * Preserves character offsets — error positions stay accurate.
 */
function stripStringLiterals(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && !isEscapedQuote(text, i)) {
            inString = !inString;
            out += ' ';
            continue;
        }
        out += inString ? ' ' : ch;
    }
    return out;
}

function splitTopLevelCsv(input: string): string[] {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let inString = false;

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];
        if (ch === "'" && !isEscapedQuote(input, i)) {
            inString = !inString;
            current += ch;
            continue;
        }
        if (!inString) {
            if (ch === '(') {
                depth++;
                current += ch;
                continue;
            }
            if (ch === ')' && depth > 0) {
                depth--;
                current += ch;
                continue;
            }
            if (ch === ',' && depth === 0) {
                const value = current.trim();
                if (value.length > 0) {
                    parts.push(value);
                }
                current = '';
                continue;
            }
        }
        current += ch;
    }

    const tail = current.trim();
    if (tail.length > 0) {
        parts.push(tail);
    }
    return parts;
}

/**
 * Check if a word is a SOQL keyword.
 */
export function isKeyword(word: string): boolean {
    return KEYWORDS.has(word.toUpperCase());
}

/**
 * Basic structural validation of a SOQL query.
 * Returns an array of error messages with approximate positions.
 */
export interface SoqlError {
    message: string;
    line: number;
    startCol: number;
    endCol: number;
}

export function validateSoqlStructure(text: string): SoqlError[] {
    const errors: SoqlError[] = [];
    const pushErrorAt = (message: string, offset: number, length: number) => {
        const safeOffset = Math.max(0, Math.min(offset, text.length));
        const line = text.substring(0, safeOffset).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', safeOffset - 1) + 1;
        errors.push({
            message,
            line,
            startCol: safeOffset - lineStart,
            endCol: safeOffset - lineStart + Math.max(1, length),
        });
    };

    // Check unmatched parentheses
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') { depth++; }
        if (text[i] === ')') { depth--; }
        if (depth < 0) {
            const line = text.substring(0, i).split('\n').length - 1;
            const lineStart = text.lastIndexOf('\n', i) + 1;
            errors.push({
                message: 'Unmatched closing parenthesis',
                line,
                startCol: i - lineStart,
                endCol: i - lineStart + 1,
            });
            break;
        }
    }
    if (depth > 0) {
        errors.push({
            message: 'Unmatched opening parenthesis',
            line: 0,
            startCol: 0,
            endCol: text.length,
        });
    }

    // Check for unclosed string literals
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === "'" && !isEscapedQuote(text, i)) {
            inString = !inString;
        }
    }
    if (inString) {
        errors.push({
            message: 'Unclosed string literal',
            line: text.split('\n').length - 1,
            startCol: 0,
            endCol: text.split('\n').pop()?.length || 0,
        });
    }

    // SELECT clause checks — extract the SELECT field list in a paren/string-aware
    // way. The previous /SELECT\s+(...)\bFROM\b/ regex truncated the clause at the
    // FIRST FROM, including a subquery's, so these checks operated on the wrong
    // substring (missing real duplicates, false-flagging valid subqueries).
    const selectKeyword = /\bSELECT\b/i.exec(text);
    let selectClause: string | null = null;
    let selectClauseStart = -1; // offset of the first char after the SELECT keyword
    if (selectKeyword) {
        const afterSelect = selectKeyword.index + selectKeyword[0].length;
        const fromIdx = findTopLevelFromIndex(text, afterSelect);
        if (fromIdx >= 0) {
            selectClause = text.slice(afterSelect, fromIdx);
            selectClauseStart = afterSelect;
        }
    }

    // Missing FROM clause — a query that starts with SELECT must have a top-level FROM.
    // `findKeywordHits` is depth/string-aware on its own, so this check is safe to
    // run even when other errors are already present (unmatched parens, unclosed
    // strings) — the user still benefits from seeing the FROM diagnostic.
    if (selectKeyword) {
        const hits = findKeywordHits(text, 'FROM').filter(h => h.depth === 0);
        if (hits.length === 0) {
            pushErrorAt('Missing FROM clause', selectKeyword.index, 'SELECT'.length);
        }
    }

    // Empty SELECT field list — e.g. "SELECT FROM Account"
    if (selectClause !== null && selectClause.trim().length === 0) {
        pushErrorAt('Empty SELECT clause', selectKeyword!.index, 'SELECT'.length);
    }

    // Trailing comma before FROM — e.g. "SELECT Name, FROM Account"
    if (selectClause !== null && /,\s*$/.test(selectClause)) {
        pushErrorAt('Trailing comma in SELECT clause', selectClauseStart + selectClause.lastIndexOf(','), 1);
    }

    // Leading comma in SELECT — e.g. "SELECT , Name FROM Account"
    if (selectClause !== null && /^\s*,/.test(selectClause)) {
        pushErrorAt('Leading comma in SELECT clause', selectClauseStart + selectClause.indexOf(','), 1);
    }

    // Missing comma between SELECT fields — e.g. "SELECT Id Name FROM Account"
    // Heuristic: a "field" slot that's actually two bare identifiers separated by
    // whitespace, and isn't a function call / subquery / aggregate / TYPEOF.
    // In aggregate queries a slot like "StageName s" is a legal field alias —
    // but only for GROUPED fields (aliasing a non-grouped bare field is invalid
    // SOQL regardless), so a two-token slot is exempt only when its first token
    // appears in the top-level GROUP BY list. This keeps "SELECT Id Name, ..."
    // flagged even when the query has a GROUP BY.
    if (selectClause !== null && selectClause.trim().length > 0) {
        const groupByHits = findKeywordHits(text, 'GROUP BY').filter(h => h.depth === 0);
        const groupedFieldHeads = new Set<string>();
        if (groupByHits.length > 0) {
            const start = groupByHits[0].index + groupByHits[0].length;
            let end = text.length;
            for (const phrase of ['HAVING', 'ORDER BY', 'LIMIT', 'OFFSET', 'FOR']) {
                for (const hit of findKeywordHits(text, phrase)) {
                    if (hit.depth === 0 && hit.index > start) {
                        end = Math.min(end, hit.index);
                    }
                }
            }
            const ids = text.slice(start, end).match(/[A-Za-z_][A-Za-z0-9_.]*/g) || [];
            for (const id of ids) {
                if (!/^(ROLLUP|CUBE|GROUPING)$/i.test(id)) {
                    groupedFieldHeads.add(id.toLowerCase());
                }
            }
        }
        for (const slot of splitTopLevelCsvWithOffsets(selectClause)) {
            const field = slot.value.trim();
            if (!field) { continue; }
            if (field.startsWith('(')) { continue; }                      // subquery
            if (/[(){}]/.test(field)) { continue; }                        // function/aggregate
            if (/^TYPEOF\b/i.test(field)) { continue; }                    // polymorphic TYPEOF ... END
            const idTokens = field.match(/[A-Za-z_][A-Za-z0-9_.]*/g) || [];
            if (idTokens.length === 2 && groupedFieldHeads.has(idTokens[0].toLowerCase())) {
                continue;                                                  // alias on a grouped field
            }
            if (idTokens.length >= 2 && !/[(),]/.test(field)) {
                // slot.start points at the first non-whitespace char of the slot.
                pushErrorAt(
                    `Missing comma between SELECT fields: '${field}'`,
                    selectClauseStart + slot.start,
                    field.length
                );
            }
        }
    }

    // Duplicate fields in SELECT — e.g. "SELECT Name, Name FROM Account"
    if (selectClause !== null && selectClause.trim().length > 0) {
        const fields = splitTopLevelCsv(selectClause);
        const seen = new Set<string>();             // field heads already encountered
        const reported = new Map<string, number>(); // head -> duplicates already reported
        for (const rawField of fields) {
            // Skip aggregates, subqueries, FIELDS(), TYPEOF.
            if (/^(COUNT|AVG|SUM|MIN|MAX|COUNT_DISTINCT|FIELDS)\s*\(/i.test(rawField)) { continue; }
            if (rawField.startsWith('(')) { continue; }
            if (/^TYPEOF\b/i.test(rawField)) { continue; }
            // Strip an optional alias (e.g. "Id alias" → "Id") for duplicate detection only.
            const fieldHead = rawField.split(/\s+/)[0];
            const key = fieldHead.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                continue;
            }
            // Locate the (N+1)-th occurrence of the field head so the 2nd, 3rd, …
            // duplicates each point at their own position rather than all at the 2nd.
            const targetOccurrence = (reported.get(key) ?? 0) + 2; // occurrence #1 is the original
            reported.set(key, (reported.get(key) ?? 0) + 1);
            const fieldRegex = new RegExp('\\b' + fieldHead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
            let m: RegExpExecArray | null;
            let occ = 0;
            let matchIdx = -1;
            while ((m = fieldRegex.exec(selectClause)) !== null) {
                occ++;
                if (occ === targetOccurrence) { matchIdx = m.index; break; }
            }
            if (matchIdx >= 0) {
                pushErrorAt(`Duplicate field: ${fieldHead}`, selectClauseStart + matchIdx, fieldHead.length);
            }
        }
    }

    // Invalid operator characters outside string literals.
    // Valid SOQL comparison operators: = != <> < > <= >=
    // Anything else built from [= ! < >] (incl. ==, => , =! , <<, >>, !! , !-, etc.)
    // is flagged. Operates on a string-stripped copy so quoted literals are ignored.
    {
        const stripped = stripStringLiterals(text);
        const VALID_OPS = new Set(['=', '!=', '<>', '<', '>', '<=', '>=']);
        const opRegex = /[=!<>][=!<>\-+]*/g;
        let m: RegExpExecArray | null;
        while ((m = opRegex.exec(stripped)) !== null) {
            const token = m[0];
            // Skip valid operators (exact match)
            if (VALID_OPS.has(token)) { continue; }
            // Also tolerate `=` immediately followed by `-`/`+` digits (e.g. value `=-1`)
            // by stripping a single trailing sign char and re-checking.
            const trimmedToken = token.replace(/[+\-]$/, '');
            if (VALID_OPS.has(trimmedToken)) { continue; }
            const detail = token === '=='
                ? "Use '=' instead of '==' in SOQL"
                : `Invalid operator '${token}'`;
            pushErrorAt(detail, m.index, token.length);
        }
    }

    // HAVING without GROUP BY — both checks are string/paren-aware via
    // findKeywordHits, so a `HAVING`/`GROUP BY` inside a string literal or a
    // subquery neither false-flags nor masks a missing top-level GROUP BY.
    {
        const havingHits = findKeywordHits(text, 'HAVING').filter(h => h.depth === 0);
        const groupByHits = findKeywordHits(text, 'GROUP BY').filter(h => h.depth === 0);
        if (havingHits.length > 0 && groupByHits.length === 0) {
            pushErrorAt('HAVING requires a GROUP BY clause', havingHits[0].index, 'HAVING'.length);
        }
    }

    // LIMIT / OFFSET must be a non-negative integer (or a bind variable like :n).
    for (const clause of ['LIMIT', 'OFFSET']) {
        for (const hit of findKeywordHits(text, clause).filter(h => h.depth === 0)) {
            const after = text.slice(hit.index + hit.length);
            const m = after.match(/^(\s*)(\S+)/);
            if (!m) { continue; }                                   // nothing typed yet
            const leading = m[1].length;
            // Stop at a following clause / paren so "LIMIT 10)" / "OFFSET 5 FOR" parse.
            const token = m[2].replace(/[),].*$/, '');
            if (token.length === 0) { continue; }
            if (token.startsWith(':')) { continue; }                // bind variable
            if (!/^\d+$/.test(token)) {
                pushErrorAt(
                    `${clause} requires a non-negative integer`,
                    hit.index + hit.length + leading,
                    token.length
                );
            }
        }
    }

    // Duplicate top-level clauses (outside subqueries, outside string literals)
    const clauseCounts = new Map<string, { count: number; lastIdx: number }>();
    for (const phrase of ['WHERE', 'ORDER BY', 'GROUP BY', 'LIMIT', 'OFFSET']) {
        const hits = findKeywordHits(text, phrase).filter(h => h.depth === 0);
        if (hits.length === 0) { continue; }
        clauseCounts.set(phrase, { count: hits.length, lastIdx: hits[hits.length - 1].index });
    }
    for (const [clause, { count, lastIdx }] of clauseCounts) {
        if (count > 1) {
            const line = text.substring(0, lastIdx).split('\n').length - 1;
            const lineStart = text.lastIndexOf('\n', lastIdx) + 1;
            errors.push({
                message: `Duplicate ${clause} clause`,
                line,
                startCol: lastIdx - lineStart,
                endCol: lastIdx - lineStart + clause.length,
            });
        }
    }

    return errors;
}

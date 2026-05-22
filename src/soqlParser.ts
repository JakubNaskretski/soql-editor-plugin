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

    // Check ORDER BY direction (only after field token + space)
    const orderTail = beforeRaw.match(/ORDER\s+BY\s+([^)]*)$/i)?.[1] ?? '';
    if (/\s+[A-Za-z]*$/.test(orderTail)) {
        return { type: 'order_direction', partial };
    }

    // Check ORDER BY
    if (/ORDER\s+BY\s+[^)]*$/i.test(before)) {
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
    const whereValueMatch = before.match(
        /(?:WHERE|AND|OR)\s+.*?(\w+)\s*(=|!=|<>|<=?|>=?|LIKE|IN|NOT\s+IN|INCLUDES|EXCLUDES)\s*[^,)]*$/i
    );
    if (whereValueMatch) {
        const afterOperator = beforeRaw.match(/(=|!=|<>|<=?|>=?|LIKE|IN|NOT\s+IN|INCLUDES|EXCLUDES)\s*([^,)]*)$/i);
        if (afterOperator) {
            const valuePart = afterOperator[2] ?? '';
            const hasTrailingWhitespace = /\s$/.test(beforeRaw);
            const hasStartedValue = valuePart.trim().length > 0;
            const valueTrimmedEnd = valuePart.replace(/\s+$/, '');
            const startedNextWord = /\s+[A-Za-z_]*$/.test(valueTrimmedEnd);
            // If value is complete and cursor moved to next token, don't stay in value context.
            if ((hasTrailingWhitespace && hasStartedValue) || startedNextWord) {
                // Continue to clause/field transition checks below.
            } else {
                return { type: 'where_value', field: whereValueMatch[1], partial };
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

    // Clause transitions in tail position
    if (/\b(FROM|WHERE|GROUP\s+BY|HAVING|ORDER\s+BY)\b[\s\S]*$/i.test(before) && /\s+[A-Z_]*$/.test(before)) {
        return { type: 'tail_clause', partial };
    }

    // Check SELECT — typing field names
    if (/SELECT\s+[^]*$/i.test(before) && !/\bFROM\b/i.test(before)) {
        return { type: 'select_fields', partial };
    }

    return { type: 'unknown' };
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

export function getQueryDepthAtOffset(text: string, offset: number): number {
    let depth = 0;
    let inString = false;
    for (let i = 0; i < offset && i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && (i === 0 || text[i - 1] !== '\\')) {
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
        if (ch === "'" && (i === 0 || text[i - 1] !== '\\')) {
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
        if (ch === "'" && (i === 0 || text[i - 1] !== '\\')) {
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
        if (ch === "'" && (i === 0 || text[i - 1] !== '\\')) {
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
 * Replace each string literal in `text` with same-length spaces so that
 * downstream scans never accidentally match SOQL syntax inside string content.
 * Preserves character offsets — error positions stay accurate.
 */
function stripStringLiterals(text: string): string {
    let out = '';
    let inString = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "'" && (i === 0 || text[i - 1] !== '\\')) {
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
        if (ch === "'" && (i === 0 || input[i - 1] !== '\\')) {
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
        if (text[i] === "'" && (i === 0 || text[i - 1] !== '\\')) {
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

    // SELECT clause checks
    const selectToFrom = text.match(/\bSELECT\s+([\s\S]*?)\bFROM\b/i);

    // Missing FROM clause — a query that starts with SELECT must have a top-level FROM.
    // Only check when there's no other structural error already (parens/strings closed).
    const selectKeywordMatch = /\bSELECT\b/i.exec(text);
    if (selectKeywordMatch && errors.length === 0) {
        const hits = findKeywordHits(text, 'FROM').filter(h => h.depth === 0);
        if (hits.length === 0) {
            pushErrorAt(
                'Missing FROM clause',
                selectKeywordMatch.index,
                'SELECT'.length
            );
        }
    }

    // Empty SELECT field list — e.g. "SELECT FROM Account"
    if (selectToFrom && selectToFrom[1].trim().length === 0) {
        const selectStart = text.toUpperCase().indexOf('SELECT');
        pushErrorAt('Empty SELECT clause', selectStart, 'SELECT'.length);
    }

    // Trailing comma before FROM — e.g. "SELECT Name, FROM Account"
    if (selectToFrom && /,\s*$/.test(selectToFrom[1])) {
        const selectStart = text.toUpperCase().indexOf('SELECT') + 6;
        const fieldsPart = selectToFrom[1];
        const commaOffset = selectStart + fieldsPart.lastIndexOf(',');
        const line = text.substring(0, commaOffset).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', commaOffset) + 1;
        errors.push({
            message: 'Trailing comma in SELECT clause',
            line,
            startCol: commaOffset - lineStart,
            endCol: commaOffset - lineStart + 1,
        });
    }

    // Leading comma in SELECT — e.g. "SELECT , Name FROM Account"
    if (selectToFrom && /^\s*,/.test(selectToFrom[1])) {
        const selectStart = text.toUpperCase().indexOf('SELECT') + 6;
        const commaOffset = selectStart + selectToFrom[1].indexOf(',');
        const line = text.substring(0, commaOffset).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', commaOffset) + 1;
        errors.push({
            message: 'Leading comma in SELECT clause',
            line,
            startCol: commaOffset - lineStart,
            endCol: commaOffset - lineStart + 1,
        });
    }

    // Missing comma between SELECT fields — e.g. "SELECT Id Name FROM Account"
    // Heuristic: a "field" returned by splitTopLevelCsv that's actually two bare
    // identifiers separated by whitespace (and isn't a function call / subquery /
    // aggregate alias).
    if (selectToFrom && selectToFrom[1].trim().length > 0) {
        const selectStart = text.toUpperCase().indexOf('SELECT') + 'SELECT'.length;
        const fields = splitTopLevelCsv(selectToFrom[1]);
        const fieldClauseRaw = selectToFrom[1];
        for (const fieldRaw of fields) {
            const field = fieldRaw.trim();
            if (field.startsWith('(')) { continue; }                      // subquery
            if (/[(){}]/.test(field)) { continue; }                        // function/aggregate
            // Two-or-more whitespace-separated identifiers without commas.
            const idTokens = field.match(/[A-Za-z_][A-Za-z0-9_.]*/g) || [];
            if (idTokens.length >= 2 && !/[(),]/.test(field)) {
                const idxInClause = fieldClauseRaw.indexOf(field);
                const absOffset = idxInClause >= 0 ? selectStart + idxInClause : selectStart;
                pushErrorAt(`Missing comma between SELECT fields: '${field}'`, absOffset, field.length);
            }
        }
    }

    // Duplicate fields in SELECT — e.g. "SELECT Name, Name FROM Account"
    if (selectToFrom && selectToFrom[1].trim().length > 0) {
        const selectStart = text.toUpperCase().indexOf('SELECT') + 6;
        const fields = splitTopLevelCsv(selectToFrom[1]);
        const seen = new Map<string, number>(); // lowercase field -> first occurrence index
        for (let fi = 0; fi < fields.length; fi++) {
            // Skip aggregates, subqueries, FIELDS()
            if (/^(COUNT|AVG|SUM|MIN|MAX|COUNT_DISTINCT|FIELDS)\s*\(/i.test(fields[fi])) { continue; }
            if (fields[fi].startsWith('(')) { continue; }
            // Strip optional alias (e.g. "Id alias" → "Id") for duplicate detection only.
            const fieldHead = fields[fi].split(/\s+/)[0];
            const key = fieldHead.toLowerCase();
            if (seen.has(key)) {
                // Find the position of this duplicate in the original text
                // Search for the nth occurrence of this field in the SELECT clause
                const fieldClause = selectToFrom[1];
                let searchFrom = 0;
                let occurrences = 0;
                const targetOccurrence = seen.get(key)! + 1; // we want the one after the first
                let matchIdx = -1;
                // Count occurrences of the field HEAD (alias-stripped) to find the duplicate
                const fieldRegex = new RegExp('\\b' + fieldHead.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
                let m;
                let occCount = 0;
                while ((m = fieldRegex.exec(fieldClause)) !== null) {
                    occCount++;
                    if (occCount > 1) {
                        matchIdx = m.index;
                        break;
                    }
                }
                if (matchIdx >= 0) {
                    const absOffset = selectStart + matchIdx;
                    const line = text.substring(0, absOffset).split('\n').length - 1;
                    const lineStart = text.lastIndexOf('\n', absOffset) + 1;
                    errors.push({
                        message: `Duplicate field: ${fieldHead}`,
                        line,
                        startCol: absOffset - lineStart,
                        endCol: absOffset - lineStart + fieldHead.length,
                    });
                }
            } else {
                seen.set(key, fi);
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

    // HAVING without GROUP BY
    if (/\bHAVING\b/i.test(text) && !/\bGROUP\s+BY\b/i.test(text)) {
        const havingMatch = text.match(/\bHAVING\b/i)!;
        const idx = havingMatch.index!;
        const line = text.substring(0, idx).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        errors.push({
            message: 'HAVING requires a GROUP BY clause',
            line,
            startCol: idx - lineStart,
            endCol: idx - lineStart + 6,
        });
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

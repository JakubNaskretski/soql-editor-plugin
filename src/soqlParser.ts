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

export type QueryContext =
    | { type: 'select_fields'; partial: string }
    | { type: 'from_object'; partial: string }
    | { type: 'where_field'; partial: string }
    | { type: 'where_operator'; field: string; partial: string }
    | { type: 'where_value'; field: string; partial: string }
    | { type: 'order_by'; partial: string }
    | { type: 'group_by'; partial: string }
    | { type: 'having'; partial: string }
    | { type: 'unknown' };

const KEYWORDS = new Set([
    'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'LIKE',
    'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET', 'ASC', 'DESC',
    'NULLS', 'FIRST', 'LAST', 'WITH', 'USING', 'SCOPE', 'FOR',
    'INCLUDES', 'EXCLUDES', 'TYPEOF', 'WHEN', 'THEN', 'ELSE', 'END',
    'ROLLUP', 'CUBE', 'NULL', 'TRUE', 'FALSE', 'UPDATE', 'VIEW', 'REFERENCE',
]);

/**
 * Determine what context the cursor is in within the SOQL query.
 */
export function getQueryContext(text: string, offset: number): QueryContext {
    const before = text.substring(0, offset).toUpperCase();
    const beforeRaw = text.substring(0, offset);

    // Get the partial word being typed
    const partialMatch = beforeRaw.match(/[a-zA-Z_][a-zA-Z0-9_.]*$/);
    const partial = partialMatch ? partialMatch[0] : '';

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
    const whereValueMatch = before.match(/(?:WHERE|AND|OR)\s+.*?(\w+)\s*(=|!=|<>|<=?|>=?|LIKE|IN|NOT\s+IN)\s*[^,)]*$/i);
    if (whereValueMatch) {
        const afterOperator = beforeRaw.match(/(=|!=|<>|<=?|>=?|LIKE|IN)\s*[^,)]*$/i);
        if (afterOperator) {
            return { type: 'where_value', field: whereValueMatch[1], partial };
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

    // Check WHERE clause — typing a field name
    if (/WHERE\s+[^)]*$/i.test(before) || /AND\s+[^)]*$/i.test(before) || /OR\s+[^)]*$/i.test(before)) {
        return { type: 'where_field', partial };
    }

    // Check FROM — typing object name
    if (/FROM\s+\w*$/i.test(before)) {
        return { type: 'from_object', partial };
    }

    // Check SELECT — typing field names
    if (/SELECT\s+[^]*$/i.test(before) && !/\bFROM\b/i.test(before)) {
        return { type: 'select_fields', partial };
    }

    return { type: 'unknown' };
}

/**
 * Extract the FROM object from a SOQL query string.
 */
export function extractFromObject(text: string): string | undefined {
    const match = text.match(/\bFROM\s+(\w+)/i);
    return match ? match[1] : undefined;
}

/**
 * Extract SELECT field list from a SOQL query string.
 */
export function extractSelectFields(text: string): string[] {
    const match = text.match(/\bSELECT\s+([\s\S]*?)\bFROM\b/i);
    if (!match) { return []; }
    return match[1]
        .split(',')
        .map(f => f.trim())
        .filter(f => f.length > 0);
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
    const upper = text.toUpperCase().trim();

    if (!upper.startsWith('SELECT')) {
        errors.push({
            message: 'Query must start with SELECT',
            line: 0,
            startCol: 0,
            endCol: Math.min(6, text.length),
        });
    }

    if (!/\bFROM\b/i.test(text)) {
        errors.push({
            message: 'Query must include a FROM clause',
            line: 0,
            startCol: 0,
            endCol: text.length,
        });
    }

    // Check FROM has an object name after it
    const fromMatch = text.match(/\bFROM\s*$/i);
    if (fromMatch) {
        const idx = text.toUpperCase().lastIndexOf('FROM');
        const line = text.substring(0, idx).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        errors.push({
            message: 'FROM clause requires an object name',
            line,
            startCol: idx - lineStart,
            endCol: idx - lineStart + 4,
        });
    }

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

    // Empty SELECT clause — e.g. "SELECT FROM Account"
    const selectToFrom = text.match(/\bSELECT\s+([\s\S]*?)\bFROM\b/i);
    if (selectToFrom && selectToFrom[1].trim().length === 0) {
        const idx = text.toUpperCase().indexOf('SELECT');
        const line = text.substring(0, idx).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        errors.push({
            message: 'SELECT clause is empty',
            line,
            startCol: idx - lineStart,
            endCol: idx - lineStart + 6,
        });
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

    // Duplicate fields in SELECT — e.g. "SELECT Name, Name FROM Account"
    if (selectToFrom && selectToFrom[1].trim().length > 0) {
        const selectStart = text.toUpperCase().indexOf('SELECT') + 6;
        const fields = selectToFrom[1].split(',').map(f => f.trim()).filter(f => f.length > 0);
        const seen = new Map<string, number>(); // lowercase field -> first occurrence index
        for (let fi = 0; fi < fields.length; fi++) {
            // Skip aggregates, subqueries, FIELDS()
            if (/^(COUNT|AVG|SUM|MIN|MAX|COUNT_DISTINCT|FIELDS)\s*\(/i.test(fields[fi])) { continue; }
            if (fields[fi].startsWith('(')) { continue; }
            const key = fields[fi].toLowerCase();
            if (seen.has(key)) {
                // Find the position of this duplicate in the original text
                // Search for the nth occurrence of this field in the SELECT clause
                const fieldClause = selectToFrom[1];
                let searchFrom = 0;
                let occurrences = 0;
                const targetOccurrence = seen.get(key)! + 1; // we want the one after the first
                let matchIdx = -1;
                // Count occurrences of this field to find the duplicate
                const fieldRegex = new RegExp('\\b' + fields[fi].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
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
                        message: `Duplicate field: ${fields[fi]}`,
                        line,
                        startCol: absOffset - lineStart,
                        endCol: absOffset - lineStart + fields[fi].length,
                    });
                }
            } else {
                seen.set(key, fi);
            }
        }
    }

    // Invalid operator == (SOQL uses =)
    const doubleEquals = /(?<!=)={2}(?!=)/.exec(text);
    if (doubleEquals) {
        const idx = doubleEquals.index;
        const line = text.substring(0, idx).split('\n').length - 1;
        const lineStart = text.lastIndexOf('\n', idx) + 1;
        errors.push({
            message: "Use '=' instead of '==' in SOQL",
            line,
            startCol: idx - lineStart,
            endCol: idx - lineStart + 2,
        });
    }

    // LIMIT must be a positive integer
    const limitMatch = text.match(/\bLIMIT\s+(\S+)/i);
    if (limitMatch) {
        const val = limitMatch[1];
        if (!/^\d+$/.test(val) || parseInt(val, 10) <= 0) {
            const idx = text.toUpperCase().indexOf('LIMIT');
            const valStart = idx + limitMatch[0].indexOf(val);
            const line = text.substring(0, valStart).split('\n').length - 1;
            const lineStart = text.lastIndexOf('\n', valStart) + 1;
            errors.push({
                message: 'LIMIT must be a positive integer',
                line,
                startCol: valStart - lineStart,
                endCol: valStart - lineStart + val.length,
            });
        }
    }

    // OFFSET must be a non-negative integer
    const offsetMatch = text.match(/\bOFFSET\s+(\S+)/i);
    if (offsetMatch) {
        const val = offsetMatch[1];
        if (!/^\d+$/.test(val)) {
            const idx = text.toUpperCase().indexOf('OFFSET');
            const valStart = idx + offsetMatch[0].indexOf(val);
            const line = text.substring(0, valStart).split('\n').length - 1;
            const lineStart = text.lastIndexOf('\n', valStart) + 1;
            errors.push({
                message: 'OFFSET must be a non-negative integer',
                line,
                startCol: valStart - lineStart,
                endCol: valStart - lineStart + val.length,
            });
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

    // Duplicate top-level clauses (outside subqueries)
    const clausePattern = /\b(WHERE|ORDER\s+BY|GROUP\s+BY|LIMIT|OFFSET)\b/gi;
    const clauseCounts = new Map<string, { count: number; lastIdx: number }>();
    let clauseMatch;
    let parenDepth = 0;
    // Track paren depth for each position
    const parenDepths: number[] = new Array(text.length).fill(0);
    let pd = 0;
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') { pd++; }
        if (text[i] === ')') { pd--; }
        parenDepths[i] = pd;
    }
    while ((clauseMatch = clausePattern.exec(text)) !== null) {
        if (parenDepths[clauseMatch.index] > 0) { continue; } // inside subquery
        const key = clauseMatch[1].toUpperCase().replace(/\s+/g, ' ');
        const entry = clauseCounts.get(key) || { count: 0, lastIdx: 0 };
        entry.count++;
        entry.lastIdx = clauseMatch.index;
        clauseCounts.set(key, entry);
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

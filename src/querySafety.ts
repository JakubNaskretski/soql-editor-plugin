export const AUTO_EXECUTE_COUNT_THRESHOLD = 5000;

export function hasLimitClause(query: string): boolean {
    return /\bLIMIT\s+\d+/i.test(query);
}

export function buildCountQuery(query: string): string | null {
    const match = query.match(/\bFROM\b\s+([\s\S]*)/i);
    if (!match) { return null; }
    const afterFrom = match[1]
        .replace(/\bORDER\s+BY\b[\s\S]*/i, '')
        .replace(/\bGROUP\s+BY\b[\s\S]*/i, '')
        .replace(/\bOFFSET\s+\d+/i, '')
        .trim()
        .replace(/\s*;?\s*$/, '');
    return `SELECT COUNT() FROM ${afterFrom}`;
}

export function applyLimit(query: string, limit: number): string {
    return query.replace(/\s*;?\s*$/, '') + ` LIMIT ${limit}`;
}

export function shouldPromptForCount(totalRows: unknown): boolean {
    const rowCount = typeof totalRows === 'number' ? totalRows : parseInt(String(totalRows), 10);
    if (Number.isNaN(rowCount)) { return true; }
    return rowCount > AUTO_EXECUTE_COUNT_THRESHOLD;
}

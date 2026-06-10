/** Central SOQL keyword/function catalogs and fuzzy ranking utility. */
export const SOQL_CLAUSE_KEYWORDS = [
    'SELECT',
    'FROM',
    'WHERE',
    'GROUP BY',
    'HAVING',
    'ORDER BY',
    'LIMIT',
    'OFFSET',
    'WITH SECURITY_ENFORCED',
    'FOR UPDATE',
    'TYPEOF',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
] as const;

export const SOQL_LOGICAL_KEYWORDS = [
    'AND',
    'OR',
    'NOT',
] as const;

export const SOQL_ORDERING_KEYWORDS = [
    'ASC',
    'DESC',
    'NULLS FIRST',
    'NULLS LAST',
    'ROLLUP',
    'CUBE',
] as const;

export const SOQL_OPERATORS = [
    '=',
    '!=',
    '<',
    '<=',
    '>',
    '>=',
    'LIKE',
    'IN',
    'NOT IN',
    'INCLUDES',
    'EXCLUDES',
] as const;

export const SOQL_AGGREGATE_FUNCTIONS = [
    'COUNT()',
    'COUNT(Id)',
    'COUNT_DISTINCT(',
    'SUM(',
    'AVG(',
    'MIN(',
    'MAX(',
    'GROUPING(',
] as const;

export const SOQL_MISC_FUNCTIONS = [
    'FIELDS(ALL)',
    'FIELDS(STANDARD)',
    'FIELDS(CUSTOM)',
] as const;

export const SOQL_BOOLEAN_LITERALS = [
    'NULL',
    'TRUE',
    'FALSE',
] as const;

export const SOQL_DATE_LITERALS = [
    'YESTERDAY',
    'TODAY',
    'TOMORROW',
    'LAST_WEEK',
    'THIS_WEEK',
    'NEXT_WEEK',
    'LAST_MONTH',
    'THIS_MONTH',
    'NEXT_MONTH',
    'LAST_90_DAYS',
    'NEXT_90_DAYS',
    'LAST_N_DAYS:',
    'NEXT_N_DAYS:',
    'THIS_QUARTER',
    'LAST_QUARTER',
    'NEXT_QUARTER',
    'LAST_N_QUARTERS:',
    'NEXT_N_QUARTERS:',
    'THIS_YEAR',
    'LAST_YEAR',
    'NEXT_YEAR',
    'LAST_N_YEARS:',
    'NEXT_N_YEARS:',
    'THIS_FISCAL_QUARTER',
    'LAST_FISCAL_QUARTER',
    'NEXT_FISCAL_QUARTER',
    'LAST_N_FISCAL_QUARTERS:',
    'NEXT_N_FISCAL_QUARTERS:',
    'THIS_FISCAL_YEAR',
    'LAST_FISCAL_YEAR',
    'NEXT_FISCAL_YEAR',
    'LAST_N_FISCAL_YEARS:',
    'NEXT_N_FISCAL_YEARS:',
    'LAST_N_MONTHS:',
    'NEXT_N_MONTHS:',
    'LAST_N_WEEKS:',
    'NEXT_N_WEEKS:',
] as const;

export const SOQL_FALLBACK_OBJECTS = [
    'Account',
    'Contact',
    'Lead',
    'Opportunity',
    'Case',
    'Task',
    'Event',
    'User',
    'Campaign',
    'OpportunityLineItem',
    'RecordType',
    'ContentDocument',
    'ContentVersion',
    'Attachment',
    'EmailMessage',
] as const;

export const SOQL_ALL_KEYWORDS: readonly string[] = [
    ...SOQL_CLAUSE_KEYWORDS,
    ...SOQL_LOGICAL_KEYWORDS,
    ...SOQL_ORDERING_KEYWORDS,
    ...SOQL_OPERATORS,
    ...SOQL_AGGREGATE_FUNCTIONS,
    ...SOQL_MISC_FUNCTIONS,
    ...SOQL_BOOLEAN_LITERALS,
    ...SOQL_DATE_LITERALS,
];

/** Clause a field suggestion is being offered for. */
export type FieldUsage = 'select' | 'where' | 'order_by' | 'group_by';

/**
 * Whether a field may be offered for the given clause, based on the describe
 * capability flags. Flags are optional (older disk caches and the local-project
 * fallback don't carry them), so only an explicit `false` excludes a field —
 * unknown means "allow", never "hide".
 *
 * This matters most for external (__x) and big (__b) objects, where many
 * columns are not filterable/sortable and suggesting them produces queries
 * that fail at runtime.
 */
export function isFieldUsableIn(
    field: { filterable?: boolean; sortable?: boolean; groupable?: boolean },
    usage: FieldUsage
): boolean {
    switch (usage) {
        case 'where': return field.filterable !== false;
        case 'order_by': return field.sortable !== false;
        case 'group_by': return field.groupable !== false;
        default: return true;
    }
}

export function rankByPartial<T>(
    values: readonly T[],
    toText: (value: T) => string,
    partial: string,
    limit: number
): T[] {
    const lower = partial.toLowerCase();
    const starts: T[] = [];
    const contains: T[] = [];
    const rest: T[] = [];

    for (const value of values) {
        const text = toText(value).toLowerCase();
        if (!partial) {
            rest.push(value);
            continue;
        }
        if (text.startsWith(lower)) {
            starts.push(value);
            continue;
        }
        if (text.includes(lower)) {
            contains.push(value);
        }
    }

    const ranked = partial ? [...starts, ...contains] : rest;
    return ranked.slice(0, limit);
}

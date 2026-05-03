/** Validates and normalizes SObject API names used across the extension. */
const SOBJECT_API_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r|mdt|e|x))?$/;

export function normalizeSObjectApiName(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) { return undefined; }
    if (!SOBJECT_API_NAME_RE.test(trimmed)) { return undefined; }
    return trimmed;
}

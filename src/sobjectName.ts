/**
 * Validates and normalizes SObject API names used across the extension.
 *
 * Accepts:
 *   - Standard names:           Account, MyCustomFoo, EntityDefinition
 *   - Underscore-segmented:     My_Custom_Thing, X_Y_Z
 *   - Custom suffix:            Foo__c, Bar__mdt, Baz__e, Qux__x, Quux__b
 *   - Namespaced + custom:      ns__Foo__c, ns__My_Thing__mdt
 *
 * Rejects:
 *   - Relationship suffix:      Foo__r  (not a queryable SObject)
 *   - Multiple namespace runs:  ns1__ns2__Foo__c, Foo__Bar__Baz__c
 *   - Trailing/leading underscores, empty, double-underscore inside body
 *
 * Path-traversal guarantee: only [A-Za-z0-9_] allowed — no '.', '/', '\\'.
 */
// The leading `(?!.*__r$)` lookahead rejects relationship-suffixed names
// directly. (Without it, the alternation would otherwise admit `Foo__r` as
// `Foo__` (NS) + `r` (body) — see the matching regression test.)
const SOBJECT_API_NAME_RE =
    /^(?!.*__r$)(?:[A-Za-z][A-Za-z0-9]*__)?[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*(?:__(?:c|mdt|e|x|b))?$/;

export function normalizeSObjectApiName(name: string): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) { return undefined; }
    if (!SOBJECT_API_NAME_RE.test(trimmed)) { return undefined; }
    // Defense in depth: the lookahead above already rejects __r, but a stray
    // regex edit could remove the guard silently — keep this explicit reject
    // so the contract holds even if the regex regresses.
    if (/__r$/.test(trimmed)) { return undefined; }
    return trimmed;
}

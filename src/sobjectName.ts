/**
 * Validates and normalizes SObject API names used across the extension.
 *
 * Accepts (namespace? + body + suffix?, i.e. at most two `__` runs):
 *   - Standard names:           Account, MyCustomFoo, EntityDefinition
 *   - Underscore-segmented:     My_Custom_Thing, X_Y_Z
 *   - Custom suffix:            Foo__c, Bar__mdt, Baz__e, Qux__x, Quux__b
 *   - System suffixes:          Foo__Share, Foo__History, Foo__Feed,
 *                               Article__kav, Model__dlm, Foo__hd, ...
 *   - Namespaced + suffix:      ns__Foo__c, ns__Foo__Share, ssot__Individual__dlm
 *   - Underscore in namespace:  vlocity_cmt__Order__c  (managed-package prefix)
 *
 * Rejects:
 *   - Relationship suffix:      Foo__r, ns__Foo__r  (not a queryable SObject)
 *   - Three or more `__` runs:  ns1__ns2__Foo__c, Foo__Bar__Baz__c
 *   - Trailing/leading underscores, empty, double-underscore inside body
 *
 * The suffix is intentionally NOT a whitelist: Salesforce keeps adding system
 * suffixes (__Share, __History, __Feed, __Tag, __kav, __ViewStat, __dlm, __hd,
 * ...) and a whitelist silently breaks the namespaced variant of each one —
 * `ns__Obj__Share` would parse as a double namespace and be rejected, so the
 * object's fields would never be describable (the exact failure mode of the
 * earlier vlocity_cmt bug, one level out). A name with a valid shape that
 * doesn't exist in the org simply fails the describe with a clean CLI error.
 *
 * Path-traversal guarantee: only [A-Za-z0-9_] allowed — no '.', '/', '\\'.
 */
// The leading `(?!.*__r$)` lookahead rejects relationship-suffixed names
// directly. (Without it, the alternation would otherwise admit `Foo__r` as
// `Foo__` (NS) + `r` (body) — see the matching regression test.)
//
// The namespace token mirrors the body's `(?:_[A-Za-z0-9]+)*` so a managed-
// package prefix that contains a single underscore (e.g. `vlocity_cmt`) is
// accepted. The suffix token allows no inner underscore, so `__` stays
// reserved as the separator and 3+ runs (`ns1__ns2__Foo__c`) still reject.
const SOBJECT_API_NAME_RE =
    /^(?!.*__r$)(?:[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*__)?[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)*(?:__[A-Za-z][A-Za-z0-9]*)?$/;

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

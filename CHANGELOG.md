# Changelog

## 0.7.1

- Add a branded extension icon — shown on the Marketplace listing and the activity-bar.

## 0.7.0

- Namespaced system objects now work end to end: share, history, feed, and
  knowledge tables of managed-package objects (`ns__Obj__Share`,
  `ns__Obj__History`, ...) and Data Cloud model objects (`ssot__*__dlm`) can be
  described, cached by sync, and provide field suggestions. Previously they
  showed up after `FROM` but never suggested any fields.
- Editor autocomplete reaches parity with the sidebar:
  - relationship paths complete across dots
    (`Account.Owner.Na` → fields of the related object)
  - a subquery's `FROM` suggests the parent's child relationship names instead
    of object names
- Polymorphic lookups (`Owner.`, `What.`, `Who.`) resolve to the most useful
  target object — `Owner.` now suggests User fields instead of Group fields.
- Smarter clause suggestions: fields that can't be filtered, sorted, or grouped
  are hidden in `WHERE` / `ORDER BY` / `GROUP BY` (most noticeable on external
  `__x` and big `__b` objects). Applies as object metadata is re-synced.
- All custom-suffix objects (`__mdt`, `__e`, `__x`, `__b`, `__dlm`) now rank as
  high as `__c` objects in object suggestions.
- Validation fixes: field aliases in aggregate queries are no longer flagged as
  missing commas, and typing in `HAVING` after a `GROUP BY` now gets the right
  suggestions.

## 0.6.10

- Managed-package support: namespaced object and field names that contain an
  underscore now resolve correctly for autocomplete, validation, and describe.
- Custom metadata types and platform objects (`__mdt`, `__e`, `__x`, `__b`) are
  now picked up by metadata sync, not just standard and `__c` objects.
- "Open record" now uses the CLI front door, so it works even without an active
  browser session.

## 0.6.9

- Add repository link to the marketplace listing (no functional changes).

## 0.6.8

- Clearer query errors: the Salesforce error code, explanation, and `Row:Column`
  are parsed out and shown; the editor squiggles the offending token ("Go to
  Error" / "Show Details"), and the panel shows the full query-echo + caret.
- Autocomplete & validation correctness:
  - field suggestions keep working after a child subquery in the SELECT list
  - `TYPEOF` and field aliases no longer flagged as missing commas / unknown fields
  - duplicate detection works after subqueries; `INCLUDES`/`EXCLUDES`, multi-field
    `ORDER BY`, and multi-condition `WHERE` resolve the token at the cursor
  - relationship-qualified `WHERE` values resolve the related object's picklist
  - escaped backslashes/quotes no longer trigger false "unclosed string"
  - basic `LIMIT`/`OFFSET` numeric validation
- Safety & robustness:
  - CSV/clipboard export neutralizes spreadsheet formula injection
  - query text is never surfaced in raw CLI error messages
  - org/object listing no longer blocks the extension host on activation
  - cross-org object-list cache cleared on org switch; cache now expires (7 days)
  - query execution is cancellable; concurrent runs guarded

## 0.6.7

- Improved query validation:
  - flags missing `FROM`, empty `SELECT`, missing commas between fields
  - rejects invalid operators (`!-`, `=>`, `=!`, `==`)
  - detects aliased duplicate fields
  - duplicate-clause check no longer fooled by text inside string literals
- Empty child subqueries no longer add a phantom `null` column to results.
- Cache survives org alias renames (now keyed by username; existing caches still work).
- One-shot warning when the CLI fails to list objects (instead of silently empty autocomplete).
- Limited workspace trust support — local project scanning and legacy `.soql-cache` migration are disabled in untrusted workspaces.
- New setting `soqlEditor.autoExcludeLegacyCache` to opt out of writing to `.git/info/exclude`.
- Smaller fixes:
  - tighter SObject API name validation
  - server-side validation of record ids before opening externally
  - CLI argv redaction now covers `--flag=value` and short flag forms
  - panel state no longer persists large result rows
  - panel input listeners consolidated; reduced redundant work per keystroke

## 0.6.6

- Reworked metadata sync performance with parallel workers and new settings:
  - `soqlEditor.syncConcurrency`
  - `soqlEditor.describeTimeoutMs`
  - `soqlEditor.describeRetryCount`
- Improved cache UX:
  - clear-cache action is now explicit and org-scoped
  - sync summaries now report fetched/cached/timeout/failure counts
- Improved query safety and configurability:
  - added `soqlEditor.slowQueryWarningThreshold`
  - reduced noisy validation warnings in panel/editor flow
- Improved autocomplete behavior:
  - no unintended pre-selected suggestion rows
  - immediate follow-up suggestions after selecting relationship paths
  - cleaner relationship labels in suggestions
  - subquery-aware scope resolution and `FROM` suggestions for child relationships
- Improved result rendering:
  - child subquery payloads are expanded into readable table columns


# Changelog

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


# Changelog

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


# SOQL Editor — Backlog

## Quick wins
- [ ] Query history — save last N queries, recall with a dropdown or up-arrow
- [x] Clickable record IDs — link 18-char IDs in results to open in browser
- [x] Cell click to copy — single-click a result cell copies its value
- [ ] Column sorting — click results table header to sort asc/desc
- [x] Export to JSON — alongside CSV
- [ ] Bug: double-click on multiline queries can target/select a different line than the cursor location (possibly caused by missing/late refresh of overlay field positioning)
- [ ] Bug: autocomplete dropdown sometimes keeps the 2nd item visually highlighted even when a different item is selected/hovered
- [ ] Performance: reduce delay between clicking Execute Query and actual query start (improve perceived responsiveness)
- [ ] Bug: diagnostics did not detect missing comma between selected fields in some queries
- [ ] Bug: parser/validator currently allows invalid operators like `!-`; tighten operator validation rules
- [ ] Master bug: rework suggestion dropdown lifecycle (show/hide/update/selection state) on solid state-management foundations

## Medium effort
- [ ] Saved/bookmarked queries — name and persist frequently-used queries per org
- [ ] Persist metadata cache across folder close/reopen — keep cached objects available after reopening workspace
- [ ] Query formatter — auto-prettify button (uppercase keywords, indent clauses)
- [ ] Results pagination — "Load more" for queries beyond the first batch
- [ ] Handle multiple AND/OR conditions in WHERE — improve parsing, field suggestions/autocomplete, and diagnostics for complex boolean clauses
- [ ] Add full ORDER BY support — robust parsing plus better sort-field/direction suggestions and validation
- [ ] Add ORDER BY direction helpers — suggest and validate `ASC` / `DESC` (and null ordering options) per sort field
- [ ] Weight parent relationship suggestions right after direct field suggestions (field-first, then parent-object relationship paths)
- [ ] Subquery autocomplete — field suggestions for nested SELECT objects
- [x] SOQL validation before run — highlight syntax errors inline without executing

## Bigger features
- [x] Syntax highlighting — color keywords/strings/numbers in the textarea
- [x] Multiple query tabs — run and compare several queries side by side
- [ ] Query explain plan — run EXPLAIN and show cost/selectivity info
- [ ] Describe object panel — list all fields/types for an object without a query

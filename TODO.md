# SOQL Editor — Backlog

## Quick wins
- [ ] Query history — save last N queries, recall with a dropdown or up-arrow
- [x] Clickable record IDs — link 18-char IDs in results to open in browser
- [x] Cell click to copy — single-click a result cell copies its value
- [ ] Column sorting — click results table header to sort asc/desc
- [x] Export to JSON — alongside CSV

## Medium effort
- [ ] Saved/bookmarked queries — name and persist frequently-used queries per org
- [ ] Query formatter — auto-prettify button (uppercase keywords, indent clauses)
- [ ] Results pagination — "Load more" for queries beyond the first batch
- [ ] Subquery autocomplete — field suggestions for nested SELECT objects
- [x] SOQL validation before run — highlight syntax errors inline without executing

## Bigger features
- [x] Syntax highlighting — color keywords/strings/numbers in the textarea
- [x] Multiple query tabs — run and compare several queries side by side
- [ ] Query explain plan — run EXPLAIN and show cost/selectivity info
- [ ] Describe object panel — list all fields/types for an object without a query

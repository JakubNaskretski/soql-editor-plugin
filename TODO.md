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

---

## Audit follow-up (from `docs/AUDIT_REPORT.md`, 2026-05-03)

### Done — shipped on `fix/audit-tier1-fixes`
- [x] **P1.1** Subquery-aware FROM resolution. `extractFromObject` now prefers the depth-0 FROM; the editor completion provider resolves the SObject for the cursor's scope (parent → child relationship lookup). Fixes false "Unknown field" warnings and wrong autocomplete inside outer SELECTs that contain subqueries.
- [x] **P1.2 / P1.3 / P1.6** `hasLimitClause`, `buildCountQuery`, and `applyLimit` rewritten on a paren- and string-aware token scanner (`findKeywordHits` in `soqlParser.ts`). Subquery LIMITs and the literal text "limit" inside string literals no longer fool the COUNT preflight; `applyLimit` replaces an existing top-level LIMIT instead of appending a duplicate.
- [x] **P1.4** Sidebar spinner clears when the user dismisses the COUNT preflight warning (panel posts an `info` message on cancel instead of returning silently).
- [x] **P1.5** Closing a sidebar tab now persists the active tab's text first so unsaved keystrokes are not overwritten by `restoreTab`.
- [x] **P3.1** Editor execution path honors `soqlEditor.slowQueryWarningThreshold` (was hard-coded to the 5000-row default).

### Open — still to address

#### Validator gaps (P2)
- [ ] **P2.1** Detect missing comma between SELECT fields (`SELECT Id Name FROM Account`). *Already listed in Quick wins; cross-reference.*
- [ ] **P2.2** Reject invalid operator runs like `!-`, `=>`, `=!`. *Cross-reference Quick wins entry.*
- [ ] **P2.3** Flag empty SELECT clause (`SELECT FROM Account`).
- [ ] **P2.4** Detect aliased duplicates in SELECT (`SELECT Id, Id alias FROM Account`); also fix duplicate position-finder when a token contains spaces.
- [ ] **P2.5** `extractSelectFields` silently swallows empty trailing comma slot — caller can't distinguish "2 fields" from "2 fields + empty".
- [ ] **P2.6** Duplicate-clause check should be string-aware (currently only paren-aware) so `WHERE Name LIKE '(LIMIT 5)'` cannot mis-classify a clause as nested.
- [ ] **P2.7** Validate that a query has a `FROM` at all (currently `SELECT Id` produces no diagnostic).

#### UX/consistency (P3)
- [ ] **P3.2** Use the org's `username` (not `alias`) as the cache directory key, so renaming the alias does not orphan the cache.
- [ ] **P3.3** Drop the phantom `Foo[0] = null` column emitted for empty child subqueries; keep only the `totalSize` / `done` columns.
- [ ] **P3.4** Decide and document how top-level array fields (e.g. multi-picklists) flatten — currently JSON-stringified, while subquery records are expanded.
- [ ] **P3.5** Tighten `normalizeSObjectApiName` — currently accepts shapes like `Object__r` (relationship suffix) and `ns__Inner__Object__c` (multiple namespace separators).
- [ ] **P3.6** De-duplicate the two `[cmd]` log lines emitted per `executeQuery` (pass a `logLabel` so `runCliAsync` doesn't double-log).
- [ ] **P3.7** Surface `getObjectList` errors in the UI; currently the catch returns `[]` and autocomplete silently empties out.
- [ ] **P3.8** Resolve nested-subquery scope SObjects via parent's `childRelationships` even when intermediate parent metadata isn't cached (today the chain falls back to the relationship name).
- [ ] **P3.9** Trim webview state: don't persist `rows` / `rawRows` for all 3 tabs into `vscode.setState` (can exceed silent size budget with 10k-row results).
- [ ] **P3.10** Consolidate duplicate `input`/`keyup` listeners in `panel.js`; `highlightSoql` runs three times per keystroke today.
- [ ] **P3.11** Declare `capabilities.untrustedWorkspaces` in `package.json` and gate the local-project scanner behind workspace trust.

#### Polish (P4)
- [ ] **P4.1** Re-evaluate the `cacheExpiryDays = 0` default (caches never expire today).
- [ ] **P4.2** Relationship-chain auto-`requestSuggestions` after `.` insertion can race validation — coalesce.
- [ ] **P4.3** When an `error` arrives, also clear `currentErrors` so stale squiggles don't linger over the textarea.
- [ ] **P4.4** Webview `keyup` handler runs `highlightSoql` even on arrow-key navigation; cosmetic but wasteful.
- [ ] **P4.5** Update `<div id="jsCheck">` banner copy ("scripts may be blocked" → "out/panel.js missing or failed to load").
- [ ] **P4.6** README/command title mismatch: README says `SOQL: Refresh Object Metadata`, package.json exposes the same id with title `SOQL: Clear Cache`. Pick one.
- [ ] **P4.7** Centralize the `_objectList.json` write so concurrent describe workers don't race on read-modify-write.
- [ ] **P4.8** Comment or replace `String(v || '')` in panel CSV/copy helpers — fragile if `flattenRecordForDisplay` ever stops stringifying.
- [ ] **P4.9** Add a JS syntax check to `scripts/copy-panel-js.mjs` so a broken `panel.js` fails the build instead of surfacing as a runtime banner.

#### Security (S)
- [ ] **S1** *(same as P3.11)* Workspace-trust opt-in.
- [ ] **S2** Re-validate `recordId` server-side in `openRecord` before composing `instanceUrl/recordId` (today only the webview client validates the shape).
- [ ] **S3** Centralize CLI log redaction so `runCliSync` cannot leak full argv with sensitive flags.
- [ ] **S5** Consider gating `addToGitExclude` behind a config; today it silently appends to `.git/info/exclude`.
- [ ] **S6** Make `copyDirRecursive` symlink-aware (the top-level link is skipped, but children traverse via `fs.copyFileSync` which follows links).

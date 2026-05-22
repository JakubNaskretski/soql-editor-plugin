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
- [x] **P2.1** Detect missing comma between SELECT fields (`SELECT Id Name FROM Account`). *Heuristic flag on two bare identifiers in one SELECT slot.*
- [x] **P2.2** Reject invalid operator runs like `!-`, `=>`, `=!`, `==`. *Scans WHERE for any `[=!<>]`-built run not in the valid-op set.*
- [x] **P2.3** Flag empty SELECT clause (`SELECT FROM Account`).
- [x] **P2.4** Detect aliased duplicates in SELECT (`SELECT Id, Id alias FROM Account`); duplicate-position finder now uses alias-stripped head.
- [x] **P2.5** Documented as intentional in the `extractSelectFields` JSDoc — callers needing strict slot semantics should rely on `validateSoqlStructure`'s trailing/leading-comma diagnostics instead.
- [x] **P2.6** Duplicate-clause check is now string- and paren-aware (rebuilt on `findKeywordHits` at depth 0).
- [x] **P2.7** Validate that a query has a `FROM` at all — `SELECT Id` now produces a diagnostic.

#### UX/consistency (P3)
- [x] **P3.2** Cache directory now keyed by `username` (with alias-fallback so old caches keep working).
- [x] **P3.3** Phantom `Foo[0] = null` column dropped for empty child subqueries — only `totalSize`/`done` are emitted.
- [x] **P3.4** Documented in `resultFlattening.ts`: top-level arrays render as compact JSON. Only child-subquery payloads (objects with a `records` array) expand into per-index columns. Multi-picklists arrive as semicolon-joined strings from the API and travel the scalar path.
- [x] **P3.5** `normalizeSObjectApiName` tightened — rejects `__r` suffix and multiple namespace separators; covered by `sobjectName.test.ts`.
- [x] **P3.6** `executeQuery` now passes a `logLabel` to `runCliAsync`, so only one redacted `[cmd]` line per query.
- [x] **P3.7** `getObjectList` errors now surface once via `vscode.window.showWarningMessage` (deduped by message).
- [ ] **P3.8** Resolve nested-subquery scope SObjects via parent's `childRelationships` even when intermediate parent metadata isn't cached (today the chain falls back to the relationship name).
- [x] **P3.9** `persistState` now writes a slim snapshot (query/errors only) so 10k-row results don't blow the `vscode.setState` size budget. Live `tabs[]` array still carries rows in memory.
- [x] **P3.10** Consolidated to a single `input` listener; removed the duplicate `change`/`keyup` `highlightSoql` calls. Non-nav keyups now early-return.
- [x] **P3.11** `capabilities.untrustedWorkspaces` declared as "limited"; local-project scanner now returns `[]` and migration/git-exclude writes are gated when the workspace is untrusted.

#### Polish (P4)
- [ ] **P4.1** Re-evaluate the `cacheExpiryDays = 0` default (caches never expire today).
- [x] **P4.2** Relationship-chain `requestSuggestions` after `.` insertion now coalesces with the main suggestion-debounce timer (60ms) instead of firing immediately and racing validation.
- [x] **P4.3** `error` message handler now clears `currentErrors`, re-renders the error list, and re-runs `highlightSoql` so stale squiggles disappear.
- [x] **P4.4** Keyup handler now early-returns when the key isn't a navigation key (no more `highlightSoql` on Arrow/Home/End — and the duplicate `keyup → highlightSoql` listener was removed entirely).
- [x] **P4.5** Banner copy updated to "out/panel.js missing or failed to load".
- [x] **P4.6** README aligned with command title (`SOQL: Clear Cache`).
- [x] **P4.7** Reviewed — not a real race. `addObjectToDiskObjectList` is fully synchronous (`readFileSync`/`writeFileSync`) and runs from within sync `saveToDiskCache`. With JS single-threaded execution and no `await` between the read and the write, concurrent workers cannot interleave. *No change required.*
- [x] **P4.8** Copy/CSV helpers now explicitly null/undefined-check and stringify (`v === null/undefined ? '' : String(v)`); 0/false survive verbatim.
- [x] **P4.9** `scripts/copy-panel-js.mjs` now syntax-checks `src/panel.js` via `vm.Script` before copying; a broken script fails the build.

#### Security (S)
- [x] **S1** *(same as P3.11)* Workspace-trust opt-in declared and enforced.
- [x] **S2** `openRecord` re-validates `recordId` server-side against the same 15/18-char regex before composing the URL.
- [x] **S3** Both `runCliSync` and `runCliAsync` now run argv through `redactArgsForLog`, which drops values after sensitive flags (`--query`, `--password`, `--token`). New flags only need to be added to one allowlist.
- [x] **S5** Added `soqlEditor.autoExcludeLegacyCache` (default `true`). Users who don't want the extension touching `.git/info/exclude` can flip it off; still gated by workspace trust.
- [x] **S6** `copyDirRecursive` skips symlink entries via `entry.isSymbolicLink()` (which uses lstat semantics), so malicious symlinks under `.soql-cache` can no longer steer migration into arbitrary read/unlink.

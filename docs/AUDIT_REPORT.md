# SOQL Editor Extension — Validation & Audit Report

**Scope:** [`soql-editor/`](../) (VS Code extension v0.6.5)
**Date:** 2026-05-03
**Method:** Static review of `src/**`, ran the Vitest suite (41/41 passing), and exercised the compiled helpers in `out/` against ~50 contrived edge-case inputs.
**Note:** Supersedes the earlier 2026-04-27 report (v0.6.0). Several previously flagged Critical/High items have been addressed (CLI now uses `execFile` with argv, SObject names normalized, path traversal blocked, diagnostics generation counter, org picker carries `OrgInfo` on the QuickPick item, log redacts query body). The findings below focus on what remains and on regressions/gaps observed in current behavior.

**Status update (2026-05-03, branch `fix/audit-tier1-fixes`):** P1.1, P1.2, P1.3, P1.4, P1.5, P1.6 and P3.1 are now fixed in code with tests. Open items have been migrated to `TODO.md` under the "Audit follow-up" section.

---

## 1. Use-case matrix (validated against code)

| ID | Use case | Entry | Primary code | Status |
|----|-----------|-------|--------------|--------|
| U1 | Open/edit `.soql` | `onLanguage:soql` | [extension.ts](../src/extension.ts), completions/diagnostics | **OK** — debounced, generation-guarded validation |
| U2 | Open sidebar “SOQL Query” | `onView:soqlEditor.panel` | [soqlPanelProvider.ts](../src/soqlPanelProvider.ts), [panelHtml.ts](../src/panelHtml.ts), [panel.js](../src/panel.js) | **Partial** — multi-tab, syntax-highlighted overlay, but several state/lifecycle edge cases (see §2) |
| U3 | Execute query from editor | `Cmd/Ctrl+Enter` / command | [queryExecutor.ts](../src/queryExecutor.ts) | **Brittle** — COUNT preflight skipped on subquery LIMIT; ignores `slowQueryWarningThreshold` |
| U4 | Execute query from panel | Run button | [soqlPanelProvider.ts](../src/soqlPanelProvider.ts) `handleExecuteQuery` | **Brittle** — same COUNT issue + spinner sticks if user dismisses warning |
| U5 | Select org | Status bar / `SOQL: Select Org` / panel org label | [orgPicker.ts](../src/orgPicker.ts) | **OK** — fixed: now carries `OrgInfo` on the QuickPick item |
| U6 | Default org on startup | `orgPicker.autoSelectDefault()` | [extension.ts](../src/extension.ts), [orgPicker.ts](../src/orgPicker.ts) | **OK** — silent fail if CLI missing |
| U7 | Refresh metadata | `SOQL: Clear Cache` (label says “Clear”, command id is `refreshMetadata`) | [extension.ts](../src/extension.ts) | **Minor mismatch** — README still says “Refresh Object Metadata” |
| U8 | Sync all / common | Commands + panel quick actions | [metadataProvider.ts](../src/metadataProvider.ts) | **OK** — workers, retry, timeout configurable |
| U9 | Cache single object | Panel → Load Metadata → single | [soqlPanelProvider.ts](../src/soqlPanelProvider.ts) | **OK** — normalized via `normalizeSObjectApiName`; argv-only CLI |
| U10 | Autocomplete (editor) | Typing `.`, `,`, ` ` | [completionProvider.ts](../src/completionProvider.ts) | **Partial** — uses subquery-blind `extractFromObject`; broken inside subqueries |
| U11 | Diagnostics | Open/change document | [diagnosticsProvider.ts](../src/diagnosticsProvider.ts) | **Partial** — same subquery blindness (see §2 P1); structural validator misses several common errors |
| U12 | Suggestions in panel | `requestSuggestions` | [panelSuggestions.ts](../src/panelSuggestions.ts) | **OK** — uses subquery-aware `extractScopedFromInfo` |
| U13 | Open record from Id | Click Id link in panel results | [panel.js](../src/panel.js), `openRecord` in provider | **OK** — argv-side regex client, server validates `instanceUrl`; record id only client-validated, but `openExternal` applied to `Uri.parse(instanceUrl/recordId)` |
| U14 | Copy / CSV / JSON | Panel actions | [soqlPanelProvider.ts](../src/soqlPanelProvider.ts) | **OK** |
| U15 | Legacy `.soql-cache` migration | First workspace open | [extension.ts](../src/extension.ts) `migrateLegacyCache` | **OK** — fixed: per-folder success tracking + retry on partial failure |
| U16 | Git exclude `.soql-cache` | Activate | [extension.ts](../src/extension.ts) `addToGitExclude` | **OK** |
| U17 | Reuse other org cache / local fallback | Org-readiness prompt | [extension.ts](../src/extension.ts) `maybePromptForMetadataReadiness`, [metadataProvider.ts](../src/metadataProvider.ts) | **OK** — bounded inside cache root, source-state persisted |

---

## 2. Functional & logic findings

These are deviations from what the plugin appears to assume — either silently broken behavior, misleading UX, or guard rails that don’t actually guard.

### P1 – Critical / impactful

**[FIXED] P1.1 `extractFromObject` is subquery-blind — wrong root object inside subqueries.**
[soqlParser.ts:165](../src/soqlParser.ts#L165) is `text.match(/\bFROM\s+([A-Za-z_][A-Za-z0-9_]*)/i)` — first match wins, so:
- `SELECT Id, (SELECT Id FROM Contacts) FROM Account` → returns `Contacts` instead of `Account`.
- This function is the input to:
  - [diagnosticsProvider.ts:86](../src/diagnosticsProvider.ts#L86) — every field outside the subquery is validated against `Contacts`, producing false “Unknown field” warnings.
  - [completionProvider.ts:111](../src/completionProvider.ts#L111) and [completionProvider.ts:217](../src/completionProvider.ts#L217) — editor autocomplete for the outer SELECT/WHERE/ORDER suggests fields of the subquery’s relationship token, not the real outer SObject.
  - [metadataProvider.ts:390](../src/metadataProvider.ts#L390) — `reconcileSuccessfulQuery` records placeholders against the wrong object after a subquery query runs.
- A subquery-aware variant (`extractScopedFromInfo`) already exists and is used by `panelSuggestions.ts`. Editor providers and metadata reconcile should switch to it (or fall back to it when paren depth > 0 / there are multiple top-level FROM tokens).

**[FIXED] P1.2 `hasLimitClause` is fooled by subquery LIMITs and string-literal text.**
[querySafety.ts:5](../src/querySafety.ts#L5) regex is `/\bLIMIT\s+\d+/i` over the raw text. Confirmed:
- `SELECT Id, (SELECT Id FROM Contacts LIMIT 1) FROM Account` → returns **true**, so the outer COUNT preflight is **skipped**, defeating the “warn before huge result” guarantee that both [queryExecutor.ts:47](../src/queryExecutor.ts#L47) and [soqlPanelProvider.ts:220](../src/soqlPanelProvider.ts#L220) rely on.
- `SELECT Id FROM Account WHERE Name = 'limit 200'` → also returns **true** (matched inside string literal).
- Should walk top-level tokens with paren/string awareness (the parser already has `getQueryDepthAtOffset` and string-aware scanners that could be reused).

**[FIXED] P1.3 `buildCountQuery` produces a syntactically broken query for any SELECT containing a subquery.**
[querySafety.ts:8](../src/querySafety.ts#L8) takes the first FROM and treats everything after it as the FROM tail. Confirmed outputs:
- Input: `SELECT Id, (SELECT Id FROM Contacts) FROM Account WHERE Name != null`
  Output: `SELECT COUNT() FROM Contacts) FROM Account WHERE Name != null` (mismatched paren, two FROMs).
- The CLI rejects this; the COUNT preflight throws and the catch swallows it (`// COUNT failed — fall through and run anyway`), so a query that was supposed to be guarded runs unbounded.
- Combined with P1.2 this means the "fast path skip" *and* the fallback both behave wrong on subquery queries.

**[FIXED] P1.4 Panel spinner sticks forever if user dismisses the COUNT-preflight warning.**
[soqlPanelProvider.ts:217](../src/soqlPanelProvider.ts#L217) emits `queryStarted` (panel shows the spinner and disables Run). [soqlPanelProvider.ts:236](../src/soqlPanelProvider.ts#L236) does `if (!choice) { return; }` — no `error`/`info`/`queryResults` is ever posted, so the panel button stays in “Running...” and the spinner never clears. Editor path is fine because the progress notification closes when the function returns.

**[FIXED] P1.5 Sidebar tab close discards in-flight edits in another tab.**
[panel.js:129](../src/panel.js#L129) `closeTab(idx)` does `tabs.splice(idx, 1)` and then `restoreTab(activeTab)` — it never calls `saveCurrentTab()` first. If the user is editing tab 1 and clicks the × on tab 0, the splice promotes tab 1 to slot 0 *with its last persisted query*, and `restoreTab(0)` overwrites the textarea, **losing the user’s typed-but-not-yet-persisted text**. The editor path persists on every keystroke (`onInputChange`), so the window is small but real (text typed since last keystroke event).

**[FIXED] P1.6 `applyLimit` blindly appends `LIMIT N` even if a LIMIT already exists.**
[querySafety.ts:20](../src/querySafety.ts#L20). With P1.2 in play, you can hit a path where `hasLimitClause` returned false (because text really has no top-level LIMIT) but a *new* COUNT pop-up adds “LIMIT 200” to a query that already has, say, a subquery LIMIT — producing `... LIMIT 1) FROM Account LIMIT 200`, which is malformed. Fix is to either (a) detect the top-level LIMIT precisely, or (b) replace any trailing top-level LIMIT instead of appending.

### P2 – High impact / structural validator gaps

These are in [soqlParser.ts:404](../src/soqlParser.ts#L404) `validateSoqlStructure`. Each is also listed in `TODO.md`, but they continue to confuse users:

**P2.1 Missing-comma between SELECT fields not detected.** `SELECT Id Name FROM Account` produces no diagnostic. (TODO.md item.)

**P2.2 Invalid operator characters not caught.** `WHERE Name !- null`, `>-`, `=!`, `=>` all parse cleanly. Only `==` is flagged.

**P2.3 `SELECT FROM Account` — missing field list — not flagged.** The validator only catches leading/trailing commas, not empty SELECT.

**P2.4 Aliased duplicates and trivially obvious duplicates aren’t both detected.**
- `SELECT Id, Id alias FROM Account` → no diagnostic (the second token is `Id alias`, which differs textually from `Id`).
- `SELECT Id, id FROM Account` → correctly flagged (case-insensitive lowercase comparison).
- The duplicate-finder regex (`new RegExp('\\b' + fields[fi] + '\\b', 'gi')`) won’t locate `Id alias` either, so the position would be wrong even if detection worked.

**P2.5 `extractSelectFields` silently swallows empty trailing columns.** `SELECT Id, Name,  FROM Account` is split as `['Id','Name']` — the trailing comma is detected by a separate path but the function itself doesn’t signal the slot is empty, so callers can’t tell the difference between “2 fields, fine” and “2 fields with trailing nothing”.

**P2.6 Duplicate-clause check tracks paren depth but not string state.** [soqlParser.ts:561](../src/soqlParser.ts#L561) builds the `parenDepths` array character-by-character with no awareness of quoted strings, so `WHERE Name LIKE '(LIMIT 5)'` could mis-classify a clause as nested. Low real-world frequency, but inconsistent with the rest of the parser.

**P2.7 `validateSoqlStructure` does not verify a `FROM` is even present.** A pure `SELECT Id` produces no errors and no diagnostic, even though it is unrunnable.

### P3 – Medium impact

**[FIXED] P3.1 Editor execution path ignores `soqlEditor.slowQueryWarningThreshold`.**
The setting exists ([package.json:136](../package.json#L136)), the panel honors it ([soqlPanelProvider.ts:227](../src/soqlPanelProvider.ts#L227)), but [queryExecutor.ts:53](../src/queryExecutor.ts#L53) calls `shouldPromptForCount(totalRows)` with no second argument, so the editor command-line path always uses the 5000 default. Inconsistency surfaces directly to users.

**P3.2 Cache directory keyed by alias, not username.**
[metadataProvider.ts:186](../src/metadataProvider.ts#L186) sanitizes `org.alias`. Two consequences:
- Renaming the alias (`sf alias set` / `sfdx force:alias:set`) silently orphans the cache.
- An org with alias collision (rare but possible across CI/scratch flows) produces overlapping caches.
- Username is the stable identifier and is what the rest of the CLI plumbing uses (`--target-org`).

**P3.3 `flattenChildSubquery` emits a phantom `[0]` row when records is empty.**
[resultFlattening.ts:57](../src/resultFlattening.ts#L57): `if (records.length === 0) { out[\`${keyPath}[0]\`] = 'null'; return; }` — produces a column like `Contacts[0]` with value `null` for accounts that genuinely have no contacts. Confusing for users who scan results.

**P3.4 `flattenValue` JSON-stringifies arrays found *directly* under a record.**
[resultFlattening.ts:21](../src/resultFlattening.ts#L21). `record.tags = ['x','y']` becomes a single `'["x","y"]'` cell — a noticeable departure from how subquery records are expanded into multiple cells. Either intentional (top-level scalar arrays are rare in SOQL) or a gap (some platform fields like multi-picklists arrive as joined strings, but the document does say "JSON.stringify"). Document or change.

**P3.5 Object-name normalization is laxer than Salesforce API rules.**
[sobjectName.ts:2](../src/sobjectName.ts#L2) regex `^[A-Za-z][A-Za-z0-9_]*(?:__(?:c|r|mdt|e|x))?$` accepts:
- `Object__r` (relationship suffix isn’t a real SObject — querying `Object__r` will fail).
- `ns__Inner__Object__c` (real Salesforce names allow at most one namespace prefix, but the validator allows multiple `__` runs because `[A-Za-z0-9_]*` is greedy).
- The only direction this actually matters: file system + CLI argv get a "valid-shaped" name that still produces a confusing `sobject describe` error. Acceptable as a path-traversal guard, lax as a semantic check.

**P3.6 Two CLI log lines per `executeQuery` call.**
[sfCliService.ts:203](../src/sfCliService.ts#L203) logs `(query redacted, length=...)`, then `runCliAsync` logs again because no `logLabel` is passed. Cosmetic, but the panel’s log overlays show duplicate `$ sf data ...` lines.

**P3.7 `getObjectList` swallows CLI errors silently.**
[sfCliService.ts:136](../src/sfCliService.ts#L136) returns `[]` on any error. The user-facing experience is “autocomplete just stops working” with no surfaced reason. The Output channel logs the error, but most users will never look there.

**P3.8 `extractScopedFromInfo` cannot resolve the SObject for child relationships in nested subqueries without parent metadata being cached.**
[panelSuggestions.ts:464](../src/panelSuggestions.ts#L464) `resolveScopeObject` walks parents and falls back to the relationship name as the SObject when no describe is cached for the parent. That fallback is harmless for suggestions (returns `Contacts` instead of `Contact` so describes will miss), but it can cascade quietly in deeply nested queries — users see “no suggestions” without an explanation.

**P3.9 Webview state can outgrow the `vscode.setState` budget.**
[panel.js:143](../src/panel.js#L143) `persistState` serializes all 3 tabs’ `rows`/`rawRows` into webview state. With the documented 10,000-row render cap × 3 tabs, the JSON blob can easily reach multi-MB and may exceed the silent state size limit, causing partial loss across reloads. A lightweight "drop result rows from persisted state, keep query text only" pass would protect this.

**P3.10 `panel.js` has duplicate `input`/`keyup` listeners.**
[panel.js:268](../src/panel.js#L268) and [panel.js:776](../src/panel.js#L776) both register `input`; [panel.js:291](../src/panel.js#L291) and [panel.js:778](../src/panel.js#L778) both register `keyup`. Each keystroke runs `requestSuggestions` debounce, `requestValidation` debounce, `persistState`, `highlightSoql` — and `highlightSoql` fires a third time from `keyup`. Heavy textareas (long queries) reflow the syntax overlay on every keypress. Performance smell more than a bug.

**P3.11 No workspace trust handling.**
The package contributes commands and runs `sf` against workspace-derived metadata (notably [localProjectScanner.ts:170](../src/localProjectScanner.ts#L170) reading `sfdx-project.json`) without declaring `capabilities.untrustedWorkspaces` in `package.json`. VS Code best practice is to either declare “limited” mode or to opt out of running scanner code on untrusted workspaces. Right now a malicious repo can choose package directory paths (constrained to workspace, but still chosen by the repo) and seed metadata that inflates fallback caches.

### P4 – Low impact / cosmetic

**P4.1 Default `cacheExpiryDays = 0` means caches *never* expire.** Documented behavior, but the “configurable freshness” surface is effectively dormant by default. Worth flipping the default or warning in README.

**P4.2 `panel.js` line [360](../src/panel.js#L360) dropdown-after-`.` chaining races validation/highlight.** The relationship chaining `setTimeout(() => requestSuggestions(), 0)` fires before validation comes back; flickering can occur on slow metadata.

**P4.3 `error` message doesn’t reset `currentErrors`.** [panel.js:506](../src/panel.js#L506) shows the error but leaves prior squiggles in the textarea overlay until the next valid validation result arrives.

**P4.4 Webview `input` debounce is independent of keyboard nav.** Pressing `ArrowDown` fires `keydown` (handled), but `keyup` still hits the bottom-of-file listener that re-runs `highlightSoql`. Cosmetic.

**P4.5 `panel.js` `<div id="jsCheck">` banner.** Currently disabled via `display: none` on first JS line. If the script fails to load (CSP misconfiguration, missing `out/panel.js` after a packaging bug), the banner stays visible — that’s the intended fallback. Fine, but the wording "scripts may be blocked" is misleading because the actual failure mode in this codebase is "out/panel.js is missing" (packaging issue caught by `webviewAssets.test.ts`). Adjust copy.

**P4.6 README mismatch for command title.**
README documents `SOQL: Refresh Object Metadata`; `package.json` exposes the same command id with title `SOQL: Clear Cache`. The activation log/messages also call it "Cache cleared".

**P4.7 `_objectList.json` writes can interleave under concurrent describes.**
[metadataProvider.ts:556](../src/metadataProvider.ts#L556) `addObjectToDiskObjectList` reads → mutates → writes synchronously on every successful describe during sync. With `syncConcurrency=4` (default) and `Promise.all` workers calling `saveToDiskCache` simultaneously, the intermediate read can miss writes from peers and lose names. `Set` semantics absorb most damage but races still favor the last writer. Worth either centralizing the object list write to once-after-sync or guarding with a queue.

**P4.8 `panel.js` numeric-zero data path is fine, but `String(v || '')` looks unsafe for non-string sources.**
Today `r[c]` always arrives as a string from `flattenRecordForDisplay`, so the `r[c] || ''` shortcut at [panel.js:214](../src/panel.js#L214) and [panel.js:221](../src/panel.js#L221) does not corrupt 0/false. If `flattenRecordForDisplay` is ever changed to keep numbers/booleans as-is, this becomes a real bug. Add a comment, or use `r[c] ?? ''`.

**P4.9 `compile` script copies `panel.js` without minification or content checks.** Not a security issue, but if `src/panel.js` ever becomes invalid JS, the symptom is the runtime banner inserted at [panel.js:788](../src/panel.js#L788). Consider a syntax check in the script.

---

## 3. Security review

The big-ticket items from the prior report (shell command injection, unquoted argv, path traversal in cache writes, query in plaintext logs, OrgPicker QuickPick description aliasing) have been **addressed**. What remains:

### S1 – Workspace-trust gap (medium)
Already covered as P3.11. `localProjectScanner` follows config-driven paths (`packageDirectories[].path`); even with the workspace-root containment check, a malicious repo can point the scanner at any directory under the workspace and harvest its XML/JSON files into the local-fallback metadata. Declaring `capabilities.untrustedWorkspaces` in `package.json` is the conventional mitigation.

### S2 – `openExternal` constructs URL from `instanceUrl` + arbitrary `recordId` (low)
[soqlPanelProvider.ts:108](../src/soqlPanelProvider.ts#L108): `vscode.Uri.parse(\`${org.instanceUrl}/${msg.recordId}\`)`. The webview client filters the link with `^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$` ([panel.js:553](../src/panel.js#L553)) before placing the link, but the *server* trusts whatever `recordId` arrives in the message. `Uri.parse` would normalize most odd inputs (the worst risk is URL-fragment shenanigans on the org domain), and `openExternal` requires user confirmation in VS Code, so blast radius is small. Safer pattern: re-validate `recordId` on the server side before composing the URL.

### S3 – CLI log redaction is partial (low)
`executeQuery` redacts the query body, but [sfCliService.ts:225](../src/sfCliService.ts#L225) `runCliSync` logs the full args array (`sf ${args.join(' ')}`). For `sobject list` and `org list` this is fine, but if argv assembly ever pushes additional flags carrying sensitive content (auth tokens, future filters), it’ll leak. Consider central log redaction in `runCliSync`/`runCliAsync` (e.g. drop anything after `--query`).

### S4 – Webview HTML-escaping holds, but error fallback banner uses concatenation (low)
[panel.js:794](../src/panel.js#L794) `banner.textContent = 'JS Init Error: ' + message;` — `textContent`, not `innerHTML`, so this is safe. (Fixed since prior audit.)

### S5 – `addToGitExclude` writes to `.git/info/exclude` (low)
[extension.ts:299](../src/extension.ts#L299) appends `.soql-cache` to the workspace’s git exclude file silently. Modifying `.git/info/exclude` is generally benign but is a side effect users may not expect. Consider gating it behind a config (`soqlEditor.autoExcludeLegacyCache`) or skipping when the legacy `.soql-cache` is no longer present anywhere.

### S6 – `Symlink check is top-level only.**
[extension.ts:371](../src/extension.ts#L371) skips a top-level symlinked `.soql-cache` directory but still recurses into the tree via `copyDirRecursive`, which uses `fs.copyFileSync` (follows symlinks). A malicious workspace could plant `.soql-cache/dir/file -> /etc/passwd` and `Migrate & Delete Old` would copy and then delete the link target. Mitigate by skipping symlink entries in `copyDirRecursive`, or by using `fs.copyFile` with `COPYFILE_FICLONE`/no-deref alternatives.

---

## 4. Test coverage observations

- 8 test files / 41 tests, all green — solid foundation.
- Gaps that would catch issues above:
  - `querySafety` tests don’t cover subquery LIMIT (P1.2) or subquery `buildCountQuery` (P1.3).
  - `soqlParser` tests don’t exercise `extractFromObject` against subqueries (P1.1).
  - `validateSoqlStructure` has no tests (despite many edge cases listed in P2). Adding cases for missing comma, invalid operator, missing FROM would lock-in current behavior and surface the gaps loudly.
  - No tests for `panel.js` lifecycle (multi-tab close/restore — P1.5). Even a JSDOM-based smoke test would catch state loss.
  - No `soqlPanelProvider.handleExecuteQuery` cancel-after-COUNT test (P1.4).

---

## 5. Manual reproduction recipes (for triage)

1. **Subquery COUNT skip:** open `.soql` file with
   `SELECT Id, (SELECT Id FROM Contacts LIMIT 1) FROM Account`
   and run. Notice no COUNT preflight runs even though the outer query has no LIMIT.
2. **Subquery diagnostics false-positive:** in the same file add `SELECT Name, (SELECT Id FROM Contacts) FROM Account` and watch `Name` get a yellow squiggle (validated against `Contacts`).
3. **Spinner stuck:** in panel, run an unbounded query, dismiss the COUNT warning toast. Spinner runs forever, Run button stays disabled until next query.
4. **Lost edits on close:** open 2 panel tabs. Type into tab 2. Without clicking elsewhere, click the × on tab 1. Tab 2’s recent characters (since last `input` event burst) are reverted to last persisted state.
5. **Slow-warning threshold ignored in editor:** set `soqlEditor.slowQueryWarningThreshold = 100` and run an editor query returning ~200 rows. No prompt — the editor ignores the setting.
6. **CSV/JSON export of empty subqueries:** run `SELECT Name, (SELECT Id FROM Contacts) FROM Account` and observe a `Contacts[0]` column with `null` everywhere accounts have no contacts (P3.3).

---

## 6. Remediation backlog (suggested order)

1. **P1.1** — Replace `extractFromObject` callers in `completionProvider`, `diagnosticsProvider`, and `metadataProvider` with `extractScopedFromInfo`-based resolution; or harden `extractFromObject` to walk top-level tokens.
2. **P1.2 / P1.3 / P1.6** — Rewrite `hasLimitClause`, `buildCountQuery`, `applyLimit` to reuse the existing depth/string-aware tokenizer (`scanSelectFromTokens`-style). Cover with explicit subquery tests in `querySafety.test.ts`.
3. **P1.4** — In `handleExecuteQuery`, ensure every early return after `queryStarted` posts at least one terminal message (`info` or `error`), so the spinner clears.
4. **P1.5** — `closeTab` must call `saveCurrentTab()` before `splice`.
5. **P3.1** — Pass the configured threshold into `shouldPromptForCount` from the editor path.
6. **P2.x bundle** — Tighten `validateSoqlStructure`: empty/missing FROM, missing-comma between SELECT fields, broaden invalid operator detection. Each change in tandem with a regression test.
7. **P3.2** — Switch cache directory key from alias to username (or fall back to alias only when username is absent).
8. **S1 / P3.11** — Add `capabilities.untrustedWorkspaces` declaration in `package.json` and gate the local-project scanner behind workspace trust.
9. **S2** — Re-validate `recordId` server-side in `openRecord` handler.
10. **S3** — Centralize log redaction so sensitive argv never reaches `outputChannel.appendLine` regardless of code path.
11. **S6** — Make `copyDirRecursive` symlink-aware; skip or refuse links.
12. **P3.3 / P3.4** — Decide and document the empty-subquery and top-level-array flattening behavior; tests pin the choice.
13. **P3.7** — Surface `getObjectList` errors as a status-bar warning or one-shot info toast.
14. **P3.10** — Consolidate the duplicate listeners in `panel.js` into a single coordinator.

---

## 7. Residual risk

- **Salesforce CLI (`sf`)** remains the trust anchor for auth and org data; the extension wraps it cleanly with argv now.
- **Workspace trust** is the largest remaining attack-surface item: a malicious repo can still steer cache content via `sfdx-project.json` paths and trigger silent migration writes via `.soql-cache`. Declaring `untrustedWorkspaces` and refusing scanner activity in untrusted mode would close most of this.
- **Result-set rendering** is capped at 10k rows but the *in-memory* arrays for copy/CSV/JSON are unbounded — an exceptionally large query (millions of rows over the API limit boundary) can still pressure the extension host.

---

*End of report.*

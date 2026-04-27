# SOQL Editor Extension — Validation & Audit Report

**Scope:** [`soql-editor/`](../) (VS Code extension v0.6.0)  
**Date:** 2026-04-27  
**Method:** Static code review (activation, commands, CLI, metadata, webviews, parser/diagnostics).

---

## 1. Use-case matrix (validated against code)

| ID | Use case | Entry | Primary code | Status |
|----|-----------|-------|--------------|--------|
| U1 | Open/edit `.soql` | `onLanguage:soql` | [`extension.ts`](../src/extension.ts), completions/diagnostics | **OK** — activates; debounced validation |
| U2 | Open sidebar “SOQL Query” | `onView:soqlEditor.panel` | [`soqlPanelProvider.ts`](../src/soqlPanelProvider.ts), [`panelHtml.ts`](../src/panelHtml.ts), [`panel.js`](../src/panel.js) | **OK** — multi-tab state, Run/Metadata/Org |
| U3 | Execute query from editor | Command + `cmd+enter` / `ctrl+enter` | [`queryExecutor.ts`](../src/queryExecutor.ts) | **Brittle** — COUNT/LIMIT prompt always (no ≤5000 fast path); 0 rows skips webview |
| U4 | Execute query from panel | Run button | [`soqlPanelProvider.ts`](../src/soqlPanelProvider.ts) `handleExecuteQuery` | **Brittle** — differs from U3 for COUNT threshold; same `buildCountQuery` limits |
| U5 | Select org | Status bar / `SOQL: Select Org` / panel org label | [`orgPicker.ts`](../src/orgPicker.ts) | **Risk** — selection matches `picked.description === username` (fragile) |
| U6 | Default org on startup | `orgPicker.autoSelectDefault()` | [`extension.ts`](../src/extension.ts), [`orgPicker.ts`](../src/orgPicker.ts) | **OK** — silent fail if CLI missing |
| U7 | Refresh metadata | `SOQL: Refresh Object Metadata` | [`extension.ts`](../src/extension.ts) | **OK** — clarifies memory vs disk |
| U8 | Sync all / common | Commands + panel quick actions | [`metadataProvider.ts`](../src/metadataProvider.ts) | **OK** — cancellable progress; disk skip logic |
| U9 | Cache single object | Panel → Load Metadata → single | [`soqlPanelProvider.ts`](../src/soqlPanelProvider.ts) | **High risk** — user input flows to shell + disk path (see §3) |
| U10 | Autocomplete (editor) | Typing `.`, `,`, space | [`completionProvider.ts`](../src/completionProvider.ts) | **Partial** — `extractFromObject` / `getQueryContext` miss namespaced `FROM`, subqueries |
| U11 | Diagnostics | Open/change document | [`diagnosticsProvider.ts`](../src/diagnosticsProvider.ts) | **Partial** — races; parser limits |
| U12 | Suggestions in panel | `requestSuggestions` | [`panelSuggestions.ts`](../src/panelSuggestions.ts) | **Partial** — same parser limits |
| U13 | Open record from Id | Click Id link in panel results | [`panel.js`](../src/panel.js), `openRecord` in provider | **Low risk** — regex + `openExternal` |
| U14 | Copy / CSV / JSON | Panel actions | [`soqlPanelProvider.ts`](../src/soqlPanelProvider.ts) | **OK** |
| U15 | Legacy `.soql-cache` migration | First workspace open | [`extension.ts`](../src/extension.ts) `migrateLegacyCache` | **Bug** — success message even on partial failure |
| U16 | Git exclude `.soql-cache` | Activate | [`extension.ts`](../src/extension.ts) `addToGitExclude` | **OK** |

---

## 2. Code quality & reliability (prioritized)

### Critical

| ID | Finding | Evidence |
|----|---------|----------|
| Q1 | **No automated tests** — regressions likely in parser, COUNT builder, CLI, org picker | [`package.json`](../package.json) — only `compile` / `watch` |

### High

| ID | Finding | Evidence |
|----|---------|----------|
| Q2 | **Diagnostics async race** — rapid edits: older `validate()` can finish after newer run and overwrite diagnostics | [`diagnosticsProvider.ts`](../src/diagnosticsProvider.ts) `scheduleValidation` → `setTimeout` → `validate()` with no generation id / cancellation |
| Q3 | **Org selection via QuickPick `description`** — duplicates, UI changes, or ambiguous items can fail to set org after pick | [`orgPicker.ts`](../src/orgPicker.ts) `orgs.find(o => o.username === picked.description)` |
| Q4 | **Migration UX** — always shows “Cache migrated successfully” after loop even if some folders failed | [`extension.ts`](../src/extension.ts) lines 252–275 vs 274–275 |
| Q5 | **Shell/CLI fragility** — `exec` + string command; weak query escaping; `describe` unquoted `objectName` | [`sfCliService.ts`](../src/sfCliService.ts) `executeQuery`, `describeSObject`, `runCliSync` |

### Medium

| ID | Finding | Evidence |
|----|---------|----------|
| Q6 | **`getObjectList` swallows errors** — returns `[]`; completions/suggestions go empty without clear UI | [`sfCliService.ts`](../src/sfCliService.ts) `getObjectList` catch |
| Q7 | **Duplicated COUNT/LIMIT policy** — editor always prompts; panel skips prompt if COUNT ≤ 5000 | [`queryExecutor.ts`](../src/queryExecutor.ts) vs [`soqlPanelProvider.ts`](../src/soqlPanelProvider.ts) |
| Q8 | **`buildCountQuery` naive** — `FROM` tail can include subqueries/joins; COUNT may be invalid or misleading | Same `buildCountQuery` in both files |
| Q9 | **Parser limits** — `FROM\s+(\w+)` misses namespace (`ns__Object__c` style with `__` is OK but not `ns.Object`); `extractSelectFields` splits on commas (breaks inside parens/functions) | [`soqlParser.ts`](../src/soqlParser.ts) |
| Q10 | **`useToolingApi` never true** — dead path for tooling queries | Grep: only default `false` in `executeQuery` |
| Q11 | **`onLog` subscription per webview resolve** — no dispose → duplicate log lines if view re-resolved | [`soqlPanelProvider.ts`](../src/soqlPanelProvider.ts) lines 45–48 |
| Q12 | **Widespread `any`** — CLI JSON, webview messages, errors | Multiple `src/*.ts` files |
| Q13 | **Editor results: large tables** — full HTML string for all rows/columns can freeze UI | [`queryExecutor.ts`](../src/queryExecutor.ts) `buildResultsHtml` |

### Low

| ID | Finding | Evidence |
|----|---------|----------|
| Q14 | **Duplicate comment** in diagnostics | [`diagnosticsProvider.ts`](../src/diagnosticsProvider.ts) lines 59–60 |
| Q15 | **Init error banner** — `insertAdjacentHTML` with `initErr.message` unescaped (only if init throws) | [`panel.js`](../src/panel.js) lines 725–727 |
| Q16 | **Sidebar HTML has no CSP** (contrast with results webview) | [`panelHtml.ts`](../src/panelHtml.ts) vs [`queryExecutor.ts`](../src/queryExecutor.ts) CSP meta |
| Q17 | **Positive:** `strict: true` in TypeScript | [`tsconfig.json`](../tsconfig.json) |

---

## 3. Security (prioritized)

### High

| ID | Threat | Exploitability | Mitigation direction |
|----|--------|----------------|----------------------|
| S1 | **OS command injection** via `exec(cmd)` shell — SOQL only escapes `"`; `$()`, `` ` ``, `;`, `&`, newlines, etc. remain dangerous | User runs crafted query in trusted-but-typical dev scenario; **high** if attacker can supply query text | `spawn('sf', ['data','query','--query', query, ...], { shell: false })` or `execFile`; never interpolate into shell string |
| S2 | Same class for **`sf sobject describe --sobject ${objectName}`** (unquoted) | **High** via “Cache Single Object” or any path passing attacker-controlled `objectName` | Validate API name `^[A-Za-z][A-Za-z0-9_]*(__c)?$`; pass as argv array |
| S3 | **Path traversal in disk cache** — `path.join(cacheDir, \`${objectName}.json\`)` | **Medium–high** — `objectName` like `../x` writes outside org cache dir | `path.resolve` + `startsWith(cacheDir + path.sep)`; reject `..` / separators |

### Medium

| ID | Threat | Notes |
|----|--------|------|
| S4 | **`sfdx-project.json` `packageDirectories[].path`** — `../../../` walks outside package | Confidentiality (read XML/metadata from arbitrary dirs process can read) | Resolve + ensure under workspace root(s) |
| S5 | **Sensitive data in logs** — full CLI string including query logged as `[cmd]`; forwarded to panel console (textContent — no XSS, but **data leak**) | [`sfCliService.ts`](../src/sfCliService.ts) `log('cmd', ...)`; redact or omit query body |
| S6 | **Legacy cache migration** — copies workspace tree into globalStorage; symlink check only on top-level `.soql-cache` | Lower than S1–S3; still trust workspace | Validate paths under source dir; skip symlinks in tree |

### Low

| ID | Threat | Notes |
|----|--------|------|
| S7 | **Sidebar webview without CSP** | Defense in depth; script is local `asWebviewUri` |
| S8 | **`openRecord` + `openExternal`** | Client restricts Id shape; low risk unless channel accepts arbitrary `recordId` |

---

## 4. Manual validation checklist (from findings)

1. Run a query containing shell metacharacters (in a VM) and confirm whether extra processes run vs strict argv invocation.
2. “Cache Single Object” with name containing `;`, backticks, `$()` — observe shell behavior.
3. Cache object name `../../../evil` — verify file lands only under intended `globalStorage/.../cache/<org>/`.
4. Malicious `sfdx-project.json` with `path: "../../../<controlled>"` — confirm scanner reads outside `force-app`.
5. Rapid typing in `.soql` with slow network/CLI — confirm diagnostics don’t flicker to stale warnings.

---

## 5. Remediation backlog (recommended order)

1. **S1/S2** — Replace shell string `exec`/`execSync` with `spawn`/`execFile` and argument arrays; quote is not sufficient on Windows.
2. **S3** — Sanitize and confine `objectName` and all cache filenames to a safe basename.
3. **Q2** — Validation generation counter or `AbortController`; ignore stale async results.
4. **Q3** — Attach `OrgInfo` or `username` on QuickPick items via `QuickPickItem` extended shape (not `description`).
5. **Q4** — Track per-folder migration success; set message and `cacheMigrationDone` accordingly.
6. **S4** — Constrain `packageDirectories` paths to resolved paths under workspace.
7. **S5** — Redact queries in logs; avoid logging full `sf` command with secrets/PII.
8. **Q7/Q8** — Single module for COUNT/LIMIT policy + document behavior; improve COUNT query construction or narrow when COUNT runs.
9. **Q1** — Add Vitest (or similar) for `soqlParser.ts` and pure helpers first.
10. **Q11/Q16/Q15** — Dispose `onLog` with webview; add CSP to panel HTML; escape init error HTML.
11. **Q9** — Parser improvements or explicit “best effort” UX copy for advanced SOQL.

---

## 6. Residual risk

- **Salesforce CLI (`sf`)** remains the trust anchor for auth and org data; extension should not weaken it with shell wrapping.
- **Workspace trust** — any extension that reads project config and runs CLI is exposed to malicious repos; minimize impact with path checks and no shell.

---

*End of report.*

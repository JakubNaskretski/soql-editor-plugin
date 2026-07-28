# Changelog

## 0.10.2

- **The "no metadata cache" prompt is readable again.** Switching to an org
  without cached metadata used to pop a notification with five buttons crammed
  onto one line, none of them legible. It now asks once — **Set Up Metadata** or
  **Later** — and the actual choices (common + custom objects, all objects, local
  repo metadata, reuse another org's cache) appear in a picker with full names and
  a line of explanation each.

## 0.10.0

- **Org picklist in the panel.** The org control at the top of the SOQL panel is
  now a real dropdown, filled instantly from the cached org list and refreshed in
  the background, with a ⟳ button beside it. Picking an org there works exactly
  like the status-bar picker (including sharing the choice with the other Skrety
  Salesforce plugins).
- **"Newest first" checkbox.** When checked, executed queries automatically get
  `ORDER BY CreatedDate DESC` — your editor text and query history keep exactly
  what you wrote. It stays out of the way when the query has its own ORDER BY, a
  GROUP BY or aggregates (`COUNT()`, `FORMAT(SUM(...))`, …) or FOR UPDATE, and the
  panel console notes what it did (or why it didn't) on every run.
- Rapid org-list refreshes now share a single `sf org list` call instead of
  spawning one per click.

## 0.9.0

- **The org picker opens instantly.** The org list is cached — including across
  window reloads — so clicking the status-bar org no longer waits on a `sf org list`
  call. The picker still refreshes in the background while open, so an org you just
  authenticated appears in the list by itself a moment later.
- New ↻ button on the org picker and a new `SOQL: Refresh Org List` command in the
  palette to force-refresh the cached list at any time.
- Hardening: the browser fallback used when opening a record only follows `https`
  instance URLs.

## 0.8.5

- Fixed: **Windows support.** The `sf` CLI now launches on Windows (recent VS Code builds
  refused to start `sf.cmd`), and queries are passed to the CLI via a temp file — so
  multi-line and quoted SOQL runs everywhere, huge queries can't overflow the Windows
  command line, and your query text stays out of process lists. Org cache folder names
  are Windows-safe (reserved names like `aux`, trailing dots, length, casing), and cache
  bootstrap failures are reported instead of vanishing silently.

## 0.8.4

- The shared target org can no longer be changed by this plugin on its own: only
  picking an org yourself writes the setting shared across the Skrety Salesforce
  plugins — activating the extension or following another plugin's switch never
  does. Org listing also skips the per-org connection probe whose hiccups could
  transiently "lose" an org.
- Org switches mid-operation can't mix data anymore: a describe or object-list
  call finishing after a switch no longer writes into the new org's caches, rapid
  switches apply in order (latest wins), and query results are labeled with the
  org they actually ran against.
- External org changes are followed even when this plugin can't fully resolve the
  org yet, and an externally cleared org now shows a proper no-org state.

## 0.8.3

- Autocomplete and error-checking racing on a not-yet-cached object now share one
  `sf sobject describe` call instead of spawning duplicate processes; the object
  list lookup is deduplicated the same way.
- Metadata syncs no longer run twice in parallel. Triggering the same sync again
  joins the one already running, and a different sync waits its turn — no more
  stacked sync progress notifications doing duplicate work.

## 0.8.2

- Results columns no longer stretch to fill the panel — they now size to their
  content, very long values are truncated with an ellipsis (hover to see the
  full value), and column widths can be adjusted by dragging the grip in the
  bottom-right corner of a column header.

## 0.8.1

- Fixed custom objects disappearing from autocomplete over time. Once the
  cached org object list expired (default: 7 days), the next field lookup
  could quietly replace it with a near-empty list, and the extension then
  stopped re-fetching the real one — `FROM` no longer offered custom objects
  and their fields never suggested. Affected caches now heal themselves; to
  repair immediately, run **Load MD → Sync All Objects** (or Clear Cache).

## 0.8.0

- **Query history.** Your last 50 queries are remembered per org — recall them
  from the History dropdown in the panel, or from the editor with
  `Cmd/Ctrl+Alt+H`.
- **Tooling API toggle.** A panel checkbox (and the `soqlEditor.useToolingApi`
  setting for `.soql` files) runs queries against the Tooling API — for objects
  like `ApexCodeCoverage` that the regular API can't see.
- Results now always land on the tab that ran the query, even if you switch
  tabs while it's running.
- The large-result prompt for editor-run queries is a proper dialog, so a run
  can no longer appear stuck behind a buried notification.
- Closing the panel mid-prompt no longer blocks all future runs until reload,
  and autocomplete no longer piles up long-running CLI calls while you type.
- The selected org is now shared with the other Skrety Salesforce extensions —
  switch once, it applies everywhere.
- Windows: the `sf` launcher is now resolved correctly.

## 0.7.2

- Fixed the sidebar query getting stuck on "Running…" after switching org. The
  large-result size prompt (Add LIMIT / Fetch all) now appears inside the panel
  instead of as an easily-missed notification, and the Run button doubles as a
  Cancel button while a query is in flight, so a run can always be stopped.

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


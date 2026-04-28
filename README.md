# SOQL Editor

SOQL Editor is a VS Code/Cursor extension for writing, validating, and running SOQL queries against Salesforce orgs.

It provides:
- SOQL syntax highlighting for `.soql` files
- inline autocomplete for objects, fields, relationships, operators, and keywords
- structural and metadata-aware diagnostics
- multi-org query execution through Salesforce CLI (`sf`)
- sidebar query panel with tabs, autocomplete, and result actions

---

## Features

### Editor experience
- Language support for `.soql`
- Completions while typing in `SELECT`, `FROM`, `WHERE`, `ORDER BY`, `GROUP BY`, and `HAVING`
- Relationship traversal suggestions (for example, `Owner.Name`)
- Query validation with inline diagnostics

### Query execution
- Run from editor (`Cmd+Enter` on macOS / `Ctrl+Enter` on Windows/Linux)
- Run from the sidebar panel (`SOQL Query`)
- Optional COUNT preflight warning when no LIMIT is present

### Results
- Rendered table results in panel/webview
- Click Salesforce IDs to open records
- Copy cell values on click
- Copy full results, export CSV, export JSON from sidebar panel

### Metadata workflows
- Select active org from status bar or panel
- Clear memory cache
- Sync common + custom objects
- Sync all objects
- Cache a single object on demand

---

## Requirements

- VS Code/Cursor compatible with extension engine `^1.105.0`
- Node.js and npm for local development/builds
- Salesforce CLI (`sf`) installed and authenticated

Authenticate at least one org, for example:

```bash
sf org login web
```

---

## Installation

### Option A: Marketplace (recommended for users)
Install `SOQL Editor` from the marketplace once published.

### Option B: Install from VSIX (local/internal testing)

1. Build VSIX:

```bash
npm install
npm run package:dev
```

2. Install in Cursor:

```bash
cursor --install-extension ./soql-editor-dev-<version>.vsix --force
```

3. Reload window (`Developer: Reload Window`).

---

## Quick Start

1. Open a `.soql` file.
2. Select org:
   - status bar: `No Org Selected` / cloud icon, or
   - command: `SOQL: Select Org`, or
   - panel org selector.
3. Write query.
4. Execute:
   - from editor: `Cmd+Enter` / `Ctrl+Enter`
   - from sidebar: click `Run`

---

## Commands

- `SOQL: Execute Query` (`soqlEditor.executeQuery`)
- `SOQL: Select Org` (`soqlEditor.selectOrg`)
- `SOQL: Refresh Object Metadata` (`soqlEditor.refreshMetadata`)
- `SOQL: Sync All Metadata from Org` (`soqlEditor.syncMetadata`)
- `SOQL: Sync Common + Custom Objects (fast)` (`soqlEditor.syncCommonMetadata`)

---

## Security and Safety Notes

- CLI execution is argument-based (no shell command interpolation).
- Object-name inputs are validated before CLI/cache usage.
- Cache file writes are constrained to cache directory boundaries.
- Sidebar webview uses CSP + nonce for script hardening.

Even for internal tooling, treat workspace configuration and query inputs as untrusted by default.

---

## Performance Notes

- Result rendering is intentionally capped to keep webviews responsive.
- Current UI render cap is `10,000` rows per view.
- Sidebar copy/export actions use full in-memory results for that query tab.

If needed, this can be tuned further or replaced with pagination/virtualization.

---

## Development

### Scripts

```bash
npm run compile
npm run watch
npm run test
npm run test:watch
```

### Project structure

- `src/extension.ts` - activation, command wiring, migration
- `src/sfCliService.ts` - Salesforce CLI integration
- `src/metadataProvider.ts` - metadata and cache orchestration
- `src/soqlParser.ts` - parser helpers and validation primitives
- `src/completionProvider.ts` - editor completions
- `src/diagnosticsProvider.ts` - diagnostics pipeline
- `src/soqlPanelProvider.ts` - sidebar webview provider
- `src/panel.js` / `src/panelHtml.ts` - sidebar UI
- `src/panelSuggestions.ts` - weighted object/field suggestions

---

## Release and Publishing

### Version bump
Update `version` in `package.json` (SemVer).

### Build artifact

```bash
npm install
npm run test
npm run package:store
```

### Publish to marketplace

```bash
npx @vscode/vsce publish
```

Use your publisher credentials/token configured for your publisher (for example `Skrety`).

### Dev vs Store packaging model

- `npm run package:dev` creates a local test VSIX with isolated identity:
  - name: `soql-editor-dev`
  - publisher: `Skrety-dev`
  - display name: `SOQL Editor (Dev)`
- `npm run package:store` creates the normal marketplace package from the canonical manifest.
- The packaging script always restores the original `package.json` after building.

### Recommended branch flow

1. Create a feature/testing branch (for example `feat/autocomplete-fixes`).
2. Iterate and test in Cursor with `npm run package:dev`.
3. Merge branch into main only after validation.
4. Build release artifact with `npm run package:store`.
5. Publish from main with `npx @vscode/vsce publish`.

---

## Known Backlog

See `TODO.md` for planned items (history, sorting, pagination, subquery autocomplete, explain plan, and more).

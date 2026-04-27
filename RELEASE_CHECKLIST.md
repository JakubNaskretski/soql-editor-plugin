# SOQL Editor Release Checklist

Use this checklist before publishing a new version to the marketplace.

## 1) Pre-release hygiene

- [ ] Confirm `package.json` version is correct (SemVer).
- [ ] Confirm `engines.vscode` matches supported Cursor/VS Code baseline.
- [ ] Ensure working tree is clean and commits are grouped logically.

## 2) Security smoke checks

- [ ] Invalid object name is rejected (`../foo`, `Account;rm -rf`, `` `whoami` ``).
- [ ] Cache writes remain inside extension cache directory only.
- [ ] Malicious `sfdx-project.json` `packageDirectories.path` outside workspace is skipped.
- [ ] Query execution still uses arg-based CLI invocation (no shell interpolation paths).
- [ ] Sidebar webview loads with CSP and no unsafe HTML insertion paths.

## 3) Functional verification

- [ ] Org selection works from status bar and panel.
- [ ] Editor execute (`Cmd/Ctrl+Enter`) works.
- [ ] Sidebar execute works.
- [ ] Parent traversal results render as dotted fields (`Owner.Name`, etc.).
- [ ] JSON export returns raw Salesforce response objects.
- [ ] Large result rendering cap behavior is acceptable.

## 4) Automated validation

- [ ] `npm run test` passes.
- [ ] `npm run compile` passes.

## 5) Package validation

- [ ] Build package: `npx @vscode/vsce package --allow-missing-repository`
- [ ] Inspect package tree (`vsce ls --tree`) and confirm no dev-only files (`src`, tests, docs, local configs).
- [ ] Install VSIX in Cursor and verify extension activation and core flows.

## 6) Publish

- [ ] Publish via `npx @vscode/vsce publish`
- [ ] Verify marketplace listing metadata, icon, and README render.

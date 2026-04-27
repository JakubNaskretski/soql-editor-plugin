import * as vscode from 'vscode';

export function getPanelHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'out', 'panel.js')
    );
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex; flex-direction: column;
    height: 100vh; overflow: hidden;
}

/* ── tab bar ────────────────────────────── */
.tab-bar {
    display: flex; align-items: center; gap: 0;
    padding: 0;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
}
.tab-bar .tab {
    padding: 5px 12px;
    font-size: 11px;
    cursor: pointer;
    border: none;
    border-right: 1px solid var(--vscode-panel-border);
    border-bottom: 2px solid transparent;
    background: none;
    color: var(--vscode-foreground);
    opacity: 0.6;
    transition: opacity 0.1s;
    white-space: nowrap;
}
.tab-bar .tab:hover { opacity: 0.85; }
.tab-bar .tab.active {
    opacity: 1;
    border-bottom-color: var(--vscode-textLink-foreground);
    font-weight: 600;
}
.tab-bar .tab-add {
    padding: 5px 10px;
    font-size: 13px;
    cursor: pointer;
    border: none;
    background: none;
    color: var(--vscode-foreground);
    opacity: 0.5;
}
.tab-bar .tab-add:hover { opacity: 1; }
.tab-bar .tab-close {
    margin-left: 6px;
    font-size: 11px;
    opacity: 0.4;
    cursor: pointer;
}
.tab-bar .tab-close:hover { opacity: 1; }

/* ── toolbar ───────────────────────────── */
.toolbar {
    display: flex; align-items: center; gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
}
.toolbar button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 3px;
    padding: 4px 10px; cursor: pointer;
    font-size: 12px;
}
.toolbar button:hover { background: var(--vscode-button-hoverBackground); }
.toolbar .org-label {
    margin-left: auto;
    font-size: 11px;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: underline;
    background: none;
    border: none;
    padding: 4px 6px;
}



/* ── editor area ───────────────────────── */
.editor-wrapper {
    position: relative;
    flex: 0 0 auto;
    min-height: 100px;
    max-height: 50vh;
    border-bottom: 1px solid var(--vscode-panel-border);
}
#highlightOverlay {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    padding: 8px;
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Consolas', monospace);
    font-size: 13px;
    line-height: 1.5;
    tab-size: 4;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
    overflow-x: hidden;
    pointer-events: none;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    z-index: 0;
}
#soqlInput {
    position: relative;
    width: 100%; height: 100%;
    min-height: 100px;
    resize: vertical;
    background: transparent;
    color: transparent;
    caret-color: var(--vscode-editor-foreground);
    border: none; outline: none;
    padding: 8px;
    font-family: var(--vscode-editor-font-family, 'Menlo', 'Consolas', monospace);
    font-size: 13px;
    line-height: 1.5;
    tab-size: 4;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow-y: auto;
    overflow-x: hidden;
    z-index: 1;
}
/* syntax token colors */
.tok-keyword { color: #c586c0; font-weight: bold; }
.tok-function { color: #dcdcaa; }
.tok-string { color: #ce9178; }
.tok-number { color: #b5cea8; }
.tok-operator { color: #4ec9b0; }
.tok-comment { color: #6a9955; font-style: italic; }
.tok-field { color: var(--vscode-editor-foreground); }
.tok-object { color: #4ec9b0; font-weight: bold; }
.tok-date-literal { color: #c586c0; }
.tok-error {
    text-decoration: wavy underline;
    text-decoration-color: var(--vscode-errorForeground, #f44747);
    text-underline-offset: 2px;
}

/* ── error list ────────────────────────── */
.error-list {
    display: none;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    font-size: 11px;
    max-height: 80px;
    overflow-y: auto;
    background: var(--vscode-sideBar-background);
}
.error-list.visible { display: block; }
.error-item {
    padding: 2px 0;
    color: var(--vscode-errorForeground, #f44747);
}
.error-item::before { content: '⚠ '; }

/* ── autocomplete dropdown ─────────────── */
.ac-dropdown {
    display: none;
    position: fixed;
    background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
    border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-panel-border));
    border-radius: 4px;
    max-height: 200px; overflow-y: auto;
    z-index: 100;
    min-width: 200px; max-width: 90vw;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
}
.ac-dropdown.visible { display: block; }
.ac-item {
    padding: 4px 8px;
    cursor: pointer;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px;
}
.ac-item:hover, .ac-item.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}
.ac-item .ac-detail {
    color: var(--vscode-descriptionForeground);
    font-size: 11px; margin-left: 12px;
}
.ac-item.selected .ac-detail {
    color: var(--vscode-list-activeSelectionForeground);
    opacity: 0.8;
}

/* ── result actions bar ───────────────── */
.result-actions {
    display: none; align-items: center; gap: 4px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
    background: var(--vscode-sideBar-background);
}
.result-actions.visible { display: flex; }
.result-actions button {
    background: none;
    color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 3px;
    padding: 3px 8px; cursor: pointer;
    line-height: 1.4;
    font-size: 11px;
}
.result-actions button:hover {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
}

/* ── results ───────────────────────────── */
.results-area {
    flex: 1 1 auto;
    overflow: auto;
    padding: 0;
}
.results-summary {
    padding: 6px 8px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border);
    position: sticky; top: 0;
    background: var(--vscode-sideBar-background);
    z-index: 2;
}
.results-table {
    width: 100%; border-collapse: collapse;
}
.results-table th, .results-table td {
    border: 1px solid var(--vscode-panel-border);
    padding: 3px 6px; text-align: left;
    white-space: nowrap;
    font-size: 12px;
}
.results-table th {
    background: var(--vscode-editorGroupHeader-tabsBackground, var(--vscode-sideBar-background));
    position: sticky; top: 28px;
    font-weight: 600; z-index: 1;
}
.results-table tr:hover { background: var(--vscode-list-hoverBackground); }
.sf-id-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: none; cursor: pointer;
}
.sf-id-link:hover { text-decoration: underline; }
.null-val { color: var(--vscode-descriptionForeground); font-style: italic; }
.error-msg {
    padding: 8px; color: var(--vscode-errorForeground);
    font-size: 12px;
}
.info-msg {
    padding: 8px; color: var(--vscode-descriptionForeground);
    font-size: 12px;
}
.toast-msg {
    position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%);
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    padding: 6px 16px; border-radius: 4px; font-size: 12px;
    z-index: 200; pointer-events: none;
    animation: fadeout 0.4s ease 1.6s forwards;
}
@keyframes fadeout { to { opacity: 0; } }
.spinner {
    padding: 12px; text-align: center;
    color: var(--vscode-descriptionForeground);
}

/* ── console log ───────────────────────── */
.console-wrapper {
    flex: 0 0 auto;
    border-top: 1px solid var(--vscode-panel-border);
    max-height: 35vh;
    display: flex; flex-direction: column;
}
.console-header {
    display: flex; align-items: center; gap: 6px;
    padding: 4px 8px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBar-background);
    user-select: none;
    border-bottom: 1px solid var(--vscode-panel-border);
}
.console-header:hover { color: var(--vscode-foreground); }
.console-header .chevron { transition: transform 0.15s; }
.console-header .chevron.open { transform: rotate(90deg); }
.console-header .badge {
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px; padding: 0 5px;
    font-size: 10px; min-width: 16px; text-align: center;
}
.console-header .clear-btn {
    margin-left: auto;
    background: none; border: none; color: var(--vscode-descriptionForeground);
    cursor: pointer; font-size: 11px; padding: 0 4px;
}
.console-header .clear-btn:hover { color: var(--vscode-foreground); }
.console-body {
    overflow-y: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    line-height: 1.5;
    padding: 4px 0;
    display: none;
}
.console-body.open { display: block; }
.log-line {
    padding: 1px 8px;
    white-space: pre-wrap;
    word-break: break-all;
}
.log-line.cmd { color: var(--vscode-textLink-foreground); }
.log-line.cmd::before { content: '$ '; opacity: 0.5; }
.log-line.error { color: var(--vscode-errorForeground); }
.log-line.warn { color: var(--vscode-editorWarning-foreground, #cca700); }
.log-line.info { color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>

<div id="jsCheck" style="padding:8px;color:red;font-weight:bold;font-size:13px;border-bottom:2px solid red;">JS NOT LOADED - scripts may be blocked</div>

<div style="padding: 4px 8px; font-size: 10px; font-style: italic; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border);">
    This extension is in beta. Use at your own risk.
</div>

<div class="tab-bar" id="tabBar">
    <button class="tab active" data-tab="0">Query 1</button>
    <button class="tab-add" id="btnAddTab" title="New query tab (max 3)">+</button>
</div>

<div class="toolbar">
    <button id="btnRun" title="Execute query (Cmd+Enter)">&#9654; Run</button>
    <button id="btnLoadMd" title="Load / refresh metadata for autocomplete">Load Metadata</button>
    <button class="org-label" id="orgLabel" title="Click to change org">No Org</button>
</div>

<div class="editor-wrapper">
    <div id="highlightOverlay"></div>
    <textarea id="soqlInput" spellcheck="false"
        placeholder="SELECT Id, Name FROM Account LIMIT 10"></textarea>
</div>
<div class="ac-dropdown" id="acDropdown"></div>
<div class="error-list" id="errorList"></div>

<div class="result-actions" id="resultActions">
    <button id="btnCopyResults" title="Copy results to clipboard (tab-separated)">Copy Results</button>
    <button id="btnCopyCSV" title="Open results as CSV file in editor">Copy to CSV</button>
    <button id="btnExportJSON" title="Open results as JSON file in editor">Export JSON</button>
</div>

<div class="results-area" id="resultsArea">
    <div class="info-msg">Type a SOQL query above and click Run</div>
</div>

<div class="console-wrapper">
    <div class="console-header" id="consoleHeader">
        <span class="chevron" id="consoleChevron">&#9654;</span>
        Console
        <span class="badge" id="consoleBadge">0</span>
        <button class="clear-btn" id="consoleClear" title="Clear console">&#10005;</button>
    </div>
    <div class="console-body" id="consoleBody"></div>
</div>

<script nonce="${nonce}" src="${scriptUri}"><\/script>
</body>
</html>`;
}

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < 32; i++) {
        out += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return out;
}

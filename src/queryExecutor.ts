import * as vscode from 'vscode';
import { SfCliService } from './sfCliService';
import { MetadataProvider } from './metadataProvider';
import { applyLimit, buildCountQuery, hasLimitClause, shouldPromptForCount } from './querySafety';
import { flattenRecordForDisplay } from './resultFlattening';

/** Convert a 1-based line/column within `text` to a 0-based character offset. */
export function lineColumnToOffset(text: string, line: number, column: number): number {
    const lines = text.split('\n');
    const targetLine = Math.max(1, line);
    let offset = 0;
    for (let i = 0; i < targetLine - 1 && i < lines.length; i++) {
        offset += lines[i].length + 1; // + the newline
    }
    offset += Math.max(0, column - 1);
    return Math.min(offset, text.length);
}

/** Inputs needed to map a CLI error position back into the source document. */
interface ErrorLocationMapping {
    doc: vscode.TextDocument;
    /** The exact query string submitted to the CLI (positions are relative to this). */
    submittedQuery: string;
    /** Document offset of the first character of the submitted query's trimmed content. */
    docBase: number;
    /** Upper bound (doc offset) of the original query content, excluding any appended LIMIT. */
    maxOffset: number;
}

/**
 * Executes SOQL queries and displays results in a webview panel.
 */
export class QueryExecutor {
    private static readonly MAX_RENDER_ROWS = 10000;
    private sfCli: SfCliService;
    private metadata: MetadataProvider;
    private outputChannel: vscode.OutputChannel;
    private panel: vscode.WebviewPanel | undefined;
    private running = false;
    private queryDiagnostics: vscode.DiagnosticCollection;
    private disposables: vscode.Disposable[] = [];

    constructor(sfCli: SfCliService, metadata: MetadataProvider, outputChannel: vscode.OutputChannel) {
        this.sfCli = sfCli;
        this.metadata = metadata;
        this.outputChannel = outputChannel;
        this.queryDiagnostics = vscode.languages.createDiagnosticCollection('soql-query');
        this.disposables.push(
            this.queryDiagnostics,
            // A query-execution error squiggle goes stale the moment the user edits,
            // so clear it on the first change to that document.
            vscode.workspace.onDidChangeTextDocument(e => {
                if (this.queryDiagnostics.has(e.document.uri)) {
                    this.queryDiagnostics.delete(e.document.uri);
                }
            })
        );
    }

    private getSlowQueryWarningThreshold(): number {
        const configured = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<number>('slowQueryWarningThreshold', 5000);
        if (!Number.isFinite(configured)) {
            return 5000;
        }
        return Math.max(0, Math.floor(configured));
    }

    async executeCurrentQuery() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'soql') {
            vscode.window.showWarningMessage('Open a .soql file to execute a query');
            return;
        }

        if (!this.sfCli.getCurrentOrg()) {
            vscode.window.showWarningMessage('Select a Salesforce org first (click the org picker in the status bar)');
            return;
        }

        // Re-entrancy guard: a second run while one is in flight would race on the
        // results panel and could let a slower earlier query overwrite a later one.
        if (this.running) {
            vscode.window.showInformationMessage('A SOQL query is already running.');
            return;
        }

        // Use selection if any, otherwise entire document. Capture where the
        // submitted text starts in the document so a CLI error position (which is
        // relative to the submitted query) can be mapped back to a source range.
        const targetDoc = editor.document;
        const selectionEmpty = editor.selection.isEmpty;
        const regionStart = selectionEmpty ? 0 : targetDoc.offsetAt(editor.selection.start);
        const originalText = selectionEmpty ? targetDoc.getText() : targetDoc.getText(editor.selection);

        let query = originalText.trim();
        if (!query) { return; }

        // trim() only strips the ends, so the trimmed content is a contiguous slice
        // of the document starting at docBase. baseQueryLen bounds the original query
        // (an appended LIMIT lands after it and must not shift error positions).
        const leadingWhitespace = originalText.length - originalText.replace(/^\s+/, '').length;
        const docBase = regionStart + leadingWhitespace;
        const baseQueryLen = query.length;

        this.running = true;
        try {
            // Clear any stale query-error squiggle from a previous run.
            this.queryDiagnostics.delete(targetDoc.uri);
            // Safety: if no LIMIT, run a COUNT() first
            if (!hasLimitClause(query)) {
                const countQuery = buildCountQuery(query);
                if (countQuery) {
                    try {
                        const countResult = await this.sfCli.executeQuery(countQuery);
                        const totalRows = countResult.totalSize ?? countResult.records?.[0]?.expr0 ?? '?';
                        if (shouldPromptForCount(totalRows, this.getSlowQueryWarningThreshold())) {
                            const choice = await vscode.window.showWarningMessage(
                                `Query matches ${totalRows} records. Run it?`,
                                { modal: false },
                                'Add LIMIT 200',
                                'Add LIMIT 2000',
                                `Fetch all ${totalRows}`
                            );
                            if (!choice) { return; }
                            if (choice === 'Add LIMIT 200') {
                                query = applyLimit(query, 200);
                            } else if (choice === 'Add LIMIT 2000') {
                                query = applyLimit(query, 2000);
                            }
                        }
                    } catch (err: any) {
                        // Surface (don't swallow) the preflight failure, then run anyway.
                        this.outputChannel.appendLine(
                            `COUNT preflight failed (running query without a size estimate): ${err?.message ?? err}`
                        );
                    }
                } else {
                    // No COUNT preflight possible (unrecognized FROM) and no LIMIT —
                    // warn rather than silently running an unbounded query.
                    const choice = await vscode.window.showWarningMessage(
                        'Could not estimate this query\'s size and it has no LIMIT clause. Run anyway?',
                        { modal: false },
                        'Add LIMIT 200',
                        'Run anyway'
                    );
                    if (!choice) { return; }
                    if (choice === 'Add LIMIT 200') { query = applyLimit(query, 200); }
                }
            }

            // Capture the org now so a mid-query org switch doesn't make us
            // reconcile metadata against (and pollute the cache of) the new org.
            const orgAtStart = this.sfCli.getCurrentOrg()?.username;

            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Executing SOQL query...',
                    cancellable: true,
                },
                async (_progress, token) => {
                    const controller = new AbortController();
                    const sub = token.onCancellationRequested(() => controller.abort());
                    try {
                        const result = await this.sfCli.executeQuery(query, false, controller.signal);
                        if (this.sfCli.getCurrentOrg()?.username === orgAtStart) {
                            await this.metadata.reconcileSuccessfulQuery(query);
                        }
                        this.queryDiagnostics.delete(targetDoc.uri); // success clears any prior error
                        this.showResults(query, result);
                    } catch (err: any) {
                        if (token.isCancellationRequested) { return; } // user cancelled — not an error
                        this.reportQueryError(err, {
                            doc: targetDoc,
                            submittedQuery: query,
                            docBase,
                            maxOffset: docBase + baseQueryLen,
                        });
                    } finally {
                        sub.dispose();
                    }
                }
            );
        } finally {
            this.running = false;
        }
    }

    /**
     * Surface a query failure: full detail (query echo + caret + Salesforce
     * explanation) goes to the output channel; when the CLI reported a position,
     * the offending token is squiggled in the editor; and a concise toast offers
     * "Go to Error" / "Show Details".
     */
    private reportQueryError(err: any, mapping?: ErrorLocationMapping) {
        const detail = (err && typeof err.detail === 'string' && err.detail) ? err.detail : (err?.message ?? String(err));
        this.outputChannel.appendLine('── SOQL query error ──');
        this.outputChannel.appendLine(detail);
        const summary = String(err?.message ?? 'Query failed').replace(/\s+/g, ' ').trim();
        const shown = summary.length > 200 ? summary.slice(0, 197) + '…' : summary;

        // If the CLI reported a position, place a diagnostic on the offending token.
        let errorRange: vscode.Range | undefined;
        if (mapping && typeof err?.line === 'number' && typeof err?.column === 'number') {
            errorRange = this.mapErrorToRange(mapping, err.line, err.column);
            if (errorRange) {
                const diag = new vscode.Diagnostic(errorRange, summary, vscode.DiagnosticSeverity.Error);
                diag.source = 'soql';
                if (err.code) { diag.code = String(err.code); }
                this.queryDiagnostics.set(mapping.doc.uri, [diag]);
            }
        }

        const actions = errorRange ? ['Go to Error', 'Show Details'] : ['Show Details'];
        void vscode.window.showErrorMessage(`Query failed: ${shown}`, ...actions).then(choice => {
            if (choice === 'Show Details') {
                this.outputChannel.show(true);
            } else if (choice === 'Go to Error' && mapping && errorRange) {
                void vscode.window.showTextDocument(mapping.doc, {
                    selection: errorRange,
                    viewColumn: vscode.ViewColumn.One,
                });
            }
        });
    }

    /** Map a CLI error line/column (relative to the submitted query) to a source range. */
    private mapErrorToRange(mapping: ErrorLocationMapping, line: number, column: number): vscode.Range | undefined {
        const qOffset = lineColumnToOffset(mapping.submittedQuery, line, column);
        if (qOffset < 0) { return undefined; }
        const docLen = mapping.doc.getText().length;
        // Clamp into the original query region (exclude any auto-appended LIMIT).
        let docOffset = mapping.docBase + qOffset;
        docOffset = Math.max(mapping.docBase, Math.min(docOffset, mapping.maxOffset, Math.max(0, docLen - 1)));

        const startPos = mapping.doc.positionAt(docOffset);
        const lineText = mapping.doc.lineAt(startPos.line).text;
        const after = lineText.slice(startPos.character);
        // Highlight the whole identifier token at that spot, else a single char.
        const tok = after.match(/^[A-Za-z_][A-Za-z0-9_.]*/);
        const endPos = tok
            ? startPos.translate(0, tok[0].length)
            : mapping.doc.positionAt(Math.min(docOffset + 1, docLen));
        return new vscode.Range(startPos, endPos);
    }

    private showResults(query: string, result: any) {
        const records: any[] = result.records || [];
        const totalSize: number = result.totalSize || records.length;
        const truncated = records.length > QueryExecutor.MAX_RENDER_ROWS;
        const displayedRecords = truncated ? records.slice(0, QueryExecutor.MAX_RENDER_ROWS) : records;

        if (displayedRecords.length === 0) {
            vscode.window.showInformationMessage(`Query returned 0 records`);
            return;
        }

        const displayRows = displayedRecords.map(flattenRecordForDisplay);

        // Collect all column names from records
        const columns = new Set<string>();
        for (const rec of displayRows) {
            for (const key of Object.keys(rec)) {
                if (!columns.has(key)) {
                    columns.add(key);
                }
            }
        }
        const columnList = Array.from(columns);

        // Create the panel once; on later runs reuse it and reveal (don't recreate
        // when it's merely hidden in another tab group — that leaked the old one).
        // The results view is static HTML with a strict CSP, so scripts stay off.
        if (!this.panel) {
            this.panel = vscode.window.createWebviewPanel(
                'soqlResults',
                'SOQL Results',
                { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
                { enableScripts: false }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
        }

        this.panel.title = `SOQL Results (${totalSize} records)`;
        this.panel.webview.html = this.buildResultsHtml(query, columnList, displayRows, totalSize, truncated);
        this.panel.reveal(vscode.ViewColumn.Two, true);
    }

    private buildResultsHtml(
        query: string,
        columns: string[],
        records: any[],
        totalSize: number,
        truncated: boolean
    ): string {
        const escapeHtml = (str: string) =>
            String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');

        const headerCells = columns.map(c => `<th>${escapeHtml(c)}</th>`).join('');
        const rows = records.map(rec => {
            const cells = columns.map(c => {
                let val = rec[c];
                if (val === null || val === undefined) {
                    return '<td class="null">null</td>';
                }
                if (typeof val === 'object') {
                    val = JSON.stringify(val);
                }
                return `<td>${escapeHtml(String(val))}</td>`;
            }).join('');
            return `<tr>${cells}</tr>`;
        }).join('');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
    body {
        font-family: var(--vscode-font-family, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        padding: 10px;
    }
    .query {
        background: var(--vscode-textBlockQuote-background);
        padding: 8px 12px;
        border-left: 3px solid var(--vscode-textLink-foreground);
        margin-bottom: 12px;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: 12px;
        white-space: pre-wrap;
        word-break: break-all;
    }
    .summary {
        margin-bottom: 8px;
        color: var(--vscode-descriptionForeground);
    }
    table {
        border-collapse: collapse;
        width: 100%;
    }
    th, td {
        border: 1px solid var(--vscode-panel-border);
        padding: 4px 8px;
        text-align: left;
        white-space: nowrap;
        max-width: 300px;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    th {
        background: var(--vscode-editor-lineHighlightBackground);
        position: sticky;
        top: 0;
        font-weight: 600;
    }
    tr:hover {
        background: var(--vscode-list-hoverBackground);
    }
    .null {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
    }
    .table-wrapper {
        overflow: auto;
        max-height: calc(100vh - 120px);
    }
</style>
</head>
<body>
    <div class="query">${escapeHtml(query)}</div>
    <div class="summary">${totalSize} record${totalSize !== 1 ? 's' : ''} returned${truncated ? ` (showing first ${QueryExecutor.MAX_RENDER_ROWS})` : ''}</div>
    <div class="table-wrapper">
        <table>
            <thead><tr>${headerCells}</tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
</body>
</html>`;
    }

    dispose() {
        this.panel?.dispose();
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

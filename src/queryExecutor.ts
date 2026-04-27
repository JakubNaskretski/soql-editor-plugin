import * as vscode from 'vscode';
import { SfCliService } from './sfCliService';
import { applyLimit, buildCountQuery, hasLimitClause, shouldPromptForCount } from './querySafety';
import { flattenRecordForDisplay } from './resultFlattening';

/**
 * Executes SOQL queries and displays results in a webview panel.
 */
export class QueryExecutor {
    private static readonly MAX_RENDER_ROWS = 10000;
    private sfCli: SfCliService;
    private outputChannel: vscode.OutputChannel;
    private panel: vscode.WebviewPanel | undefined;

    constructor(sfCli: SfCliService, outputChannel: vscode.OutputChannel) {
        this.sfCli = sfCli;
        this.outputChannel = outputChannel;
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

        // Use selection if any, otherwise entire document
        let query: string;
        if (!editor.selection.isEmpty) {
            query = editor.document.getText(editor.selection);
        } else {
            query = editor.document.getText();
        }

        query = query.trim();
        if (!query) { return; }

        // Safety: if no LIMIT, run a COUNT() first
        if (!hasLimitClause(query)) {
            const countQuery = buildCountQuery(query);
            if (countQuery) {
                try {
                    const countResult = await this.sfCli.executeQuery(countQuery);
                    const totalRows = countResult.totalSize ?? countResult.records?.[0]?.expr0 ?? '?';
                    if (shouldPromptForCount(totalRows)) {
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
                } catch {
                    // COUNT failed — run anyway
                }
            }
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Executing SOQL query...',
                cancellable: false,
            },
            async () => {
                try {
                    const result = await this.sfCli.executeQuery(query);
                    this.showResults(query, result);
                } catch (err: any) {
                    this.outputChannel.appendLine(`Query error: ${err.message}`);
                    vscode.window.showErrorMessage(`Query failed: ${err.message}`);
                }
            }
        );
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

        // Create or reuse webview panel
        if (!this.panel || this.panel.visible === false) {
            this.panel = vscode.window.createWebviewPanel(
                'soqlResults',
                'SOQL Results',
                vscode.ViewColumn.Two,
                { enableScripts: true }
            );
            this.panel.onDidDispose(() => {
                this.panel = undefined;
            });
        }

        this.panel.title = `SOQL Results (${totalSize} records)`;
        this.panel.webview.html = this.buildResultsHtml(query, columnList, displayRows, totalSize, truncated);
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
                .replace(/"/g, '&quot;');

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
    }
}

import * as vscode from 'vscode';
import { SfCliService, OrgInfo, normalizeSObjectApiName } from './sfCliService';
import { MetadataProvider } from './metadataProvider';
import { getPanelHtml } from './panelHtml';
import { getSuggestions } from './panelSuggestions';
import { validateSoqlStructure } from './soqlParser';
import { applyLimit, buildCountQuery, hasLimitClause, shouldPromptForCount } from './querySafety';
import { flattenRecordForDisplay } from './resultFlattening';

/**
 * Sidebar webview: SOQL textarea with inline suggestions + run button + results table.
 */
export class SoqlPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'soqlEditor.panel';
    private view?: vscode.WebviewView;
    private sfCli: SfCliService;
    private metadata: MetadataProvider;
    private outputChannel: vscode.OutputChannel;
    private extensionUri: vscode.Uri;
    private logSubscription?: vscode.Disposable;

    constructor(sfCli: SfCliService, metadata: MetadataProvider, outputChannel: vscode.OutputChannel, extensionUri: vscode.Uri) {
        this.sfCli = sfCli;
        this.metadata = metadata;
        this.outputChannel = outputChannel;
        this.extensionUri = extensionUri;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'src')]
        };
        this.outputChannel.appendLine('resolveWebviewView called, setting HTML');
        webviewView.webview.html = getPanelHtml(webviewView.webview, this.extensionUri);

        this.logSubscription?.dispose();
        this.logSubscription = undefined;

        // If an org is already selected, update the label immediately
        const currentOrg = this.sfCli.getCurrentOrg();
        if (currentOrg) {
            this.postMessage({ type: 'orgChanged', alias: currentOrg.alias, username: currentOrg.username });
        }

        // Pipe CLI log events to the webview console
        this.logSubscription = this.sfCli.onLog(({ level, message }: { level: string; message: string }) => {
            this.postMessage({ type: 'log', level, message });
        });
        webviewView.onDidDispose(() => {
            this.logSubscription?.dispose();
            this.logSubscription = undefined;
            if (this.view === webviewView) {
                this.view = undefined;
            }
        });

        webviewView.webview.onDidReceiveMessage(async (msg: any) => {
            try {
                switch (msg.type) {
                    case 'executeQuery':
                        await this.handleExecuteQuery(msg.query);
                        break;
                    case 'requestSuggestions': {
                        const items = await getSuggestions(msg.text, msg.offset, this.metadata);
                        this.postMessage({ type: 'suggestions', items });
                        break;
                    }
                    case 'selectOrg':
                        await vscode.commands.executeCommand('soqlEditor.selectOrg');
                        break;
                    case 'loadMetadata':
                        await this.handleLoadMetadata();
                        break;
                    case 'copyToClipboard':
                        await vscode.env.clipboard.writeText(msg.text);
                        this.postMessage({ type: 'toast', message: 'Results copied to clipboard' });
                        break;
                    case 'openCSV': {
                        const csvDoc = await vscode.workspace.openTextDocument({ content: msg.text, language: 'csv' });
                        await vscode.window.showTextDocument(csvDoc);
                        break;
                    }
                    case 'openJSON': {
                        const jsonDoc = await vscode.workspace.openTextDocument({ content: msg.text, language: 'json' });
                        await vscode.window.showTextDocument(jsonDoc);
                        break;
                    }
                    case 'openRecord': {
                        const org = this.sfCli.getCurrentOrg();
                        if (org?.instanceUrl) {
                            const url = `${org.instanceUrl}/${msg.recordId}`;
                            await vscode.env.openExternal(vscode.Uri.parse(url));
                        }
                        break;
                    }
                    case 'requestValidation': {
                        const errors = validateSoqlStructure(msg.text);
                        this.postMessage({ type: 'validationErrors', errors });
                        break;
                    }
                }
            } catch (err: any) {
                this.outputChannel.appendLine(`Panel error [${msg.type}]: ${err.message}`);
                this.postMessage({ type: 'error', message: err.message });
            }
        });
    }

    /** Called when the org changes so the webview can update its label */
    notifyOrgChanged(org: OrgInfo) {
        this.postMessage({ type: 'orgChanged', alias: org.alias, username: org.username });
    }

    private postMessage(msg: any) {
        this.view?.webview.postMessage(msg);
    }

    // ── load metadata (QuickPick) ──────────────────────────────────────

    private async handleLoadMetadata() {
        if (!this.sfCli.getCurrentOrg()) {
            this.postMessage({ type: 'error', message: 'Select an org first (click the org label above)' });
            return;
        }
        const pick = await vscode.window.showQuickPick([
            { label: '$(refresh) Clear Memory Cache', description: 'Keeps disk cache; next query re-reads from disk or org', value: 'refresh' },
            { label: '$(zap) Sync Common + Custom Objects', description: '~50 standard objects + all custom objects (~1-2 min)', value: 'syncCommon' },
            { label: '$(server) Sync All Objects', description: 'Every object in the org (can take 30+ min)', value: 'syncAll' },
            { label: '$(search) Cache Single Object', description: 'Type an object API name to fetch and cache its fields', value: 'single' },
        ], { placeHolder: 'Choose a metadata action' });
        if (!pick) { return; }
        try {
            switch (pick.value) {
                case 'refresh':
                    this.sfCli.clearCache();
                    this.postMessage({ type: 'log', level: 'info', message: 'In-memory cache cleared. Disk cache kept. Next query will re-fetch from cache or org.' });
                    this.postMessage({ type: 'info', message: 'Memory cache cleared (disk cache kept)' });
                    break;
                case 'syncCommon':
                    await vscode.commands.executeCommand('soqlEditor.syncCommonMetadata');
                    break;
                case 'syncAll':
                    await vscode.commands.executeCommand('soqlEditor.syncMetadata');
                    break;
                case 'single':
                    await this.handleCacheSingleObject();
                    break;
            }
        } catch (err: any) {
            this.outputChannel.appendLine(`Load metadata error: ${err.message}`);
            this.postMessage({ type: 'error', message: err.message });
        }
    }

    private async handleCacheSingleObject() {
        const objectName = await vscode.window.showInputBox({
            placeHolder: 'e.g. Account, My_Custom_Object__c',
            prompt: 'Enter the SObject API name to cache',
            ignoreFocusOut: true,
        });
        if (!objectName || !objectName.trim()) { return; }
        const normalized = normalizeSObjectApiName(objectName);
        if (!normalized) {
            this.postMessage({ type: 'error', message: 'Invalid object API name format' });
            return;
        }
        const name = normalized;
        this.postMessage({ type: 'log', level: 'info', message: 'Fetching metadata for ' + name + '...' });
        // Clear from memory + disk so it re-fetches live
        this.sfCli.clearCachedDescribe(name);
        this.metadata.clearSingleDiskCache(name);
        const result = await this.metadata.describeSObject(name);
        if (result) {
            this.postMessage({ type: 'log', level: 'info', message: 'Cached ' + name + ' (' + result.fields.length + ' fields)' });
            this.postMessage({ type: 'info', message: 'Cached ' + name + ' - ' + result.fields.length + ' fields' });
        } else {
            this.postMessage({ type: 'error', message: 'Could not find object: ' + name });
        }
    }

    // ── query execution ──────────────────────────────────────────────

    private async handleExecuteQuery(query: string) {
        if (!query.trim()) { return; }
        if (!this.sfCli.getCurrentOrg()) {
            this.postMessage({ type: 'error', message: 'Select an org first (click the org button above)' });
            return;
        }

        // Safety: if no LIMIT, run a COUNT() first to warn the user
        if (!hasLimitClause(query)) {
            const countQuery = buildCountQuery(query);
            if (countQuery) {
                this.postMessage({ type: 'log', level: 'cmd', message: 'Preparing COUNT() preflight query' });
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
                    // COUNT failed (e.g. complex query) — fall through and run anyway
                }
            }
        }

        this.postMessage({ type: 'queryStarted' });

        try {
            const result = await this.sfCli.executeQuery(query);
            const records: any[] = result.records || [];
            const totalSize: number = result.totalSize || records.length;

            const columns: string[] = [];
            const colSet = new Set<string>();
            const rows = records.map(rec => {
                const row = flattenRecordForDisplay(rec);
                for (const key of Object.keys(row)) {
                    if (!colSet.has(key)) {
                        colSet.add(key);
                        columns.push(key);
                    }
                }
                return row;
            });

            this.postMessage({ type: 'queryResults', columns, rows, rawRows: records, totalSize });
        } catch (err: any) {
            this.outputChannel.appendLine(`Panel query error: ${err.message}`);
            this.postMessage({ type: 'error', message: err.message });
        }
    }

}

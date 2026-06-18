import * as vscode from 'vscode';
import { SfCliService, OrgInfo, normalizeSObjectApiName } from './sfCliService';
import { MetadataProvider } from './metadataProvider';
import { getPanelHtml } from './panelHtml';
import { getSuggestions } from './panelSuggestions';
import { validateSoqlStructure } from './soqlParser';
import { applyLimit, buildCountQuery, hasLimitClause, shouldPromptForCount } from './querySafety';
import { flattenRecordForDisplay } from './resultFlattening';
import { PANEL_LOCAL_RESOURCE_ROOT } from './webviewAssets';

/** The user's answer to the in-panel large-query confirm prompt. */
type LargeQueryChoice = 'limit200' | 'limit2000' | 'all' | 'cancel';

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
    private executing = false;
    /** Aborts the in-flight CLI call (COUNT preflight or the query itself) when
     *  the user cancels from the panel. */
    private currentAbort?: AbortController;
    /** Resolver for the in-panel "large query" confirm prompt. Set while the
     *  webview is showing the prompt; cleared once a choice (or cancel) arrives. */
    private pendingConfirm?: (choice: LargeQueryChoice) => void;

    /** Upper bound on rows shipped to the webview, to avoid cloning an unbounded
     *  result set across the postMessage boundary on a "Fetch all". */
    private static readonly MAX_PANEL_ROWS = 50000;

    constructor(sfCli: SfCliService, metadata: MetadataProvider, outputChannel: vscode.OutputChannel, extensionUri: vscode.Uri) {
        this.sfCli = sfCli;
        this.metadata = metadata;
        this.outputChannel = outputChannel;
        this.extensionUri = extensionUri;
    }

    private getSlowQueryWarningThreshold(): number {
        const configured = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<number>('slowQueryWarningThreshold', 5000);
        if (!Number.isFinite(configured)) {
            return 5000;
        }
        const normalized = Math.floor(configured);
        return Math.max(0, normalized);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this.view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, PANEL_LOCAL_RESOURCE_ROOT)]
        };
        this.outputChannel.appendLine('resolveWebviewView called, setting HTML');
        webviewView.webview.html = getPanelHtml(webviewView.webview, this.extensionUri);

        this.logSubscription?.dispose();
        this.logSubscription = undefined;

        // Always push org state to webview immediately so label never shows stale restored state.
        const currentOrg = this.sfCli.getCurrentOrg();
        this.postMessage({
            type: 'orgChanged',
            alias: currentOrg?.alias,
            username: currentOrg?.username,
        });

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
                    case 'cancelQuery':
                        this.handleCancelQuery();
                        break;
                    case 'largeQueryChoice':
                        this.resolveLargeQueryChoice(msg.choice);
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
                        this.postMessage({ type: 'toast', message: msg.label || 'Copied to clipboard' });
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
                        // Defense in depth: webview client already filters the link,
                        // but re-validate here so the server never trusts the message.
                        const rawId = typeof msg.recordId === 'string' ? msg.recordId : '';
                        const validId = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(rawId);
                        if (!validId) {
                            this.outputChannel.appendLine(
                                `openRecord rejected: invalid record id "${rawId}"`
                            );
                            break;
                        }
                        const org = this.sfCli.getCurrentOrg();
                        if (!org) {
                            this.postMessage({ type: 'error', message: 'Select an org first to open records' });
                            break;
                        }
                        // Prefer the CLI's authenticated session (frontdoor) so the
                        // record opens even when the browser has no Salesforce login.
                        // Fall back to the bare instance URL (lands on the login page,
                        // which then redirects to the record once the user signs in).
                        const opened = await this.sfCli.openRecord(rawId);
                        if (!opened && org.instanceUrl) {
                            const url = `${org.instanceUrl.replace(/\/$/, '')}/${rawId}`;
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
            { label: '$(trash) Clear Cache', description: 'Clears cached metadata for the selected org', value: 'clearOrg' },
            { label: '$(zap) Sync Common + Custom Objects', description: '~50 standard objects + all custom objects (~1-2 min)', value: 'syncCommon' },
            { label: '$(server) Sync All Objects', description: 'Every object in the org (can take 30+ min)', value: 'syncAll' },
            { label: '$(search) Cache Single Object', description: 'Type an object API name to fetch and cache its fields', value: 'single' },
        ], { placeHolder: 'Choose a metadata action' });
        if (!pick) { return; }
        try {
            switch (pick.value) {
                case 'clearOrg':
                    this.sfCli.clearCache();
                    this.metadata.clearDiskCache();
                    this.postMessage({
                        type: 'log',
                        level: 'info',
                        message: 'Cleared cache for selected org.'
                    });
                    this.postMessage({ type: 'info', message: 'Cache cleared for selected org' });
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

        // Re-entrancy guard: overlapping runs race on the results message — a slower
        // earlier query could overwrite a later one (last-to-arrive wins). While a
        // run is in flight the webview's Run button becomes Cancel, so a second
        // click cancels rather than re-entering here.
        if (this.executing) {
            this.postMessage({ type: 'info', message: 'A query is already running' });
            return;
        }
        this.executing = true;
        const abort = new AbortController();
        this.currentAbort = abort;

        // Notify UI immediately so users get instant feedback on Run/Cmd+Enter,
        // even while preflight checks are still running.
        this.postMessage({ type: 'queryStarted' });

        try {
            // Safety: if no LIMIT, run a COUNT() first to warn the user
            if (!hasLimitClause(query)) {
                const countQuery = buildCountQuery(query);
                if (countQuery) {
                    this.postMessage({ type: 'log', level: 'cmd', message: 'Preparing COUNT() preflight query' });
                    try {
                        const countResult = await this.sfCli.executeQuery(countQuery, false, abort.signal);
                        const totalRows = countResult.totalSize ?? countResult.records?.[0]?.expr0 ?? '?';
                        const threshold = this.getSlowQueryWarningThreshold();
                        if (shouldPromptForCount(totalRows, threshold)) {
                            // Ask IN the panel rather than via a VS Code toast: right
                            // after an org switch the org's own notifications fill the
                            // toast stack, so a non-modal warning slides unseen into the
                            // notification center and the run wedges on "Running..." with
                            // the LIMIT options the user never saw. The in-panel prompt
                            // can't be buried, and Cancel is always one click away.
                            const choice = await this.askLargeQueryChoice(totalRows);
                            if (choice === 'cancel') {
                                this.postMessage({ type: 'info', message: 'Query cancelled' });
                                return;
                            }
                            if (choice === 'limit200') {
                                query = applyLimit(query, 200);
                            } else if (choice === 'limit2000') {
                                query = applyLimit(query, 2000);
                            }
                            // 'all' → run the query unbounded (the user opted in after
                            // seeing the row count).
                        }
                    } catch (err: any) {
                        if (abort.signal.aborted) {
                            this.postMessage({ type: 'info', message: 'Query cancelled' });
                            return;
                        }
                        // Surface (don't swallow) the preflight failure. Mirror it to
                        // the panel console too — the catch previously logged only to
                        // the output channel, so when the first post-switch CLI call
                        // failed the user saw nothing explaining the missing prompt.
                        const reason = err?.message ?? String(err);
                        this.outputChannel.appendLine(
                            `COUNT preflight failed (running without a size estimate): ${reason}`
                        );
                        this.postMessage({
                            type: 'log',
                            level: 'warn',
                            message: `COUNT preflight failed (running without a size estimate): ${reason}`,
                        });
                    }
                }
            }

            // Capture the org now so a mid-query org switch doesn't make us reconcile
            // (and pollute the cache of) the new org with this query's fields.
            const orgAtStart = this.sfCli.getCurrentOrg()?.username;

            const result = await this.sfCli.executeQuery(query, false, abort.signal);
            if (this.sfCli.getCurrentOrg()?.username === orgAtStart) {
                await this.metadata.reconcileSuccessfulQuery(query);
            }
            const allRecords: any[] = result.records || [];
            const totalSize: number = result.totalSize || allRecords.length;

            // Bound what we ship to the webview so a huge "Fetch all" can't OOM the
            // host serializing the full set. Display is further capped client-side.
            const cap = SoqlPanelProvider.MAX_PANEL_ROWS;
            const records = allRecords.length > cap ? allRecords.slice(0, cap) : allRecords;
            if (allRecords.length > cap) {
                this.outputChannel.appendLine(
                    `Result set capped at ${cap} rows for display/export (query matched ${totalSize}).`
                );
            }

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
            if (abort.signal.aborted) {
                // User cancelled — not an error. (The CLI rejects with a generic
                // envelope on SIGTERM, so key off our own signal, not err shape.)
                this.postMessage({ type: 'info', message: 'Query cancelled' });
            } else {
                this.outputChannel.appendLine(`Panel query error: ${err?.detail ?? err?.message ?? err}`);
                this.postMessage({
                    type: 'error',
                    message: err?.message ?? 'Query failed',
                    detail: err?.detail,
                    code: err?.code,
                    line: err?.line,
                    column: err?.column,
                });
            }
        } finally {
            this.executing = false;
            this.currentAbort = undefined;
            this.pendingConfirm = undefined;
        }
    }

    /**
     * Show the in-panel "large query" prompt and resolve once the webview reports
     * the user's choice (or a cancel). The returned promise is settled by
     * `resolveLargeQueryChoice` / `handleCancelQuery`.
     */
    private askLargeQueryChoice(totalRows: number | string): Promise<LargeQueryChoice> {
        return new Promise<LargeQueryChoice>(resolve => {
            this.pendingConfirm = resolve;
            this.postMessage({ type: 'confirmLargeQuery', totalRows });
        });
    }

    /** Settle a pending large-query prompt with the webview's choice. */
    private resolveLargeQueryChoice(choice: unknown) {
        const resolve = this.pendingConfirm;
        if (!resolve) { return; }
        this.pendingConfirm = undefined;
        const valid: LargeQueryChoice =
            choice === 'limit200' || choice === 'limit2000' || choice === 'all'
                ? choice
                : 'cancel';
        resolve(valid);
    }

    /** Cancel from the panel: abort an in-flight CLI call and/or a pending prompt. */
    private handleCancelQuery() {
        this.currentAbort?.abort();
        // If we're parked on the confirm prompt (no CLI call in flight), unblock it.
        this.resolveLargeQueryChoice('cancel');
    }

}

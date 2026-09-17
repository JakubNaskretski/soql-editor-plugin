/** VS Code extension activation and top-level service wiring. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { SfCliService } from './sfCliService';
import { OrgPicker } from './orgPicker';
import { SoqlCompletionProvider } from './completionProvider';
import { SoqlDiagnosticsProvider } from './diagnosticsProvider';
import { QueryExecutor } from './queryExecutor';
import { SoqlPanelProvider } from './soqlPanelProvider';
import { MetadataProvider } from './metadataProvider';
import { QueryHistoryStore } from './queryHistory';
import { getSharedOrg, onSharedOrgChange } from './kit/orgs';
import {
    LAST_SELECTED_ORG_KEY,
    ORG_SYNC_SETTING,
    isOrgSyncEnabled,
    resolveStartupOrg
} from './orgSync';

const SOQL_SELECTOR: vscode.DocumentSelector = { language: 'soql', scheme: 'file' };

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('SOQL Editor');
    outputChannel.appendLine('SOQL Editor activating...');

    // Core services
    const sfCli = new SfCliService(outputChannel);
    const metadata = new MetadataProvider(sfCli, outputChannel, context.globalStorageUri.fsPath);
    // Per-org query history (globalState ring buffer, 50 entries).
    const history = new QueryHistoryStore(context.globalState);

    // Org picker (status bar + quick pick; globalState persists the org-list
    // cache so the picker opens instantly in a fresh window).
    const orgPicker = new OrgPicker(sfCli, context.globalState);

    // Sidebar panel
    const panelProvider = new SoqlPanelProvider(sfCli, metadata, outputChannel, context.extensionUri, history);
    // The panel's inline org picklist is backed by OrgPicker's cached list:
    // picking in the dropdown is a user pick (so it publishes to the shared org
    // setting when sync is on), and every fresh `sf org list` re-feeds it.
    panelProvider.getOrgs = () => orgPicker.getKnownOrgs();
    panelProvider.onPickOrg = (username) => orgPicker.pickKnownOrg(username);
    panelProvider.onRefreshOrgs = () => orgPicker.refreshOrgs();
    context.subscriptions.push(orgPicker.onOrgListChanged(() => panelProvider.notifyOrgList()));
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SoqlPanelProvider.viewType, panelProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    let firstOrgNotificationPending = true;

    // Diagnostics (created before the org-change handler so it can re-validate).
    const diagnosticsProvider = new SoqlDiagnosticsProvider(sfCli, metadata);

    // Single org-change handler (consolidated; previously two separate listeners
    // were registered, neither disposed).
    orgPicker.onOrgChanged(async (org) => {
        // The private key is this plugin's source of truth and is written on
        // EVERY applied change (user pick, startup auto-select, following the
        // family). The shared cross-plugin setting is written ONLY by a
        // user-initiated pick, and only while org sync is on (inside
        // OrgPicker.applySelection) — otherwise merely activating this plugin, or
        // following a sibling's switch, would retarget the whole family.
        await context.globalState.update(LAST_SELECTED_ORG_KEY, org.username);

        // Drop the shared, non-per-org in-memory caches so the new org never
        // briefly serves the previous org's object list (30s TTL window).
        metadata.clearInMemoryCaches();

        panelProvider.notifyOrgChanged(org);

        // Re-validate all open SOQL files against the new org's metadata.
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'soql') {
                diagnosticsProvider.scheduleValidation(doc);
            }
        }

        const promptType: 'startup' | 'switch' = firstOrgNotificationPending ? 'startup' : 'switch';
        firstOrgNotificationPending = false;
        await maybePromptForMetadataReadiness(metadata, promptType);
    });

    // Auto-select the startup org (after the listener is registered). The private
    // key decides, with the one-time shared→private backfill and — only while
    // sync is on — the family's org applied first; an empty private key falls
    // back to the CLI default. Nothing here writes the shared setting.
    void resolveStartupOrg(context.globalState).then(
        startupOrg => orgPicker.autoSelectDefault(startupOrg),
        err => {
            // A globalState read/write failure must not leave the window org-less:
            // log it and fall through to the CLI-default auto-select.
            outputChannel.appendLine(`Could not resolve the stored org: ${err?.message ?? err}`);
            return orgPicker.autoSelectDefault(undefined);
        }
    );

    // React to external writes of the shared setting (another family plugin or
    // the user editing settings) by retargeting this plugin to that org — but
    // only while sync is on. The flag is read here, at event time, so toggling it
    // takes effect without a reload. An empty shared value is never adopted:
    // clearing the family org leaves this plugin on the org it is using.
    context.subscriptions.push(
        onSharedOrgChange(username => {
            if (!username || !isOrgSyncEnabled()) { return; }
            void orgPicker.applyExternalOrgUsername(username);
        })
    );

    // Turning sync ON adopts the family's current org right away (again, only a
    // non-empty one). Turning it off does nothing — this plugin simply keeps the
    // org it is on.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration(ORG_SYNC_SETTING) || !isOrgSyncEnabled()) { return; }
            const shared = getSharedOrg();
            if (shared) { void orgPicker.applyExternalOrgUsername(shared); }
        })
    );

    // Autocomplete
    const completionProvider = new SoqlCompletionProvider(metadata);

    // Query execution
    const queryExecutor = new QueryExecutor(sfCli, metadata, outputChannel, history);

    // Register completion provider — trigger on `.` (for relationship traversals) and `,`
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider(
            SOQL_SELECTOR,
            completionProvider,
            '.', ',', ' '
        )
    );

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.executeQuery', () => {
            queryExecutor.executeCurrentQuery();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.queryHistory', () => {
            return queryExecutor.pickFromHistory();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.help', () => showHelp(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.selectOrg', () => {
            return orgPicker.showPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.refreshOrgs', () => {
            return orgPicker.refreshOrgs();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.refreshMetadata', async () => {
            const selectedOrg = sfCli.getCurrentOrg();
            if (!selectedOrg) {
                vscode.window.showWarningMessage('Select an org first');
                return;
            }
            sfCli.clearCache();
            metadata.clearDiskCache();
            vscode.window.showInformationMessage(`SOQL Editor: Cache cleared for ${selectedOrg.alias}`);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.syncMetadata', async () => {
            if (!sfCli.getCurrentOrg()) {
                vscode.window.showWarningMessage('Select an org first');
                return;
            }
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'SOQL Editor: Syncing ALL metadata from org',
                    cancellable: true,
                },
                async (progress, token) => {
                    const r = await metadata.syncAllMetadata(progress, token);
                    if (r.candidateCount === 0) {
                        vscode.window.showWarningMessage(
                            'SOQL Editor: No objects to sync for this org. Check Output → SOQL Editor and that `sf sobject list` works.'
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            `SOQL Editor: Fetched ${r.fetched}; cached ${r.alreadyCached}; timed out ${r.timedOut}; failed ${r.failed}`
                        );
                    }
                }
            );
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.syncCommonMetadata', async () => {
            if (!sfCli.getCurrentOrg()) {
                vscode.window.showWarningMessage('Select an org first');
                return;
            }
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'SOQL Editor: Syncing common + custom objects',
                    cancellable: true,
                },
                async (progress, token) => {
                    const r = await metadata.syncCommonMetadata(progress, token);
                    if (r.candidateCount === 0) {
                        vscode.window.showWarningMessage(
                            'SOQL Editor: No objects to sync for this org. Check Output → SOQL Editor and that `sf sobject list` works.'
                        );
                    } else if (r.fetched === 0 && r.alreadyCached > 0) {
                        vscode.window.showInformationMessage(
                            `SOQL Editor: ${r.alreadyCached} common + custom objects already cached (nothing new to fetch)`
                        );
                    } else if (r.fetched === 0 && (r.failed > 0 || r.timedOut > 0)) {
                        vscode.window.showWarningMessage(
                            `SOQL Editor: 0 describes saved (${r.attempted} attempted, ${r.timedOut} timed out, ${r.failed} failed). See Output → SOQL Editor.`
                        );
                    } else if (r.fetched === 0) {
                        vscode.window.showWarningMessage(
                            `SOQL Editor: 0 describes saved (${r.candidateCount} tried). See Output → SOQL Editor for errors.`
                        );
                    } else {
                        vscode.window.showInformationMessage(
                            `SOQL Editor: Fetched ${r.fetched}; cached ${r.alreadyCached}; timed out ${r.timedOut}; failed ${r.failed}`
                        );
                    }
                }
            );
        })
    );

    // Validate on open and on change
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            diagnosticsProvider.scheduleValidation(doc);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument(event => {
            diagnosticsProvider.scheduleValidation(event.document);
        })
    );

    // (org-change re-validation is handled by the consolidated handler above)

    // Validate already-open documents
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'soql') {
            diagnosticsProvider.scheduleValidation(doc);
        }
    }

    // Disposables
    context.subscriptions.push(orgPicker);
    context.subscriptions.push(diagnosticsProvider);
    context.subscriptions.push(queryExecutor);
    context.subscriptions.push(outputChannel);

    outputChannel.appendLine('SOQL Editor activated');

    // Workspace-trust gate: skip filesystem mutations and local-project scanning
    // when the workspace is untrusted (the user opened a folder in "limited" mode).
    if (vscode.workspace.isTrusted) {
        const autoExclude = vscode.workspace
            .getConfiguration('soqlEditor')
            .get<boolean>('autoExcludeLegacyCache', true);
        if (autoExclude) {
            addToGitExclude(outputChannel);
        } else {
            outputChannel.appendLine(
                'soqlEditor.autoExcludeLegacyCache=false; not touching .git/info/exclude.'
            );
        }
        migrateLegacyCache(context.globalStorageUri.fsPath, context.globalState, outputChannel);
    } else {
        outputChannel.appendLine(
            'Workspace is untrusted: skipping .git/info/exclude write and legacy .soql-cache migration.'
        );
    }
}

export async function maybePromptForMetadataReadiness(
    metadata: MetadataProvider,
    promptType: 'startup' | 'switch'
) {
    const status = metadata.getCurrentOrgCacheStatus();
    if (status.hasCache && status.source === 'org') { return; }

    const isLocalFallback = status.source === 'local-fallback';
    const title = isLocalFallback
        ? 'SOQL Editor: This org is using local-repo metadata — autocomplete may be inaccurate.'
        : promptType === 'startup'
            ? 'SOQL Editor: Metadata cache is empty for this org — autocomplete may be limited.'
            : 'SOQL Editor: This org has no metadata cache yet — autocomplete may be limited.';

    // 2 buttons max: VS Code squeezes notification actions onto one
    // line and truncates them, so the old 5-action toast was unreadable.
    // The real choices live in the quick pick below, where they get full labels.
    const open = await vscode.window.showInformationMessage(title, 'Set Up Metadata', 'Later');
    if (open !== 'Set Up Metadata') { return; }

    const otherCaches = metadata.listOtherCachedOrgKeys();

    const items = [
        {
            label: '$(cloud-download) Download common + custom objects',
            detail: 'Recommended. Standard objects most queries touch, plus every custom object.',
            action: 'common',
        },
        {
            label: '$(cloud-download) Download all objects',
            detail: 'Complete, but slow on large orgs.',
            action: 'all',
        },
        ...(isLocalFallback ? [] : [{
            label: '$(folder) Use local repo metadata',
            detail: 'Build a cache from SFDX object files in this workspace. No org call.',
            action: 'local',
        }]),
        ...(otherCaches.length > 0 ? [{
            label: '$(copy) Reuse another org cache',
            detail: `Copy cached describes from one of ${otherCaches.length} other cached org${otherCaches.length === 1 ? '' : 's'}.`,
            action: 'reuse',
        }] : []),
    ];

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'How should SOQL Editor get metadata for this org?',
    });
    const choice = picked?.action;
    if (!choice) { return; }

    if (choice === 'common') {
        await vscode.commands.executeCommand('soqlEditor.syncCommonMetadata');
        return;
    }

    if (choice === 'all') {
        await vscode.commands.executeCommand('soqlEditor.syncMetadata');
        return;
    }

    if (choice === 'local') {
        const built = metadata.bootstrapCurrentOrgCacheFromLocalProject();
        if (built > 0) {
            vscode.window.showInformationMessage(
                `SOQL Editor: Generated local fallback cache for ${built} objects.`
            );
        } else {
            vscode.window.showWarningMessage(
                'SOQL Editor: No local SFDX object metadata found to build a fallback cache.'
            );
        }
        return;
    }

    if (choice === 'reuse') {
        const picked = await vscode.window.showQuickPick(
            otherCaches.map(key => ({
                label: key,
                detail: 'Reuse cached metadata files from this org cache',
            })),
            { placeHolder: 'Select cache source org' }
        );
        if (!picked) { return; }

        const copied = metadata.bootstrapCurrentOrgCacheFrom(picked.label);
        if (copied > 0) {
            vscode.window.showInformationMessage(
                `SOQL Editor: Reused ${copied} cached metadata files from ${picked.label}`
            );
        } else {
            vscode.window.showWarningMessage(
                'SOQL Editor: Could not reuse cache files. Try Download Common Metadata instead.'
            );
        }
    }
}

/**
 * Add .soql-cache to .git/info/exclude in every workspace folder that has a .git dir.
 * This prevents the legacy cache folder from being tracked without touching .gitignore.
 */
function addToGitExclude(outputChannel: vscode.OutputChannel) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    const entry = '.soql-cache';

    for (const folder of folders) {
        const excludePath = path.join(folder.uri.fsPath, '.git', 'info', 'exclude');
        try {
            if (!fs.existsSync(path.dirname(excludePath))) { continue; }
            let content = '';
            if (fs.existsSync(excludePath)) {
                content = fs.readFileSync(excludePath, 'utf-8');
            }
            if (content.split('\n').some(line => line.trim() === entry)) { continue; }
            const sep = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
            fs.appendFileSync(excludePath, `${sep}${entry}\n`, 'utf-8');
            outputChannel.appendLine(`Added ${entry} to ${excludePath}`);
        } catch {
            // Silently skip — might not have write access
        }
    }
}

/**
 * Detect legacy .soql-cache folders in workspace and offer to migrate them
 * to the new globalStorage location.
 */
async function migrateLegacyCache(globalStoragePath: string, globalState: vscode.Memento, outputChannel: vscode.OutputChannel) {
    // Don't prompt again if user already dismissed or migrated
    if (globalState.get<boolean>('cacheMigrationDone')) { return; }

    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    const legacyDirs: { folderPath: string; cachePath: string }[] = [];
    for (const folder of folders) {
        const cachePath = path.join(folder.uri.fsPath, '.soql-cache');
        if (fs.existsSync(cachePath) && fs.statSync(cachePath).isDirectory()) {
            legacyDirs.push({ folderPath: folder.uri.fsPath, cachePath });
        }
    }

    if (legacyDirs.length === 0) { return; }

    const fileCount = legacyDirs.reduce((sum, d) => {
        try {
            return sum + fs.readdirSync(d.cachePath, { recursive: true }).length;
        } catch { return sum; }
    }, 0);

    const choice = await vscode.window.showInformationMessage(
        `SOQL Editor found legacy cache (.soql-cache) with ~${fileCount} files. ` +
        `Migrate to the new location? This is recommended — the new cache is stored ` +
        `outside your repo and won't be tracked by git.`,
        'Migrate & Delete Old',
        'Migrate & Keep Old',
        'Skip'
    );

    if (!choice || choice === 'Skip') {
        await globalState.update('cacheMigrationDone', true);
        return;
    }

    const destBase = path.join(globalStoragePath, 'cache');
    let migratedCount = 0;
    let failedCount = 0;

    for (const { cachePath } of legacyDirs) {
        try {
            // Safety: skip if .soql-cache is a symlink
            if (fs.lstatSync(cachePath).isSymbolicLink()) {
                outputChannel.appendLine(`Skipping symlinked cache: ${cachePath}`);
                failedCount++;
                continue;
            }

            // Recursively copy all files preserving directory structure
            copyDirRecursive(cachePath, destBase);
            outputChannel.appendLine(`Migrated cache from ${cachePath} to ${destBase}`);
            migratedCount++;

            if (choice === 'Migrate & Delete Old') {
                fs.rmSync(cachePath, { recursive: true, force: true });
                outputChannel.appendLine(`Deleted legacy cache: ${cachePath}`);
            }
        } catch (err: any) {
            failedCount++;
            outputChannel.appendLine(`Cache migration error: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to migrate cache: ${err.message}`);
        }
    }

    if (failedCount === 0) {
        vscode.window.showInformationMessage(
            `SOQL Editor: Cache migration completed (${migratedCount}/${legacyDirs.length} folders)`
        );
        await globalState.update('cacheMigrationDone', true);
    } else {
        vscode.window.showWarningMessage(
            `SOQL Editor: Cache migration partially completed (${migratedCount} succeeded, ${failedCount} failed). You can retry on next startup.`
        );
        await globalState.update('cacheMigrationDone', false);
    }
}

function copyDirRecursive(src: string, dest: string) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        // Skip any symlink entry — a malicious workspace could plant
        // `.soql-cache/dir/file -> /etc/passwd` and turn migration into an
        // arbitrary read (or, with "Delete Old", an arbitrary unlink).
        // withFileTypes uses lstat semantics, so this catches all symlinks.
        if (entry.isSymbolicLink()) {
            continue;
        }
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

export function deactivate() {}

// The "?" in the panel title: a short plain-text guide (a modal's detail renders no markdown).
async function showHelp(context: vscode.ExtensionContext): Promise<void> {
    const HELP = `1. Authenticate an org first: sf org login web (Salesforce CLI required).
2. Pick the org from the status bar, the panel dropdown, or SOQL: Select Org.
3. Query from the SOQL Query panel in the Activity Bar, or open a .soql file.
4. Run with Cmd/Ctrl+Enter. Past queries: the panel's History button, or Cmd/Ctrl+Alt+H in a .soql file.
5. Autocomplete needs org metadata: Load Metadata, then Sync Common + Custom Objects.
6. Results: click an Id to open the record, click a cell to copy, open them as CSV or JSON.
7. Tooling API objects (ApexClass, CustomField): the panel's Tooling toggle, or soqlEditor.useToolingApi for .soql files.
8. Stale fields after an org change? SOQL: Clear Cache, then sync again.`;
    const choice = await vscode.window.showInformationMessage('SOQL Editor', { modal: true, detail: HELP }, 'Open README');
    if (choice === 'Open README') {
        // vsce ships the file as readme.md while the dev host has README.md: open whichever exists
        for (const name of ['readme.md', 'README.md']) {
            const uri = vscode.Uri.joinPath(context.extensionUri, name);
            try {
                await vscode.workspace.fs.stat(uri);
                await vscode.commands.executeCommand('markdown.showPreview', uri);
                return;
            } catch { /* try the other spelling */ }
        }
        void vscode.window.showWarningMessage('README not found in the extension folder.');
    }
}

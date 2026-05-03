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

const SOQL_SELECTOR: vscode.DocumentSelector = { language: 'soql', scheme: 'file' };
const LAST_SELECTED_ORG_KEY = 'soqlEditor.lastSelectedOrgUsername';

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('SOQL Editor');
    outputChannel.appendLine('SOQL Editor activating...');

    // Core services
    const sfCli = new SfCliService(outputChannel);
    const metadata = new MetadataProvider(sfCli, outputChannel, context.globalStorageUri.fsPath);

    // Org picker (status bar + quick pick)
    const orgPicker = new OrgPicker(sfCli);

    // Sidebar panel
    const panelProvider = new SoqlPanelProvider(sfCli, metadata, outputChannel, context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(SoqlPanelProvider.viewType, panelProvider, {
            webviewOptions: { retainContextWhenHidden: true }
        })
    );

    let firstOrgNotificationPending = true;

    // Notify panel when org changes
    orgPicker.onOrgChanged(async (org) => {
        await context.globalState.update(LAST_SELECTED_ORG_KEY, org.username);
        panelProvider.notifyOrgChanged(org);

        const promptType: 'startup' | 'switch' = firstOrgNotificationPending ? 'startup' : 'switch';
        firstOrgNotificationPending = false;
        await maybePromptForMetadataReadiness(metadata, promptType);
    });

    // Auto-select default org (after listener is registered)
    const lastSelectedOrg = context.globalState.get<string>(LAST_SELECTED_ORG_KEY);
    orgPicker.autoSelectDefault(lastSelectedOrg);

    // Autocomplete
    const completionProvider = new SoqlCompletionProvider(metadata);

    // Diagnostics
    const diagnosticsProvider = new SoqlDiagnosticsProvider(sfCli, metadata);

    // Query execution
    const queryExecutor = new QueryExecutor(sfCli, metadata, outputChannel);

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
        vscode.commands.registerCommand('soqlEditor.selectOrg', () => {
            return orgPicker.showPicker();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('soqlEditor.refreshMetadata', async () => {
            const choice = await vscode.window.showQuickPick(
                [
                    { label: 'Memory only', description: 'Clear in-memory cache, keep disk cache', value: 'memory' },
                    { label: 'Memory + Disk', description: 'Clear everything, re-fetch from org', value: 'both' },
                ],
                { placeHolder: 'What to clear?' }
            );
            if (!choice) { return; }
            sfCli.clearCache();
            if (choice.value === 'both') {
                metadata.clearDiskCache();
                vscode.window.showInformationMessage('SOQL Editor: All caches cleared');
            } else {
                vscode.window.showInformationMessage('SOQL Editor: Memory cache cleared (disk cache kept)');
            }
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
                    const count = await metadata.syncAllMetadata(progress, token);
                    vscode.window.showInformationMessage(
                        `SOQL Editor: ${count} objects in cache`
                    );
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
                    const count = await metadata.syncCommonMetadata(progress, token);
                    vscode.window.showInformationMessage(
                        `SOQL Editor: Cached ${count} common + custom objects`
                    );
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

    // Re-validate and re-fetch metadata when org changes
    orgPicker.onOrgChanged(() => {
        // Re-validate all open SOQL files
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'soql') {
                diagnosticsProvider.scheduleValidation(doc);
            }
        }
    });

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

    // Ensure .soql-cache is in .git/info/exclude for all workspace repos
    addToGitExclude(outputChannel);

    // Offer to migrate legacy .soql-cache to globalStorage
    migrateLegacyCache(context.globalStorageUri.fsPath, context.globalState, outputChannel);
}

export async function maybePromptForMetadataReadiness(
    metadata: MetadataProvider,
    promptType: 'startup' | 'switch'
) {
    const status = metadata.getCurrentOrgCacheStatus();
    if (status.hasCache && status.source === 'org') { return; }

    if (status.source === 'local-fallback') {
        const localTitle = promptType === 'startup'
            ? 'SOQL Editor: This org is using local-repo generated metadata cache. It may be incomplete for the target org.'
            : 'SOQL Editor: Active cache source is local-repo metadata for this org and may be inaccurate.';
        const localChoice = await vscode.window.showInformationMessage(
            localTitle,
            'Download Common Metadata',
            'Download All Metadata',
            'Keep Local Cache'
        );
        if (!localChoice || localChoice === 'Keep Local Cache') { return; }
        if (localChoice === 'Download Common Metadata') {
            await vscode.commands.executeCommand('soqlEditor.syncCommonMetadata');
        } else if (localChoice === 'Download All Metadata') {
            await vscode.commands.executeCommand('soqlEditor.syncMetadata');
        }
        return;
    }

    const otherCaches = metadata.listOtherCachedOrgKeys();
    const hasOtherCaches = otherCaches.length > 0;

    const title = promptType === 'startup'
        ? 'SOQL Editor: Metadata cache is empty for this org. Autocomplete may be limited until metadata is downloaded.'
        : 'SOQL Editor: This org has no metadata cache yet. Autocomplete may be limited.';

    const actions = hasOtherCaches
        ? ['Download Common Metadata', 'Download All Metadata', 'Use Local Repo Metadata', 'Reuse Other Org Cache', 'Later']
        : ['Download Common Metadata', 'Download All Metadata', 'Use Local Repo Metadata', 'Later'];

    const choice = await vscode.window.showInformationMessage(title, ...actions);
    if (!choice || choice === 'Later') { return; }

    if (choice === 'Download Common Metadata') {
        await vscode.commands.executeCommand('soqlEditor.syncCommonMetadata');
        return;
    }

    if (choice === 'Download All Metadata') {
        await vscode.commands.executeCommand('soqlEditor.syncMetadata');
        return;
    }

    if (choice === 'Use Local Repo Metadata') {
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

    if (choice === 'Reuse Other Org Cache') {
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


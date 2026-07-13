import * as vscode from 'vscode';
import { SfCliService, OrgInfo } from './sfCliService';
import { setSharedOrg } from './kit/orgs';

interface OrgQuickPickItem extends vscode.QuickPickItem {
    org: OrgInfo;
}

/**
 * Manages org selection via a status bar item and quick pick.
 */
export class OrgPicker {
    private statusBarItem: vscode.StatusBarItem;
    private sfCli: SfCliService;
    private onOrgChangedEmitter = new vscode.EventEmitter<OrgInfo>();
    public readonly onOrgChanged = this.onOrgChangedEmitter.event;
    /** Monotonic token so out-of-order external-switch resolutions can't revert a
     *  newer choice: each external event captures it and bails if superseded. */
    private applyGeneration = 0;

    constructor(sfCli: SfCliService) {
        this.sfCli = sfCli;

        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'soqlEditor.selectOrg';
        this.statusBarItem.tooltip = 'Select Salesforce Org for SOQL queries';
        this.updateLabel();
        this.statusBarItem.show();
    }

    async showPicker(): Promise<void> {
        let orgs: OrgInfo[];
        try {
            orgs = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'Loading orgs...' },
                () => this.sfCli.listOrgs()
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to list orgs: ${err.message}`);
            return;
        }

        if (orgs.length === 0) {
            vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Run `sf org login web` first.');
            return;
        }

        const items: OrgQuickPickItem[] = orgs.map(o => ({
            label: o.alias,
            description: o.username,
            detail: o.instanceUrl,
            picked: o.isDefault,
            org: o,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a Salesforce org to query against',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (picked) {
            const selectedOrg = picked.org;
            if (selectedOrg) {
                // User-initiated pick: applySelection publishes the choice to the
                // shared cross-plugin setting so the other family plugins retarget
                // the same org. This is the ONLY path allowed to write it.
                this.applySelection(selectedOrg, true);
                vscode.window.showInformationMessage(`SOQL Editor: Now targeting ${selectedOrg.alias}`);
            }
        }
    }

    /** Apply an org locally (sfCli + label + change event). Shared between the
     *  manual picker, startup auto-select, and external shared-setting changes.
     *
     *  `userInitiated` gates the one cross-plugin side effect: only a manual pick
     *  publishes to the shared `skrety.salesforce.targetOrg` setting. Programmatic
     *  applies (startup auto-select, following an external change) stay local, so
     *  merely activating this plugin — or following the family — never writes the
     *  shared setting back and silently retargets every sibling. */
    private applySelection(org: OrgInfo, userInitiated: boolean) {
        this.sfCli.setCurrentOrg(org);
        this.updateLabel();
        if (userInitiated) {
            // Fire-and-forget; the write is idempotent and our own
            // onSharedOrgChange handler no-ops when the username already matches.
            void setSharedOrg(org.username);
        }
        this.onOrgChangedEmitter.fire(org);
    }

    /** Build a minimal OrgInfo from a bare username so this plugin can still
     *  follow the family to an org we can't enrich — auth known only to another
     *  plugin, or a transient `sf org list` failure. Unknown flags are treated
     *  conservatively (not the CLI default). */
    private minimalOrg(username: string): OrgInfo {
        return { alias: username, username, instanceUrl: '', isDefault: false };
    }

    /**
     * React to an external write of the shared `skrety.salesforce.targetOrg`
     * setting (another family plugin, or the user editing settings): switch this
     * plugin to that org. No-ops when it already matches the current org (so our
     * own picker write doesn't cause a redundant re-switch). Applies locally only
     * — an external change must never be written back to the shared setting.
     */
    async applyExternalOrgUsername(username: string | undefined): Promise<void> {
        // Monotonic generation: rapid external A→B→C switches each fire this
        // handler. Capture a token now and re-check it after the async listOrgs so
        // a superseded resolution bails instead of clobbering a newer choice
        // (out-of-order listOrgs completions could otherwise land B after C).
        const gen = ++this.applyGeneration;

        // External clear (the shared setting was emptied): drop the current org and
        // show the no-org state rather than silently staying on the org every
        // sibling just moved off.
        if (!username) {
            this.sfCli.clearCurrentOrg();
            this.updateLabel();
            return;
        }
        if (this.sfCli.getCurrentOrg()?.username === username) { return; }

        let orgs: OrgInfo[];
        try {
            orgs = await this.sfCli.listOrgs();
        } catch {
            // Couldn't enrich the org — follow the family with a minimal OrgInfo
            // rather than stranding this plugin on the previous org. Skip if a
            // newer switch already superseded this one.
            if (gen === this.applyGeneration) {
                this.applySelection(this.minimalOrg(username), false);
            }
            return;
        }
        if (gen !== this.applyGeneration) { return; } // a newer switch won the race

        // Fall back to a minimal OrgInfo when the username isn't in the list (auth
        // known only to another plugin) so we still follow the family.
        const match = orgs.find(o => o.username.toLowerCase() === username.toLowerCase())
            ?? this.minimalOrg(username);
        if (this.sfCli.getCurrentOrg()?.username === match.username) { return; }
        this.applySelection(match, false);
    }

    async autoSelectDefault(preferredUsername?: string): Promise<void> {
        try {
            const orgs = await this.sfCli.listOrgs();
            const preferredOrg = preferredUsername
                ? orgs.find(o => o.username.toLowerCase() === preferredUsername.toLowerCase())
                : undefined;
            const startupOrg = preferredOrg || orgs.find(o => o.isDefault);
            if (startupOrg) {
                // Programmatic (activation): apply locally, never write shared.
                this.applySelection(startupOrg, false);
            }
        } catch {
            // Silently fail on startup — user can pick manually
        }
    }

    private updateLabel() {
        const org = this.sfCli.getCurrentOrg();
        if (org) {
            this.statusBarItem.text = `$(cloud) ${org.alias}`;
        } else {
            this.statusBarItem.text = '$(cloud) No Org Selected';
        }
    }

    dispose() {
        this.statusBarItem.dispose();
        this.onOrgChangedEmitter.dispose();
    }
}

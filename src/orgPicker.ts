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
                this.applySelection(selectedOrg);
                // Publish the choice to the shared, cross-plugin setting so the
                // other family plugins retarget the same org. Fire-and-forget; the
                // write is idempotent and our own onSharedOrgChange handler no-ops
                // when the username already matches the current org.
                void setSharedOrg(selectedOrg.username);
                vscode.window.showInformationMessage(`SOQL Editor: Now targeting ${selectedOrg.alias}`);
            }
        }
    }

    /** Apply an org locally (sfCli + label + change event). Shared between the
     *  manual picker, startup auto-select, and external shared-setting changes. */
    private applySelection(org: OrgInfo) {
        this.sfCli.setCurrentOrg(org);
        this.updateLabel();
        this.onOrgChangedEmitter.fire(org);
    }

    /**
     * React to an external write of the shared `skrety.salesforce.targetOrg`
     * setting (another family plugin, or the user editing settings): switch this
     * plugin to that org. No-ops when it already matches the current org (so our
     * own picker write doesn't cause a redundant re-switch) or when the username
     * isn't among the authenticated orgs.
     */
    async applyExternalOrgUsername(username: string | undefined): Promise<void> {
        if (!username) { return; }
        if (this.sfCli.getCurrentOrg()?.username === username) { return; }
        let orgs: OrgInfo[];
        try {
            orgs = await this.sfCli.listOrgs();
        } catch {
            return; // can't resolve — leave the current org untouched
        }
        const match = orgs.find(o => o.username.toLowerCase() === username.toLowerCase());
        if (!match) { return; }
        if (this.sfCli.getCurrentOrg()?.username === match.username) { return; }
        this.applySelection(match);
    }

    async autoSelectDefault(preferredUsername?: string): Promise<void> {
        try {
            const orgs = await this.sfCli.listOrgs();
            const preferredOrg = preferredUsername
                ? orgs.find(o => o.username.toLowerCase() === preferredUsername.toLowerCase())
                : undefined;
            const startupOrg = preferredOrg || orgs.find(o => o.isDefault);
            if (startupOrg) {
                this.applySelection(startupOrg);
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

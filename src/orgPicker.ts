import * as vscode from 'vscode';
import { SfCliService, OrgInfo } from './sfCliService';

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

        const items: vscode.QuickPickItem[] = orgs.map(o => ({
            label: o.alias,
            description: o.username,
            detail: o.instanceUrl,
            picked: o.isDefault,
        }));

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a Salesforce org to query against',
            matchOnDescription: true,
            matchOnDetail: true,
        });

        if (picked) {
            const org = orgs.find(o => o.username === picked.description);
            if (org) {
                this.sfCli.setCurrentOrg(org);
                this.updateLabel();
                this.onOrgChangedEmitter.fire(org);
                vscode.window.showInformationMessage(`SOQL Editor: Now targeting ${org.alias}`);
            }
        }
    }

    async autoSelectDefault(): Promise<void> {
        try {
            const orgs = await this.sfCli.listOrgs();
            const defaultOrg = orgs.find(o => o.isDefault);
            if (defaultOrg) {
                this.sfCli.setCurrentOrg(defaultOrg);
                this.updateLabel();
                this.onOrgChangedEmitter.fire(defaultOrg);
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

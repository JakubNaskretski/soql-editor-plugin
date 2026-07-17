import * as vscode from 'vscode';
import { SfCliService, OrgInfo } from './sfCliService';
import { setSharedOrg } from './kit/orgs';

interface OrgQuickPickItem extends vscode.QuickPickItem {
    org: OrgInfo;
}

/** globalState key holding the last successful `sf org list` result, so the
 *  picker opens instantly (even in a fresh window) while a live list loads. */
const ORG_LIST_CACHE_KEY = 'soqlEditor.cachedOrgList';

/**
 * Manages org selection via a status bar item and quick pick.
 *
 * The org list is cached (in memory + globalState): opening the picker shows
 * the cached orgs immediately and revalidates via `sf org list` in the
 * background, swapping the items in place when the live list lands — so a
 * just-added org appears without reopening. Explicit refresh: the picker's
 * ↻ title button or the `SOQL: Refresh Org List` palette command.
 */
export class OrgPicker {
    private statusBarItem: vscode.StatusBarItem;
    private sfCli: SfCliService;
    private onOrgChangedEmitter = new vscode.EventEmitter<OrgInfo>();
    public readonly onOrgChanged = this.onOrgChangedEmitter.event;
    /** Fires whenever a fresh org list lands in the cache — feeds the panel's
     *  inline org picklist. */
    private onOrgListChangedEmitter = new vscode.EventEmitter<OrgInfo[]>();
    public readonly onOrgListChanged = this.onOrgListChangedEmitter.event;
    /** Monotonic token so out-of-order external-switch resolutions can't revert a
     *  newer choice: each external event captures it and bails if superseded. */
    private applyGeneration = 0;

    /** Cached org list backing the picker (display-only — selection state and
     *  external-switch resolution still always fetch live). */
    private knownOrgs: OrgInfo[] = [];
    /** Monotonic token: only the newest in-flight list fetch may update the
     *  cache/picker, so a slow stale fetch can't clobber a fresh refresh. */
    private listGeneration = 0;
    /** The QuickPick currently on screen — used to no-op a re-entrant open
     *  (status-bar double-click) and to retarget refresh results. */
    private activePick: vscode.QuickPick<OrgQuickPickItem> | undefined;
    /** Single-flight guards: rapid ⟳ clicks / refresh commands join the one
     *  in-flight `sf org list` instead of spawning one process each. */
    private listOrgsInflight: Promise<OrgInfo[]> | undefined;
    private refreshInflight: Promise<void> | undefined;

    constructor(sfCli: SfCliService, private readonly globalState?: vscode.Memento) {
        this.sfCli = sfCli;

        // Seed from the persisted copy; drop malformed entries rather than let a
        // corrupt cache break the picker (it self-heals on the next fetch).
        const cached = globalState?.get<OrgInfo[]>(ORG_LIST_CACHE_KEY);
        if (Array.isArray(cached)) {
            this.knownOrgs = cached.filter(o =>
                o
                && typeof o.username === 'string'
                && typeof o.alias === 'string'
                && typeof o.instanceUrl === 'string'
            );
        }

        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            100
        );
        this.statusBarItem.command = 'soqlEditor.selectOrg';
        this.statusBarItem.tooltip = 'Select Salesforce Org for SOQL queries';
        this.updateLabel();
        this.statusBarItem.show();
    }

    /** Update the in-memory + persisted org cache (persist is fire-and-forget;
     *  a storage failure only costs the warm start, so it's swallowed). */
    private setKnownOrgs(orgs: OrgInfo[]) {
        this.knownOrgs = orgs;
        this.globalState?.update(ORG_LIST_CACHE_KEY, orgs).then(undefined, () => {});
        this.onOrgListChangedEmitter.fire(orgs);
    }

    /** The cached org list (possibly stale until the next fetch lands). */
    getKnownOrgs(): OrgInfo[] {
        return this.knownOrgs;
    }

    /** Select an org by username, from the panel's inline picklist. Honors only
     *  usernames present in the cached list — the webview can only legitimately
     *  offer what we gave it, so anything else is stale/forged and ignored.
     *  This IS a user-initiated pick: it publishes to the shared setting. */
    pickKnownOrg(username: string): void {
        const org = this.knownOrgs.find(o => o.username.toLowerCase() === username.toLowerCase());
        if (org) { this.applySelection(org, true); }
    }

    /** All picker-surface fetches funnel through here so concurrent callers
     *  share one `sf org list` spawn. */
    private fetchOrgList(): Promise<OrgInfo[]> {
        return (this.listOrgsInflight ??= this.sfCli.listOrgs().finally(() => {
            this.listOrgsInflight = undefined;
        }));
    }

    /**
     * Open the org picker. Resolves when the picker closes (picked or
     * dismissed). Cached orgs render instantly; a background `sf org list`
     * refreshes them in place.
     */
    showPicker(): Promise<void> {
        if (this.activePick) { return Promise.resolve(); } // double-click on the status bar
        const qp = vscode.window.createQuickPick<OrgQuickPickItem>();
        this.activePick = qp;
        qp.placeholder = 'Select a Salesforce org to query against';
        qp.matchOnDescription = true;
        qp.matchOnDetail = true;
        qp.buttons = [{ iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh org list' }];
        this.renderItems(qp, this.knownOrgs);
        qp.onDidTriggerButton(() => { void this.revalidate(qp); });
        qp.onDidAccept(() => {
            const picked = qp.selectedItems[0];
            qp.hide();
            if (picked) {
                // User-initiated pick: applySelection publishes the choice to the
                // shared cross-plugin setting so the other family plugins retarget
                // the same org. This is the ONLY path allowed to write it.
                this.applySelection(picked.org, true);
                vscode.window.showInformationMessage(`SOQL Editor: Now targeting ${picked.org.alias}`);
            }
        });
        const closed = new Promise<void>(resolve => {
            qp.onDidHide(() => {
                if (this.activePick === qp) { this.activePick = undefined; }
                qp.dispose();
                resolve();
            });
        });
        qp.show();
        void this.revalidate(qp);
        return closed;
    }

    /** Palette command (`SOQL: Refresh Org List`): force-refresh the cached org
     *  list so the picker reflects a just-added/removed org. Re-entrant calls
     *  (panel ⟳ spam, repeated command) join the in-flight refresh. */
    refreshOrgs(): Promise<void> {
        return (this.refreshInflight ??= this.doRefreshOrgs().finally(() => {
            this.refreshInflight = undefined;
        }));
    }

    private async doRefreshOrgs(): Promise<void> {
        const gen = ++this.listGeneration;
        try {
            const orgs = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: 'SOQL: Refreshing org list...' },
                () => this.fetchOrgList()
            );
            if (gen !== this.listGeneration) { return; } // superseded by a newer fetch
            this.setKnownOrgs(orgs);
            if (this.activePick) {
                // This fetch is now the newest, so it owns the busy spinner too —
                // a revalidate it superseded returns early without clearing it.
                this.activePick.busy = false;
                this.renderItems(this.activePick, orgs);
            }
            if (orgs.length === 0) {
                vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Run `sf org login web` first.');
            } else {
                vscode.window.showInformationMessage(
                    `SOQL Editor: Org list refreshed — ${orgs.length} org${orgs.length === 1 ? '' : 's'}.`
                );
            }
        } catch (err: any) {
            // Superseded by a newer fetch → stay silent; that fetch owns the
            // spinner and reports its own outcome (avoids double error toasts).
            if (gen !== this.listGeneration) { return; }
            if (this.activePick) { this.activePick.busy = false; }
            vscode.window.showErrorMessage(`Failed to refresh org list: ${err.message}`);
        }
    }

    /** Swap the picker's items, keeping the highlight on the org the user had
     *  it on (or the current org for a fresh picker). */
    private renderItems(qp: vscode.QuickPick<OrgQuickPickItem>, orgs: OrgInfo[]) {
        const active = qp.activeItems[0]?.org.username ?? this.sfCli.getCurrentOrg()?.username;
        qp.items = orgs.map(o => ({
            label: o.alias,
            description: o.username,
            detail: o.instanceUrl,
            org: o,
        }));
        const keep = active ? qp.items.find(i => i.org.username === active) : undefined;
        if (keep) { qp.activeItems = [keep]; }
    }

    /** Fetch a live org list; if still the newest fetch, update the cache and
     *  the picker. A failure while cached items are on screen keeps serving
     *  them (the service already logged it); a failure with nothing to show
     *  keeps the old loud error path. */
    private async revalidate(qp: vscode.QuickPick<OrgQuickPickItem>): Promise<void> {
        const gen = ++this.listGeneration;
        qp.busy = true;
        let orgs: OrgInfo[];
        try {
            orgs = await this.fetchOrgList();
        } catch (err: any) {
            if (gen !== this.listGeneration || this.activePick !== qp) { return; }
            qp.busy = false;
            if (qp.items.length === 0) {
                qp.hide();
                vscode.window.showErrorMessage(`Failed to list orgs: ${err.message}`);
            }
            return;
        }
        if (gen !== this.listGeneration) { return; } // superseded by a newer fetch
        this.setKnownOrgs(orgs);
        if (this.activePick !== qp) { return; } // picker closed while loading
        qp.busy = false;
        if (orgs.length === 0) {
            qp.hide();
            vscode.window.showWarningMessage('No authenticated Salesforce orgs found. Run `sf org login web` first.');
            return;
        }
        this.renderItems(qp, orgs);
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
        // A fresh list landed — cache it even if this switch lost the race below.
        this.setKnownOrgs(orgs);
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
            this.setKnownOrgs(orgs); // warm the picker cache at activation
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
        this.activePick?.dispose();
        this.statusBarItem.dispose();
        this.onOrgChangedEmitter.dispose();
        this.onOrgListChangedEmitter.dispose();
    }
}

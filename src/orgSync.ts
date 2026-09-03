/**
 * Org-sync policy: this plugin targets its OWN org by default.
 *
 * Following (and publishing) the family-shared `skrety.salesforce.targetOrg`
 * setting is opt-in per plugin via `soqlEditor.syncOrgWithFamily` (default off).
 * The private globalState key below is the source of truth either way — it is
 * written on every applied org change, so turning sync off never loses the org
 * this window was on.
 */
import * as vscode from 'vscode';
import { getSharedOrg } from './kit/orgs';

/** Opt-in: follow AND publish the family-shared org setting. */
export const ORG_SYNC_SETTING = 'soqlEditor.syncOrgWithFamily';

/** Private source of truth — the org this plugin is targeting. */
export const LAST_SELECTED_ORG_KEY = 'soqlEditor.lastSelectedOrgUsername';

/** One-shot flag for the shared → private backfill below. */
export const ORG_SYNC_MIGRATED_KEY = 'soqlEditor.orgSyncMigrated.v1';

/**
 * Read the sync flag at call time (never cached at registration) so toggling it
 * takes effect immediately, without a window reload.
 */
export function isOrgSyncEnabled(): boolean {
    return vscode.workspace.getConfiguration().get<boolean>(ORG_SYNC_SETTING) === true;
}

/**
 * Decide which org this window starts on, keeping the private key in step:
 *
 * a) One-time backfill: the first activation on this version adopts whatever the
 *    shared setting holds, so an install whose private key went stale while the
 *    family setting drove everything keeps its org. Runs regardless of the sync
 *    flag, and exactly once — it is an upgrade fixup, not a standing rule, so
 *    the flag is set even when there was nothing to copy.
 * b) With sync on, a shared org that differs from the private one wins.
 * c) Otherwise the private value stands; the caller falls back to the CLI
 *    default org when it is empty.
 *
 * Never writes the shared setting — only a user-initiated pick may do that.
 */
export async function resolveStartupOrg(globalState: vscode.Memento): Promise<string | undefined> {
    let privateOrg = globalState.get<string>(LAST_SELECTED_ORG_KEY);
    const shared = getSharedOrg();

    if (!globalState.get<boolean>(ORG_SYNC_MIGRATED_KEY)) {
        if (shared) {
            privateOrg = shared;
            await globalState.update(LAST_SELECTED_ORG_KEY, shared);
        }
        await globalState.update(ORG_SYNC_MIGRATED_KEY, true);
    }

    if (isOrgSyncEnabled() && shared && shared !== privateOrg) {
        privateOrg = shared;
        await globalState.update(LAST_SELECTED_ORG_KEY, shared);
    }

    return privateOrg;
}

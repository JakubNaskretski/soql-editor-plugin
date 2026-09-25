/**
 * Org-sync policy: this plugin targets its OWN org by default.
 *
 * Following (and publishing) the family-shared `skrety.salesforce.targetOrg`
 * setting is opt-in per plugin via `soqlEditor.syncOrgWithFamily` (default off).
 * The private key below is the source of truth either way — it is written on
 * every applied org change, so turning sync off never loses the org this window
 * was on. It lives in `workspaceState`, so each VS Code window keeps its own
 * target org; only the one-time migration flag is machine-wide (`globalState`).
 */
import * as vscode from 'vscode';
import { getSharedOrg } from './kit/orgs';

/** Opt-in: follow AND publish the family-shared org setting. */
export const ORG_SYNC_SETTING = 'soqlEditor.syncOrgWithFamily';

/** Private source of truth — the org this plugin is targeting (workspaceState). */
export const LAST_SELECTED_ORG_KEY = 'soqlEditor.lastSelectedOrgUsername';

/** One-shot flag for the shared → private backfill below (globalState: once per install). */
export const ORG_SYNC_MIGRATED_KEY = 'soqlEditor.orgSyncMigrated.v1';

/** One-shot stamp for the legacy port-forward (workspaceState: once per window). */
export const ORG_PORTED_KEY = 'soqlEditor.orgPortedFromGlobal.v1';

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
 * a) Legacy port-forward, at most ONE hop per window: releases before the
 *    per-window switch kept the org in `globalState` under this same key. The
 *    first activation in a window that has no org of its own copies that value
 *    into its store, so upgrading keeps every window on the org the extension
 *    was last using instead of silently retargeting it to the CLI default (which
 *    may be production). The hop is then stamped in the window store —
 *    unconditionally, whether or not there was anything to copy — so that an org
 *    later cleared on purpose (logout, or a reconciliation dropping an org that
 *    is gone) stays cleared instead of being resurrected on every reload. The
 *    org is written before the stamp, so a crash in between just re-ports. The
 *    legacy value is only ever READ — never rewritten and never deleted, because
 *    the other open windows still have to port it forward too. Per-window
 *    separation starts at the next pick.
 * b) One-time backfill: the first activation on this version adopts whatever the
 *    shared setting holds, so an install whose private key went stale while the
 *    family setting drove everything keeps its org. Runs regardless of the sync
 *    flag, and exactly once per install — it is an upgrade fixup, not a standing
 *    rule, so the flag is set even when there was nothing to copy. Being
 *    machine-wide, the flag is stamped by whichever window activates first; the
 *    others keep the org they ported forward in (a).
 * c) With sync on, a shared org that differs from the private one wins.
 * d) Otherwise the private value stands; the caller falls back to the CLI
 *    default org when it is empty.
 *
 * Never writes the shared setting — only a user-initiated pick may do that.
 *
 * @param privateState per-window store (`context.workspaceState`) holding the org.
 * @param installState machine-wide store (`context.globalState`) holding the
 *        once-per-install migration flag — and, on an upgraded install, the
 *        legacy org this function reads (never writes) in (a).
 */
export async function resolveStartupOrg(
    privateState: vscode.Memento,
    installState: vscode.Memento
): Promise<string | undefined> {
    let privateOrg = privateState.get<string>(LAST_SELECTED_ORG_KEY);
    const shared = getSharedOrg();

    // (a) Adopt the org older releases stored machine-wide — one hop per window.
    if (!privateState.get<boolean>(ORG_PORTED_KEY)) {
        if (!privateOrg) {
            // Read defensively: written by an older release and editable by hand.
            const legacy = installState.get<unknown>(LAST_SELECTED_ORG_KEY);
            if (typeof legacy === 'string' && legacy.trim()) {
                privateOrg = legacy.trim();
                await privateState.update(LAST_SELECTED_ORG_KEY, privateOrg);
            }
        }
        await privateState.update(ORG_PORTED_KEY, true);
    }

    if (!installState.get<boolean>(ORG_SYNC_MIGRATED_KEY)) {
        if (shared) {
            privateOrg = shared;
            await privateState.update(LAST_SELECTED_ORG_KEY, shared);
        }
        await installState.update(ORG_SYNC_MIGRATED_KEY, true);
    }

    if (isOrgSyncEnabled() && shared && shared !== privateOrg) {
        privateOrg = shared;
        await privateState.update(LAST_SELECTED_ORG_KEY, shared);
    }

    return privateOrg;
}

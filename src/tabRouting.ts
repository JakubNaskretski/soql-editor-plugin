/**
 * Pure helpers for routing a query run's messages back to the tab that started
 * it, independent of which tab is active when the message arrives.
 *
 * The webview (panel.js) tags each run with the *stable id* of the tab that
 * launched it and the host echoes that id back on every response message
 * (queryStarted / confirmLargeQuery / queryResults / error / info). Because the
 * user can switch — or close — tabs mid-run, "route to activeTab at arrival
 * time" mis-attributes results (the MED this fixes). Resolving by stable id
 * lands each message on its originating tab, or drops it if that tab is gone.
 *
 * This module is the single source of truth for that resolution and is unit
 * tested; panel.js carries a byte-identical mirror of `tabIndexForRunId`
 * (it runs in the webview and can't import). Keep the two in sync.
 */

/** Minimal shape needed for routing — the real tab state carries more fields. */
export interface RoutableTab {
    /** Stable, unique id assigned at tab creation; never reused. */
    id: number;
}

/**
 * Resolve the array index of the tab whose stable id is `runId`.
 *
 * Returns -1 when no tab has that id (the originating tab was closed while the
 * run was in flight) — callers must treat -1 as "drop this message, its tab is
 * gone" rather than falling back to the active tab.
 *
 * `runId === undefined` also yields -1: a message with no run stamp (e.g. an
 * old client or a non-run message mis-routed here) must not be attributed to an
 * arbitrary tab.
 */
export function tabIndexForRunId(tabs: readonly RoutableTab[], runId: number | undefined): number {
    if (runId === undefined || runId === null) { return -1; }
    return tabs.findIndex(t => t.id === runId);
}

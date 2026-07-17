import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted mocks: setSharedOrg (the cross-plugin write we assert on) and a shared
// status-bar stub the OrgPicker mutates via updateLabel().
const { setSharedOrgMock, hoisted } = vi.hoisted(() => ({
    setSharedOrgMock: vi.fn(),
    hoisted: {
        statusBar: { command: '', tooltip: '', text: '', show: () => {}, dispose: () => {} },
    },
}));

vi.mock('./kit/orgs', () => ({ setSharedOrg: setSharedOrgMock }));

// FakeQuickPick: the createQuickPick stand-in the picker drives. Tests reach the
// instance via quickPicks[] and fire accept/hide/button like a user would.
const { withProgressMock, showInfoMock, showWarnMock, showErrorMock, quickPicks, FakeQuickPick } = vi.hoisted(() => {
    class FakeQuickPick {
        items: any[] = [];
        activeItems: any[] = [];
        selectedItems: any[] = [];
        busy = false;
        placeholder = '';
        matchOnDescription = false;
        matchOnDetail = false;
        buttons: any[] = [];
        shown = false;
        disposed = false;
        private acceptHandler: (() => void) | undefined;
        private hideHandler: (() => void) | undefined;
        private buttonHandler: ((b: unknown) => void) | undefined;
        onDidAccept = (h: () => void) => { this.acceptHandler = h; return { dispose() {} }; };
        onDidHide = (h: () => void) => { this.hideHandler = h; return { dispose() {} }; };
        onDidTriggerButton = (h: (b: unknown) => void) => { this.buttonHandler = h; return { dispose() {} }; };
        show = () => { this.shown = true; };
        hide = () => { this.hideHandler?.(); };
        dispose = () => { this.disposed = true; };
        /** Test driver: simulate the user picking an item. */
        accept(item: unknown) { this.selectedItems = [item]; this.acceptHandler?.(); }
        /** Test driver: simulate the ↻ title-bar button. */
        pressRefresh() { this.buttonHandler?.({}); }
    }
    return {
        withProgressMock: vi.fn(),
        showInfoMock: vi.fn(),
        showWarnMock: vi.fn(),
        showErrorMock: vi.fn(),
        quickPicks: [] as InstanceType<typeof FakeQuickPick>[],
        FakeQuickPick,
    };
});

vi.mock('vscode', () => {
    class FakeEmitter {
        private handler: ((v: unknown) => void) | undefined;
        event = (h: (v: unknown) => void) => { this.handler = h; return { dispose() {} }; };
        fire = (v: unknown) => { this.handler?.(v); };
        dispose = () => {};
    }
    class ThemeIcon {
        constructor(public readonly id: string) {}
    }
    return {
        EventEmitter: FakeEmitter,
        ThemeIcon,
        StatusBarAlignment: { Left: 1, Right: 2 },
        ProgressLocation: { Notification: 15 },
        window: {
            createStatusBarItem: () => hoisted.statusBar,
            createQuickPick: () => { const qp = new FakeQuickPick(); quickPicks.push(qp); return qp; },
            withProgress: withProgressMock,
            showInformationMessage: showInfoMock,
            showWarningMessage: showWarnMock,
            showErrorMessage: showErrorMock,
        },
    };
});

import { OrgPicker } from './orgPicker';
import { OrgInfo } from './sfCliService';

const ORG_CACHE_KEY = 'soqlEditor.cachedOrgList';

const ORG_A: OrgInfo = { alias: 'A', username: 'a@example.com', instanceUrl: '', isDefault: true };
const ORG_B: OrgInfo = { alias: 'B', username: 'b@example.com', instanceUrl: '', isDefault: false };
const ORG_C: OrgInfo = { alias: 'C', username: 'c@example.com', instanceUrl: '', isDefault: false };

function makeSfCli(initial?: OrgInfo) {
    let current = initial;
    return {
        getCurrentOrg: vi.fn(() => current),
        setCurrentOrg: vi.fn((o: OrgInfo) => { current = o; }),
        clearCurrentOrg: vi.fn(() => { current = undefined; }),
        listOrgs: vi.fn(async (): Promise<OrgInfo[]> => []),
    };
}

function makeMemento(initial: Record<string, unknown> = {}) {
    const store: Record<string, unknown> = { ...initial };
    return {
        store,
        get: vi.fn((k: string) => store[k]),
        update: vi.fn(async (k: string, v: unknown) => { store[k] = v; }),
    };
}

function capture(picker: OrgPicker): OrgInfo[] {
    const fired: OrgInfo[] = [];
    picker.onOrgChanged(o => fired.push(o));
    return fired;
}

function lastQuickPick() {
    return quickPicks[quickPicks.length - 1];
}

/** Let pending microtasks/timers (the background revalidate) settle. */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

beforeEach(() => {
    vi.clearAllMocks();
    quickPicks.length = 0;
    hoisted.statusBar.text = '';
    withProgressMock.mockImplementation(async (_opts: unknown, task: () => unknown) => task());
});

describe('OrgPicker shared-setting write policy', () => {
    it('publishes to the shared setting only on a user-initiated pick', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([ORG_A]);

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        const closed = picker.showPicker();
        await flush(); // background revalidate lands
        const qp = lastQuickPick();
        expect(qp.items.map((i: any) => i.org)).toEqual([ORG_A]);

        qp.accept(qp.items[0]);
        await closed;

        expect(setSharedOrgMock).toHaveBeenCalledWith('a@example.com');
        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(ORG_A);
        expect(fired).toEqual([ORG_A]);
        expect(qp.disposed).toBe(true);
    });

    it('does NOT write the shared setting on startup auto-select (activation)', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([ORG_A]);

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        await picker.autoSelectDefault('a@example.com');

        expect(setSharedOrgMock).not.toHaveBeenCalled();
        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(ORG_A);
        expect(fired).toEqual([ORG_A]);
    });

    it('does NOT write the shared setting when following an external switch', async () => {
        const sfCli = makeSfCli(ORG_A);
        sfCli.listOrgs.mockResolvedValue([ORG_A, ORG_B]);

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        await picker.applyExternalOrgUsername('b@example.com');

        expect(setSharedOrgMock).not.toHaveBeenCalled();
        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(ORG_B);
        expect(fired).toEqual([ORG_B]);
    });
});

describe('OrgPicker org-list cache', () => {
    it('opens instantly from the persisted cache and revalidates in place', async () => {
        const sfCli = makeSfCli(undefined);
        let resolveList!: (v: OrgInfo[]) => void;
        sfCli.listOrgs.mockReturnValue(new Promise<OrgInfo[]>(r => { resolveList = r; }));
        const memento = makeMemento({ [ORG_CACHE_KEY]: [ORG_A] });

        const picker = new OrgPicker(sfCli as any, memento as any);
        const closed = picker.showPicker();
        const qp = lastQuickPick();

        // Cached org rendered before the live list resolves; picker marked busy.
        expect(qp.shown).toBe(true);
        expect(qp.items.map((i: any) => i.org)).toEqual([ORG_A]);
        expect(qp.busy).toBe(true);

        resolveList([ORG_A, ORG_B]);
        await flush();

        // Live list swapped in place and persisted.
        expect(qp.items.map((i: any) => i.org)).toEqual([ORG_A, ORG_B]);
        expect(qp.busy).toBe(false);
        expect(memento.store[ORG_CACHE_KEY]).toEqual([ORG_A, ORG_B]);

        qp.hide();
        await closed;
    });

    it('drops malformed persisted entries instead of rendering them', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockReturnValue(new Promise<OrgInfo[]>(() => {})); // never resolves
        const memento = makeMemento({ [ORG_CACHE_KEY]: [ORG_A, null, { alias: 'no-username' }, 42] });

        const picker = new OrgPicker(sfCli as any, memento as any);
        void picker.showPicker();

        expect(lastQuickPick().items.map((i: any) => i.org)).toEqual([ORG_A]);
    });

    it('re-entrant open is a no-op while the picker is on screen', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([ORG_A]);

        const picker = new OrgPicker(sfCli as any);
        const closed = picker.showPicker();
        await picker.showPicker(); // status-bar double-click
        expect(quickPicks.length).toBe(1);

        await flush();
        const qp = lastQuickPick();
        qp.hide(); // dismiss without picking (ESC)
        await closed;

        // A dismissal must never touch selection state or the shared setting.
        expect(setSharedOrgMock).not.toHaveBeenCalled();
        expect(sfCli.setCurrentOrg).not.toHaveBeenCalled();
    });

    it('the ↻ button refetches and swaps the items in place', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValueOnce([ORG_A]).mockResolvedValueOnce([ORG_A, ORG_C]);
        const memento = makeMemento();

        const picker = new OrgPicker(sfCli as any, memento as any);
        const closed = picker.showPicker();
        await flush();
        const qp = lastQuickPick();
        expect(qp.items.map((i: any) => i.org)).toEqual([ORG_A]);

        qp.pressRefresh();
        await flush();

        expect(qp.items.map((i: any) => i.org)).toEqual([ORG_A, ORG_C]);
        expect(memento.store[ORG_CACHE_KEY]).toEqual([ORG_A, ORG_C]);

        qp.hide();
        await closed;
    });

    it('refreshOrgs (palette command) refetches, persists, and reports the count', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([ORG_A, ORG_B]);
        const memento = makeMemento({ [ORG_CACHE_KEY]: [ORG_A] });

        const picker = new OrgPicker(sfCli as any, memento as any);
        await picker.refreshOrgs();

        expect(memento.store[ORG_CACHE_KEY]).toEqual([ORG_A, ORG_B]);
        expect(showInfoMock).toHaveBeenCalledWith(expect.stringContaining('2 orgs'));
        expect(showErrorMock).not.toHaveBeenCalled();
    });

    it('keeps serving cached items when the background refresh fails', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockRejectedValue(new Error('sf exploded'));
        const memento = makeMemento({ [ORG_CACHE_KEY]: [ORG_A] });

        const picker = new OrgPicker(sfCli as any, memento as any);
        const closed = picker.showPicker();
        await flush();

        const qp = lastQuickPick();
        expect(qp.items.map((i: any) => i.org)).toEqual([ORG_A]); // stale beats broken
        expect(qp.busy).toBe(false);
        expect(showErrorMock).not.toHaveBeenCalled();
        expect(memento.store[ORG_CACHE_KEY]).toEqual([ORG_A]); // failure never overwrites the cache

        qp.hide();
        await closed;
    });

    it('falls back to the loud error path when there is no cache to show', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockRejectedValue(new Error('sf exploded'));

        const picker = new OrgPicker(sfCli as any);
        const closed = picker.showPicker();
        await flush();
        await closed; // revalidate hid the empty picker

        expect(showErrorMock).toHaveBeenCalledWith(expect.stringContaining('Failed to list orgs'));
    });

    it('warns and closes when the live list is genuinely empty', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([]);

        const picker = new OrgPicker(sfCli as any);
        const closed = picker.showPicker();
        await flush();
        await closed;

        expect(showWarnMock).toHaveBeenCalledWith(expect.stringContaining('No authenticated Salesforce orgs'));
    });
});

describe('OrgPicker panel-picklist API', () => {
    it('pickKnownOrg applies a cached org as a user pick (writes the shared setting)', async () => {
        const sfCli = makeSfCli(undefined);
        const memento = makeMemento({ [ORG_CACHE_KEY]: [ORG_A, ORG_B] });

        const picker = new OrgPicker(sfCli as any, memento as any);
        const fired = capture(picker);
        picker.pickKnownOrg('B@EXAMPLE.COM'); // case-insensitive match

        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(ORG_B);
        expect(setSharedOrgMock).toHaveBeenCalledWith('b@example.com');
        expect(fired).toEqual([ORG_B]);
    });

    it('pickKnownOrg ignores a username missing from the cached list', () => {
        const sfCli = makeSfCli(undefined);
        const memento = makeMemento({ [ORG_CACHE_KEY]: [ORG_A] });

        const picker = new OrgPicker(sfCli as any, memento as any);
        picker.pickKnownOrg('forged@example.com');

        expect(sfCli.setCurrentOrg).not.toHaveBeenCalled();
        expect(setSharedOrgMock).not.toHaveBeenCalled();
    });

    it('concurrent refreshes share one sf org list spawn (single-flight)', async () => {
        const sfCli = makeSfCli(undefined);
        let resolveList!: (v: OrgInfo[]) => void;
        sfCli.listOrgs.mockReturnValue(new Promise<OrgInfo[]>(r => { resolveList = r; }));

        const picker = new OrgPicker(sfCli as any);
        const p1 = picker.refreshOrgs();
        const p2 = picker.refreshOrgs(); // ⟳ spam joins, doesn't respawn
        resolveList([ORG_A]);
        await Promise.all([p1, p2]);

        expect(sfCli.listOrgs).toHaveBeenCalledTimes(1);
    });

    it('onOrgListChanged fires with the fresh list when a fetch lands', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([ORG_A, ORG_C]);

        const picker = new OrgPicker(sfCli as any);
        const lists: OrgInfo[][] = [];
        picker.onOrgListChanged(l => lists.push(l));
        await picker.refreshOrgs();

        expect(lists).toEqual([[ORG_A, ORG_C]]);
        expect(picker.getKnownOrgs()).toEqual([ORG_A, ORG_C]);
    });
});

describe('OrgPicker.applyExternalOrgUsername resilience', () => {
    it('follows the family via a minimal OrgInfo when the username is not in the org list', async () => {
        const sfCli = makeSfCli(ORG_A);
        sfCli.listOrgs.mockResolvedValue([ORG_A]); // ghost not present
        const minimal: OrgInfo = { alias: 'ghost@example.com', username: 'ghost@example.com', instanceUrl: '', isDefault: false };

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        await picker.applyExternalOrgUsername('ghost@example.com');

        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(minimal);
        expect(fired).toEqual([minimal]);
        expect(setSharedOrgMock).not.toHaveBeenCalled();
    });

    it('follows the family via a minimal OrgInfo when the org list cannot be fetched', async () => {
        const sfCli = makeSfCli(ORG_A);
        sfCli.listOrgs.mockRejectedValue(new Error('sf not found'));
        const minimal: OrgInfo = { alias: 'b@example.com', username: 'b@example.com', instanceUrl: '', isDefault: false };

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        await picker.applyExternalOrgUsername('b@example.com');

        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(minimal);
        expect(fired).toEqual([minimal]);
        expect(setSharedOrgMock).not.toHaveBeenCalled();
    });

    it('caches the fresh list fetched while resolving an external switch', async () => {
        const sfCli = makeSfCli(ORG_A);
        sfCli.listOrgs.mockResolvedValue([ORG_A, ORG_B]);
        const memento = makeMemento();

        const picker = new OrgPicker(sfCli as any, memento as any);
        await picker.applyExternalOrgUsername('b@example.com');

        expect(memento.store[ORG_CACHE_KEY]).toEqual([ORG_A, ORG_B]);
    });

    it('clears the current org and shows the no-org state on an external clear', async () => {
        const sfCli = makeSfCli(ORG_A);

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        await picker.applyExternalOrgUsername(undefined);

        expect(sfCli.clearCurrentOrg).toHaveBeenCalled();
        expect(hoisted.statusBar.text).toContain('No Org');
        expect(setSharedOrgMock).not.toHaveBeenCalled();
        expect(fired).toEqual([]); // a clear has no org payload, so it fires no change event
    });

    it('ignores a superseded external switch that resolves out of order (generation token)', async () => {
        const sfCli = makeSfCli(ORG_A);

        // Two deferred org lists: the first (for B) resolves AFTER the second (for C).
        let resolveB!: (v: OrgInfo[]) => void;
        let resolveC!: (v: OrgInfo[]) => void;
        const pB = new Promise<OrgInfo[]>(r => { resolveB = r; });
        const pC = new Promise<OrgInfo[]>(r => { resolveC = r; });
        sfCli.listOrgs.mockReturnValueOnce(pB).mockReturnValueOnce(pC);

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);

        const switchB = picker.applyExternalOrgUsername('b@example.com'); // generation 1
        const switchC = picker.applyExternalOrgUsername('c@example.com'); // generation 2

        resolveC([ORG_A, ORG_B, ORG_C]); // newest resolves first → applies C
        await switchC;
        resolveB([ORG_A, ORG_B, ORG_C]); // stale resolves later → must bail
        await switchB;

        expect(fired).toEqual([ORG_C]); // B was superseded and never applied
        expect(sfCli.setCurrentOrg).toHaveBeenCalledTimes(1);
        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(ORG_C);
    });
});

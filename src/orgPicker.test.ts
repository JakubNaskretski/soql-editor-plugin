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

const { withProgressMock, showQuickPickMock, showInfoMock, showWarnMock } = vi.hoisted(() => ({
    withProgressMock: vi.fn(),
    showQuickPickMock: vi.fn(),
    showInfoMock: vi.fn(),
    showWarnMock: vi.fn(),
}));

vi.mock('vscode', () => {
    class FakeEmitter {
        private handler: ((v: unknown) => void) | undefined;
        event = (h: (v: unknown) => void) => { this.handler = h; return { dispose() {} }; };
        fire = (v: unknown) => { this.handler?.(v); };
        dispose = () => {};
    }
    return {
        EventEmitter: FakeEmitter,
        StatusBarAlignment: { Left: 1, Right: 2 },
        ProgressLocation: { Notification: 15 },
        window: {
            createStatusBarItem: () => hoisted.statusBar,
            withProgress: withProgressMock,
            showQuickPick: showQuickPickMock,
            showInformationMessage: showInfoMock,
            showWarningMessage: showWarnMock,
        },
    };
});

import { OrgPicker } from './orgPicker';
import { OrgInfo } from './sfCliService';

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

function capture(picker: OrgPicker): OrgInfo[] {
    const fired: OrgInfo[] = [];
    picker.onOrgChanged(o => fired.push(o));
    return fired;
}

beforeEach(() => {
    vi.clearAllMocks();
    hoisted.statusBar.text = '';
    withProgressMock.mockImplementation(async (_opts: unknown, task: () => unknown) => task());
});

describe('OrgPicker shared-setting write policy', () => {
    it('publishes to the shared setting only on a user-initiated pick', async () => {
        const sfCli = makeSfCli(undefined);
        sfCli.listOrgs.mockResolvedValue([ORG_A]);
        showQuickPickMock.mockResolvedValue({ org: ORG_A });

        const picker = new OrgPicker(sfCli as any);
        const fired = capture(picker);
        await picker.showPicker();

        expect(setSharedOrgMock).toHaveBeenCalledWith('a@example.com');
        expect(sfCli.setCurrentOrg).toHaveBeenCalledWith(ORG_A);
        expect(fired).toEqual([ORG_A]);
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

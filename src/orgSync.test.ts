import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Settings store backing `soqlEditor.syncOrgWithFamily`, plus the shared
// cross-plugin org setting (read-only here — the activation path must never
// write it).
const { hoisted, getSharedOrgMock } = vi.hoisted(() => ({
    hoisted: { config: {} as Record<string, unknown> },
    getSharedOrgMock: vi.fn<() => string | undefined>(),
}));

vi.mock('vscode', () => ({
    workspace: {
        getConfiguration: () => ({ get: (key: string) => hoisted.config[key] }),
    },
}));

vi.mock('./kit/orgs', () => ({ getSharedOrg: getSharedOrgMock }));

import {
    LAST_SELECTED_ORG_KEY,
    ORG_PORTED_KEY,
    ORG_SYNC_MIGRATED_KEY,
    isOrgSyncEnabled,
    resolveStartupOrg,
} from './orgSync';

const PRIVATE_ORG = 'dev@acme.example';
const SHARED_ORG = 'qa@acme.example';
/** What a pre-per-window release left behind in globalState. */
const LEGACY_ORG = 'legacy@acme.example';

function makeMemento(initial: Record<string, unknown> = {}) {
    const store: Record<string, unknown> = { ...initial };
    return {
        store,
        get: vi.fn((k: string) => store[k]),
        update: vi.fn(async (k: string, v: unknown) => { store[k] = v; }),
    };
}

const enableOrgSync = () => { hoisted.config['soqlEditor.syncOrgWithFamily'] = true; };

beforeEach(() => {
    vi.clearAllMocks();
    hoisted.config = {}; // org sync off — the shipped default
    getSharedOrgMock.mockReturnValue(undefined);
});

describe('isOrgSyncEnabled', () => {
    it('is off unless the setting is explicitly true', () => {
        expect(isOrgSyncEnabled()).toBe(false);
        hoisted.config['soqlEditor.syncOrgWithFamily'] = false;
        expect(isOrgSyncEnabled()).toBe(false);
        enableOrgSync();
        expect(isOrgSyncEnabled()).toBe(true);
    });
});

describe('resolveStartupOrg', () => {
    it('backfills the private key from the shared org once, then no-ops', async () => {
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        const workspaceState = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });
        const globalState = makeMemento();

        // First activation: the one-time migration adopts the shared org even
        // though sync is off, and marks itself done.
        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(SHARED_ORG);
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
        expect(globalState.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);

        // A later family switch must NOT be adopted while sync is off.
        getSharedOrgMock.mockReturnValue('other@acme.example');
        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(SHARED_ORG);
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
    });

    it('marks the migration done even when there is no shared org to copy', async () => {
        const workspaceState = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });
        const globalState = makeMemento();

        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(PRIVATE_ORG);
        expect(globalState.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);

        // The backfill is a one-time upgrade fixup, not a standing rule: a shared
        // org appearing afterwards is ignored while sync is off.
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(PRIVATE_ORG);
    });

    it('keeps the private org when sync is off', async () => {
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        const workspaceState = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });
        const globalState = makeMemento({ [ORG_SYNC_MIGRATED_KEY]: true });

        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(PRIVATE_ORG);
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBe(PRIVATE_ORG);
    });

    it('adopts a differing shared org when sync is on', async () => {
        enableOrgSync();
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        const workspaceState = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });
        const globalState = makeMemento({ [ORG_SYNC_MIGRATED_KEY]: true });

        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(SHARED_ORG);
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
    });

    it('returns undefined (CLI-default fallback) when nothing is stored', async () => {
        const workspaceState = makeMemento();
        const globalState = makeMemento();

        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBeUndefined();
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBeUndefined();
        expect(globalState.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);
    });

    it('ports a legacy machine-wide org into the window store once, then keeps the org per window', async () => {
        // Upgrade from a pre-per-window release: this window has no org yet, so
        // it adopts the one globalState still holds instead of silently
        // retargeting to the CLI default org.
        const workspaceState = makeMemento();
        const globalState = makeMemento({ [LAST_SELECTED_ORG_KEY]: LEGACY_ORG });

        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBe(LEGACY_ORG);

        // The port-forward must WRITE the window store: a startup read that just
        // fell back to globalState would leave this window empty and keep
        // re-reading the machine-wide value.
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBe(LEGACY_ORG);

        // The legacy value is read-only — other open windows still have to port
        // it forward — and the migration flag is the only machine-wide write.
        expect(globalState.store[LAST_SELECTED_ORG_KEY]).toBe(LEGACY_ORG);
        expect(globalState.update).not.toHaveBeenCalledWith(LAST_SELECTED_ORG_KEY, expect.anything());
        expect(globalState.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);
        expect(workspaceState.store[ORG_SYNC_MIGRATED_KEY]).toBeUndefined();

        // The hop is stamped in THIS window's store, so it happens at most once.
        expect(workspaceState.store[ORG_PORTED_KEY]).toBe(true);
        expect(globalState.store[ORG_PORTED_KEY]).toBeUndefined();

        // The org is later cleared on purpose (logout, or a reconciliation
        // dropping an org that is gone): the next activation must NOT resurrect
        // the dead legacy value.
        await workspaceState.update(LAST_SELECTED_ORG_KEY, undefined);
        expect(await resolveStartupOrg(workspaceState as any, globalState as any)).toBeUndefined();
        expect(workspaceState.store[LAST_SELECTED_ORG_KEY]).toBeUndefined();

        // A window with nothing to port stamps itself all the same — the stamp
        // is what makes the hop one-per-window rather than one-per-activation.
        const freshWindow = makeMemento();
        const noLegacy = makeMemento({ [ORG_SYNC_MIGRATED_KEY]: true });
        expect(await resolveStartupOrg(freshWindow as any, noLegacy as any)).toBeUndefined();
        expect(freshWindow.store[ORG_PORTED_KEY]).toBe(true);
        expect(noLegacy.store[ORG_PORTED_KEY]).toBeUndefined();

        // A window that already has its own org ignores the machine-wide
        // leftover, and adopting the family org never writes it either.

        enableOrgSync();
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        const otherWindow = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });

        expect(await resolveStartupOrg(otherWindow as any, globalState as any)).toBe(SHARED_ORG);
        expect(otherWindow.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
        expect(globalState.store[LAST_SELECTED_ORG_KEY]).toBe(LEGACY_ORG);
        expect(globalState.update).not.toHaveBeenCalledWith(LAST_SELECTED_ORG_KEY, expect.anything());
    });
});

describe('extension wiring', () => {
    // Source pins: a swapped memento pair compiles and passes every unit test
    // while silently making the org machine-wide again.
    const source = readFileSync(join(process.cwd(), 'src', 'extension.ts'), 'utf8');

    it('hands the private org to workspaceState and the migration flag to globalState', () => {
        expect(source).toContain('resolveStartupOrg(context.workspaceState, context.globalState)');
        expect(source).toContain('context.workspaceState.update(LAST_SELECTED_ORG_KEY, org.username)');
    });

    it('never persists the picked org to globalState', () => {
        expect(
            source.includes('globalState.update(LAST_SELECTED_ORG_KEY'),
            'src/extension.ts must persist the picked org with context.workspaceState.update(LAST_SELECTED_ORG_KEY, …): writing it to globalState puts the org back in every other VS Code window'
        ).toBe(false);
    });
});

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
    ORG_SYNC_MIGRATED_KEY,
    isOrgSyncEnabled,
    resolveStartupOrg,
} from './orgSync';

const PRIVATE_ORG = 'dev@acme.example';
const SHARED_ORG = 'qa@acme.example';

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
        const memento = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });

        // First activation: the one-time migration adopts the shared org even
        // though sync is off, and marks itself done.
        expect(await resolveStartupOrg(memento as any)).toBe(SHARED_ORG);
        expect(memento.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
        expect(memento.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);

        // A later family switch must NOT be adopted while sync is off.
        getSharedOrgMock.mockReturnValue('other@acme.example');
        expect(await resolveStartupOrg(memento as any)).toBe(SHARED_ORG);
        expect(memento.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
    });

    it('marks the migration done even when there is no shared org to copy', async () => {
        const memento = makeMemento({ [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG });

        expect(await resolveStartupOrg(memento as any)).toBe(PRIVATE_ORG);
        expect(memento.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);

        // The backfill is a one-time upgrade fixup, not a standing rule: a shared
        // org appearing afterwards is ignored while sync is off.
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        expect(await resolveStartupOrg(memento as any)).toBe(PRIVATE_ORG);
    });

    it('keeps the private org when sync is off', async () => {
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        const memento = makeMemento({
            [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG,
            [ORG_SYNC_MIGRATED_KEY]: true,
        });

        expect(await resolveStartupOrg(memento as any)).toBe(PRIVATE_ORG);
        expect(memento.store[LAST_SELECTED_ORG_KEY]).toBe(PRIVATE_ORG);
    });

    it('adopts a differing shared org when sync is on', async () => {
        enableOrgSync();
        getSharedOrgMock.mockReturnValue(SHARED_ORG);
        const memento = makeMemento({
            [LAST_SELECTED_ORG_KEY]: PRIVATE_ORG,
            [ORG_SYNC_MIGRATED_KEY]: true,
        });

        expect(await resolveStartupOrg(memento as any)).toBe(SHARED_ORG);
        expect(memento.store[LAST_SELECTED_ORG_KEY]).toBe(SHARED_ORG);
    });

    it('returns undefined (CLI-default fallback) when nothing is stored', async () => {
        const memento = makeMemento();

        expect(await resolveStartupOrg(memento as any)).toBeUndefined();
        expect(memento.store[LAST_SELECTED_ORG_KEY]).toBeUndefined();
        expect(memento.store[ORG_SYNC_MIGRATED_KEY]).toBe(true);
    });
});

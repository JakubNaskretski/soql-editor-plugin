import { beforeEach, describe, expect, it, vi } from 'vitest';

const { vscodeMock } = vi.hoisted(() => ({
    vscodeMock: {
        window: {
            showInformationMessage: vi.fn(),
            showWarningMessage: vi.fn(),
            showQuickPick: vi.fn(),
        },
        commands: {
            executeCommand: vi.fn(),
        },
    },
}));

vi.mock('vscode', () => vscodeMock);

import { maybePromptForMetadataReadiness } from './extension';

describe('maybePromptForMetadataReadiness', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not prompt when org cache is present', async () => {
        const metadata = {
            getCurrentOrgCacheStatus: () => ({
                hasCache: true,
                hasObjectList: true,
                objectFileCount: 10,
                source: 'org',
            }),
            listOtherCachedOrgKeys: () => [],
        };

        await maybePromptForMetadataReadiness(metadata as any, 'startup');

        expect(vscodeMock.window.showInformationMessage).not.toHaveBeenCalled();
        expect(vscodeMock.commands.executeCommand).not.toHaveBeenCalled();
    });

    it('prompts for local-fallback state and runs common sync on acceptance', async () => {
        const metadata = {
            getCurrentOrgCacheStatus: () => ({
                hasCache: true,
                hasObjectList: true,
                objectFileCount: 5,
                source: 'local-fallback',
            }),
            listOtherCachedOrgKeys: () => [],
        };
        vscodeMock.window.showInformationMessage.mockResolvedValueOnce('Download Common Metadata');

        await maybePromptForMetadataReadiness(metadata as any, 'switch');

        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledTimes(1);
        expect(vscodeMock.commands.executeCommand).toHaveBeenCalledWith('soqlEditor.syncCommonMetadata');
    });

    it('offers local bootstrap for empty cache and reports generated count', async () => {
        const metadata = {
            getCurrentOrgCacheStatus: () => ({
                hasCache: false,
                hasObjectList: false,
                objectFileCount: 0,
                source: 'none',
            }),
            listOtherCachedOrgKeys: () => [],
            bootstrapCurrentOrgCacheFromLocalProject: vi.fn(() => 3),
        };
        vscodeMock.window.showInformationMessage
            .mockResolvedValueOnce('Use Local Repo Metadata')
            .mockResolvedValue(undefined);

        await maybePromptForMetadataReadiness(metadata as any, 'startup');

        expect(metadata.bootstrapCurrentOrgCacheFromLocalProject).toHaveBeenCalledTimes(1);
        expect(vscodeMock.window.showInformationMessage).toHaveBeenCalledWith(
            'SOQL Editor: Generated local fallback cache for 3 objects.'
        );
    });
});

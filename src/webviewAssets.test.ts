import { describe, expect, it } from 'vitest';
import { PANEL_LOCAL_RESOURCE_ROOT, PANEL_SCRIPT_RELATIVE_PATH } from './webviewAssets';

describe('webview asset paths', () => {
    it('loads panel script from packaged out directory', () => {
        expect(PANEL_LOCAL_RESOURCE_ROOT).toBe('out');
        expect(PANEL_SCRIPT_RELATIVE_PATH).toEqual(['out', 'panel.js']);
    });

    it('never points to src, which is excluded from VSIX', () => {
        expect(PANEL_LOCAL_RESOURCE_ROOT).not.toBe('src');
        expect(PANEL_SCRIPT_RELATIVE_PATH[0]).not.toBe('src');
    });
});

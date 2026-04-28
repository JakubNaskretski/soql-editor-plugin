/**
 * Single source of truth for sidebar webview static asset locations.
 * Keep these values aligned with packaged output (.vscodeignore excludes src/**).
 */
export const PANEL_LOCAL_RESOURCE_ROOT = 'out';
export const PANEL_SCRIPT_RELATIVE_PATH = ['out', 'panel.js'] as const;

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const srcFile = resolve(process.cwd(), 'src', 'panel.js');
const outDir = resolve(process.cwd(), 'out');
const outFile = resolve(outDir, 'panel.js');

if (!existsSync(srcFile)) {
    throw new Error(`Missing source file: ${srcFile}`);
}

// Syntax-check src/panel.js before copying it into out/. A broken script would
// otherwise be detected only at runtime, via the in-page "JS NOT LOADED" banner.
const source = readFileSync(srcFile, 'utf-8');
try {
    new vm.Script(source, { filename: srcFile });
} catch (err) {
    const message = err?.message || String(err);
    throw new Error(`panel.js failed syntax check: ${message}`);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(srcFile, outFile);

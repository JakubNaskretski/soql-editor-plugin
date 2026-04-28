import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const srcFile = resolve(process.cwd(), 'src', 'panel.js');
const outDir = resolve(process.cwd(), 'out');
const outFile = resolve(outDir, 'panel.js');

if (!existsSync(srcFile)) {
    throw new Error(`Missing source file: ${srcFile}`);
}

mkdirSync(outDir, { recursive: true });
copyFileSync(srcFile, outFile);

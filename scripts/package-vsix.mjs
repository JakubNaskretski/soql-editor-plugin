import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'dev' && mode !== 'store') {
    throw new Error('Usage: node ./scripts/package-vsix.mjs <dev|store>');
}

const rootDir = process.cwd();
const packageJsonPath = resolve(rootDir, 'package.json');
const originalRaw = readFileSync(packageJsonPath, 'utf8');
const originalPkg = JSON.parse(originalRaw);

function run(command, args) {
    const result = spawnSync(command, args, {
        cwd: rootDir,
        stdio: 'inherit',
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed with code ${result.status}`);
    }
}

function buildDevPackageJson(pkg) {
    const next = { ...pkg };
    if (!next.name.endsWith('-dev')) {
        next.name = `${next.name}-dev`;
    }
    if (!next.publisher.endsWith('-dev')) {
        next.publisher = `${next.publisher}-dev`;
    }
    if (!/\(Dev\)$/i.test(next.displayName)) {
        next.displayName = `${next.displayName} (Dev)`;
    }
    if (!next.description.startsWith('[DEV] ')) {
        next.description = `[DEV] ${next.description}`;
    }
    return next;
}

try {
    run('npm', ['run', 'compile']);

    let outputName = `${originalPkg.name}-${originalPkg.version}.vsix`;

    if (mode === 'dev') {
        const devPkg = buildDevPackageJson(originalPkg);
        writeFileSync(packageJsonPath, JSON.stringify(devPkg, null, 2) + '\n', 'utf8');
        outputName = `${devPkg.name}-${devPkg.version}.vsix`;
    }

    run('npx', ['@vscode/vsce', 'package', '--allow-missing-repository', '-o', outputName]);
    writeFileSync(packageJsonPath, originalRaw, 'utf8');
    console.log(`Created ${outputName}`);
} catch (err) {
    // Always restore the canonical manifest for normal development/publishing.
    writeFileSync(packageJsonPath, originalRaw, 'utf8');
    throw err;
}

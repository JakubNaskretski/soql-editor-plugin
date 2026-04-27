#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "==> Compiling..."
npm run compile

echo "==> Packaging..."
echo "y" | vsce package --allow-missing-repository

VSIX=$(ls -t *.vsix | head -1)

# Archive to releases/ folder
mkdir -p releases
cp "$VSIX" releases/
echo "==> Archived to releases/$VSIX"

echo "==> Installing ${VSIX}..."
"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension "$VSIX" --force

echo "==> Done! Reload VS Code (Cmd+Shift+P → 'Developer: Reload Window')"

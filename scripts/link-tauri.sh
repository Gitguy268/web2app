#!/bin/sh
# npm hoists pake-cli's dependencies to the top node_modules, but Pake looks for the
# Tauri CLI in its own node_modules. Without these links it runs `pnpm install` before
# every build, which makes every build need the internet.
set -e
mkdir -p node_modules/pake-cli/node_modules
ln -sfn ../../.bin node_modules/pake-cli/node_modules/.bin
ln -sfn ../../@tauri-apps node_modules/pake-cli/node_modules/@tauri-apps

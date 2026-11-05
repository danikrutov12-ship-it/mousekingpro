#!/usr/bin/env bash
# Запуск Mouse King Pro (Electron). Старая версия на Python/Qt: legacy-qt/run-qt.sh
set -euo pipefail
cd "$(dirname "$0")/desktop"

NODE_DIR="$HOME/.local/lib/nodejs/current/bin"
[ -d "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
if ! command -v node >/dev/null; then
  echo "Не найден Node.js. Установите его (https://nodejs.org) в ~/.local/lib/nodejs/current." >&2
  exit 1
fi

[ -d node_modules ] || npm install
# пересобираем, если исходники новее сборки
if [ ! -f out/main/index.js ] || [ -n "$(find src electron.vite.config.ts -newer out/main/index.js -print -quit)" ]; then
  npx electron-vite build
fi

# VS Code и некоторые терминалы выставляют ELECTRON_RUN_AS_NODE — с ним Electron работает как обычный Node
unset ELECTRON_RUN_AS_NODE
exec ./node_modules/.bin/electron . "$@"

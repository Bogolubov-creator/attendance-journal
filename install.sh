#!/usr/bin/env bash
# Установщик журнала для Linux и macOS: проверяет Node.js 24 и запускает общий
# установщик (scripts/installer). Те же вопросы, что у install.bat на Windows.
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Нужен Node.js 24 или новее: https://nodejs.org/ (на Linux удобно через пакеты NodeSource)." >&2
  exit 1
fi
major="$(node -p 'process.versions.node.split(".")[0]')"
if ((major < 24)); then
  echo "Нужен Node.js 24 или новее, сейчас $(node -v): https://nodejs.org/" >&2
  exit 1
fi
exec node scripts/installer/main.mjs "$@"

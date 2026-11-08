#!/usr/bin/env bash
# Подпись расширения «Mouse King Pro для Firefox» в Mozilla (частное, в каталоге не публикуется).
# Ключи AMO берутся из ~/.amo-keys (две строки: JWT issuer, JWT secret) — https://addons.mozilla.org/developers/addon/api/key/
# Перед подписью поднимите "version" в desktop/firefox-extension/manifest.json — одну версию Mozilla подписывает один раз.
# Результат: desktop/build/firefox-extension.xpi — попадает в сборку программы (Настройки → Firefox → «Установить»).
set -euo pipefail
cd "$(dirname "$0")/desktop"
NODE_DIR="$HOME/.local/lib/nodejs/current/bin"
[ -d "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
[ -s "$HOME/.amo-keys" ] || { echo "Нет ~/.amo-keys (две строки: JWT issuer и JWT secret)" >&2; exit 1; }
ISSUER="$(sed -n 1p "$HOME/.amo-keys" | tr -d ' \r\n')"
SECRET="$(sed -n 2p "$HOME/.amo-keys" | tr -d ' \r\n')"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
npx web-ext lint --source-dir firefox-extension
WEB_EXT_API_KEY="$ISSUER" WEB_EXT_API_SECRET="$SECRET" \
  npx web-ext sign --source-dir firefox-extension --channel unlisted --artifacts-dir "$OUT"
XPI="$(ls "$OUT"/*.xpi | head -1)"
cp "$XPI" build/firefox-extension.xpi
echo "Готово: desktop/build/firefox-extension.xpi ($(basename "$XPI"))"

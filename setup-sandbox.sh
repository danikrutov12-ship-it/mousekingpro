#!/usr/bin/env bash
# Разрешает Electron (Venice Agent) создавать песочницу на Ubuntu 24.04+.
# Ubuntu по умолчанию запрещает это всем программам через AppArmor; без разрешения
# окно падает при запуске из меню. Запуск: sudo ./setup-sandbox.sh
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then
  echo "Запустите через sudo: sudo $0" >&2
  exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
ELECTRON="$DIR/desktop/node_modules/electron/dist/electron"
[ -x "$ELECTRON" ] || { echo "Не найден $ELECTRON — сначала запустите ./run.sh" >&2; exit 1; }
cat > /etc/apparmor.d/venice-agent <<PROFILE
abi <abi/4.0>,
include <tunables/global>

profile venice-agent "$ELECTRON" flags=(unconfined) {
  userns,
  include if exists <local/venice-agent>
}
PROFILE
apparmor_parser -r /etc/apparmor.d/venice-agent
echo "Готово: Venice Agent можно запускать из меню приложений."

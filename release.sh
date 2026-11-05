#!/usr/bin/env bash
# Выпуск новой версии: ./release.sh 2.2.0 "Что нового: …"
# Меняет версию, коммитит, ставит тег и отправляет в GitHub. Сборку и релиз делает GitHub Actions,
# после чего программы на всех компьютерах покажут плашку «Доступно обновление».
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:?Укажите версию, например: ./release.sh 2.2.0}"
NOTES="${2:-}"
[ -z "$(git status --porcelain)" ] || { echo "Есть незакоммиченные изменения — сначала закоммитьте их." >&2; exit 1; }
NODE_DIR="$HOME/.local/lib/nodejs/current/bin"
[ -d "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
(cd desktop && npm version "$VERSION" --no-git-tag-version >/dev/null)
git add desktop/package.json desktop/package-lock.json
git commit -m "Mouse King Pro $VERSION"
git tag -a "v$VERSION" -m "${NOTES:-Mouse King Pro $VERSION}"
# токен GitHub (если есть) берётся из ~/.mkp-token и передаётся только этой команде — в git он не сохраняется
AUTH=()
if [ -s "$HOME/.mkp-token" ]; then
  AUTH=(-c "http.extraheader=Authorization: Basic $(printf 'x-access-token:%s' "$(tr -d ' \r\n' < "$HOME/.mkp-token")" | base64 -w0)")
fi
git "${AUTH[@]}" push origin HEAD "v$VERSION"
echo "Готово: v$VERSION отправлена. Сборка: https://github.com/danikrutov12-ship-it/mousekingpro/actions"

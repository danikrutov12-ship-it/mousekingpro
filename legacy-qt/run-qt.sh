#!/usr/bin/env bash
# Старая версия на Python/Qt (больше не развивается). Запуск: при первом запуске создаёт окружение и ставит зависимости.
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ] || ! .venv/bin/python -m pip --version >/dev/null 2>&1; then
    rm -rf .venv
    if ! python3 -m venv .venv 2>/dev/null; then
        # нет пакета python3-venv (ensurepip): ставим pip официальным установщиком PyPA
        rm -rf .venv
        python3 -m venv --without-pip .venv
        tmp=$(mktemp -d)
        curl -fsSL https://bootstrap.pypa.io/get-pip.py -o "$tmp/get-pip.py"
        .venv/bin/python -I "$tmp/get-pip.py" -q
        rm -rf "$tmp"
    fi
    .venv/bin/python -m pip install -q -r requirements.txt
fi
exec .venv/bin/python -m venice_agent "$@"

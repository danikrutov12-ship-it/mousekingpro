#!/usr/bin/env bash
# Старт воркера VSR на RunPod: обработчик с сетевого диска + пакет runpod.
# Пакет runpod лежит на диске (/runpod-volume/vsr/pylib). Если его там нет — ставим в локальную папку контейнера
# (быстро) и в фоне копируем на диск на будущее. Ставить сразу на сетевой диск нельзя: это ~2 минуты, всё это
# время воркер не берёт задачи, и RunPod гасит его как простаивающего (idleTimeout) — установка так и не доходит до конца.
# Весь вывод пишется в /tmp/start.log; если обработчик упал, diag.py вернёт этот лог в ответе задачи.
V=/runpod-volume/vsr
exec > >(tee -a /tmp/start.log) 2>&1
set -x
mkdir -p "$V/jobs"
if [ ! -d "$V/pylib/runpod" ]; then
  pip install --no-cache-dir --target /tmp/pylib 'runpod>=1.7,<2'
  ( rm -rf "$V/pylib.tmp" && cp -r /tmp/pylib "$V/pylib.tmp" && rm -rf "$V/pylib" && mv "$V/pylib.tmp" "$V/pylib" ) &
fi
cd /vsr
python -u "$V/handler.py"
echo "handler exited: $?"
python -u "$V/diag.py"

#!/usr/bin/env bash
# Старт воркера VSR на RunPod: пакет runpod ставится один раз на сетевой диск, дальше — обработчик.
# Весь вывод пишется в /tmp/start.log; если обработчик упал, diag.py вернёт этот лог в ответе задачи.
V=/runpod-volume/vsr
exec > >(tee -a /tmp/start.log) 2>&1
set -x
mkdir -p "$V/jobs"
if [ ! -d "$V/pylib/runpod" ]; then
  pip install --no-cache-dir --target "$V/pylib.tmp" 'runpod>=1.7,<2' && rm -rf "$V/pylib" && mv "$V/pylib.tmp" "$V/pylib"
fi
cd /vsr
python -u "$V/handler.py"
echo "handler exited: $?"
python -u "$V/diag.py"

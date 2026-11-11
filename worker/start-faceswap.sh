#!/usr/bin/env bash
# Старт воркера фейсвапа: подключаем модели и ноду с сетевого диска, дальше — обычный старт worker-comfyui.
set -euo pipefail

VOL=/runpod-volume
M=/comfyui/models

# ReActor ищет модели по путям внутри /comfyui/models, поэтому подменяем папки ссылками на диск.
if [ -d "$VOL/models" ]; then
  mkdir -p "$VOL/models/insightface" "$VOL/models/facerestore_models" "$VOL/models/reactor" \
           "$VOL/models/hyperswap" "$VOL/models/reswapper" "$VOL/models/ultralytics" "$VOL/models/sams"
  for d in insightface facerestore_models reactor hyperswap reswapper ultralytics sams; do
    rm -rf "$M/$d"
    ln -sfn "$VOL/models/$d" "$M/$d"
  done
fi

# Своя копия ноды на диске важнее той, что в образе: так её можно обновить без пересборки.
if [ -d "$VOL/custom_nodes/reactor" ]; then
  rm -rf /comfyui/custom_nodes/ComfyUI-ReActor
  ln -sfn "$VOL/custom_nodes/reactor" /comfyui/custom_nodes/ComfyUI-ReActor
fi

exec /start.sh

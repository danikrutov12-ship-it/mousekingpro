#!/usr/bin/env bash
# Старт воркера апскейла (образ runpod/worker-comfyui:5.10.0-base): подключаем SeedVR2 с сетевого диска
# ссылками — секунды, без установки при старте (долгая установка при старте = воркер гаснет как простаивающий).
# Установка — worker/upscale/setup.sh, один раз.
N=/runpod-volume/seedvr2
ln -sfn "$N/node" /comfyui/custom_nodes/ComfyUI-SeedVR2_VideoUpscaler
mkdir -p /runpod-volume/models/SEEDVR2
rm -rf /comfyui/models/SEEDVR2 && ln -sfn /runpod-volume/models/SEEDVR2 /comfyui/models/SEEDVR2
# пакеты узла — в конец sys.path (.pth), чтобы библиотеки образа оставались главными
SP=$(/opt/venv/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')
echo "$N/pylib" > "$SP/zz-seedvr2.pth"
exec /start.sh

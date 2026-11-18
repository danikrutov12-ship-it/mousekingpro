#!/usr/bin/env bash
# Однократная установка апскейлера SeedVR2 на сетевой диск RunPod. Запускается внутри образа
# runpod/worker-comfyui:5.10.0-base (тот же Python 3.12 и библиотеки, что у воркера), диск — в /runpod-volume.
# Кладёт: узел ComfyUI (зафиксированная версия), недостающие Python-пакеты (без torch/numpy образа), модели.
# Повторный запуск безопасен: уже скачанное не перекачивается.
set -x
V=/runpod-volume
N=$V/seedvr2
PY=/opt/venv/bin/python
NODE_COMMIT=4490bd1f482e026674543386bb2a4d176da245b9   # 2025-12-24, версия 2.5.24
mkdir -p "$N" "$V/models/SEEDVR2"

# --- узел
if [ ! -d "$N/node/.git" ]; then
  rm -rf "$N/node" && git clone -q https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler.git "$N/node"
fi
git -C "$N/node" fetch -q origin && git -C "$N/node" checkout -q "$NODE_COMMIT"
git -C "$N/node" log -1 --format='узел: %h %cs'

# --- пакеты: ставим только то, чего нет в окружении воркера, и без зависимостей (torch, numpy и т. п. — из образа)
grep -viE '^(torch|torchvision|numpy|opencv-python)\b' "$N/node/requirements.txt" > /tmp/req.txt
$PY -c "import cv2" 2>/dev/null || echo opencv-python-headless >> /tmp/req.txt
$PY -m pip install --dry-run --quiet --report /tmp/r.json -r /tmp/req.txt
$PY - <<'EOF' > /tmp/missing.txt
import json
for i in json.load(open('/tmp/r.json'))['install']:
    m = i['metadata']
    if m['name'].lower() not in ('torch', 'torchvision', 'numpy', 'nvidia-cudnn-cu12'):
        print(f"{m['name']}=={m['version']}")
EOF
echo "доставить пакеты:"; cat /tmp/missing.txt
rm -rf "$N/pylib.tmp"
if [ -s /tmp/missing.txt ]; then
  $PY -m pip install --quiet --no-deps --target "$N/pylib.tmp" -r /tmp/missing.txt || exit 1
else
  mkdir -p "$N/pylib.tmp"
fi
rm -rf "$N/pylib" && mv "$N/pylib.tmp" "$N/pylib"

# --- модели (7B fp16 — максимум качества, и VAE)
cd "$V/models/SEEDVR2"
for f in seedvr2_ema_7b_fp16.safetensors ema_vae_fp16.safetensors; do
  if [ ! -s "$f" ]; then
    curl -fL --retry 3 -o "$f.part" "https://huggingface.co/numz/SeedVR2_comfyUI/resolve/main/$f" && mv "$f.part" "$f"
  fi
done
ls -la "$V/models/SEEDVR2"
sha256sum seedvr2_ema_7b_fp16.safetensors | cut -c1-16
df -h "$V" | tail -1
echo "SETUP_OK"

"""Проверка апскейла на поде: ComfyUI с SeedVR2 с диска, один тестовый кадр, замер времени и размера.
Запуск (в образе worker-comfyui, после setup.sh и подключения как в start.sh): python podtest.py <картинка> <куда сохранить>"""
import json
import shutil
import subprocess
import sys
import time
import urllib.request

src, dst = sys.argv[1], sys.argv[2]
blocks = int(sys.argv[3]) if len(sys.argv) > 3 else 0  # подкачка блоков DiT в память (для карт 24–32 ГБ)
print('blocks_to_swap =', blocks)
shutil.copy(src, '/comfyui/input/test.jpg')
proc = subprocess.Popen(['/opt/venv/bin/python', 'main.py', '--listen', '127.0.0.1', '--port', '8188'], cwd='/comfyui')
API = 'http://127.0.0.1:8188'


def get(p):
    return json.load(urllib.request.urlopen(API + p, timeout=30))


for _ in range(180):
    try:
        info = get('/object_info/SeedVR2VideoUpscaler')
        break
    except Exception:
        time.sleep(2)
else:
    print('ComfyUI не поднялся'); sys.exit(1)
print('узел загружен:', list(info))
dev = get('/object_info/SeedVR2LoadDiTModel')['SeedVR2LoadDiTModel']['input']['required']['device'][0]
print('устройства:', dev)
wf = {
    '1': {'class_type': 'LoadImage', 'inputs': {'image': 'test.jpg'}},
    '2': {'class_type': 'SeedVR2LoadDiTModel', 'inputs': {'model': 'seedvr2_ema_7b_fp16.safetensors', 'device': dev[0], 'blocks_to_swap': blocks,
          'swap_io_components': blocks > 0, 'offload_device': 'cpu' if blocks else 'none', 'cache_model': False, 'attention_mode': 'sdpa'}},
    '3': {'class_type': 'SeedVR2LoadVAEModel', 'inputs': {'model': 'ema_vae_fp16.safetensors', 'device': dev[0], 'encode_tiled': True,
          'encode_tile_size': 1024, 'encode_tile_overlap': 128, 'decode_tiled': True, 'decode_tile_size': 1024, 'decode_tile_overlap': 128,
          'tile_debug': 'false', 'offload_device': 'none', 'cache_model': False}},
    '4': {'class_type': 'SeedVR2VideoUpscaler', 'inputs': {'image': ['1', 0], 'dit': ['2', 0], 'vae': ['3', 0], 'seed': 42, 'resolution': 1344,
          'max_resolution': 2048, 'batch_size': 1, 'uniform_batch_size': False, 'temporal_overlap': 0, 'prepend_frames': 0,
          'color_correction': 'lab', 'input_noise_scale': 0.0, 'latent_noise_scale': 0.0, 'offload_device': 'cpu', 'enable_debug': False}},
    '5': {'class_type': 'SaveImage', 'inputs': {'images': ['4', 0], 'filename_prefix': 'up'}},
}
t0 = time.time()
req = urllib.request.Request(API + '/prompt', data=json.dumps({'prompt': wf}).encode(), headers={'Content-Type': 'application/json'})
try:
    pid = json.load(urllib.request.urlopen(req))['prompt_id']
except urllib.error.HTTPError as e:
    print('ошибка графа:', e.read().decode()[:3000]); sys.exit(1)
while True:
    h = get('/history/' + pid)
    if pid in h:
        st = h[pid].get('status', {})
        print('статус:', st.get('status_str'), 'за', round(time.time() - t0), 'с')
        if st.get('status_str') != 'success':
            print(json.dumps(st)[:3000]); sys.exit(1)
        img = h[pid]['outputs']['5']['images'][0]
        shutil.copy(f"/comfyui/output/{img['filename']}", dst)
        break
    time.sleep(2)
# второй прогон — модель уже в памяти, это время ближе к «тёплому» воркеру
t1 = time.time()
wf['4']['inputs']['seed'] = 43  # другой seed — иначе ComfyUI вернёт результат из кэша
pid = json.load(urllib.request.urlopen(urllib.request.Request(API + '/prompt', data=json.dumps({'prompt': wf, 'client_id': 'x2'}).encode(), headers={'Content-Type': 'application/json'})))['prompt_id']
while pid not in get('/history/' + pid):
    time.sleep(2)
print('второй прогон:', round(time.time() - t1), 'с')
proc.terminate()
print('PODTEST_OK')

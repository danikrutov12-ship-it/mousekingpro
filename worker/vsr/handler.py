"""RunPod Serverless: удаление текста с видео через video-subtitle-remover (VSR).

Работает внутри официального образа eritpchy/video-subtitle-remover (код VSR в /vsr).
Файл лежит на сетевом диске (/runpod-volume/vsr) и запускается из start.sh — так его можно
обновлять без пересборки образа.

Вход (job["input"]):
  job    — имя папки задачи в /runpod-volume/vsr/jobs (её создаёт программа, загружая видео по S3)
  file   — имя видео в этой папке (in.mp4 / in.mov / ...)
  video_b64 + ext — вместо S3: само видео в base64 (только для маленьких файлов)
  mode   — sttn-auto | sttn-det | lama | propainter
  areas  — рамки в долях кадра [[x0, y0, x1, y1], ...]; пусто — искать текст по всему кадру
Выход:   {"file": "out.mp4", "seconds": N}  или  {"video_b64": ...} для маленьких файлов.
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import time

sys.path += ['/runpod-volume/vsr/pylib', '/tmp/pylib']  # пакет runpod (см. start.sh); пакеты образа важнее
import runpod  # noqa: E402

JOBS = '/runpod-volume/vsr/jobs'
VSR = '/vsr'
MODES = {'sttn-auto', 'sttn-det', 'lama', 'propainter'}
NAME = re.compile(r'^[A-Za-z0-9_-]{6,64}$')
FILE = re.compile(r'^in\.(mp4|mov|webm|mkv|avi|m4v)$')
PCT = re.compile(rb'(\d{1,3})%\|')


def video_size(path):
    import cv2
    cap = cv2.VideoCapture(path)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    frames, fps = cap.get(cv2.CAP_PROP_FRAME_COUNT), cap.get(cv2.CAP_PROP_FPS) or 25
    cap.release()
    return w, h, frames / fps if fps else 0


def gpu_gb():
    try:
        out = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.total', '--format=csv,noheader,nounits'], text=True)
        return int(out.split()[0]) / 1024
    except Exception:
        return 24


def set_config(mode, w, h):
    """ProPainter: сколько кадров держать в памяти — под размер кадра и видеокарту (иначе нехватка памяти)."""
    path = os.path.join(VSR, 'config', 'config.json')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        cfg = json.load(open(path))
    except Exception:
        cfg = {}
    if mode == 'propainter':
        mp = w * h / 1e6
        n = int((gpu_gb() * 0.85 - 9) / (0.22 * max(mp, 0.3)))
        cfg.setdefault('ProPainter', {})['MaxLoadNum'] = max(8, min(70, n))
    json.dump(cfg, open(path, 'w'))


def to_h264(src, dst):
    """VSR 1.4.0 пишет MPEG-4 Part 2 — встроенный плеер (Chromium) его не играет. Перекодируем в H.264, звук как есть."""
    ff = next((p for p in (os.path.join(VSR, 'backend', 'ffmpeg', 'linux_x64', 'ffmpeg'), shutil.which('ffmpeg')) if p and os.path.exists(p)), None)
    if not ff:
        return False
    r = subprocess.run([ff, '-y', '-v', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast',
                        '-crf', '17', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', dst],
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    if r.returncode != 0:
        print('to_h264:', r.stdout[-800:])
    return r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst) > 0


def cleanup_old():
    """Задачи старше суток (программа не успела забрать) — удаляем, чтобы не занимать диск."""
    if not os.path.isdir(JOBS):
        return
    now = time.time()
    for name in os.listdir(JOBS):
        p = os.path.join(JOBS, name)
        try:
            if now - os.path.getmtime(p) > 86400:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass


def handler(job):
    inp = job.get('input') or {}
    cleanup_old()
    mode = inp.get('mode', 'sttn-auto')
    if mode not in MODES:
        return {'error': f'неизвестный режим {mode}'}
    small = 'video_b64' in inp
    jid = inp.get('job') or job['id'].replace('-', '')[:32]
    if not NAME.match(jid):
        return {'error': 'неверное имя задачи'}
    d = os.path.join(JOBS, jid)
    os.makedirs(d, exist_ok=True)
    if small:
        ext = inp.get('ext', 'mp4')
        name = f'in.{ext}'
        if not FILE.match(name):
            return {'error': 'неподдерживаемый формат видео'}
        open(os.path.join(d, name), 'wb').write(base64.b64decode(inp['video_b64']))
    else:
        name = inp.get('file', '')
        if not FILE.match(name):
            return {'error': 'неверное имя файла'}
    src, out, raw = os.path.join(d, name), os.path.join(d, 'out.mp4'), os.path.join(d, 'raw.mp4')
    if not os.path.exists(src):
        return {'error': 'видео не найдено на диске RunPod — загрузка не дошла'}
    w, h, dur = video_size(src)
    if not w or not h:
        return {'error': 'не удалось прочитать видео (формат не поддерживается или файл повреждён)'}
    if dur > 610:
        return {'error': f'видео длиннее 10 минут ({round(dur)} с)'}
    areas = []
    for a in inp.get('areas') or []:
        x0, y0, x1, y1 = [min(1.0, max(0.0, float(v))) for v in a]
        if x1 - x0 < 0.002 or y1 - y0 < 0.002:
            continue
        areas.append((int(y0 * h), int(round(y1 * h)), int(x0 * w), int(round(x1 * w))))
    if not areas and mode == 'sttn-auto':
        mode = 'sttn-det'  # без рамки STTN стёр бы весь кадр — ищем текст детектором
    set_config(mode, w, h)
    cmd = [sys.executable, '-u', 'backend/main.py', '-i', src, '-o', raw, '--inpaint-mode', mode]
    for a in areas:
        cmd += ['-c', *map(str, a)]
    started = time.time()
    proc = subprocess.Popen(cmd, cwd=VSR, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    log, last, sent = b'', -1, 0.0
    while True:
        chunk = proc.stdout.read1(65536) if hasattr(proc.stdout, 'read1') else proc.stdout.read(4096)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        log = (log + chunk)[-20000:]
        found = PCT.findall(chunk)
        if found:
            pct = int(found[-1])
            if pct != last and time.time() - sent > 3:
                runpod.serverless.progress_update(job, f'{pct}%')
                last, sent = pct, time.time()
    rc = proc.wait()
    tail = log.decode('utf-8', 'replace').replace('\r', '\n')
    if rc != 0 or not os.path.exists(raw):
        lines = [l for l in tail.split('\n') if l.strip() and '%|' not in l]
        return {'error': 'VSR завершился с ошибкой: ' + '\n'.join(lines[-12:])[-1500:]}
    h264 = to_h264(raw, out)
    if h264:
        os.remove(raw)
    else:
        os.replace(raw, out)
    res = {'seconds': round(time.time() - started), 'width': w, 'height': h, 'mode': mode, 'h264': h264}
    if small:
        res['video_b64'] = base64.b64encode(open(out, 'rb').read()).decode()
        shutil.rmtree(d, ignore_errors=True)
    else:
        os.remove(src)  # исходник больше не нужен; результат программа заберёт и удалит сама
        res['file'] = 'out.mp4'
    return res


runpod.serverless.start({'handler': handler})

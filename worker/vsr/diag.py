"""Запасной обработчик: если основной упал при старте, берём задачу и возвращаем лог запуска как ошибку.

Только стандартная библиотека — работает даже если пакет runpod не установился. Без него задача
висела бы в очереди, а RunPod перезапускал бы воркер за деньги.
"""
import json
import os
import time
import urllib.parse
import urllib.request

POD = os.environ.get('RUNPOD_POD_ID', '')
GPU = urllib.parse.quote(os.environ.get('RUNPOD_GPU_TYPE_ID', ''))
HEAD = {'Authorization': os.environ.get('RUNPOD_AI_API_KEY', ''), 'User-Agent': 'mkp-vsr-diag/1.0'}


def url(name, job=''):
    return os.environ[name].replace('$RUNPOD_POD_ID', POD).replace('$RUNPOD_GPU_TYPE_ID', GPU).replace('$ID', job)


try:
    log = open('/tmp/start.log', errors='replace').read()[-6000:]
except OSError:
    log = '(лога нет)'
deadline = time.time() + 120
while time.time() < deadline:
    try:
        r = urllib.request.urlopen(urllib.request.Request(url('RUNPOD_WEBHOOK_GET_JOB'), headers=HEAD), timeout=30)
        body = r.read()
    except Exception as e:  # noqa: BLE001
        print('diag: job-take', e)
        time.sleep(3)
        continue
    if r.status == 200 and body:
        job = json.loads(body)
        data = json.dumps({'output': {'error': 'Воркер VSR не запустился:\n' + log}}).encode()
        req = urllib.request.Request(url('RUNPOD_WEBHOOK_POST_OUTPUT', job['id']), data=data, method='POST',
                                     headers={**HEAD, 'Content-Type': 'application/json'})
        try:
            urllib.request.urlopen(req, timeout=30)
        except Exception as e:  # noqa: BLE001
            print('diag: job-done', e)
        break
    time.sleep(2)

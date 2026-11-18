"""RunPod Serverless: запускатель воркера «Убрать текст с видео» (VSR).

Вся логика — в job.py рядом; он загружается заново на каждую задачу, поэтому обновление файлов на диске
(worker/vsr/tools/deploy.sh) действует сразу, даже на уже запущенных («тёплых») воркерах.
"""
import importlib.util
import sys

sys.path += ['/runpod-volume/vsr/pylib', '/tmp/pylib']  # пакет runpod (см. start.sh); пакеты образа важнее
import runpod  # noqa: E402

JOB = '/runpod-volume/vsr/job.py'


def handler(job):
    spec = importlib.util.spec_from_file_location('vsr_job', JOB)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.handle(job, runpod)


runpod.serverless.start({'handler': handler})

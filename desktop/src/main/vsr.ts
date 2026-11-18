// «Убрать текст с видео»: VSR на своём RunPod Serverless.
// Видео идёт на сетевой диск через S3 RunPod (без лимита 10 МБ на запрос), обработчик worker/vsr/handler.py
// берёт его оттуда и кладёт результат рядом; программа скачивает результат и подчищает диск.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { VSR_ENDPOINT, VSR_INLINE_MAX_BYTES, vsrMode, type VsrParams } from '@shared/vsr'
import { account, call, endpointByName } from './runpod'
import * as s3 from './s3'

export interface VsrKeys { key: string; s3: { access: string; secret: string } | null }

const volumes = new Map<string, { id: string; dc: string }>()

/** Сетевой диск эндпоинта и его датацентр — для адреса S3. */
async function volumeOf(key: string, endpoint: string) {
  if (volumes.has(endpoint)) return volumes.get(endpoint)!
  const acc = await account(key)
  const volId = acc.endpoints.find((e) => e.id === endpoint)?.networkVolumeId
  if (!volId) throw new Error('У эндпоинта VSR нет сетевого диска')
  const vol = acc.networkVolumes.find((n) => n.id === volId)
  if (!vol) throw new Error('Сетевой диск эндпоинта VSR не найден в аккаунте RunPod')
  const v = { id: volId, dc: vol.dataCenterId }
  volumes.set(endpoint, v)
  return v
}

export interface VsrResult { path: string; seconds: number; cold: boolean; mode: string }

export async function run(keys: VsrKeys, p: VsrParams, video: string, outDir: string,
  status: (s: string) => void, stopped: () => boolean): Promise<VsrResult> {
  const mode = vsrMode(p.mode)
  const name = VSR_ENDPOINT
  const endpoint = await endpointByName(keys.key, name).catch(() => null)
  if (!endpoint) throw new Error(`В аккаунте RunPod нет эндпоинта ${name} — без него удаление текста не работает`)
  const cfg = { key: keys.key, endpoint }
  const ext = extname(video).slice(1).toLowerCase()
  const size = statSync(video).size
  const jid = randomBytes(12).toString('hex')
  const input: Record<string, unknown> = { job: jid, mode: mode.id, areas: p.areas }
  let bucket: s3.S3Cfg | null = null
  const dir = `vsr/jobs/${jid}`
  if (keys.s3) {
    const vol = await volumeOf(keys.key, endpoint)
    bucket = s3.runpodS3(keys.s3.access, keys.s3.secret, vol.id, vol.dc)
    status('Загружаю видео на RunPod…')
    await s3.upload(bucket, `${dir}/in.${ext}`, video, (done, total) => status(`Загружаю видео на RunPod… ${Math.round((done / total) * 100)}%`), stopped)
    input.file = `in.${ext}`
  } else {
    if (size > VSR_INLINE_MAX_BYTES) {
      throw new Error(`Видео ${Math.round(size / 1048576)} МБ: без S3-ключа RunPod можно отправить только до 7 МБ. Добавьте S3-ключ в Настройки → RunPod / WaveSpeed.`)
    }
    input.video_b64 = readFileSync(video).toString('base64')
    input.ext = ext
  }
  const cleanup = async () => {
    if (!bucket) return
    await Promise.all([s3.remove(bucket, `${dir}/in.${ext}`), s3.remove(bucket, `${dir}/out.mp4`)])
  }
  try {
    const h = await call(cfg, '/health').catch(() => null)
    const cold = !!h && !(h.workers?.idle > 0) && !(h.workers?.running > 0)
    status(cold ? 'Включаю видеокарту на RunPod (после простоя — 1–3 минуты)…' : 'Отправляю на RunPod…')
    const job = await call(cfg, '/run', { input })
    const started = Date.now()
    for (;;) {
      if (stopped()) {
        await call(cfg, `/cancel/${job.id}`, {}).catch(() => {})
        throw new Error('Остановлено')
      }
      await new Promise((r) => setTimeout(r, 3000))
      const s = await call(cfg, `/status/${job.id}`)
      const sec = Math.round((Date.now() - started) / 1000)
      const out = s.output
      if (s.status === 'IN_QUEUE') status(cold ? `Включаю видеокарту… ${sec} с` : `В очереди… ${sec} с`)
      else if (s.status === 'IN_PROGRESS') status(`Убираю текст (${mode.name})… ${typeof out === 'string' ? out + ' · ' : ''}${sec} с`)
      else if (s.status === 'COMPLETED') {
        if (out?.error) throw new Error(String(out.error))
        mkdirSync(outDir, { recursive: true })
        const stem = basename(video, extname(video)).replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 40) || 'video'
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const path = join(outDir, `${stem}-без-текста-${stamp}.mp4`)
        if (out?.video_b64) writeFileSync(path, Buffer.from(out.video_b64, 'base64'))
        else if (bucket && out?.file) {
          status('Скачиваю готовое видео…')
          await s3.download(bucket, `${dir}/${out.file}`, path)
        } else throw new Error('RunPod завершил задачу без видео: ' + JSON.stringify(out).slice(0, 300))
        return { path, seconds: out.seconds ?? Math.round((s.executionTime || 0) / 1000), cold, mode: out.mode || mode.id }
      } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(s.status)) {
        const err = typeof s.error === 'string' ? s.error : JSON.stringify(s.error || out || {})
        throw new Error(`RunPod: ${s.status === 'TIMED_OUT' ? 'не уложился в час' : s.status} — ${err.slice(0, 800)}`)
      }
    }
  } finally {
    await cleanup()
  }
}

/** Проверка S3-ключа: читаем с диска обработчик VSR (он там точно есть). */
export async function checkS3(key: string, access: string, secret: string) {
  const endpoint = await endpointByName(key, VSR_ENDPOINT).catch(() => null)
  if (!endpoint) throw new Error(`В аккаунте RunPod нет эндпоинта ${VSR_ENDPOINT}`)
  const vol = await volumeOf(key, endpoint)
  await s3.probe(s3.runpodS3(access, secret, vol.id, vol.dc), 'vsr/start.sh')
}

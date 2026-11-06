// «Картинка Pro»: генерация на своём RunPod Serverless (worker-comfyui) — воркфлоу ComfyUI в формате API.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { proModel, type ProModel, type ProParams } from '@shared/runpod'
import { buildWorkflow } from './workflows'

// ---------------------------------------------------------------- клиент RunPod

export interface RunpodCfg { key: string; endpoint: string }

const API = 'https://api.runpod.ai/v2'

async function call(cfg: RunpodCfg, path: string, body?: unknown) {
  const r = await fetch(`${API}/${cfg.endpoint}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text()
  if (!r.ok) {
    const hint = r.status === 401 ? 'Ключ RunPod не подошёл — проверьте его в настройках.'
      : r.status === 404 ? 'Эндпоинт RunPod не найден — проверьте его ID в настройках.' : ''
    throw new Error(`RunPod ${r.status}: ${hint || text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : {}
}

/** Состояние эндпоинта: сколько рабочих готово, просыпается, в очереди. */
export const health = (cfg: RunpodCfg) => call(cfg, '/health')

/** Баланс аккаунта RunPod (GraphQL). */
export async function balance(key: string): Promise<number | null> {
  const r = await fetch('https://api.runpod.io/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query { myself { clientBalance } }' }), signal: AbortSignal.timeout(20_000),
  })
  const d = await r.json().catch(() => null)
  return d?.data?.myself?.clientBalance ?? null
}

/** Фото для отправки: длинная сторона до 1536 px, JPEG — чтобы запрос уложился в лимит RunPod (10 МБ). */
function prepImage(path: string): string {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) return readFileSync(path).toString('base64')
  const { width, height } = img.getSize()
  const k = Math.min(1, 1536 / Math.max(width, height))
  const out = k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img
  return out.toJPEG(94).toString('base64')
}

export interface ProResult { paths: string[]; seconds: number; cold: boolean }

/** Запуск: отправить воркфлоу, ждать результат, сохранить картинки. */
export async function generate(
  cfg: RunpodCfg, p: ProParams, photos: string[], outDir: string,
  status: (s: string) => void, stopped: () => boolean,
): Promise<ProResult> {
  const m: ProModel = proModel(p.model)
  if (m.kind === 'edit' && !photos.length) throw new Error(`${m.name} правит фото — прикрепите хотя бы одно`)
  const names = photos.slice(0, m.maxRefs).map((_, i) => `ref_${i + 1}.jpg`)
  const workflow = buildWorkflow(p, names)
  const images = photos.slice(0, m.maxRefs).map((path, i) => ({ name: names[i], image: prepImage(path) }))
  const h = await health(cfg).catch(() => null)
  const cold = !!h && !(h.workers?.idle > 0) && !(h.workers?.running > 0)
  status(cold ? 'Включаю видеокарту на RunPod (первый запуск после простоя — до 1–2 минут)…' : 'Отправляю на RunPod…')
  const job = await call(cfg, '/run', { input: { workflow, images } })
  const started = Date.now()
  for (;;) {
    if (stopped()) {
      await call(cfg, `/cancel/${job.id}`, {}).catch(() => {})
      throw new Error('Остановлено')
    }
    await new Promise((r) => setTimeout(r, 2000))
    const s = await call(cfg, `/status/${job.id}`)
    const sec = Math.round((Date.now() - started) / 1000)
    if (s.status === 'IN_QUEUE') status(cold ? `Включаю видеокарту… ${sec} с` : `В очереди… ${sec} с`)
    else if (s.status === 'IN_PROGRESS') status(`Генерирую на RunPod… ${sec} с`)
    else if (s.status === 'COMPLETED') {
      const imgs: { filename: string; type: string; data: string }[] = s.output?.images || []
      if (!imgs.length) throw new Error('RunPod завершил задачу без картинки: ' + JSON.stringify(s.output).slice(0, 300))
      mkdirSync(outDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const paths = imgs.map((im, i) => {
        const path = join(outDir, `pro-${m.id}-${stamp}${imgs.length > 1 ? '-' + (i + 1) : ''}.png`)
        writeFileSync(path, Buffer.from(im.data, 'base64'))
        return path
      })
      return { paths, seconds: Math.round((s.executionTime || 0) / 1000), cold }
    } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(s.status)) {
      const err = typeof s.error === 'string' ? s.error : JSON.stringify(s.error || s.output || {})
      throw new Error(`RunPod: ${s.status} — ${err.slice(0, 500)}`)
    }
  }
}

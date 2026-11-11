// «Картинка Pro»: генерация на своём RunPod Serverless (worker-comfyui) — воркфлоу ComfyUI в формате API.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { HQ_ENDPOINT_NAME, proModel, type ProModel, type ProParams } from '@shared/runpod'
import type { RunpodSpendInfo } from '@shared/types'
import { keepOriginal } from './blend'
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

/** Найти эндпоинт по имени в аккаунте (для «Макс. качества» — отдельный, с видеокартами 48 ГБ+). */
const found = new Map<string, string>()
export async function endpointByName(key: string, name: string): Promise<string | null> {
  if (found.has(name)) return found.get(name)!
  const r = await fetch('https://rest.runpod.io/v1/endpoints', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) return null
  const list: { id: string; name: string }[] = await r.json().catch(() => [])
  const id = list.find((e) => e.name === name)?.id ?? null
  if (id) found.set(name, id)
  return id
}

/** Баланс аккаунта RunPod (GraphQL). */
export async function balance(key: string): Promise<number | null> {
  const r = await fetch('https://api.runpod.io/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'query { myself { clientBalance } }' }), signal: AbortSignal.timeout(20_000),
  })
  const d = await r.json().catch(() => null)
  return d?.data?.myself?.clientBalance ?? null
}

/** Расходы без подсчёта картинок (его добавляет index.ts по галерее). */
export type RunpodSpend = Omit<RunpodSpendInfo, 'images'>

async function rest(key: string, path: string) {
  const r = await fetch(`https://rest.runpod.io/v1/${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`RunPod ${r.status}`)
  return r.json()
}

/** Расходы RunPod: видеокарты (по типам), диск, текущая ставка и баланс. */
export async function spend(key: string): Promise<RunpodSpend> {
  const now = new Date()
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const today = now.toISOString().slice(0, 10)
  const q = `bucketSize=day&startTime=${start}&endTime=${now.toISOString()}`
  const [gpu, disk, me] = await Promise.all([
    rest(key, `billing/endpoints?${q}&grouping=gpuTypeId`) as Promise<{ amount: number; timeBilledMs: number; gpuTypeId: string; time: string }[]>,
    (rest(key, `billing/networkvolumes?${q}`) as Promise<{ amount: number }[]>).catch(() => []),
    fetch('https://api.runpod.io/graphql', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'query { myself { clientBalance currentSpendPerHr } }' }), signal: AbortSignal.timeout(20_000),
    }).then((r) => r.json()).then((d) => d?.data?.myself).catch(() => null),
  ])
  const by = new Map<string, { usd: number; sec: number }>()
  let month = 0, todaySum = 0
  for (const b of gpu) {
    month += b.amount
    if (String(b.time).startsWith(today)) todaySum += b.amount
    const name = String(b.gpuTypeId || '—').replace(/^NVIDIA (GeForce )?/, '')
    const g = by.get(name) || { usd: 0, sec: 0 }
    g.usd += b.amount
    g.sec += (b.timeBilledMs || 0) / 1000
    by.set(name, g)
  }
  return {
    today: todaySum, month, disk: disk.reduce((s, b) => s + (b.amount || 0), 0),
    perHour: me?.currentSpendPerHr ?? null, balance: me?.clientBalance ?? null,
    gpus: [...by].map(([name, g]) => ({ name, ...g })).sort((a, b) => b.usd - a.usd),
  }
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

/** Понятный текст для частых ошибок ComfyUI: нет файла LoRA или модели на диске RunPod. */
function friendlyError(err: string): string | null {
  const m = /(lora_name|unet_name|ckpt_name|clip_name|vae_name|model_name): '([^']+)' not in \[([^\]]*)\]/.exec(err)
  if (!m) return null
  const have = m[3].replace(/'/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  if (m[1] === 'lora_name') {
    const list = have.filter((n) => !/Lightning/i.test(n))
    return `LoRA «${m[2]}» нет на диске RunPod (папка models/loras).` + (list.length ? ` Есть: ${list.join(', ')}` : ' Там пока нет ни одной своей LoRA.')
  }
  return `На диске RunPod нет файла модели «${m[2]}» — модели нужно докачать.`
}

export interface ProResult {
  paths: string[]; seconds: number; cold: boolean
  /** «Сохранять исходник»: доля кадра, взятая из генерации (null — не применялось или изменилось почти всё) */
  kept?: number | null
}

/** Совместить генерацию с исходным фото и взять из неё только изменённое. Размер — больший из двух. */
export function keepSource(photo: string, png: Buffer): { png: Buffer; changed: number } | null {
  try {
    let orig = nativeImage.createFromPath(photo)
    let gen = nativeImage.createFromBuffer(png)
    if (orig.isEmpty() || gen.isEmpty()) return null
    const o = orig.getSize(), g = gen.getSize()
    const r0 = o.width / o.height, r1 = g.width / g.height
    if (Math.abs(Math.log(r0 / r1)) > 0.05) return null // кадр другой формы — это уже не та же картинка
    if (g.width * g.height > o.width * o.height) orig = orig.resize({ width: g.width, height: g.height, quality: 'best' })
    else gen = gen.resize({ width: o.width, height: o.height, quality: 'best' })
    const { width, height } = orig.getSize()
    const r = keepOriginal({ data: orig.toBitmap(), width, height }, { data: gen.toBitmap(), width, height })
    if (!r) return null
    return { png: nativeImage.createFromBitmap(Buffer.from(r.out.data.buffer), { width, height }).toPNG(), changed: r.changed }
  } catch {
    return null
  }
}

/** Запуск: отправить воркфлоу, ждать результат, сохранить картинки. */
export async function generate(
  cfg: RunpodCfg, p: ProParams, photos: string[], outDir: string,
  status: (s: string) => void, stopped: () => boolean,
): Promise<ProResult> {
  const m: ProModel = proModel(p.model)
  if (p.maxq && m.quality) {
    const hq = await endpointByName(cfg.key, HQ_ENDPOINT_NAME).catch(() => null)
    if (!hq) throw new Error(`Для «Макс. качества» нужен эндпоинт RunPod с именем ${HQ_ENDPOINT_NAME} (видеокарты 48 ГБ+)`)
    cfg = { ...cfg, endpoint: hq }
  }
  if (m.kind === 'edit' && !photos.length) throw new Error(`${m.name} правит фото — прикрепите хотя бы одно`)
  if (m.kind === 'faceswap' && photos.length < 2) throw new Error('Для фейсвапа нужно два фото: 1 — куда вставлять лицо, 2 — откуда его взять')
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
      let kept: number | null = null
      const paths = imgs.map((im, i) => {
        const path = join(outDir, `pro-${m.id}-${stamp}${imgs.length > 1 ? '-' + (i + 1) : ''}.png`)
        let png: Buffer = Buffer.from(im.data, 'base64')
        if (m.kind === 'edit' && p.keep && photos[0]) {
          status('Переношу изменения на исходное фото…')
          const r = keepSource(photos[0], png)
          if (r) [png, kept] = [r.png, r.changed]
        }
        writeFileSync(path, png)
        return path
      })
      return { paths, seconds: Math.round((s.executionTime || 0) / 1000), cold, kept }
    } else if (['FAILED', 'CANCELLED', 'TIMED_OUT'].includes(s.status)) {
      const err = typeof s.error === 'string' ? s.error : JSON.stringify(s.error || s.output || {})
      throw new Error(friendlyError(err) || `RunPod: ${s.status} — ${err.slice(0, 500)}`)
    }
  }
}

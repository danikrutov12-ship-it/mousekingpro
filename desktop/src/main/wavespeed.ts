// «Картинка Pro» через WaveSpeedAI: Qwen Image 3.0 Pro (закрытая модель Alibaba, только по API).
// Фото загружаются в хранилище WaveSpeed (живут 7 дней), в запрос идут их ссылки.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeImage } from 'electron'
import { proModel, type ProParams } from '@shared/runpod'
import { keepSource, type ProResult } from './runpod'

const API = 'https://api.wavespeed.ai/api/v3'

async function call(key: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text()
  const d = (() => { try { return JSON.parse(text) } catch { return null } })()
  if (!r.ok || (d?.code && d.code !== 200)) {
    const hint = r.status === 401 ? 'Ключ WaveSpeed не подошёл — проверьте его в настройках.'
      : r.status === 402 ? 'На балансе WaveSpeed не хватает денег.' : ''
    throw new Error(`WaveSpeed ${r.status}: ${hint || d?.message || text.slice(0, 300)}`)
  }
  return d?.data ?? d ?? {}
}

/** Баланс аккаунта в долларах. */
export async function balance(key: string): Promise<number | null> {
  try {
    const d = await call(key, '/balance')
    return typeof d.balance === 'number' ? d.balance : null
  } catch {
    return null
  }
}

/** Фото для модели: стороны 384–2048 px, JPEG. */
function prep(path: string): { buf: Buffer; name: string } {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) throw new Error('Не удалось открыть фото')
  const { width, height } = img.getSize()
  if (Math.min(width, height) < 384) throw new Error(`Фото слишком маленькое (${width}×${height}): Qwen Image 3 Pro нужно не меньше 384 px по каждой стороне`)
  const k = Math.min(1, 2048 / Math.max(width, height))
  const out = k < 1 ? img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' }) : img
  return { buf: out.toJPEG(95), name: 'photo.jpg' }
}

/** Загрузить файл в хранилище WaveSpeed, вернуть ссылку для запроса. */
async function upload(key: string, path: string): Promise<string> {
  const { buf, name } = prep(path)
  const d = await call(key, '/media/uploads', { filename: name, size: buf.length, content_type: 'image/jpeg' })
  if (!d.upload?.url || !d.download_url) throw new Error('WaveSpeed не выдал адрес для загрузки фото')
  const r = await fetch(d.upload.url, {
    method: d.upload.method || 'PUT', headers: d.upload.headers || { 'Content-Type': 'image/jpeg' }, body: new Uint8Array(buf),
    signal: AbortSignal.timeout(120_000),
  })
  if (!r.ok) throw new Error(`WaveSpeed: не удалось загрузить фото (${r.status})`)
  return d.download_url
}

export async function generate(
  key: string, p: ProParams, photos: string[], outDir: string,
  status: (s: string) => void, stopped: () => boolean,
): Promise<ProResult> {
  const m = proModel(p.model)
  const refs = photos.slice(0, m.maxRefs)
  if (m.kind === 'edit' && !refs.length) throw new Error(`${m.name} правит фото — прикрепите хотя бы одно`)
  const body: Record<string, unknown> = {
    prompt: p.prompt.slice(0, 800), resolution: p.hires ? '2k' : '1k', enable_prompt_expansion: false,
    seed: p.seed ?? -1,
  }
  if (m.kind === 'edit') {
    status('Загружаю фото на WaveSpeed…')
    body.images = []
    for (const path of refs) {
      if (stopped()) throw new Error('Остановлено')
      ;(body.images as string[]).push(await upload(key, path))
    }
  } else body.aspect_ratio = p.aspect || '1:1'
  status('Отправляю на WaveSpeed…')
  const job = await call(key, `/${m.file}`, body)
  if (!job.id) throw new Error('WaveSpeed не вернул номер задачи')
  const started = Date.now()
  for (;;) {
    if (stopped()) throw new Error('Остановлено')
    await new Promise((r) => setTimeout(r, 2000))
    const s = await call(key, `/predictions/${job.id}/result`)
    const sec = Math.round((Date.now() - started) / 1000)
    if (s.status === 'completed') {
      const urls: string[] = s.outputs || []
      if (!urls.length) throw new Error('WaveSpeed завершил задачу без картинки')
      mkdirSync(outDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      let kept: number | null = null
      const paths: string[] = []
      for (const [i, url] of urls.entries()) {
        const r = await fetch(url, { signal: AbortSignal.timeout(120_000) })
        if (!r.ok) throw new Error(`WaveSpeed: не удалось скачать результат (${r.status})`)
        let png: Buffer = Buffer.from(await r.arrayBuffer())
        const img = nativeImage.createFromBuffer(png)
        if (!img.isEmpty()) png = img.toPNG()
        if (m.kind === 'edit' && p.keep && refs[0]) {
          status('Переношу изменения на исходное фото…')
          const k = keepSource(refs[0], png)
          if (k) [png, kept] = [k.png, k.changed]
        }
        const path = join(outDir, `pro-${m.id}-${stamp}${urls.length > 1 ? '-' + (i + 1) : ''}.png`)
        writeFileSync(path, png)
        paths.push(path)
      }
      return { paths, seconds: Math.round((s.timings?.inference || sec * 1000) / 1000), cold: false, kept }
    }
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(s.status)) {
      throw new Error(`WaveSpeed: ${s.status}${s.error ? ' — ' + String(s.error).slice(0, 400) : ''}`)
    }
    status(`Генерирую на WaveSpeed… ${sec} с`)
  }
}

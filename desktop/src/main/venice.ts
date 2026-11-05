// REST-клиент Venice: модели, баланс, веб-поиск, изображения, видео.
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { usd } from '@shared/pricing'
import type { Balance, Mode, Model } from '@shared/types'

export class VeniceError extends Error {}

const HINTS: Record<number, string> = {
  401: 'Ключ Venice не подошёл. Проверьте его в настройках.',
  402: 'На балансе Venice API закончились деньги. Пополните его: https://venice.ai/settings/api',
  422: 'Модель не смогла выполнить запрос на стороне поставщика (часто — его собственная модерация, неподходящая картинка или ' +
    'временный сбой). Деньги за такую попытку Venice возвращает. Попробуйте ещё раз, измените запрос или выберите другую модель.',
  429: 'Слишком много запросов к Venice. Подождите немного и повторите.',
}

/** Понятный текст ошибки API: подсказка для частых кодов плюс исходное сообщение Venice. */
export function explain(status: number, msg: unknown): string {
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg)
  const hint = HINTS[status]
  return hint ? `${hint}\n\n(${status}: ${text})` : `HTTP ${status}: ${text}`
}


const stamp = () => {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class Venice {
  spent = 0 // сколько списали вспомогательные запросы (веб-поиск), USD
  private base: string
  private headers: Record<string, string>

  constructor(apiKey: string, baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.headers = { Authorization: `Bearer ${apiKey}` }
  }

  private async request(path: string, init: RequestInit & { timeout?: number } = {}): Promise<Response> {
    const r = await fetch(this.base + path, {
      ...init,
      headers: { ...this.headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: init.signal ?? AbortSignal.timeout(init.timeout ?? 300_000),
    })
    if (r.status >= 400) {
      let msg: unknown
      try {
        const data = await r.json()
        msg = data.error ?? data.message ?? data.details ?? data
      } catch {
        msg = r.statusText
      }
      throw new VeniceError(explain(r.status, msg))
    }
    return r
  }

  private post(path: string, body: unknown, timeout?: number) {
    return this.request(path, { method: 'POST', body: JSON.stringify(body), timeout })
  }

  async listModels(type: Mode): Promise<Model[]> {
    const r = await this.request(`/models?type=${type}`, { timeout: 30_000 })
    const data = ((await r.json()).data || []) as any[]
    return data
      .filter((m) => !m.model_spec?.offline)
      .map((m) => {
        const spec = m.model_spec || {}
        const caps = spec.capabilities || {}
        return {
          id: m.id,
          type,
          name: spec.name || m.id,
          description: spec.description || '',
          uncensored: !!spec.uncensored,
          tools: !!caps.supportsFunctionCalling,
          vision: !!caps.supportsVision,
          reasoning: !!caps.supportsReasoning,
          web_search: !!caps.supportsWebSearch,
          context: spec.availableContextTokens || m.context_length || null,
          constraints: spec.constraints || {},
          pricing: spec.pricing || {},
        } satisfies Model
      })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }

  async balance(): Promise<Balance> {
    const r = await this.request('/api_keys/rate_limits', { timeout: 20_000 })
    return ((await r.json()).data || {}).balances || {}
  }

  async videoQuote(params: Record<string, any>): Promise<number> {
    const body: Record<string, any> = {}
    for (const k of ['model', 'duration', 'resolution', 'aspect_ratio', 'audio']) if (k in params) body[k] = params[k]
    return Number((await (await this.post('/video/quote', body, 20_000)).json()).quote)
  }

  async webSearch(model: string, query: string, limit: number): Promise<string> {
    const body = {
      model,
      messages: [{
        role: 'user',
        content: `Search the web for: ${query}\n\nList the ${limit} most relevant results. ` +
          'For each give the title, the URL and a 1-2 sentence summary. Answer in the language of the query.',
      }],
      temperature: 0.2,
      venice_parameters: { enable_web_search: 'on', include_venice_system_prompt: false, strip_thinking_response: true },
    }
    const data = await (await this.post('/chat/completions', body, 120_000)).json()
    this.spent += usd(data.cost) || 0
    const answer: string = data.choices?.[0]?.message?.content || ''
    const citations: any[] = data.venice_parameters?.web_search_citations || []
    const sources = citations.slice(0, limit * 2).filter((c) => c.url).map((c) => `- ${c.title || ''} — ${c.url}`)
    return answer.trim() + (sources.length ? `\n\nИсточники:\n${sources.join('\n')}` : '')
  }

  async generateImage(params: Record<string, any>, outDir: string): Promise<string[]> {
    const body = { format: 'png', return_binary: false, ...params }
    const data = await (await this.post('/image/generate', body)).json()
    const images: string[] = data.images || []
    if (!images.length) {
      const v = data.content_policy_violation_count
      throw new VeniceError('Модель не вернула изображений' + (v ? ` (отклонено политикой: ${v})` : ''))
    }
    mkdirSync(outDir, { recursive: true })
    const s = stamp()
    return images.map((b64, i) => {
      const p = join(outDir, `image-${s}-${i + 1}.${body.format}`)
      writeFileSync(p, Buffer.from(b64, 'base64'))
      return p
    })
  }

  async generateVideo(
    params: Record<string, any>, outDir: string,
    progress: (s: string) => void, stopped: () => boolean,
  ): Promise<string> {
    const queued = await (await this.post('/video/queue', params, 120_000)).json()
    const queueId: string = queued.queue_id
    const downloadUrl: string | undefined = queued.download_url
    progress(`Видео в очереди`)
    const started = Date.now()
    mkdirSync(outDir, { recursive: true })
    const path = join(outDir, `video-${stamp()}.mp4`)
    for (;;) {
      if (stopped()) throw new VeniceError('Остановлено (генерация на сервере может продолжиться)')
      if (Date.now() - started > 3600_000) throw new VeniceError(`Видео не готово за час. queue_id: ${queueId}`)
      const r = await this.post('/video/retrieve', { queue_id: queueId }, 600_000)
      const ctype = r.headers.get('content-type') || ''
      if (ctype.startsWith('video/') || ctype === 'application/octet-stream') {
        writeFileSync(path, Buffer.from(await r.arrayBuffer()))
        return path
      }
      const status = await r.json()
      if (status.status === 'COMPLETED' && downloadUrl) return this.download(downloadUrl, path)
      const done = Math.round((status.execution_duration || 0) / 1000)
      const avg = Math.round((status.average_execution_time || 0) / 1000)
      progress(`Генерация видео: ${done} с` + (avg ? ` из ~${avg} с` : ''))
      for (let i = 0; i < 10 && !stopped(); i++) await sleep(500)
    }
  }

  private async download(url: string, path: string): Promise<string> {
    let last: unknown
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(600_000) })
        if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
        await pipeline(Readable.fromWeb(r.body as any), createWriteStream(path))
        return path
      } catch (e) {
        last = e
        await sleep(2000)
      }
    }
    throw new VeniceError(`Не удалось скачать видео: ${last}`)
  }

  // ------------------------------------------------------------ картинки: увеличение, фон, правка

  /** Ответ Venice с картинкой: бинарный PNG или JSON с base64. */
  private async imageResult(r: Response, out: string): Promise<string> {
    const ctype = r.headers.get('content-type') || ''
    let buf: Buffer
    if (ctype.startsWith('image/')) buf = Buffer.from(await r.arrayBuffer())
    else {
      const data = await r.json()
      const b64 = data.images?.[0] || data.image || data.data?.[0]?.b64_json
      if (!b64) throw new VeniceError('Venice не вернул картинку')
      buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64')
    }
    writeFileSync(out, buf)
    return out
  }

  async upscale(imageB64: string, scale: number, out: string) {
    return this.imageResult(await this.post('/image/upscale', { image: imageB64, scale }), out)
  }

  async removeBackground(imageB64: string, out: string) {
    return this.imageResult(await this.post('/image/background-remove', { image: imageB64 }), out)
  }

  async editImage(model: string, imageB64: string, prompt: string, out: string, safe: boolean) {
    return this.imageResult(await this.post('/image/edit', { model, image: imageB64, prompt, safe_mode: safe, output_format: 'png' }), out)
  }

  // ------------------------------------------------------------ голос

  async speech(model: string, voice: string, input: string): Promise<Buffer> {
    const body: Record<string, any> = { model, input, response_format: 'mp3' }
    if (voice) body.voice = voice
    const r = await this.post('/audio/speech', body, 120_000)
    return Buffer.from(await r.arrayBuffer())
  }

  async transcribe(model: string, bytes: Uint8Array, mime: string): Promise<string> {
    const form = new FormData()
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'm4a' : mime.includes('wav') ? 'wav' : 'webm'
    form.append('file', new Blob([Buffer.from(bytes)], { type: mime }), `voice.${ext}`)
    form.append('model', model)
    form.append('response_format', 'json')
    const r = await fetch(this.base + '/audio/transcriptions', { method: 'POST', body: form, headers: this.headers, signal: AbortSignal.timeout(120_000) })
    if (r.status >= 400) {
      let msg: unknown
      try {
        const data = await r.json()
        msg = data.error ?? data.message ?? data
      } catch {
        msg = r.statusText
      }
      throw new VeniceError(explain(r.status, msg))
    }
    return String((await r.json()).text || '').trim()
  }

  /** Модели вспомогательных типов (tts, asr, inpaint) как есть. */
  async rawModels(type: string): Promise<any[]> {
    const r = await this.request(`/models?type=${type}`, { timeout: 30_000 })
    return ((await r.json()).data || []).filter((m: any) => !m.model_spec?.offline)
  }

  /** Генерация без записи на диск: base64 картинок (имена файлов задаёт вызывающий). */
  async generateRaw(params: Record<string, any>): Promise<{ images: string[]; format: string }> {
    const body = { format: 'png', return_binary: false, ...params }
    const data = await (await this.post('/image/generate', body)).json()
    const images: string[] = data.images || []
    if (!images.length) {
      const v = data.content_policy_violation_count
      throw new VeniceError('Модель не вернула изображений' + (v ? ` (отклонено политикой: ${v})` : ''))
    }
    return { images, format: body.format }
  }

  /** Правка по нескольким картинкам: первая — основа, остальные — что добавить или взять из них. */
  async multiEdit(model: string, imagesB64: string[], prompt: string, out: string, safe: boolean) {
    return this.imageResult(await this.post('/image/multi-edit', { modelId: model, images: imagesB64, prompt, safe_mode: safe, output_format: 'png' }), out)
  }

  /** Описание картинки моделью со зрением. */
  async describe(model: string, imageB64: string, mime: string, instruction: string): Promise<{ text: string; cost: number }> {
    const body = {
      model, temperature: 0.3,
      messages: [{ role: 'user', content: [{ type: 'text', text: instruction }, { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } }] }],
      venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true },
    }
    const data = await (await this.post('/chat/completions', body, 120_000)).json()
    return { text: String(data.choices?.[0]?.message?.content || '').trim(), cost: usd(data.cost) || 0 }
  }

  /** Короткий текстовый запрос без инструментов (улучшить промпт и т.п.). */
  async ask(model: string, system: string, user: string): Promise<{ text: string; cost: number }> {
    const body = { model, temperature: 0.7, messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      venice_parameters: { include_venice_system_prompt: false, strip_thinking_response: true } }
    const data = await (await this.post('/chat/completions', body, 60_000)).json()
    return { text: String(data.choices?.[0]?.message?.content || '').trim(), cost: usd(data.cost) || 0 }
  }
}

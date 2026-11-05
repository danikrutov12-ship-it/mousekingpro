// Все операции с картинками в одном месте: имена по описанию, метаданные в PNG, учёт в галерее и стоимость.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { imagePrice } from '@shared/pricing'
import type { GalleryItem, Model } from '@shared/types'
import * as gallery from './gallery'
import { freePath } from './store'
import { Venice } from './venice'

export interface ImgCtx { projectId?: string; chatId?: string; safe: boolean; dir: string }
export interface ImgResult { paths: string[]; cost: number | null; items: GalleryItem[]; fallback?: { from: string; to: string } }

// если модель отказала на стороне поставщика (422) — пробуем модели без цензуры, которые такие запросы обычно выполняют
const GEN_FALLBACK = ['lustify-v8', 'chroma', 'lustify-v7']
const EDIT_FALLBACK = ['qwen-edit-uncensored', 'seedream-v5-lite-edit', 'qwen-image-2-1-pro-edit']
const refused = (e: unknown) => /\(422:|HTTP 422/.test(String((e as Error)?.message || e))

async function withFallback(model: string, list: string[], run: (m: string) => Promise<ImgResult>): Promise<ImgResult> {
  try {
    return await run(model)
  } catch (e) {
    if (!refused(e)) throw e
    let last = e
    for (const alt of list.filter((m) => m !== model)) {
      try {
        return { ...(await run(alt)), fallback: { from: model, to: alt } }
      } catch (e2) {
        last = e2
        if (!refused(e2)) throw e2
      }
    }
    throw last
  }
}

const RU: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }

/** Имя файла по описанию: «кот-астронавт» → kot-astronavt. */
export function slug(text: string, max = 40): string {
  return text.toLowerCase().replace(/[а-яё]/g, (c) => RU[c] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'image'
}

const mimeOf = (p: string) => ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(p).toLowerCase()] || 'image/png')
const b64 = (p: string) => readFileSync(p).toString('base64')

// ---------------------------------------------------------------- метаданные PNG (tEXt): промпт и модель внутри файла

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function pngMeta(file: string, entries: Record<string, string>) {
  if (!/\.png$/i.test(file)) return
  try {
    const buf = readFileSync(file)
    if (buf.readUInt32BE(0) !== 0x89504e47) return
    const ihdrEnd = 8 + 8 + buf.readUInt32BE(8) + 4
    const chunks = Object.entries(entries).filter(([, v]) => v).map(([k, v]) => {
      // tEXt — только latin1, поэтому русский текст кладём в iTXt (UTF-8)
      const data = Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(v, 'utf-8')])
      const type = Buffer.from('iTXt', 'latin1')
      const len = Buffer.alloc(4)
      len.writeUInt32BE(data.length)
      const crc = Buffer.alloc(4)
      crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
      return Buffer.concat([len, type, data, crc])
    })
    writeFileSync(file, Buffer.concat([buf.subarray(0, ihdrEnd), ...chunks, buf.subarray(ihdrEnd)]))
  } catch {
    // метаданные — не главное, картинка уже сохранена
  }
}

/** В галерею и подписи — только просьба пользователя, без служебных инструкций модели («не меняй остальное», маска). */
const userPart = (prompt?: string) => (prompt || '').split('\n\nИзмени только')[0].replace(/^Второе изображение — служебная маска[\s\S]*?Задача: /, '').trim()

function register(path: string, meta: Partial<GalleryItem> & { source: GalleryItem['source'] }, ctx: ImgCtx): GalleryItem {
  meta = { ...meta, prompt: userPart(meta.prompt) }
  pngMeta(path, { Description: meta.prompt || '', Software: 'Mouse King Pro', Model: meta.model || '' })
  return gallery.add({ path, prompt: meta.prompt || '', model: meta.model, params: meta.params, source: meta.source, parent: meta.parent,
    projectId: ctx.projectId, chatId: ctx.chatId, cost: meta.cost ?? undefined, seed: meta.seed })
}

// ---------------------------------------------------------------- операции

let inpaintCache: any[] | null = null
async function inpaintPrice(api: Venice, model: string): Promise<number | null> {
  inpaintCache ||= await api.rawModels('inpaint').catch(() => [])
  return inpaintCache.find((m: any) => m.id === model)?.model_spec?.pricing?.inpaint?.usd ?? null
}

export async function generate(api: Venice, model: Model, params: Record<string, any>, ctx: ImgCtx): Promise<ImgResult> {
  return withFallback(model.id, GEN_FALLBACK, async (id) => {
    if (id === model.id) return generateOnce(api, model, params, ctx)
    const alt = (await api.listModels('image')).find((m) => m.id === id)
    if (!alt) throw new Error('модель недоступна')
    // у запасной модели свои параметры: пропорции и разрешение — по её ограничениям
    const c = alt.constraints || {}
    const p: Record<string, any> = { prompt: params.prompt, variants: params.variants || 1, negative_prompt: params.negative_prompt }
    if (c.aspectRatios?.length) p.aspect_ratio = c.aspectRatios.includes(params.aspect_ratio) ? params.aspect_ratio : c.defaultAspectRatio || c.aspectRatios[0]
    else Object.assign(p, { width: params.width || 1024, height: params.height || 1024 })
    return generateOnce(api, alt, p, ctx)
  })
}

async function generateOnce(api: Venice, model: Model, params: Record<string, any>, ctx: ImgCtx): Promise<ImgResult> {
  const p: Record<string, any> = { hide_watermark: true, ...params, model: model.id, safe_mode: ctx.safe }
  if (p.seed == null || p.seed === '') p.seed = Math.floor(Math.random() * 999_999_999)
  const { images, format } = await api.generateRaw(p)
  mkdirSync(ctx.dir, { recursive: true })
  const one = imagePrice(model, { ...params, variants: 1 })
  const items = images.map((img, i) => {
    const path = freePath(ctx.dir, `${slug(String(params.prompt || 'image'))}${images.length > 1 ? '-' + (i + 1) : ''}.${format}`)
    writeFileSync(path, Buffer.from(img, 'base64'))
    const { prompt, ...rest } = params
    return register(path, { source: 'generate', prompt: String(prompt || ''), model: model.id, params: rest, cost: one ?? undefined, seed: p.seed }, ctx)
  })
  return { paths: items.map((i) => i.path), cost: imagePrice(model, params), items }
}

const derived = (src: string, suffix: string, ctx: ImgCtx, ext = '.png') =>
  freePath(ctx.dir, `${basename(src).replace(/\.[^.]+$/, '').replace(/-(x[24]|bez-fona|pravka)(_\d+)?$/, '')}-${suffix}${ext}`)

export async function upscale(api: Venice, src: string, scale: 2 | 4, ctx: ImgCtx): Promise<ImgResult> {
  mkdirSync(ctx.dir, { recursive: true })
  const parent = gallery.ensure(src, ctx.projectId)
  const out = await api.upscale(b64(src), scale, derived(src, `x${scale}`, ctx))
  const cost = scale === 4 ? 0.08 : 0.02
  const it = register(out, { source: 'upscale', prompt: parent.prompt, model: 'upscaler', parent: parent.id, cost }, ctx)
  return { paths: [out], cost, items: [it] }
}

export async function background(api: Venice, src: string, ctx: ImgCtx): Promise<ImgResult> {
  mkdirSync(ctx.dir, { recursive: true })
  const parent = gallery.ensure(src, ctx.projectId)
  const out = await api.removeBackground(b64(src), derived(src, 'bez-fona', ctx))
  const it = register(out, { source: 'background', prompt: parent.prompt, parent: parent.id }, ctx)
  return { paths: [out], cost: null, items: [it] }
}

export async function edit(api: Venice, src: string, prompt: string, model: string, ctx: ImgCtx): Promise<ImgResult> {
  return withFallback(model, EDIT_FALLBACK, (m) => editOnce(api, src, prompt, m, ctx))
}

async function editOnce(api: Venice, src: string, prompt: string, model: string, ctx: ImgCtx): Promise<ImgResult> {
  mkdirSync(ctx.dir, { recursive: true })
  const parent = gallery.ensure(src, ctx.projectId)
  const out = await api.editImage(model, b64(src), prompt, derived(src, 'pravka', ctx), ctx.safe)
  const cost = await inpaintPrice(api, model)
  const it = register(out, { source: 'edit', prompt, model, parent: parent.id, cost: cost ?? undefined }, ctx)
  return { paths: [out], cost, items: [it] }
}

export async function combine(api: Venice, srcs: string[], prompt: string, model: string, ctx: ImgCtx): Promise<ImgResult> {
  return withFallback(model, EDIT_FALLBACK.filter((m) => m !== 'qwen-edit-uncensored' || srcs.length <= 3), (m) => combineOnce(api, srcs, prompt, m, ctx))
}

async function combineOnce(api: Venice, srcs: string[], prompt: string, model: string, ctx: ImgCtx): Promise<ImgResult> {
  mkdirSync(ctx.dir, { recursive: true })
  const parent = gallery.ensure(srcs[0], ctx.projectId)
  srcs.slice(1).forEach((s) => gallery.ensure(s, ctx.projectId))
  const out = await api.multiEdit(model, srcs.map(b64), prompt, freePath(ctx.dir, `${slug(prompt)}-kombo.png`), ctx.safe)
  const cost = await inpaintPrice(api, model)
  const it = register(out, { source: 'combine', prompt, model, parent: parent.id, cost: cost ?? undefined, params: { inputs: srcs } }, ctx)
  return { paths: [out], cost, items: [it] }
}

const DESCRIBE: Record<string, string> = {
  caption: 'Напиши живую подпись к этому фото для соцсетей на русском: 1–2 предложения и 3–5 уместных хэштегов.',
  alt: 'Опиши изображение для alt-текста на русском: одно точное предложение до 125 символов, без «на изображении».',
  ocr: 'Распознай и выпиши весь текст на изображении как есть, сохраняя строки. Если текста нет — так и скажи.',
  critique: 'Оцени это фото как фотограф: композиция, свет, резкость, цвет. Что получилось, что исправить (кадрирование, правка, пересъёмка). Кратко, по-русски, списком.',
  prompt: 'Опиши это изображение как промпт для генерации картинки на русском: объект, стиль, свет, ракурс, фон, детали. Одним абзацем.',
}

export async function describe(api: Venice, src: string, task: string, visionModel: string): Promise<{ text: string; cost: number }> {
  return api.describe(visionModel, b64(src), mimeOf(src), DESCRIBE[task] || task)
}

export const projectDir = (root: string) => join(root, 'generated')
export { dirname }

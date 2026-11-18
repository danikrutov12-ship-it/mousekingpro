// «Обучение LoRA»: проекты и наборы фото на диске. Папка проекта: <APP_DIR>/lora/<id>/{project.json, images/}.
// Фото копируются в проект — исходники пользователя не трогаем. Анализ (размер, резкость, dHash) — через nativeImage,
// без ffmpeg и нативных модулей, одинаково на Windows и Linux.
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { nativeImage } from 'electron'
import { stageFromPath, type LoraItem, type LoraKind, type LoraProject, type LoraSource, type LoraStage, type LoraSummary } from '@shared/lora'
import { APP_DIR } from './config'

const ROOT = join(APP_DIR, 'lora')
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp'])
export const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.m4v'])

const id = () => randomBytes(6).toString('hex')
const dirOf = (pid: string) => join(ROOT, pid.replace(/[^a-f0-9]/g, ''))
export const imagesDir = (pid: string) => join(dirOf(pid), 'images')
export const itemPath = (pid: string, it: LoraItem) => join(imagesDir(pid), it.file)

function save(p: LoraProject) {
  p.updated = Date.now()
  mkdirSync(dirOf(p.id), { recursive: true })
  writeFileSync(join(dirOf(p.id), 'project.json'), JSON.stringify(p, null, 1))
  return p
}

export function get(pid: string): LoraProject {
  const f = join(dirOf(pid), 'project.json')
  if (!existsSync(f)) throw new Error('Проект LoRA не найден')
  return JSON.parse(readFileSync(f, 'utf-8'))
}

export function list(): LoraSummary[] {
  if (!existsSync(ROOT)) return []
  const out: LoraSummary[] = []
  for (const d of readdirSync(ROOT)) {
    try {
      const p = get(d)
      const cover = p.items.find((i) => i.stage === 'face' && !i.excluded) || p.items.find((i) => !i.excluded)
      out.push({ id: p.id, name: p.name, kind: p.kind, count: p.items.filter((i) => !i.excluded).length,
        cover: cover ? itemPath(p.id, cover) : undefined, updated: p.updated })
    } catch {
      // битая папка — пропускаем
    }
  }
  return out.sort((a, b) => b.updated - a.updated)
}

export function create(name: string, kind: LoraKind, trigger: string): LoraProject {
  const now = Date.now()
  return save({ id: id(), name: name.trim() || 'Новый персонаж', kind, trigger: trigger.trim(), notes: '', created: now, updated: now, items: [] })
}

export function update(pid: string, patch: Partial<Pick<LoraProject, 'name' | 'kind' | 'trigger' | 'notes' | 'consent'>>) {
  return save({ ...get(pid), ...patch })
}

export function remove(pid: string) {
  rmSync(dirOf(pid), { recursive: true, force: true })
}

// ---------------------------------------------------------------- анализ кадра

/** Размер, резкость (дисперсия лапласиана на копии до 512 px) и dHash (9×8). */
function analyze(img: Electron.NativeImage): { w: number; h: number; sharp: number; hash: string } {
  const { width: w, height: h } = img.getSize()
  const k = Math.min(1, 512 / Math.max(w, h))
  const small = k < 1 ? img.resize({ width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), quality: 'good' }) : img
  const { width: sw, height: sh } = small.getSize()
  const px = small.toBitmap()
  const gray = new Float32Array(sw * sh)
  for (let i = 0; i < sw * sh; i++) gray[i] = 0.114 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.299 * px[i * 4 + 2]
  let sum = 0
  let sum2 = 0
  let n = 0
  for (let y = 1; y < sh - 1; y++) {
    for (let x = 1; x < sw - 1; x++) {
      const i = y * sw + x
      const l = gray[i - 1] + gray[i + 1] + gray[i - sw] + gray[i + sw] - 4 * gray[i]
      sum += l
      sum2 += l * l
      n++
    }
  }
  const sharp = n ? Math.round(sum2 / n - (sum / n) ** 2) : 0
  const tiny = img.resize({ width: 9, height: 8, quality: 'good' }).toBitmap()
  const g = (x: number, y: number) => {
    const i = (y * 9 + x) * 4
    return 0.114 * tiny[i] + 0.587 * tiny[i + 1] + 0.299 * tiny[i + 2]
  }
  let hash = ''
  for (let y = 0; y < 8; y++) {
    let byte = 0
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g(x, y) > g(x + 1, y) ? 1 : 0)
    hash += byte.toString(16).padStart(2, '0')
  }
  return { w, h, sharp, hash }
}

/** Положить картинку в проект: webp/bmp → PNG (AI-Toolkit плохо читает webp), остальное — копией. */
function store(pid: string, img: Electron.NativeImage, src: { path?: string; data?: Buffer; ext: string }): string {
  mkdirSync(imagesDir(pid), { recursive: true })
  const keep = src.ext === '.png' || src.ext === '.jpg' || src.ext === '.jpeg'
  const file = id() + (keep ? (src.ext === '.jpeg' ? '.jpg' : src.ext) : '.png')
  const dest = join(imagesDir(pid), file)
  if (!keep) writeFileSync(dest, img.toPNG())
  else if (src.path) copyFileSync(src.path, dest)
  else writeFileSync(dest, src.data!)
  return file
}

function addImage(p: LoraProject, img: Electron.NativeImage, src: { path?: string; data?: Buffer; ext: string },
  stage: LoraStage, source: LoraSource, origin?: string): LoraItem | null {
  if (img.isEmpty()) return null
  const a = analyze(img)
  const it: LoraItem = { id: id(), file: store(p.id, img, src), source, stage, caption: '', ...a, origin, added: Date.now() }
  p.items.push(it)
  return it
}

/** Добавить файлы с диска. */
export function addFiles(pid: string, paths: string[], stage: LoraStage, source: LoraSource = 'photo') {
  const p = get(pid)
  let added = 0
  const skipped: string[] = []
  for (const path of paths) {
    const ext = extname(path).toLowerCase()
    if (!IMAGE_EXT.has(ext)) {
      skipped.push(basename(path))
      continue
    }
    if (addImage(p, nativeImage.createFromPath(path), { path, ext }, stage, source, path)) added++
    else skipped.push(basename(path))
  }
  save(p)
  return { added, skipped }
}

/** Добавить картинки из памяти (кадры из видео, сгенерированные). */
export function addData(pid: string, files: { data: Uint8Array; origin?: string }[], stage: LoraStage, source: LoraSource) {
  const p = get(pid)
  let added = 0
  for (const f of files) {
    const data = Buffer.from(f.data)
    if (addImage(p, nativeImage.createFromBuffer(data), { data, ext: '.png' }, stage, source, f.origin)) added++
  }
  save(p)
  return { added }
}

/** Импорт готовой папки: картинки — по этапам из названий подпапок, видео — списком (кадры отбирает интерфейс),
 *  текстовые заметки — в заметки проекта. */
export function importFolder(pid: string, dir: string) {
  const p = get(pid)
  const videos: string[] = []
  const notes: string[] = []
  let added = 0
  const walk = (d: string, depth: number) => {
    if (depth > 6) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else {
        const ext = extname(e.name).toLowerCase()
        const rel = relative(dir, full)
        if (IMAGE_EXT.has(ext)) {
          if (addImage(p, nativeImage.createFromPath(full), { path: full, ext }, stageFromPath(rel), 'import', full)) added++
        } else if (VIDEO_EXT.has(ext)) videos.push(full)
        else if (ext === '.txt' && depth === 0 && statSync(full).size < 50_000) notes.push(`— ${e.name} —\n` + readFileSync(full, 'utf-8').trim())
      }
    }
  }
  walk(dir, 0)
  if (notes.length) p.notes = [p.notes.trim(), ...notes].filter(Boolean).join('\n\n')
  save(p)
  return { added, videos, notes: notes.length }
}

/** Изменить фото: этап, исключение, подпись. */
export function updateItems(pid: string, ids: string[], patch: Partial<Pick<LoraItem, 'stage' | 'excluded' | 'caption'>>) {
  const p = get(pid)
  for (const it of p.items) if (ids.includes(it.id)) Object.assign(it, patch)
  return save(p)
}

export function removeItems(pid: string, ids: string[]) {
  const p = get(pid)
  for (const it of p.items.filter((i) => ids.includes(i.id))) rmSync(itemPath(pid, it), { force: true })
  p.items = p.items.filter((i) => !ids.includes(i.id))
  return save(p)
}

export const folderOf = (pid: string) => dirOf(pid)

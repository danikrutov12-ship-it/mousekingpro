// Реестр картинок для галереи: откуда взялась, какой промпт и модель, от какой версии сделана.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GalleryItem } from '@shared/types'
import { APP_DIR } from './config'
import * as store from './store'

const FILE = join(APP_DIR, 'gallery.json')
let cache: { imported: boolean; deduped?: boolean; items: GalleryItem[] } | null = null

export const hashOf = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Хеш записи (считается один раз и сохраняется). */
function hashed(it: GalleryItem): string {
  if (!it.hash && existsSync(it.path)) it.hash = hashOf(it.path)
  return it.hash || ''
}

function load() {
  if (cache) return cache
  try {
    cache = JSON.parse(readFileSync(FILE, 'utf-8'))
  } catch {
    cache = { imported: false, items: [] }
  }
  return cache!
}

function persist() {
  mkdirSync(APP_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(load()), 'utf-8')
}

export function add(item: Omit<GalleryItem, 'id' | 'created'> & { created?: number }): GalleryItem {
  const existing = load().items.find((i) => i.path === item.path)
  if (existing) return existing
  const full: GalleryItem = { id: randomBytes(5).toString('hex'), created: Date.now() / 1000, ...item }
  load().items.push(full)
  persist()
  return full
}

export const byPath = (path: string) => load().items.find((i) => i.path === path || i.aliases?.includes(path))
export const byId = (id: string) => load().items.find((i) => i.id === id)

export function update(id: string, patch: Partial<GalleryItem>) {
  const it = byId(id)
  if (it) Object.assign(it, patch)
  persist()
}

export function remove(ids: string[]) {
  const set = new Set(ids)
  load().items = load().items.filter((i) => !set.has(i.id))
  persist()
}

/** Исходная картинка без записи в реестре (своё фото) — регистрируем как «своё». */
export function ensure(path: string, projectId?: string): GalleryItem {
  const known = byPath(path)
  if (known) return known
  // то же фото, прикреплённое ещё раз (копия в uploads под другим именем), — это одна запись, а не новая
  const hash = hashOf(path)
  const same = load().items.find((i) => hashed(i) === hash)
  if (same) {
    same.aliases = [...(same.aliases || []), path]
    persist()
    return same
  }
  return add({ path, source: 'own', prompt: '', projectId, hash })
}

/** Один раз: склеиваем уже накопившиеся одинаковые «свои фото». Файлы не трогаем — на них ссылаются чаты. */
function dedupeOwn() {
  const c = load()
  const keep = new Map<string, GalleryItem>()
  const gone = new Map<string, GalleryItem>() // id дубля → оставленная запись
  for (const it of [...c.items].sort((a, b) => a.created - b.created)) {
    if (it.source !== 'own' || !existsSync(it.path)) continue
    const first = keep.get(hashed(it))
    if (!first) keep.set(it.hash!, it)
    else {
      first.aliases = [...new Set([...(first.aliases || []), it.path, ...(it.aliases || [])])]
      first.favorite ||= it.favorite
      gone.set(it.id, first)
    }
  }
  for (const it of c.items) if (it.parent && gone.has(it.parent)) it.parent = gone.get(it.parent)!.id
  c.items = c.items.filter((i) => !gone.has(i.id))
  c.deduped = true
  persist()
}

export function list(): GalleryItem[] {
  if (!load().imported) importFromChats()
  if (!load().deduped) dedupeOwn()
  return load().items.filter((i) => existsSync(i.path)).sort((a, b) => b.created - a.created)
}

const SOURCE_BY_LABEL: [RegExp, GalleryItem['source']][] = [
  [/^Увеличение/, 'upscale'], [/^Удаление фона/, 'background'], [/^Правка картинки/, 'edit'], [/^Объединение/, 'combine'],
]

/** Первый запуск галереи: собираем картинки из всех существующих чатов. */
function importFromChats() {
  for (const p of store.projects()) {
    for (const c of store.chats(p.id)) {
      const chat = store.loadChat(p.id, c.id)
      if (!chat) continue
      let user: (typeof chat.messages)[number] | undefined
      for (const m of chat.messages) {
        if (m.role === 'user' && !m._hidden) user = m
        for (const path of m._media || []) {
          if (!/\.(png|jpe?g|webp)$/i.test(path) || !existsSync(path) || byPath(path) || /[\\/]browser[\\/]/.test(path)) continue
          const label = user?._mode || ''
          load().items.push({
            id: randomBytes(5).toString('hex'), path, prompt: user?._display || '', model: user?._gen?.model,
            params: user?._gen?.params, source: SOURCE_BY_LABEL.find(([rx]) => rx.test(label))?.[1] || 'generate',
            projectId: p.id, chatId: chat.id, created: statSync(path).mtimeMs / 1000,
          })
        }
      }
    }
  }
  load().imported = true
  persist()
}

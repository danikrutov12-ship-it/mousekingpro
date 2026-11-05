// Вложения: копирование в папку проекта, распаковка архивов, текст для модели.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { hashOf } from './gallery'
import { basename, extname, join, relative, sep } from 'node:path'
import type { Attachment } from '@shared/types'
import { freePath } from './store'
import { defaultExtractDir, extract, humanSize, isArchive, treePreview } from './tools'

const MAX_INLINE_TEXT = 30_000 // больше — агент дочитает файл сам по частям
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
export const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.mkv'])
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
}

const inside = (root: string, p: string) => p.startsWith(root + sep)

export function dataUrl(path: string): string {
  const mime = MIME[extname(path).toLowerCase()] || 'application/octet-stream'
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`
}

/** Файл с тем же содержимым в папке (сравниваем размер, потом sha256). */
function sameFile(dir: string, src: string): string | null {
  const size = statSync(src).size
  let hash = ''
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (!st.isFile() || st.size !== size) continue
      hash ||= hashOf(src)
      if (hashOf(p) === hash) return p
    } catch {
      // файл исчез — пропускаем
    }
  }
  return null
}

export async function prepare(srcPath: string, rootPath: string): Promise<Attachment> {
  mkdirSync(rootPath, { recursive: true })
  const root = realpathSync(rootPath)
  const src = realpathSync(srcPath)
  if (statSync(src).isDirectory()) return { kind: 'folder', name: basename(src) + '/', path: src }
  let dest = src
  if (!inside(root, src)) {
    const uploads = join(root, 'uploads')
    mkdirSync(uploads, { recursive: true })
    // этот файл уже лежит в uploads (прикрепляли раньше) — берём его, а не делаем ещё одну копию
    dest = sameFile(uploads, src) || freePath(uploads, basename(src))
    if (dest !== src && !existsSync(dest)) copyFileSync(src, dest)
  }
  const att: Attachment = { kind: 'binary', name: basename(src), path: dest, rel: relative(root, dest), size: statSync(dest).size }
  const ext = extname(dest).toLowerCase()
  if (isArchive(dest)) {
    const target = defaultExtractDir(dest)
    const count = await extract(dest, target)
    Object.assign(att, { kind: 'archive', extracted: relative(root, target), count, tree: treePreview(target, 80) })
  } else if (IMAGE_EXT.has(ext)) att.kind = 'image'
  else if (VIDEO_EXT.has(ext)) att.kind = 'video'
  else {
    const data = readFileSync(dest).subarray(0, MAX_INLINE_TEXT + 1)
    if (!data.subarray(0, 8192).includes(0)) {
      att.kind = 'text'
      att.truncated = data.length > MAX_INLINE_TEXT
      att.text = data.subarray(0, MAX_INLINE_TEXT).toString('utf-8')
    }
  }
  return att
}

export function notes(list: Attachment[]): string {
  return list.map((a) => {
    switch (a.kind) {
      case 'text':
        return `<file path="${a.rel}">\n${a.text}${a.truncated ? '\n[файл обрезан — дочитай через read_file]' : ''}\n</file>`
      case 'archive':
        return `[Архив ${a.name} сохранён как ${a.rel} и распакован в ${a.extracted}/ (${a.count} файлов):\n${a.tree}]`
      case 'folder':
        return `[Пользователь указал папку: ${a.path}]`
      case 'image':
        return `[Прикреплено изображение: ${a.rel}]`
      default:
        return `[Прикреплён файл: ${a.rel} (${humanSize(a.size || 0)})]`
    }
  }).join('\n\n')
}

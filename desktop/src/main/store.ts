// Проекты и чаты в JSON-файлах (формат как у версии на Python).
import { randomBytes } from 'node:crypto'
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { Chat, ChatSummary, KnowledgeFile, Project, SearchHit } from '@shared/types'
import { APP_DIR } from './config'

export const DEFAULT_PROJECT_NAME = 'Общий'
export const KNOWLEDGE_DIR = 'knowledge'
// папка проектов: прежняя ~/VeniceAgent, если уже есть, иначе ~/MouseKingPro (на Windows — C:\\Users\\<имя>\\MouseKingPro)
export const PROJECTS_ROOT = existsSync(join(homedir(), 'VeniceAgent')) ? join(homedir(), 'VeniceAgent') : join(homedir(), 'MouseKingPro')

const BASE = join(APP_DIR, 'projects')
const now = () => Date.now() / 1000
const newId = () => randomBytes(6).toString('hex')

export function expand(p: string): string {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

function safeName(name: string): string {
  return name.replace(/[/\\:*?"<>|\x00-\x1f]/g, ' ').trim().slice(0, 80) || 'Проект'
}

/** Свободное имя файла в папке: name.txt, name_1.txt, … */
export function freePath(dir: string, name: string): string {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  let dest = join(dir, name)
  for (let n = 1; existsSync(dest); n++) dest = join(dir, `${stem}_${n}${ext}`)
  return dest
}

export function projects(): Project[] {
  mkdirSync(BASE, { recursive: true })
  const out: Project[] = []
  for (const d of readdirSync(BASE)) {
    const p = readJson<Project>(join(BASE, d, 'project.json'))
    if (p) out.push(p)
  }
  return out.sort((a, b) => (a.created || 0) - (b.created || 0))
}

export function project(id: string): Project | null {
  return readJson<Project>(join(BASE, id, 'project.json'))
}

export function saveProject(p: Project): void {
  const dir = join(BASE, p.id)
  mkdirSync(join(dir, 'chats'), { recursive: true })
  const { chat_count: _c, updated: _u, ...clean } = p
  writeFileSync(join(dir, 'project.json'), JSON.stringify(clean, null, 2), 'utf-8')
}

export function createProject(name: string, description = '', folder?: string): Project {
  const dir = folder || freePath(PROJECTS_ROOT, safeName(name))
  const p: Project = { id: newId(), name, folder: dir, description, instructions: '', created: now() }
  mkdirSync(expand(dir), { recursive: true })
  saveProject(p)
  return p
}

export function defaultProject(): Project {
  const all = projects()
  const marked = all.find((p) => p.default)
  if (marked) return marked
  const legacy = all.find((p) => p.name === DEFAULT_PROJECT_NAME)
  if (legacy) {
    legacy.default = true
    saveProject(legacy)
    return legacy
  }
  const p = createProject(DEFAULT_PROJECT_NAME, '', join(PROJECTS_ROOT, DEFAULT_PROJECT_NAME))
  p.default = true
  saveProject(p)
  return p
}

export function userProjects(): Project[] {
  return projects()
    .filter((p) => !p.default)
    .map((p) => {
      const list = chats(p.id)
      return { ...p, chat_count: list.length, updated: Math.max(p.created || 0, ...list.map((c) => c.updated)) }
    })
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
}

export function deleteProject(id: string): void {
  rmSync(join(BASE, id), { recursive: true, force: true })
}

// ---------------------------------------------------------------- файлы проекта

export function knowledgeDir(p: Project): string {
  return join(expand(p.folder), KNOWLEDGE_DIR)
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const full = join(dir, name)
    try {
      if (statSync(full).isDirectory()) walk(full, out)
      else out.push(full)
    } catch {
      // файл исчез или нет доступа
    }
  }
  return out
}

export function knowledgeFiles(p: Project): KnowledgeFile[] {
  return walk(knowledgeDir(p))
    .map((f) => ({ name: basename(f), path: f, size: statSync(f).size }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function addKnowledge(p: Project, paths: string[]): void {
  const dir = knowledgeDir(p)
  mkdirSync(dir, { recursive: true })
  for (const src of paths) {
    if (statSync(src).isFile()) copyFileSync(src, freePath(dir, basename(src)))
  }
}

export function removeKnowledge(p: Project, path: string): void {
  const dir = resolve(knowledgeDir(p)) + sep
  if (resolve(path).startsWith(dir)) unlinkSync(path)
}

// ---------------------------------------------------------------- чаты

export function chats(projectId: string): ChatSummary[] {
  const dir = join(BASE, projectId, 'chats')
  if (!existsSync(dir)) return []
  const out: ChatSummary[] = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const c = readJson<Chat>(join(dir, f))
    if (c) out.push({ id: c.id, title: c.title || '', updated: c.updated || 0, project_id: projectId })
  }
  return out.sort((a, b) => b.updated - a.updated)
}

export function allChats(limit = 300): ChatSummary[] {
  const out: ChatSummary[] = []
  for (const p of projects()) {
    for (const c of chats(p.id)) out.push({ ...c, project_name: p.default ? null : p.name })
  }
  return out.sort((a, b) => b.updated - a.updated).slice(0, limit)
}

export function newChat(): Chat {
  const t = now()
  return { id: newId(), title: 'Новый чат', created: t, updated: t, messages: [] }
}

export function loadChat(projectId: string, chatId: string): Chat | null {
  return readJson<Chat>(join(BASE, projectId, 'chats', `${chatId}.json`))
}

export function saveChat(projectId: string, chat: Chat): void {
  chat.updated = now()
  const path = join(BASE, projectId, 'chats', `${chat.id}.json`)
  mkdirSync(join(BASE, projectId, 'chats'), { recursive: true })
  const tmp = path.replace(/\.json$/, '.tmp')
  writeFileSync(tmp, JSON.stringify(chat), 'utf-8')
  renameSync(tmp, path)
}

export function deleteChat(projectId: string, chatId: string): void {
  rmSync(join(BASE, projectId, 'chats', `${chatId}.json`), { force: true })
}

// ---------------------------------------------------------------- поиск

const textOf = (m: Chat['messages'][number]): string => {
  if (m._display != null) return m._display
  if (Array.isArray(m.content)) return m.content.map((p) => (p.type === 'text' ? p.text : '')).join(' ')
  return m.content || ''
}

/** Поиск по тексту всех чатов: заголовки, вопросы и ответы (без вывода инструментов). */
export function search(query: string, limit = 40): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1)
  if (!words.length) return []
  const hits: SearchHit[] = []
  for (const p of projects()) {
    const dir = join(BASE, p.id, 'chats')
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue
      const c = readJson<Chat>(join(dir, f))
      if (!c) continue
      const texts = [c.title, ...c.messages.filter((m) => (m.role === 'user' && !m._hidden) || (m.role === 'assistant' && !m._error)).map(textOf)]
      const all = texts.join('\n').toLowerCase()
      if (!words.every((w) => all.includes(w))) continue
      const src = texts.find((t) => t.toLowerCase().includes(words[0])) || c.title
      const at = Math.max(0, src.toLowerCase().indexOf(words[0]) - 50)
      const snippet = (at > 0 ? '…' : '') + src.slice(at, at + 140).replace(/\s+/g, ' ') + (src.length > at + 140 ? '…' : '')
      hits.push({ project_id: p.id, chat_id: c.id, title: c.title, snippet, updated: c.updated })
    }
  }
  return hits.sort((a, b) => b.updated - a.updated).slice(0, limit)
}

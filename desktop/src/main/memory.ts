// Память между чатами: короткие факты о пользователе и проектах. Агент только предлагает — сохраняет пользователь.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryItem } from '@shared/types'
import { APP_DIR } from './config'

const FILE = join(APP_DIR, 'memory.json')

export function list(): MemoryItem[] {
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8'))
  } catch {
    return []
  }
}

function save(items: MemoryItem[]) {
  mkdirSync(APP_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(items, null, 2), 'utf-8')
}

export function add(text: string, projectId?: string): MemoryItem {
  const item: MemoryItem = { id: randomBytes(4).toString('hex'), text: text.trim().slice(0, 500), created: Date.now() / 1000, projectId }
  save([...list(), item])
  return item
}

export function update(id: string, text: string) {
  save(list().map((m) => (m.id === id ? { ...m, text: text.trim().slice(0, 500) } : m)))
}

export function remove(id: string) {
  save(list().filter((m) => m.id !== id))
}

/** Для системного промпта: общие факты и факты этого проекта. */
export function forPrompt(projectId: string): string {
  const items = list().filter((m) => !m.projectId || m.projectId === projectId)
  if (!items.length) return ''
  return '\n\n## What you remember about the user (saved by the user; use when relevant, do not recite)\n' +
    items.map((m) => `- ${m.text}`).join('\n')
}

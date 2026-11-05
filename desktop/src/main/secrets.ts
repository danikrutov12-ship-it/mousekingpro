// Секреты (пароли серверов, токены): шифруются ключом системного хранилища и никогда не показываются модели.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { Secret } from '@shared/types'
import { APP_DIR } from './config'

const FILE = join(APP_DIR, 'secrets.json')
let cache: Record<string, string> | null = null

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$|^(server|app):[a-z0-9_]+$/

function load(): Record<string, string> {
  if (cache) return cache
  cache = {}
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf-8')) as Record<string, string>
    for (const [k, v] of Object.entries(raw)) {
      try {
        cache[k] = safeStorage.decryptString(Buffer.from(v, 'base64'))
      } catch {
        // ключ системного хранилища сменился — секрет не расшифровать
      }
    }
  } catch {
    // файла ещё нет
  }
  return cache
}

function persist() {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(load())) out[k] = safeStorage.encryptString(v).toString('base64')
  mkdirSync(APP_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(out, null, 2), 'utf-8')
  chmodSync(FILE, 0o600)
}

export const available = () => safeStorage.isEncryptionAvailable()

export function list(): Secret[] {
  return Object.entries(load())
      .filter(([k]) => !k.includes(':'))
    .map(([name, v]) => ({ name, preview: v.length > 6 ? `${v.slice(0, 2)}•••${v.slice(-2)}` : '•••' }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function set(name: string, value: string) {
  if (!NAME_RE.test(name)) throw new Error('Имя секрета: латиница, цифры и _, например DEPLOY_TOKEN')
  load()[name] = value
  persist()
}

export function remove(name: string) {
  delete load()[name]
  persist()
}

export const get = (name: string): string | undefined => load()[name]

/** Секреты как переменные окружения для команд (без паролей серверов). */
export function env(): Record<string, string> {
  return Object.fromEntries(Object.entries(load()).filter(([k]) => !k.includes(':')))
}

/** Прячем значения секретов в любом тексте, который увидит модель или интерфейс. */
export function mask(text: string): string {
  let out = text
  for (const v of Object.values(load())) if (v.length >= 4) out = out.split(v).join('••••••')
  return out
}

/** Имена секретов для системного промпта. */
export const names = () => list().map((s) => s.name)

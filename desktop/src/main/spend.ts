// Учёт расходов по дням (для дневного лимита).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Chat } from '@shared/types'
import { APP_DIR } from './config'

const FILE = join(APP_DIR, 'spend.json')
const day = () => new Date().toLocaleDateString('sv-SE') // ГГГГ-ММ-ДД по местному времени

function load(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8'))
  } catch {
    return {}
  }
}

export function add(usd: number) {
  if (!usd) return
  const data = load()
  data[day()] = (data[day()] || 0) + usd
  mkdirSync(APP_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(data), 'utf-8')
}

export const today = () => load()[day()] || 0

export const chatTotal = (chat: Chat) => chat.messages.reduce((n, m) => n + (m._cost || 0), 0)

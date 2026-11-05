// Настройки и пути к данным. Те же файлы, что у версии на Python: ~/.local/share/venice-agent.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Settings } from '@shared/types'

// Linux: ~/.local/share/venice-agent (папка осталась от прежнего названия — так сохраняются чаты и настройки);
// Windows: %APPDATA%\\Mouse King Pro
export const APP_DIR = process.platform === 'win32'
  ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Mouse King Pro')
  : join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'venice-agent')
const SETTINGS_FILE = join(APP_DIR, 'settings.json')

export const DEFAULTS: Settings = {
  api_key: '',
  base_url: 'https://api.venice.ai/api/v1',
  text_model: 'deepseek-v4-1-flash-1017-uncensored',
  image_model: '',
  video_model: '',
  temperature: 0.7,
  max_steps: 40,
  tool_mode: 'auto',
  venice_system_prompt: false,
  venice_web_search: 'off',
  safe_mode: false,
  theme: 'system',
  sidebar: true,
  context_budget: 200_000,
  auto_safe_commands: true,
  allowed_commands: [],
  limit_chat_usd: 0,
  limit_day_usd: 0,
  servers: [],
  tts_model: 'tts-xai-v1',
  tts_voice: '',
  stt_model: 'openai/whisper-large-v3',
  memory_enabled: true,
  mcp_servers: [],
  git_auto: true,
  telegram: { enabled: false },
  schedules: [],
  fast_model: 'deepseek-v4-flash',
  embedding_model: 'text-embedding-qwen3-0-6b',
  notifications: true,
  browser_auto: false,
  autostart: false,
  prompts: [],
  vision_model: '',
  ref_sets: [],
  edit_model: 'qwen-edit-uncensored',
}

let cache: Settings | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  let saved: Record<string, any> = {}
  try {
    saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
  } catch {
    // первый запуск или повреждённый файл — берём значения по умолчанию
  }
  cache = { ...DEFAULTS, ...saved } as Settings
  if (!cache.api_key) cache.api_key = process.env.VENICE_API_KEY || ''
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  // читаем файл заново, чтобы не потерять ключи, которые знает только версия на Python
  let saved: Record<string, any> = {}
  try {
    saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf-8'))
  } catch {
    saved = {}
  }
  cache = { ...loadSettings(), ...patch }
  mkdirSync(APP_DIR, { recursive: true })
  writeFileSync(SETTINGS_FILE, JSON.stringify({ ...saved, ...cache }, null, 2), 'utf-8')
  chmodSync(SETTINGS_FILE, 0o600) // там лежит API-ключ
  return cache
}

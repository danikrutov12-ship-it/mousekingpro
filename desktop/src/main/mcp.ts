// Подключения MCP: внешние инструменты (GitHub, базы данных, Docker…) по стандарту Model Context Protocol.
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServer, McpStatus } from '@shared/types'
import { COMMAND_ENV } from './jobs'
import * as secrets from './secrets'
import { isWin } from './platform'

interface Conn { client: Client; tools: { name: string; description?: string; inputSchema: any }[]; key: string }

const conns = new Map<string, Conn>()
const errors = new Map<string, string>()
let onChange: () => void = () => {}
export const setMcpListener = (fn: () => void) => (onChange = fn)

const keyOf = (s: McpServer) => JSON.stringify([s.command, s.args, s.env])
/** Имя для модели: латиница, цифры, _ — как требуют API инструментов. */
const RU: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' }
export const safeName = (s: string) => s.toLowerCase().replace(/[а-яё]/g, (c) => RU[c] ?? '').replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'srv'

/** Разбор строки запуска: «npx -y @pkg/server /path» → команда и аргументы (с поддержкой кавычек). */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

async function connect(s: McpServer): Promise<Conn> {
  const existing = conns.get(s.id)
  if (existing && existing.key === keyOf(s)) return existing
  if (existing) await existing.client.close().catch(() => {})
  let [command, ...args] = s.args?.length ? [s.command, ...s.args] : splitCommand(s.command)
  // Windows: npx, uvx и т. п. — это .cmd-скрипты, их запускает cmd
  if (isWin && !/\.exe$/i.test(command)) [command, args] = ['cmd.exe', ['/d', '/s', '/c', command, ...args]]
  // в переменных подключения можно ссылаться на секреты: GITHUB_TOKEN=$GITHUB_TOKEN
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(s.env || {})) env[k] = v.replace(/^\$(\w+)$/, (_, n) => secrets.get(n) ?? '')
  const transport = new StdioClientTransport({ command, args, env: { ...(COMMAND_ENV as Record<string, string>), ...env }, stderr: 'pipe' })
  const client = new Client({ name: 'mouse-king-pro', version: '2.0.0' })
  await Promise.race([
    client.connect(transport),
    new Promise((_, fail) => setTimeout(() => fail(new Error('сервер не ответил за 60 с')), 60_000)),
  ])
  const { tools } = await client.listTools()
  const conn = { client, tools, key: keyOf(s) }
  conns.set(s.id, conn)
  errors.delete(s.id)
  onChange()
  return conn
}

/** Все включённые подключения: схемы инструментов для модели (mcp__сервер__инструмент). */
export async function toolSchemas(servers: McpServer[]): Promise<{ schemas: any[]; route: Map<string, [McpServer, string]> }> {
  const schemas: any[] = []
  const route = new Map<string, [McpServer, string]>()
  await Promise.all(servers.filter((s) => s.enabled).map(async (s) => {
    try {
      const c = await connect(s)
      for (const t of c.tools) {
        const name = `mcp__${safeName(s.name)}__${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64)
        route.set(name, [s, t.name])
        schemas.push({ type: 'function', function: { name, description: `[${s.name}] ${t.description || t.name}`.slice(0, 1000), parameters: t.inputSchema || { type: 'object', properties: {} } } })
      }
    } catch (e) {
      errors.set(s.id, (e as Error).message)
      onChange()
    }
  }))
  return { schemas, route }
}

export async function call(s: McpServer, tool: string, args: Record<string, unknown>): Promise<string> {
  const c = await connect(s)
  const res: any = await c.client.callTool({ name: tool, arguments: args })
  const parts = (res.content || []).map((p: any) => (p.type === 'text' ? p.text : p.type === 'resource' ? p.resource?.text || p.resource?.uri : `[${p.type}]`))
  return secrets.mask((res.isError ? 'Ошибка: ' : '') + (parts.join('\n') || '(пустой ответ)'))
}

export function status(servers: McpServer[]): McpStatus[] {
  return servers.map((s) => ({ id: s.id, connected: conns.has(s.id), tools: conns.get(s.id)?.tools.map((t) => t.name) || [], error: errors.get(s.id) }))
}

export async function test(s: McpServer): Promise<McpStatus> {
  conns.delete(s.id)
  try {
    const c = await connect(s)
    return { id: s.id, connected: true, tools: c.tools.map((t) => t.name) }
  } catch (e) {
    errors.set(s.id, (e as Error).message)
    return { id: s.id, connected: false, tools: [], error: (e as Error).message }
  }
}

export async function closeAll() {
  await Promise.all([...conns.values()].map((c) => c.client.close().catch(() => {})))
  conns.clear()
}

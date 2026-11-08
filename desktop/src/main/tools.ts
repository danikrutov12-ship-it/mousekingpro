// Инструменты агента: файлы, папки, команды, архивы, веб.
import { spawn, spawnSync } from 'node:child_process'
import {
  copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createTwoFilesPatch } from 'diff'
import { parse, type HTMLElement, type Node as HNode } from 'node-html-parser'
import yauzl from 'yauzl'
import type { FileChange, Server } from '@shared/types'
import { APP_DIR } from './config'
import * as browser from './browser'
import * as firefox from './firefox'
import { COMMAND_ENV, getJob, jobLog, startJob, stopJob } from './jobs'
import { isWin, killTree, SHELL_NAME, shellArgv, spawnOpts, which } from './platform'

export const MAX_OUTPUT = 30_000
const MAX_LIST = 500
const MAX_MATCHES = 200
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea', '.tox', '.cache',
])
export const ARCHIVE_SUFFIXES = ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tar.xz', '.txz', '.tar.zst', '.rar', '.7z']
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'
export const DENIED = 'Пользователь отклонил это действие. Не повторяй его в том же виде; спроси пользователя, как поступить.'

export class ToolError extends Error {}

export interface ToolContext {
  root: string
  chatId: string
  /** команда только для чтения или из списка разрешённых — выполняется без вопроса */
  safe(command: string): boolean
  servers: Server[]
  /** секреты как переменные окружения для команд */
  env: Record<string, string>
  /** прячет значения секретов в тексте */
  mask(text: string): string
  /** текущий план задачи (инструмент update_plan) */
  plan?(steps: PlanStep[]): void
  /** картинка в ленте у этого шага */
  media?(path: string): void
  /** показать модели картинку (скриншот браузера) на следующем шаге */
  attachImage?(path: string): void
  /** поиск по смыслу в коде проекта */
  semantic?(query: string, k: number): Promise<string>
  /** поручить подзадачу помощнику */
  delegate?(task: string, label: string): Promise<string>
  /** клики и ввод в браузере без вопроса */
  browserAuto?: boolean
  /** счётчики вызовов за один ответ агента (общий объект для всех шагов) */
  counts?: Record<string, number>
  /** работа с картинками через Venice (генерация, правка, увеличение…) */
  images?: ImageHooks
  /** живой вывод текущего инструмента (команды) */
  output?(chunk: string): void
  /** агент изменил файл — запоминаем, чтобы можно было откатить */
  changed?(change: FileChange): void
  /** danger — почему действие опасно; такие запросы не разрешаются автоматически «для всего чата» */
  approve(title: string, details: string, danger?: string): Promise<boolean>
  search?: (query: string, limit: number) => Promise<string>
  signal: AbortSignal
}

const resolvePath = (ctx: ToolContext, p?: string) => {
  let path = p || '.'
  if (path.startsWith('~')) path = join(homedir(), path.slice(1))
  return resolve(isAbsolute(path) ? path : join(ctx.root, path))
}
const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep)
const rel = (ctx: ToolContext, p: string) => (inside(ctx.root, p) ? relative(ctx.root, p) || '.' : p)
const outsideNote = (ctx: ToolContext, p: string) => (inside(ctx.root, p) ? '' : '  ⚠ ВНЕ ПАПКИ ПРОЕКТА')

export function truncate(text: string, limit = MAX_OUTPUT): string {
  return text.length <= limit ? text : text.slice(0, limit) + `\n... [обрезано, всего ${text.length} символов]`
}

export function humanSize(n: number): string {
  for (const unit of ['Б', 'КБ', 'МБ', 'ГБ']) {
    if (n < 1024) return unit === 'Б' ? `${n.toFixed(0)} ${unit}` : `${n.toFixed(1)} ${unit}`
    n /= 1024
  }
  return `${n.toFixed(1)} ТБ`
}

export const isArchive = (p: string) => ARCHIVE_SUFFIXES.some((s) => p.toLowerCase().endsWith(s))

const makeDiff = (oldText: string, newText: string, name: string) => {
  const patch = createTwoFilesPatch(`a/${name}`, `b/${name}`, oldText, newText, '', '', { context: 3 })
  const body = patch.split('\n').slice(2).join('\n') // без строки «Index» и разделителя
  return body.includes('@@') ? body : '(без изменений)'
}

const isBinary = (buf: Buffer) => buf.subarray(0, 8192).includes(0)

function* iterFiles(base: string): Generator<string> {
  let st
  try {
    st = statSync(base)
  } catch {
    return
  }
  if (st.isFile()) {
    yield base
    return
  }
  let entries: string[] = []
  try {
    entries = readdirSync(base).sort()
  } catch {
    return
  }
  const dirs: string[] = []
  for (const name of entries) {
    const full = join(base, name)
    let s
    try {
      s = statSync(full)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (!SKIP_DIRS.has(name)) dirs.push(full)
    } else yield full
  }
  for (const d of dirs) yield* iterFiles(d)
}

export function treePreview(base: string, limit = 100): string {
  const lines: string[] = []
  for (const f of iterFiles(base)) {
    lines.push(relative(base, f))
    if (lines.length >= limit) {
      lines.push('...')
      break
    }
  }
  return lines.join('\n')
}

const globToRegex = (glob: string) =>
  new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')

// ---------------------------------------------------------------- файлы

function listDir(ctx: ToolContext, a: { path?: string; depth?: number }) {
  const base = resolvePath(ctx, a.path)
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new ToolError(`Это не папка: ${base}`)
  const depth = Math.max(1, Math.min(Number(a.depth ?? 2), 5))
  const lines: string[] = []
  const walk = (d: string, level: number) => {
    let entries: string[]
    try {
      entries = readdirSync(d)
    } catch {
      lines.push('  '.repeat(level) + '[нет доступа]')
      return
    }
    const items = entries.map((name) => {
      let dir = false
      let size = 0
      try {
        const s = statSync(join(d, name))
        dir = s.isDirectory()
        size = s.size
      } catch {
        // битая ссылка
      }
      return { name, dir, size }
    }).sort((x, y) => (x.dir === y.dir ? x.name.toLowerCase().localeCompare(y.name.toLowerCase()) : x.dir ? -1 : 1))
    for (const e of items) {
      if (lines.length >= MAX_LIST) return
      if (e.dir) {
        lines.push('  '.repeat(level) + e.name + '/')
        if (!SKIP_DIRS.has(e.name) && level + 1 < depth) walk(join(d, e.name), level + 1)
      } else lines.push(`${'  '.repeat(level)}${e.name} (${humanSize(e.size)})`)
    }
  }
  walk(base, 0)
  if (lines.length >= MAX_LIST) lines.push(`... [показаны первые ${MAX_LIST} элементов]`)
  return `${base}\n` + (lines.join('\n') || '(пусто)')
}

function readFile(ctx: ToolContext, a: { path: string; offset?: number; limit?: number }) {
  const p = resolvePath(ctx, a.path)
  if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError(`Файл не найден: ${p}`)
  const size = statSync(p).size
  if (size > 50 * 1024 * 1024) throw new ToolError(`Файл слишком большой (${humanSize(size)})`)
  const data = readFileSync(p)
  if (isBinary(data)) return `Бинарный файл ${p} (${humanSize(data.length)}), как текст не читается.`
  const lines = data.toString('utf-8').split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const offset = Math.max(1, Number(a.offset ?? 1))
  const limit = Math.max(1, Math.min(Number(a.limit ?? 2000), 5000))
  const chunk = lines.slice(offset - 1, offset - 1 + limit)
  let out = chunk.map((line, i) => `${String(i + offset).padStart(5)}\t${line}`).join('\n')
  const rest = lines.length - (offset - 1 + chunk.length)
  if (rest > 0) out += `\n... [ещё ${rest} строк, продолжи с offset=${offset + chunk.length}]`
  return truncate(out || '(пустой файл)')
}

/** Копия файла до изменения (для отката); null — файла не было. */
function snapshot(ctx: ToolContext, p: string): FileChange {
  if (!existsSync(p)) return { path: p, backup: null }
  const dir = join(APP_DIR, 'backups', ctx.chatId)
  mkdirSync(dir, { recursive: true })
  const backup = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${basename(p)}`)
  copyFileSync(p, backup)
  return { path: p, backup }
}

const writeText = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf-8')
}

async function writeFile(ctx: ToolContext, a: { path: string; content: string }) {
  const p = resolvePath(ctx, a.path)
  if (existsSync(p) && statSync(p).isDirectory()) throw new ToolError(`Это папка: ${p}`)
  const exists = existsSync(p)
  const details = exists ? makeDiff(readFileSync(p, 'utf-8'), a.content, rel(ctx, p)) : a.content
  const title = (exists ? 'Перезаписать файл' : 'Создать файл') + `: ${p}` + outsideNote(ctx, p)
  if (!(await ctx.approve(title, truncate(details, 20_000)))) return DENIED
  const change = snapshot(ctx, p)
  writeText(p, a.content)
  ctx.changed?.(change)
  return `Файл записан: ${p} (${a.content.split('\n').length} строк)`
}

async function editFile(ctx: ToolContext, a: { path: string; old_string: string; new_string: string; replace_all?: boolean }) {
  const p = resolvePath(ctx, a.path)
  if (!existsSync(p) || !statSync(p).isFile()) throw new ToolError(`Файл не найден: ${p}`)
  if (!a.old_string) throw new ToolError('old_string пустой. Для нового файла используй write_file.')
  const text = readFileSync(p, 'utf-8')
  const count = text.split(a.old_string).length - 1
  if (count === 0) {
    throw new ToolError('old_string не найден. Прочитай файл заново и скопируй фрагмент точно, с отступами, без номеров строк.')
  }
  if (count > 1 && !a.replace_all) {
    throw new ToolError(`old_string встречается ${count} раз. Добавь контекст или укажи replace_all=true.`)
  }
  const next = a.replace_all ? text.split(a.old_string).join(a.new_string) : text.replace(a.old_string, () => a.new_string)
  if (!(await ctx.approve(`Изменить файл: ${p}${outsideNote(ctx, p)}`, truncate(makeDiff(text, next, rel(ctx, p)), 20_000)))) {
    return DENIED
  }
  const change = snapshot(ctx, p)
  writeText(p, next)
  ctx.changed?.(change)
  return `Файл изменён: ${p} (замен: ${a.replace_all ? count : 1})`
}

function searchFiles(ctx: ToolContext, a: { pattern: string; path?: string; glob?: string; ignore_case?: boolean }) {
  const base = resolvePath(ctx, a.path)
  let rx: RegExp
  try {
    rx = new RegExp(a.pattern, a.ignore_case ? 'i' : '')
  } catch (e) {
    throw new ToolError(`Неверное регулярное выражение: ${(e as Error).message}`)
  }
  const globRx = a.glob ? globToRegex(a.glob) : null
  const results: string[] = []
  outer: for (const f of iterFiles(base)) {
    if (globRx && !globRx.test(basename(f))) continue
    let data: Buffer
    try {
      if (statSync(f).size > 2_000_000) continue
      data = readFileSync(f)
    } catch {
      continue
    }
    if (isBinary(data.subarray(0, 4096))) continue
    const lines = data.toString('utf-8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (rx.test(lines[i])) {
        results.push(`${rel(ctx, f)}:${i + 1}: ${lines[i].trim().slice(0, 300)}`)
        if (results.length >= MAX_MATCHES) {
          results.push(`... [показаны первые ${MAX_MATCHES} совпадений]`)
          break outer
        }
      }
    }
  }
  return truncate(results.join('\n') || 'Совпадений нет.')
}

function findFiles(ctx: ToolContext, a: { pattern: string; path?: string }) {
  const base = resolvePath(ctx, a.path)
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new ToolError(`Это не папка: ${base}`)
  const rx = globToRegex(a.pattern)
  const results: string[] = []
  for (const f of iterFiles(base)) {
    const r = relative(base, f).split(sep).join('/')
    if (rx.test(a.pattern.includes('/') ? r : basename(f))) {
      results.push(rel(ctx, f))
      if (results.length >= MAX_LIST) {
        results.push('...')
        break
      }
    }
  }
  return results.join('\n') || 'Ничего не найдено.'
}

// ---------------------------------------------------------------- команды

const DANGER: [RegExp, string][] = [
  [/\b(sudo|pkexec|doas|run0)\b|\bsu\s+(-|root\b)/, 'запуск с правами администратора (root)'],
  [/\bdd\b[^|;&]*\bof=\/dev\//, 'запись напрямую на диск'],
  [/>\s*\/dev\/(sd|nvme|mmcblk|hd|vd|disk)/, 'запись напрямую на диск'],
  [/\b(mkfs(\.\w+)?|mkswap|wipefs|fdisk|sfdisk|cfdisk|gdisk|sgdisk|parted|partprobe|blkdiscard|shred)\b/, 'разметка, форматирование или стирание диска'],
  [/\b(Ventoy2Disk|vtoycli|VentoyWeb|VentoyGUI)/i, 'утилита Ventoy — может стереть диск'],
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]*\s+)*("|')?(\/|~|\$HOME)("|')?(\s|$|\/\*)/, 'рекурсивное удаление системной или домашней папки'],
  [/\b(shutdown|reboot|poweroff|halt)\b|\bsystemctl\s+(reboot|poweroff|halt|suspend)/, 'выключение или перезагрузка компьютера'],
  [/\bchmod\s+-R\b[^;&|]*\s\/(\s|$)|\bchown\s+-R\b[^;&|]*\s\/(\s|$)/, 'смена прав на всю систему'],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, 'fork-бомба'],
  // Windows
  [/\b(Start-Process\b[^;|]*-Verb\s+RunAs|runas)\b/i, 'запуск с правами администратора'],
  [/\b(format|diskpart|bcdedit|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i, 'форматирование или разметка диска'],
  [/\b(Remove-Item|rm|del|rd|rmdir)\b[^;|]*(-Recurse|\/s)[^;|]*\s(['"]?[A-Za-z]:\\?['"]?(\s|$)|\$env:USERPROFILE|~\\?['"]?(\s|$)|\$HOME)/i, 'рекурсивное удаление диска или домашней папки'],
  [/\b(reg\s+delete|Remove-ItemProperty\b[^;|]*HKLM|Set-ExecutionPolicy|Stop-Computer|Restart-Computer)\b/i, 'изменение системы или перезагрузка'],
]

/** Почему команда опасна (или null). */
export function dangerOf(command: string): string | null {
  const reasons = [...new Set(DANGER.filter(([rx]) => rx.test(command)).map(([, why]) => why))]
  return reasons.length ? reasons.join('; ') : null
}

// ---------------------------------------------------------------- безопасные команды

// команды только для чтения: их можно запускать без вопроса
const SAFE_BINS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'file', 'stat', 'pwd', 'echo', 'printf',
  'which', 'whereis', 'type', 'tree', 'du', 'df', 'find', 'sort', 'uniq', 'cut', 'tr', 'diff', 'cmp', 'md5sum',
  'sha256sum', 'sha1sum', 'basename', 'dirname', 'realpath', 'readlink', 'date', 'whoami', 'id', 'uname', 'hostname',
  'env', 'printenv', 'nproc', 'free', 'uptime', 'ps', 'lsblk', 'lscpu', 'jq', 'column', 'nl', 'less', 'more', 'awk',
  'sed', 'true', 'test', 'xxd', 'od', 'hexdump', 'strings', 'tar', 'unzip', 'zipinfo', 'ldd', 'getconf', 'locale',
  // Windows: cmd и PowerShell (команды только для чтения)
  'dir', 'type', 'where', 'findstr', 'Get-ChildItem', 'gci', 'Get-Content', 'gc', 'Select-String', 'sls', 'Get-Item', 'gi',
  'Get-Location', 'Test-Path', 'Get-Command', 'Resolve-Path', 'Get-FileHash', 'Measure-Object', 'Get-Process', 'Get-Date',
  'Write-Output', 'Get-ComputerInfo', 'systeminfo', 'whoami', 'Select-Object', 'Sort-Object', 'Format-Table', 'Format-List',
  'Where-Object', 'ForEach-Object', 'Out-String', 'ConvertTo-Json', 'ConvertFrom-Json',
])
const SAFE_GIT = /^git\s+(-C\s+\S+\s+)?((status|log|diff|show|ls-files|blame|rev-parse|describe|shortlog)\b|config\s+--get\b|(branch|tag)(\s+(-a|-l|-v|-r|--list|--show-current))*\s*$|remote(\s+-v)?\s*$)/
const VERSION = /^\S+\s+(--version|-v|-V|version)$/

function safeSegment(seg: string): boolean {
  const s = seg.trim().replace(/^(\w+=\S*\s+)+/, '')
  if (!s) return true
  if (SAFE_GIT.test(s) || VERSION.test(s)) return true
  const bin = s.split(/\s+/)[0].replace(/^.*[\/\\]/, '').replace(/\.exe$/i, '')
  if (!SAFE_BINS.has(bin) && !SAFE_BINS.has(bin.toLowerCase()) && ![...SAFE_BINS].some((b) => b.toLowerCase() === bin.toLowerCase())) return false
  if (bin === 'find' && /\s-(delete|exec|execdir|ok|okdir|fprint|fls)\b/.test(s)) return false
  if (bin === 'sed' && /\s-[a-zA-Z]*i/.test(s)) return false
  if (bin === 'awk' && /system\s*\(|>\s*"/.test(s)) return false
  if (bin === 'tar' && !/^-?[a-zA-Z]*t[a-zA-Z]*$/.test(s.split(/\s+/)[1] || '')) return false
  if (bin === 'unzip' && !/\s-l\b/.test(s)) return false
  if (bin === 'env' && s.split(/\s+/).length > 1) return false
  return true
}

/** Можно ли выполнить команду без вопроса: всё только для чтения или начинается с разрешённого пользователем. */
export function isSafeCommand(command: string, allowed: string[], readOnly = true): boolean {
  const cmd = command.trim()
  if (!cmd || dangerOf(cmd)) return false
  // свои разрешённые команды («npm test», «pytest») — только без цепочек и подстановок
  const chained = /[;&|`<>]|\$\(/.test(cmd.replace(/2>&1/g, ''))
  if (!chained && allowed.some((p) => p.trim() && (cmd === p.trim() || cmd.startsWith(p.trim() + ' ')))) return true
  if (!readOnly) return false
  // подстановки и перенаправления в файлы — уже не «только чтение»
  if (/`|\$\(|<\(|>\(/.test(cmd)) return false
  const rest = cmd.replace(/\d?>\s*\/dev\/null/g, '').replace(/2>&1/g, '')
  if (/>/.test(rest)) return false
  return rest.split(/\|\||&&|;|\|/).every(safeSegment)
}

/** Запуск процесса с живым выводом, таймаутом и остановкой по сигналу агента. */
function execute_(ctx: ToolContext, argv: string[], timeout: number, extraEnv: Record<string, string> = {}): Promise<string> {
  mkdirSync(ctx.root, { recursive: true })
  return new Promise<string>((done) => {
    const proc = spawn(argv[0], argv.slice(1), { cwd: ctx.root, ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'], env: { ...COMMAND_ENV, ...ctx.env, ...extraEnv } })
    const chunks: Buffer[] = []
    let size = 0
    const collect = (b: Buffer) => {
      if (size < MAX_OUTPUT * 4) chunks.push(b)
      size += b.length
      ctx.output?.(ctx.mask(b.toString('utf-8')))
    }
    proc.stdout.on('data', collect)
    proc.stderr.on('data', collect)
    let status = ''
    const kill = (why: string) => {
      status = why
      killTree(proc.pid) // вместе с дочерними процессами
    }
    const timer = setTimeout(() => kill(`Остановлено по таймауту (${timeout} с)`), timeout * 1000)
    const onAbort = () => kill('Остановлено пользователем')
    ctx.signal.addEventListener('abort', onAbort)
    proc.on('close', (code) => {
      clearTimeout(timer)
      ctx.signal.removeEventListener('abort', onAbort)
      const text = ctx.mask(Buffer.concat(chunks).toString('utf-8'))
      done(truncate(`${status || `Код выхода: ${code}`}\n${text}`.trimEnd()))
    })
    proc.on('error', (e) => done(`Ошибка запуска: ${e.message}`))
  })
}

async function runCommand(ctx: ToolContext, a: { command: string; timeout?: number }) {
  const timeout = Math.max(1, Math.min(Number(a.timeout ?? 120), 1800))
  if (!ctx.safe(a.command)) {
    const danger = dangerOf(a.command)
    if (!(await ctx.approve(`Выполнить команду: в папке ${ctx.root}`, a.command, danger || undefined))) return DENIED
  }
  return execute_(ctx, shellArgv(a.command), timeout)
}

// ---------------------------------------------------------------- серверы

function findServer(ctx: ToolContext, name: string): Server {
  const s = ctx.servers.find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.id === name)
  if (!s) throw new ToolError(`Сервер «${name}» не найден. Доступны: ${ctx.servers.map((x) => x.name).join(', ') || 'нет (добавьте в Настройки → Серверы)'}`)
  return s
}

/** Аргументы ssh/scp и переменные для входа по паролю через SSH_ASKPASS (пароль не попадает в команду). */
export function sshAuth(s: Server, password?: string): { opts: string[]; env: Record<string, string> } {
  const opts = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30']
  const env: Record<string, string> = {}
  if (s.auth === 'key') {
    opts.push('-o', 'BatchMode=yes')
    if (s.key_path) opts.push('-i', s.key_path.replace(/^~/, homedir()))
  } else {
    if (!password) throw new ToolError(`Для сервера «${s.name}» не сохранён пароль (Настройки → Серверы)`)
    const askpass = join(APP_DIR, isWin ? 'askpass.cmd' : 'askpass.sh')
    if (!existsSync(askpass)) {
      mkdirSync(APP_DIR, { recursive: true })
      writeFileSync(askpass, isWin ? '@echo off\r\necho %VENICE_SSH_PASS%\r\n' : '#!/bin/sh\nprintf "%s\\n" "$VENICE_SSH_PASS"\n', { mode: 0o700 })
    }
    Object.assign(env, { SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', VENICE_SSH_PASS: password, DISPLAY: process.env.DISPLAY || ':0' })
    opts.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'NumberOfPasswordPrompts=1')
  }
  return { opts, env }
}

async function sshRun(ctx: ToolContext, a: { server: string; command: string; timeout?: number; background?: boolean; name?: string }) {
  const s = findServer(ctx, a.server)
  const danger = dangerOf(a.command)
  const where = `${s.user}@${s.host}${s.port && s.port !== 22 ? ':' + s.port : ''}`
  if (!(await ctx.approve(`Выполнить на сервере: ${s.name} (${where})`, a.command, danger || undefined))) return DENIED
  const { opts, env } = sshAuth(s, secretFor(s))
  const argv = ['ssh', ...opts, '-p', String(s.port || 22), `${s.user}@${s.host}`, a.command]
  if (a.background) {
    const job = startJob(a.command, ctx.root, a.name || `${s.name}: ${a.command.slice(0, 40)}`, ctx.chatId, { argv, env: { ...ctx.env, ...env } })
    await new Promise((r) => setTimeout(r, 2000))
    const now = getJob(job.id)!
    return `Запущено на ${s.name} в фоне: id=${job.id}. Статус: ${now.status}\n${jobLog(job.id, 20) || ''}\nПроверяй через job_status.`
  }
  return execute_(ctx, argv, Math.max(1, Math.min(Number(a.timeout ?? 300), 1800)), env)
}

async function sshUpload(ctx: ToolContext, a: { server: string; local: string; remote: string }) {
  const s = findServer(ctx, a.server)
  const local = resolvePath(ctx, a.local)
  if (!existsSync(local)) throw new ToolError(`Нет такого файла или папки: ${local}`)
  if (!(await ctx.approve(`Загрузить на сервер: ${s.name}`, `${local}\n→ ${s.user}@${s.host}:${a.remote}`))) return DENIED
  const { opts, env } = sshAuth(s, secretFor(s))
  const argv = ['scp', ...opts, '-P', String(s.port || 22), '-r', local, `${s.user}@${s.host}:${a.remote}`]
  return execute_(ctx, argv, 1800, env)
}

let secretFor: (s: Server) => string | undefined = () => undefined
export function setServerSecrets(fn: (s: Server) => string | undefined) {
  secretFor = fn
}

// ---------------------------------------------------------------- план

export interface PlanStep { title: string; status: 'pending' | 'in_progress' | 'done' }

function updatePlan(ctx: ToolContext, a: { steps: PlanStep[] }) {
  if (!Array.isArray(a.steps)) throw new ToolError('steps должен быть списком')
  const steps = a.steps.map((s) => ({ title: String(s.title || ''), status: (['pending', 'in_progress', 'done'].includes(s.status) ? s.status : 'pending') as PlanStep['status'] }))
  ctx.plan?.(steps)
  const done = steps.filter((s) => s.status === 'done').length
  return `План обновлён: выполнено ${done} из ${steps.length}.`
}

// ---------------------------------------------------------------- фоновые задачи

async function startBackground(ctx: ToolContext, a: { command: string; name?: string }) {
  const danger = dangerOf(a.command)
  if (!(await ctx.approve(`Запустить в фоне: в папке ${ctx.root}`, a.command, danger || undefined))) return DENIED
  mkdirSync(ctx.root, { recursive: true })
  const job = startJob(a.command, ctx.root, a.name || '', ctx.chatId, { env: ctx.env })
  await new Promise((r) => setTimeout(r, 1500)) // первые строки вывода — сразу видно, запустилось ли
  const now = getJob(job.id)!
  return `Задача запущена в фоне: id=${job.id} (${job.name}). Статус: ${now.status}` +
    (now.code != null ? `, код выхода ${now.code}` : '') + `
Первые строки вывода:
${jobLog(job.id, 20) || '(пока пусто)'}
` +
    'Проверяй ход через job_status, остановить можно через stop_job.'
}

async function jobStatus(ctx: ToolContext, a: { id: string; lines?: number; wait_seconds?: number }) {
  let job = getJob(a.id)
  if (!job) return `Ошибка: задача ${a.id} не найдена`
  // можно подождать завершения, не тратя шаги на частые проверки
  const until = Date.now() + Math.max(0, Math.min(Number(a.wait_seconds ?? 0), 600)) * 1000
  while (job.status === 'running' && Date.now() < until && !ctx.signal.aborted) {
    await new Promise((r) => setTimeout(r, 1000))
    job = getJob(a.id)!
  }
  const took = Math.round(((job.ended || Date.now()) - job.started) / 1000)
  return `Задача ${job.id} (${job.name}): ${job.status}` + (job.code != null ? `, код выхода ${job.code}` : '') +
    `, ${took} с
Последние строки вывода:
${truncate(jobLog(job.id, Number(a.lines ?? 60)) || '(пусто)', 15_000)}`
}

function stopBackground(_ctx: ToolContext, a: { id: string }) {
  return stopJob(a.id) ? `Задача ${a.id} остановлена` : `Задача ${a.id} не найдена или уже завершилась`
}

// ---------------------------------------------------------------- архивы

export function defaultExtractDir(src: string): string {
  let name = basename(src)
  const suffix = [...ARCHIVE_SUFFIXES].sort((x, y) => y.length - x.length).find((s) => name.toLowerCase().endsWith(s))
  if (suffix) name = name.slice(0, -suffix.length)
  name ||= 'archive'
  let target = join(dirname(src), name)
  for (let n = 1; existsSync(target); n++) target = join(dirname(src), `${name}_${n}`)
  return target
}

function extractZip(src: string, root: string): Promise<void> {
  return new Promise((done, fail) => {
    yauzl.open(src, { lazyEntries: true, decodeStrings: true }, (err, zip) => {
      if (err || !zip) return fail(new ToolError(`Не удалось открыть zip: ${err?.message}`))
      zip.on('error', (e) => fail(new ToolError(`Ошибка zip: ${e.message}`)))
      zip.on('end', () => done())
      zip.on('entry', (entry: yauzl.Entry) => {
        const dest = resolve(root, entry.fileName)
        if (!inside(root, dest)) {
          zip.close()
          return fail(new ToolError(`Опасный путь в архиве: ${entry.fileName}`))
        }
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000
        if (mode === 0o120000) return zip.readEntry() // символические ссылки не распаковываем
        if (entry.fileName.endsWith('/')) {
          mkdirSync(dest, { recursive: true })
          return zip.readEntry()
        }
        mkdirSync(dirname(dest), { recursive: true })
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return fail(new ToolError(`Ошибка zip: ${e?.message}`))
          pipeline(stream, createWriteStream(dest)).then(() => zip.readEntry(), fail)
        })
      })
      zip.readEntry()
    })
  })
}

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  if (r.error) throw new ToolError(`${cmd}: ${r.error.message}`)
  if (r.status !== 0) throw new ToolError(`${cmd} завершился с ошибкой:\n${(r.stdout || '').slice(-2000)}${(r.stderr || '').slice(-2000)}`)
  return r.stdout
}


/** Распаковывает архив в target, возвращает число файлов. */
export async function extract(src: string, target: string): Promise<number> {
  if (!existsSync(src) || !statSync(src).isFile()) throw new ToolError(`Архив не найден: ${src}`)
  mkdirSync(target, { recursive: true })
  const root = realpathSync(target)
  const lower = src.toLowerCase()
  if (lower.endsWith('.zip')) {
    await extractZip(src, root)
  } else if (lower.endsWith('.rar') || lower.endsWith('.7z')) {
    const tool = ['7z', '7za', 'bsdtar', 'unrar'].find(which)
    if (!tool) throw new ToolError('Для rar/7z нужна утилита 7z, bsdtar или unrar (например: sudo apt install 7zip)')
    const args: Record<string, string[]> = {
      '7z': ['x', '-y', `-o${root}`, src], '7za': ['x', '-y', `-o${root}`, src],
      bsdtar: ['-xf', src, '-C', root], unrar: ['x', '-o+', src, root + '/'],
    }
    run(tool, args[tool])
  } else {
    // сначала проверяем имена: никаких абсолютных путей и выходов наверх
    for (const name of run('tar', ['-tf', src]).split('\n').filter(Boolean)) {
      if (isAbsolute(name) || name.split('/').includes('..')) throw new ToolError(`Опасный путь в архиве: ${name}`)
    }
    run('tar', ['-xf', src, '-C', root, '--no-same-owner', '--no-same-permissions'])
  }
  let count = 0
  for (const _ of iterFiles(root)) count++
  return count
}

async function extractArchive(ctx: ToolContext, a: { path: string; destination?: string }) {
  const src = resolvePath(ctx, a.path)
  const target = a.destination ? resolvePath(ctx, a.destination) : defaultExtractDir(src)
  if (!(await ctx.approve(`Распаковать архив: ${basename(src)}`, `Куда: ${target}${outsideNote(ctx, target)}`))) return DENIED
  const count = await extract(src, target)
  return `Распаковано в ${target}: файлов ${count}\n${treePreview(target)}`
}

// ---------------------------------------------------------------- веб

const BLOCK = new Set(['p', 'div', 'br', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
  'header', 'footer', 'pre', 'blockquote', 'table', 'ul', 'ol'])
const SKIP = new Set(['script', 'style', 'noscript', 'svg', 'template', 'head'])

export function htmlToText(page: string, baseUrl: string): { title: string; text: string } {
  const doc = parse(page, { comment: false })
  const title = doc.querySelector('title')?.text.trim() || ''
  const parts: string[] = []
  const visit = (node: HNode) => {
    if (node.nodeType === 3) {
      parts.push(node.text)
      return
    }
    const el = node as HTMLElement
    const tag = (el.tagName || '').toLowerCase()
    if (SKIP.has(tag)) return
    if (BLOCK.has(tag)) parts.push('\n')
    if (/^h[1-6]$/.test(tag)) parts.push('#'.repeat(Number(tag[1])) + ' ')
    if (tag === 'li') parts.push('- ')
    if (tag === 'a') {
      const href = el.getAttribute('href')
      const text = el.text.replace(/\s+/g, ' ').trim()
      if (href && !href.startsWith('#') && !href.startsWith('javascript:') && text) {
        try {
          parts.push(`[${text}](${new URL(href, baseUrl).href})`)
          return
        } catch {
          // некорректный адрес — выводим как текст
        }
      }
    }
    for (const c of el.childNodes) visit(c)
    if (BLOCK.has(tag)) parts.push('\n')
  }
  visit(doc)
  const out: string[] = []
  let blank = false
  for (const raw of parts.join('').split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim()
    if (line) {
      out.push(line)
      blank = false
    } else if (!blank) {
      out.push('')
      blank = true
    }
  }
  return { title, text: out.join('\n').trim() }
}

const stripTags = (s: string) => parse(s).text.replace(/\s+/g, ' ').trim()

function bingHref(href: string): string {
  href = parse(`<a href="${href}"></a>`).querySelector('a')?.getAttribute('href') || href
  if (href.includes('bing.com/ck/a')) {
    try {
      const u = new URL(href).searchParams.get('u') || ''
      if (u.startsWith('a1')) return Buffer.from(u.slice(2), 'base64url').toString('utf-8')
    } catch {
      // оставляем как есть
    }
  }
  return href
}

type Hit = [string, string, string]

async function searchBing(query: string, limit: number, signal: AbortSignal): Promise<Hit[]> {
  const r = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const out: Hit[] = []
  for (const block of (await r.text()).split('<li class="b_algo"').slice(1)) {
    const link = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    const snippet = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block)
    out.push([stripTags(link[2]), bingHref(link[1]), snippet ? stripTags(snippet[1]) : ''])
    if (out.length >= limit) break
  }
  return out
}

async function searchDuckDuckGo(query: string, limit: number, signal: AbortSignal): Promise<Hit[]> {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST', body: new URLSearchParams({ q: query }),
    headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const doc = parse(await r.text())
  const out: Hit[] = []
  for (const res of doc.querySelectorAll('.result')) {
    const a = res.querySelector('a.result__a')
    let href = a?.getAttribute('href') || ''
    if (!a || !href) continue
    try {
      const u = new URL(href, 'https://duckduckgo.com')
      href = u.searchParams.get('uddg') || u.href
    } catch {
      // оставляем как есть
    }
    if (href.includes('duckduckgo.com/y.js')) continue // реклама
    out.push([a.text.trim(), href, res.querySelector('.result__snippet')?.text.trim() || ''])
    if (out.length >= limit) break
  }
  return out
}

async function webSearch(ctx: ToolContext, a: { query: string; max_results?: number }) {
  const limit = Math.max(1, Math.min(Number(a.max_results ?? 8), 20))
  const errors: string[] = []
  if (ctx.search) {
    try {
      return await ctx.search(a.query, limit)
    } catch (e) {
      errors.push(`venice: ${(e as Error).message}`)
    }
  }
  for (const [name, engine] of [['bing', searchBing], ['duckduckgo', searchDuckDuckGo]] as const) {
    try {
      const hits = await engine(a.query, limit, ctx.signal)
      if (hits.length) return hits.map(([t, u, s], i) => `${i + 1}. ${t}\n   ${u}\n   ${s}`).join('\n')
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`)
    }
  }
  return 'Результатов нет (поисковики могли ограничить запросы). Попробуй fetch_url с прямым адресом.' +
    (errors.length ? ` Ошибки: ${errors.join('; ')}` : '')
}

async function fetchUrl(ctx: ToolContext, a: { url: string; max_chars?: number }) {
  const url = /^https?:\/\//.test(a.url) ? a.url : 'https://' + a.url
  const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]) })
  const ctype = r.headers.get('content-type') || ''
  let head = `URL: ${r.url}\nСтатус: ${r.status}\n`
  let text: string
  if (ctype.includes('html')) {
    const page = htmlToText(await r.text(), r.url)
    head += `Заголовок: ${page.title}\n`
    text = page.text
  } else if (ctype.startsWith('text/') || /json|xml|javascript/.test(ctype)) {
    text = await r.text()
  } else {
    const size = Number(r.headers.get('content-length') || 0)
    await r.body?.cancel()
    return head + `Тип: ${ctype}${size ? `, размер ${humanSize(size)}` : ''}. Чтобы сохранить файл, используй download_file.`
  }
  return head + '\n' + truncate(text, Math.max(1000, Math.min(Number(a.max_chars ?? 20_000), 100_000)))
}

async function downloadFile(ctx: ToolContext, a: { url: string; path: string }) {
  const p = resolvePath(ctx, a.path)
  if (!(await ctx.approve(`Скачать файл: ${p}${outsideNote(ctx, p)}`, a.url))) return DENIED
  mkdirSync(dirname(p), { recursive: true })
  const r = await fetch(a.url, { headers: { 'User-Agent': USER_AGENT }, signal: ctx.signal })
  if (!r.ok || !r.body) throw new ToolError(`HTTP ${r.status}`)
  let size = 0
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) {
      size += chunk.length
      if (size > 1024 ** 3) ctrl.error(new ToolError('Файл больше 1 ГБ, загрузка прервана'))
      else ctrl.enqueue(chunk)
    },
  })
  await pipeline(Readable.fromWeb(r.body.pipeThrough(limiter) as any), createWriteStream(p))
  return `Сохранено: ${p} (${humanSize(size)})`
}

// ---------------------------------------------------------------- браузер, поиск по смыслу, помощники, память

async function browserOpen(_ctx: ToolContext, a: { url: string }) {
  return browser.open(a.url)
}

async function browserClick(ctx: ToolContext, a: { index: number; why?: string }) {
  if (!ctx.browserAuto && !(await ctx.approve(`Нажать в браузере: элемент [${a.index}]`, a.why || 'Агент хочет нажать на элемент страницы.'))) return DENIED
  return browser.click(Number(a.index))
}

async function browserType(ctx: ToolContext, a: { index: number; text: string; submit?: boolean }) {
  if (!ctx.browserAuto && !(await ctx.approve(`Ввести текст в браузере: поле [${a.index}]`, a.text + (a.submit ? '\n\n(и нажать Enter)' : '')))) return DENIED
  return browser.type(Number(a.index), String(a.text), !!a.submit)
}

async function browserScreenshot(ctx: ToolContext) {
  const file = await browser.screenshot()
  ctx.attachImage?.(file)
  ctx.media?.(file)
  return `Скриншот сохранён: ${file}` + (ctx.attachImage ? ' (картинка будет у тебя в следующем сообщении)' : '')
}

// ---------------------------------------------------------------- Firefox пользователя (расширение)
// Чтение — без вопроса; всё, что меняет что-то в браузере пользователя, — только с подтверждением (browser_auto не действует).

const tabArg = (a: { tab_id?: unknown }) => (a.tab_id == null || a.tab_id === '' ? undefined : Number(a.tab_id))
const tabName = (a: { tab_id?: unknown }) => (tabArg(a) == null ? 'активная вкладка' : `вкладка ${tabArg(a)}`)

async function firefoxClick(ctx: ToolContext, a: { tab_id?: number; index: number; why?: string }) {
  if (!(await ctx.approve(`Нажать в вашем Firefox: элемент [${a.index}] (${tabName(a)})`, a.why || 'Агент хочет нажать на элемент страницы.'))) return DENIED
  return firefox.click(tabArg(a), Number(a.index))
}

async function firefoxType(ctx: ToolContext, a: { tab_id?: number; index: number; text: string; submit?: boolean }) {
  if (!(await ctx.approve(`Ввести текст в вашем Firefox: поле [${a.index}] (${tabName(a)})`, a.text + (a.submit ? '\n\n(и нажать Enter)' : '')))) return DENIED
  return firefox.type(tabArg(a), Number(a.index), String(a.text), !!a.submit)
}

async function firefoxOpen(ctx: ToolContext, a: { url: string; new_tab?: boolean }) {
  const newTab = a.new_tab !== false
  if (!(await ctx.approve(`Открыть в вашем Firefox${newTab ? ' (новая вкладка)' : ' (в активной вкладке)'}`, String(a.url)))) return DENIED
  return firefox.open(String(a.url), newTab)
}

async function firefoxClose(ctx: ToolContext, a: { tab_id: number }) {
  if (!(await ctx.approve(`Закрыть вкладку ${a.tab_id} в вашем Firefox`, 'Агент хочет закрыть вкладку.'))) return DENIED
  return firefox.close(Number(a.tab_id))
}

async function firefoxBack(ctx: ToolContext, a: { tab_id?: number }) {
  if (!(await ctx.approve(`Назад в вашем Firefox (${tabName(a)})`, 'Агент хочет вернуться на предыдущую страницу.'))) return DENIED
  return firefox.back(tabArg(a))
}

async function firefoxScreenshot(ctx: ToolContext, a: { tab_id?: number }) {
  const file = await firefox.screenshot(tabArg(a))
  ctx.attachImage?.(file)
  ctx.media?.(file)
  return `Снимок вкладки сохранён: ${file}` + (ctx.attachImage ? ' (картинка будет у тебя в следующем сообщении)' : '')
}

/** Просмотр картинки моделью со зрением — платный; больше LOOK_FREE за ответ — только с разрешения (защита от перебора папки). */
const LOOK_FREE = 5
async function describeImage(ctx: ToolContext, a: { path: string; task?: string }) {
  const path = imgPath(ctx, a.path)
  const n = ctx.counts ? (ctx.counts.describe = (ctx.counts.describe || 0) + 1) : 0
  if (n > LOOK_FREE && !(await ctx.approve(`Посмотреть ещё одну картинку (${n}-ю за этот ответ)`,
    `${rel(ctx, path)}\n\nАгент уже посмотрел ${n - 1} картинок подряд. Если он ищет не то — откажите и уточните задачу в чате.`))) {
    return DENIED
  }
  return needImages(ctx).describe(path, a.task || 'caption')
}

async function semanticSearch(ctx: ToolContext, a: { query: string; k?: number }) {
  if (!ctx.semantic) return 'Поиск по смыслу недоступен'
  return ctx.semantic(a.query, Number(a.k ?? 8))
}

async function delegateTask(ctx: ToolContext, a: { task: string; label?: string }) {
  if (!ctx.delegate) return 'Помощники недоступны внутри помощника — сделай это сам.'
  return ctx.delegate(String(a.task), a.label || String(a.task).slice(0, 50))
}

function rememberFact(_ctx: ToolContext, a: { fact: string }) {
  return `Предложено пользователю запомнить: «${String(a.fact).slice(0, 300)}». Сохранится, если пользователь подтвердит.`
}


// ---------------------------------------------------------------- картинки

export interface ImageHooks {
  generate(prompt: string, opts: { model?: string; aspect_ratio?: string; variants?: number; seed?: number }): Promise<{ paths: string[]; cost: number | null; model: string }>
  edit(path: string, prompt: string, model?: string): Promise<{ paths: string[]; cost: number | null }>
  combine(paths: string[], prompt: string, model?: string): Promise<{ paths: string[]; cost: number | null }>
  upscale(path: string, scale: 2 | 4): Promise<{ paths: string[]; cost: number | null }>
  background(path: string): Promise<{ paths: string[]; cost: number | null }>
  describe(path: string, task: string): Promise<string>
}

const imgDone = (ctx: ToolContext, r: { paths: string[]; cost: number | null }, extra = '') => {
  r.paths.forEach((p) => ctx.media?.(p))
  return `Готово: ${r.paths.join(', ')}${r.cost != null ? ` (стоимость $${r.cost.toFixed(3)})` : ''}${extra}`
}
const needImages = (ctx: ToolContext) => {
  if (!ctx.images) throw new ToolError('Работа с картинками недоступна')
  return ctx.images
}
const imgPath = (ctx: ToolContext, p: string) => {
  const full = resolvePath(ctx, p)
  if (!existsSync(full)) throw new ToolError(`Нет файла: ${full}`)
  return full
}

async function generateImage(ctx: ToolContext, a: { prompt: string; model?: string; aspect_ratio?: string; variants?: number; seed?: number }) {
  const r = await needImages(ctx).generate(String(a.prompt), { model: a.model, aspect_ratio: a.aspect_ratio, variants: Math.max(1, Math.min(Number(a.variants || 1), 4)), seed: a.seed })
  return imgDone(ctx, r, ` · модель ${r.model}`)
}

// ---------------------------------------------------------------- реестр

const S = { type: 'string' }
const I = { type: 'integer' }
const B = { type: 'boolean' }
const schema = (name: string, description: string, properties: Record<string, any>, required: string[]) => ({
  type: 'function' as const,
  function: { name, description, parameters: { type: 'object', properties, required } },
})

type ToolFn = (ctx: ToolContext, args: any) => string | Promise<string>

export const TOOLS: Record<string, [ToolFn, ReturnType<typeof schema>]> = {
  list_dir: [listDir, schema('list_dir', 'List files and folders as a tree. Relative paths are resolved against the project folder.',
    { path: { ...S, description: "Folder path, default '.'" }, depth: { ...I, description: 'Tree depth 1-5, default 2' } }, [])],
  read_file: [readFile, schema('read_file', 'Read a text file. Returns lines prefixed with line numbers (the numbers are not part of the file).',
    { path: S, offset: { ...I, description: 'First line, 1-based' }, limit: { ...I, description: 'Max lines, default 2000' } }, ['path'])],
  write_file: [writeFile, schema('write_file', 'Create a file or overwrite it completely. Requires user approval.',
    { path: S, content: { ...S, description: 'Full new file content' } }, ['path', 'content'])],
  edit_file: [editFile, schema('edit_file', 'Replace an exact text fragment in a file. old_string must match exactly and be unique ' +
    'unless replace_all is true. Requires user approval.',
    { path: S, old_string: S, new_string: S, replace_all: B }, ['path', 'old_string', 'new_string'])],
  search_files: [searchFiles, schema('search_files', 'Search file contents with a regular expression (like grep).',
    { pattern: S, path: S, glob: { ...S, description: "Filename filter, e.g. '*.py'" }, ignore_case: B }, ['pattern'])],
  find_files: [findFiles, schema('find_files', "Find files by name pattern, e.g. '*.py' or 'src/*.js'.",
    { pattern: S, path: S }, ['pattern'])],
  run_command: [runCommand, schema('run_command', `Run a shell command (${SHELL_NAME}) in the project folder and wait for it to finish. ` +
    'Non-interactive: no stdin, no password prompts. Requires user approval. For anything long (deploys, builds, servers, ' +
    'watchers) use start_background instead.',
    { command: S, timeout: { ...I, description: 'Seconds, default 120, max 1800' } }, ['command'])],
  start_background: [startBackground, schema('start_background', 'Start a long-running shell command in the background ' +
    '(deploy, build, dev server, long script) and return immediately with a job id. Requires user approval.',
    { command: S, name: { ...S, description: 'Short human-readable name, e.g. "Деплой на сервер"' } }, ['command'])],
  job_status: [jobStatus, schema('job_status', 'Check a background job: status, exit code and the last lines of output. ' +
    'Set wait_seconds to wait for it to finish (up to 600) instead of polling often.',
    { id: S, lines: { ...I, description: 'How many last lines of output, default 60' }, wait_seconds: I }, ['id'])],
  stop_job: [stopBackground, schema('stop_job', 'Stop a background job.', { id: S }, ['id'])],
  ssh_run: [sshRun, schema('ssh_run', 'Run a command on one of the user\'s saved servers over SSH (credentials are handled ' +
    'by the app, never ask for them). Requires user approval. Set background=true for long deploys and check with job_status.',
    { server: { ...S, description: 'Server name from the list in the system prompt' }, command: S,
      timeout: { ...I, description: 'Seconds, default 300' }, background: B, name: S }, ['server', 'command'])],
  ssh_upload: [sshUpload, schema('ssh_upload', 'Upload a local file or folder to a saved server (scp -r). Requires user approval.',
    { server: S, local: { ...S, description: 'Local path (relative to the project folder)' }, remote: { ...S, description: 'Remote path' } },
    ['server', 'local', 'remote'])],
  browser_open: [browserOpen, schema('browser_open', 'Open a web page in a real browser (JavaScript, logins and cookies work). ' +
    'Returns page text and a numbered list of interactive elements. Use for sites where fetch_url is not enough.',
    { url: S }, ['url'])],
  browser_read: [() => browser.read(), schema('browser_read', 'Re-read the current browser page: text and numbered elements.', {}, [])],
  browser_click: [browserClick, schema('browser_click', 'Click an element by its number from the latest browser element list.',
    { index: I, why: { ...S, description: 'Short reason, shown to the user' } }, ['index'])],
  browser_type: [browserType, schema('browser_type', 'Type text into an input by its element number; submit=true presses Enter.',
    { index: I, text: S, submit: B }, ['index', 'text'])],
  browser_scroll: [(_c: ToolContext, a: { direction?: string }) => browser.scroll(a.direction === 'up' ? 'up' : 'down'),
    schema('browser_scroll', 'Scroll the browser page down or up.', { direction: { type: 'string', enum: ['down', 'up'] } }, [])],
  browser_back: [() => browser.back(), schema('browser_back', 'Go back in browser history.', {}, [])],
  browser_screenshot: [browserScreenshot, schema('browser_screenshot', 'Take a screenshot of the visible browser page ' +
    '(you will see it if your model supports images; the user sees it too).', {}, [])],
  firefox_tabs: [() => firefox.tabs(), schema('firefox_tabs', 'List tabs open in the USER\'S OWN Firefox (their logins, the page they ' +
    'are looking at). Use when the user says "my browser", "this page", "the tab I have open".', {}, [])],
  firefox_read: [(_c: ToolContext, a: { tab_id?: number }) => firefox.read(tabArg(a)), schema('firefox_read', 'Read a page in the user\'s ' +
    'Firefox: text and numbered interactive elements. Omit tab_id for the tab the user is looking at.', { tab_id: I }, [])],
  firefox_screenshot: [firefoxScreenshot, schema('firefox_screenshot', 'Screenshot of the visible part of a tab in the user\'s Firefox ' +
    '(the tab becomes active). You see it if your model supports images.', { tab_id: I }, [])],
  firefox_scroll: [(_c: ToolContext, a: { tab_id?: number; direction?: string }) => firefox.scroll(tabArg(a), a.direction === 'up' ? 'up' : 'down'),
    schema('firefox_scroll', 'Scroll a page in the user\'s Firefox.', { tab_id: I, direction: { type: 'string', enum: ['down', 'up'] } }, [])],
  firefox_click: [firefoxClick, schema('firefox_click', 'Click an element (number from firefox_read) in the user\'s Firefox. Needs approval.',
    { tab_id: I, index: I, why: { ...S, description: 'Short reason, shown to the user' } }, ['index'])],
  firefox_type: [firefoxType, schema('firefox_type', 'Type into a field (number from firefox_read) in the user\'s Firefox; submit=true presses Enter. Needs approval.',
    { tab_id: I, index: I, text: S, submit: B }, ['index', 'text'])],
  firefox_open: [firefoxOpen, schema('firefox_open', 'Open a URL in the user\'s Firefox (new tab by default). Needs approval.',
    { url: S, new_tab: B }, ['url'])],
  firefox_back: [firefoxBack, schema('firefox_back', 'Go back in a tab of the user\'s Firefox. Needs approval.', { tab_id: I }, [])],
  firefox_close: [firefoxClose, schema('firefox_close', 'Close a tab in the user\'s Firefox. Needs approval.', { tab_id: I }, ['tab_id'])],
  semantic_search: [semanticSearch, schema('semantic_search', 'Search the project code by meaning (embeddings), e.g. ' +
    '"where payments are processed". Better than search_files when you do not know exact words. Returns file:line ranges.',
    { query: S, k: { ...I, description: 'How many results, default 8' } }, ['query'])],
  delegate: [delegateTask, schema('delegate', 'Give a self-contained subtask to a helper agent that has the same tools and returns ' +
    'a report. Several delegate calls in one step run in parallel — use it to explore different parts of a big project at once ' +
    'or to do independent pieces of work. Describe the task fully: the helper does not see this conversation.',
    { task: S, label: { ...S, description: 'Very short name for the user, e.g. "Изучить фронтенд"' } }, ['task'])],
  remember: [rememberFact, schema('remember', 'Suggest saving a durable fact about the user or their projects for future chats ' +
    '(preferences, stack, servers, recurring context). The user confirms it. Use rarely, only for genuinely useful long-term facts.',
    { fact: S }, ['fact'])],
  generate_image: [generateImage, schema('generate_image', 'Generate images with Venice (costs money: ~$0.01–0.3 each). ' +
    'Write a detailed prompt (subject, style, light, composition). Images are saved in the project and shown to the user.',
    { prompt: S, model: { ...S, description: 'Image model id; omit for the user\'s default' }, aspect_ratio: { ...S, description: 'e.g. 1:1, 16:9, 9:16, 4:5' },
      variants: { ...I, description: '1-4' }, seed: I }, ['prompt'])],
  edit_image: [async (ctx: ToolContext, a: { path: string; prompt: string; model?: string }) => imgDone(ctx, await needImages(ctx).edit(imgPath(ctx, a.path), String(a.prompt), a.model)),
    schema('edit_image', 'Edit an image by instruction ("make the sky sunset", "remove the person"). Saves a new version.',
      { path: S, prompt: S, model: { ...S, description: 'Edit model id, default qwen-edit-uncensored' } }, ['path', 'prompt'])],
  combine_images: [async (ctx: ToolContext, a: { paths: string[]; prompt: string; model?: string }) => imgDone(ctx, await needImages(ctx).combine((a.paths || []).map((p) => imgPath(ctx, p)), String(a.prompt), a.model)),
    schema('combine_images', 'Create an image from several: the first is the base, others are references ("put the person from image 2 into image 1", ' +
      '"dress the model in this outfit", keep the same character).', { paths: { type: 'array', items: S }, prompt: S, model: S }, ['paths', 'prompt'])],
  upscale_image: [async (ctx: ToolContext, a: { path: string; scale?: number }) => imgDone(ctx, await needImages(ctx).upscale(imgPath(ctx, a.path), Number(a.scale) === 4 ? 4 : 2)),
    schema('upscale_image', 'Upscale an image 2x ($0.02) or 4x ($0.08).', { path: S, scale: { type: 'integer', enum: [2, 4] } }, ['path'])],
  remove_background: [async (ctx: ToolContext, a: { path: string }) => imgDone(ctx, await needImages(ctx).background(imgPath(ctx, a.path))),
    schema('remove_background', 'Remove the background (transparent PNG).', { path: S }, ['path'])],
  describe_image: [describeImage,
    schema('describe_image', 'Look at an image with a vision model: task caption (social media caption), alt, ocr (read text), ' +
      'critique (photo review), prompt (describe as a generation prompt), or any custom question.', { path: S, task: S }, ['path'])],
  update_plan: [updatePlan, schema('update_plan', 'Show the user a checklist of the task. Use it for any task with 3+ steps: ' +
    'create the plan first, then update statuses as you go (exactly one step in_progress). Always send the full list.',
    { steps: { type: 'array', items: { type: 'object', properties: { title: S, status: { type: 'string', enum: ['pending', 'in_progress', 'done'] } }, required: ['title', 'status'] } } },
    ['steps'])],
  extract_archive: [extractArchive, schema('extract_archive', 'Extract zip/tar/tar.gz/rar/7z archive. Requires user approval.',
    { path: S, destination: { ...S, description: 'Target folder; default is next to the archive' } }, ['path'])],
  web_search: [webSearch, schema('web_search', 'Search the internet. Returns titles, URLs and snippets.',
    { query: S, max_results: I }, ['query'])],
  fetch_url: [fetchUrl, schema('fetch_url', 'Open a web page and return its text content with links.',
    { url: S, max_chars: I }, ['url'])],
  download_file: [downloadFile, schema('download_file', 'Download a file from a URL to a path. Requires user approval.',
    { url: S, path: S }, ['url', 'path'])],
}

export const SCHEMAS = Object.values(TOOLS).map(([, s]) => s)

export async function execute(ctx: ToolContext, name: string, args: unknown): Promise<string> {
  const entry = TOOLS[name]
  if (!entry) return `Ошибка: неизвестный инструмент «${name}». Доступны: ${Object.keys(TOOLS).join(', ')}`
  if (!args || typeof args !== 'object' || Array.isArray(args)) return 'Ошибка: arguments должен быть JSON-объектом'
  const props = entry[1].function.parameters
  const missing = props.required.filter((k) => (args as any)[k] == null)
  if (missing.length) return `Ошибка аргументов: не хватает ${missing.join(', ')}`
  try {
    return await entry[0](ctx, args)
  } catch (e) {
    if (e instanceof ToolError) return `Ошибка: ${e.message}`
    if ((e as Error).name === 'AbortError') return 'Отменено пользователем.'
    return `Ошибка: ${(e as Error).name}: ${(e as Error).message}`
  }
}

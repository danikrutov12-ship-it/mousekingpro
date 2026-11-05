// Встроенный терминал: bash в настоящем псевдотерминале через системную утилиту script (без нативных модулей).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readlinkSync } from 'node:fs'
import { COMMAND_ENV } from './jobs'
import { isWin } from './platform'

interface Term { proc: ChildProcess; tty?: string; bash?: number; line?: string; pipe?: boolean }
const terms = new Map<string, Term>()

export function create(cwd: string, cols: number, rows: number, onData: (id: string, d: string) => void, onExit: (id: string) => void): string {
  if (isWin) return createWin(cwd, onData, onExit)
  const id = randomBytes(4).toString('hex')
  const proc = spawn('script', ['-qfec', 'bash -i', '/dev/null'], {
    cwd, env: { ...COMMAND_ENV, TERM: 'xterm-256color', COLUMNS: String(cols), LINES: String(rows), PAGER: 'less' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const t: Term = { proc }
  terms.set(id, t)
  proc.stdout!.on('data', (b: Buffer) => onData(id, b.toString('utf-8')))
  proc.stderr!.on('data', (b: Buffer) => onData(id, b.toString('utf-8')))
  proc.on('close', () => {
    terms.delete(id)
    onExit(id)
  })
  // находим терминал bash, чтобы менять размер окна (stty) при изменении панели
  setTimeout(() => {
    const child = spawnSync('pgrep', ['-P', String(proc.pid)], { encoding: 'utf-8' }).stdout.trim().split('\n')[0]
    if (!child) return
    t.bash = Number(child)
    try {
      t.tty = readlinkSync(`/proc/${child}/fd/0`)
    } catch {
      // нет доступа к /proc — размер останется начальным
    }
    resize(id, cols, rows)
  }, 400)
  return id
}

/**
 * Windows: PowerShell без псевдотерминала. Ввод собираем построчно и сами показываем набранное
 * (стрелки истории и полноэкранные программы не работают, обычные команды — да).
 */
function createWin(cwd: string, onData: (id: string, d: string) => void, onExit: (id: string) => void): string {
  const id = randomBytes(4).toString('hex')
  const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '-'], {
    cwd, env: { ...COMMAND_ENV }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const t: Term = { proc, line: '', pipe: true }
  terms.set(id, t)
  proc.on('echo', (d: string) => onData(id, d))
  const out = (b: Buffer) => onData(id, b.toString('utf-8').replace(/\r?\n/g, '\r\n'))
  proc.stdout!.on('data', out)
  proc.stderr!.on('data', out)
  proc.on('close', () => {
    terms.delete(id)
    onExit(id)
  })
  proc.stdin!.write('[Console]::OutputEncoding=[Text.Encoding]::UTF8; function prompt { "PS $($PWD.Path)> " }\n')
  setTimeout(() => onData(id, `PowerShell · ${cwd}\r\nPS ${cwd}> `), 300)
  return id
}

export function write(id: string, data: string) {
  const t = terms.get(id)
  if (!t) return
  if (!t.pipe) return void t.proc.stdin?.write(data)
  for (const ch of data) {
    if (ch === '\r') {
      t.proc.stdin!.write(t.line + '\n')
      // после команды печатаем приглашение сами: PowerShell в режиме каналов его не выводит
      t.proc.stdin!.write('Write-Host -NoNewline ("PS " + $PWD.Path + "> ")\n')
      t.line = ''
      t.proc.emit('echo', '\r\n')
    } else if (ch === '\x7f' || ch === '\b') {
      if (t.line) {
        t.line = t.line.slice(0, -1)
        t.proc.emit('echo', '\b \b')
      }
    } else if (ch === '\x03') {
      t.line = ''
      t.proc.emit('echo', '^C\r\n')
    } else if (ch >= ' ') {
      t.line += ch
      t.proc.emit('echo', ch)
    }
  }
}

export function resize(id: string, cols: number, rows: number) {
  const t = terms.get(id)
  if (!t?.tty?.startsWith('/dev/pts/')) return
  spawnSync('stty', ['-F', t.tty, 'cols', String(cols), 'rows', String(rows)])
  if (t.bash) {
    try {
      process.kill(t.bash, 'SIGWINCH')
    } catch {
      // процесс уже завершился
    }
  }
}

export function kill(id: string) {
  const t = terms.get(id)
  if (!t) return
  try {
    t.proc.kill('SIGHUP')
  } catch {
    // уже закрыт
  }
  terms.delete(id)
}

export const killAll = () => [...terms.keys()].forEach(kill)

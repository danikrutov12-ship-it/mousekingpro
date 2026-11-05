// Фоновые задачи: долгие команды (деплой, сборка, сервер), которые агент запускает и проверяет позже.
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { Job } from '@shared/types'
import { killTree, shellArgv, spawnOpts } from './platform'
import { mask } from './secrets'

const MAX_LOG = 400_000 // символов вывода в памяти на задачу

interface Entry extends Job { proc: ChildProcess | null; log: string }

const jobs = new Map<string, Entry>()
let onChange: () => void = () => {}

export function setJobsListener(fn: () => void) {
  onChange = fn
}

/** Переменные окружения для неинтерактивного запуска: никаких вопросов в терминале и пейджеров. */
export const COMMAND_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  DEBIAN_FRONTEND: 'noninteractive',
  ELECTRON_RUN_AS_NODE: undefined,
} as NodeJS.ProcessEnv

const view = ({ proc: _p, log: _l, ...job }: Entry): Job => job

/** argv — что запускать (по умолчанию bash -c command), env — дополнительные переменные (секреты). */
export function startJob(command: string, cwd: string, name: string, chatId: string,
  opts: { argv?: string[]; env?: Record<string, string> } = {}): Job {
  const id = randomBytes(4).toString('hex')
  const [bin, ...args] = opts.argv || shellArgv(command)
  const proc = spawn(bin, args, { cwd, ...spawnOpts, stdio: ['ignore', 'pipe', 'pipe'], env: { ...COMMAND_ENV, ...opts.env } })
  const job: Entry = { id, name: name || command.slice(0, 60), command, cwd, chatId, started: Date.now(), status: 'running', code: null, proc, log: '' }
  const append = (b: Buffer) => {
    job.log += b.toString('utf-8')
    if (job.log.length > MAX_LOG) job.log = '…\n' + job.log.slice(-MAX_LOG)
  }
  proc.stdout!.on('data', append)
  proc.stderr!.on('data', append)
  proc.on('close', (code, signal) => {
    job.status = job.status === 'stopped' ? 'stopped' : code === 0 ? 'done' : 'failed'
    job.code = code ?? (signal ? -1 : null)
    job.ended = Date.now()
    job.proc = null
    onChange()
  })
  proc.on('error', (e) => {
    job.log += `\nОшибка запуска: ${e.message}`
    job.status = 'failed'
    job.proc = null
    onChange()
  })
  jobs.set(id, job)
  onChange()
  return view(job)
}

export function jobLog(id: string, lines = 60): string | null {
  const job = jobs.get(id)
  if (!job) return null
  return mask(job.log.split('\n').slice(-Math.max(1, lines)).join('\n'))
}

export function getJob(id: string): Job | null {
  const job = jobs.get(id)
  return job ? view(job) : null
}

export function listJobs(): Job[] {
  return [...jobs.values()].map(view).sort((a, b) => b.started - a.started)
}

export function stopJob(id: string): boolean {
  const job = jobs.get(id)
  if (!job?.proc) return false
  job.status = 'stopped'
  killTree(job.proc.pid, 'SIGTERM')
  setTimeout(() => job.proc && killTree(job.proc.pid), 3000)
  onChange()
  return true
}

export function clearFinished() {
  for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id)
  onChange()
}

/** При выходе из приложения останавливаем всё, что ещё работает. */
export function stopAll() {
  for (const j of jobs.values()) {
    if (!j.proc) continue
    killTree(j.proc.pid, 'SIGTERM')
  }
}

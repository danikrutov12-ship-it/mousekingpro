// Обновления из GitHub-релизов (danikrutov12-ship-it/mousekingpro).
// Установленная программа (AppImage, установщик Windows) обновляется через electron-updater.
// Запуск из исходников (git clone + run.sh) обновляется через git pull и пересборку.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { isWin, shellArgv } from './platform'

export const REPO = 'danikrutov12-ship-it/mousekingpro'
const RELEASES = `https://github.com/${REPO}/releases`
const CHECK_EVERY = 6 * 3600_000

const SOURCE_ROOT = resolve(__dirname, '../../..') // папка репозитория при запуске из исходников
type Mode = UpdateState['mode']

function detectMode(): Mode {
  if (!app.isPackaged) return existsSync(join(SOURCE_ROOT, '.git')) ? 'source' : 'manual'
  if (isWin || process.env.APPIMAGE) return 'installer'
  return 'manual'
}

let state: UpdateState = { status: 'idle', current: app.getVersion(), mode: detectMode() }
let listener: (s: UpdateState) => void = () => {}
const emit = (patch: Partial<UpdateState>) => {
  state = { ...state, ...patch }
  listener(state)
}
export const getState = () => state

/** 2.1.0 > 2.0.9 */
export function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n) || 0)
  const pb = b.replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  }
  return false
}

export async function check(manual = false): Promise<UpdateState> {
  if (['downloading', 'ready'].includes(state.status)) return state
  if (manual) emit({ status: 'checking', error: undefined })
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'mouse-king-pro' },
      signal: AbortSignal.timeout(20_000),
    })
    if (r.status === 404) return emit({ status: 'latest' }), state // релизов ещё нет
    if (!r.ok) throw new Error(`GitHub ответил ${r.status}`)
    const rel = (await r.json()) as { tag_name: string; body?: string; html_url: string }
    const version = rel.tag_name.replace(/^v/, '')
    if (newer(version, state.current)) {
      emit({ status: 'available', version, notes: (rel.body || '').slice(0, 4000), url: rel.html_url, error: undefined })
    } else emit({ status: 'latest', version })
  } catch (e) {
    // молча при фоновой проверке (нет сети), с ошибкой — если нажали «Проверить»
    emit(manual ? { status: 'error', error: (e as Error).message } : { status: 'idle' })
  }
  return state
}

export async function download() {
  if (state.status !== 'available' && state.status !== 'error') return
  if (state.mode === 'manual') return void shell.openExternal(state.url || RELEASES)
  emit({ status: 'downloading', percent: 0, error: undefined })
  try {
    if (state.mode === 'installer') {
      await autoUpdater.checkForUpdates()
      await autoUpdater.downloadUpdate()
    } else {
      await updateSource()
      emit({ status: 'ready', percent: 100 })
    }
  } catch (e) {
    emit({ status: 'error', error: (e as Error).message.split('\n')[0].slice(0, 300) })
  }
}

export function install() {
  if (state.status !== 'ready') return
  if (state.mode === 'installer') {
    // isSilent=false: на Windows покажется окно установщика; isForceRunAfter: запустить после установки
    return autoUpdater.quitAndInstall(false, true)
  }
  app.relaunch()
  app.exit(0)
}

/** git pull + npm install (если менялись зависимости) + сборка. */
async function updateSource() {
  const run = (cmd: string, cwd: string, pct: number) =>
    new Promise<string>((ok, fail) => {
      const nodeBin = join(homedir(), '.local', 'lib', 'nodejs', 'current', 'bin')
      const PATH = [nodeBin, process.env.PATH].filter(Boolean).join(delimiter)
      const [bin, ...args] = shellArgv(cmd)
      const p = spawn(bin, args, { cwd, env: { ...process.env, PATH, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true })
      let out = ''
      p.stdout.on('data', (b) => (out += b))
      p.stderr.on('data', (b) => (out += b))
      p.on('error', fail)
      p.on('close', (code) => {
        if (code === 0) {
          emit({ percent: pct })
          ok(out)
        } else fail(new Error(`${cmd}: ${out.trim().split('\n').slice(-3).join(' ')}`))
      })
    })
  const desktop = join(SOURCE_ROOT, 'desktop')
  const before = (await run('git rev-parse HEAD', SOURCE_ROOT, 5)).trim()
  await run('git pull --ff-only', SOURCE_ROOT, 30)
  const changed = await run(`git diff --name-only ${before} HEAD`, SOURCE_ROOT, 35)
  if (/desktop\/package(-lock)?\.json/.test(changed)) await run('npm install --no-audit --no-fund', desktop, 75)
  await run('npx electron-vite build', desktop, 100)
}

export function start(onChange: (s: UpdateState) => void) {
  listener = onChange
  if (state.mode === 'installer') {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('download-progress', (p) => emit({ percent: Math.round(p.percent) }))
    autoUpdater.on('update-downloaded', () => emit({ status: 'ready', percent: 100 }))
    autoUpdater.on('error', (e) => state.status === 'downloading' && emit({ status: 'error', error: e.message.split('\n')[0] }))
  }
  setTimeout(() => check(), 8_000)
  setInterval(() => check(), CHECK_EVERY)
}

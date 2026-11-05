// Различия Windows и Linux в одном месте: оболочка для команд, остановка процессов, поиск программ.
import { spawnSync } from 'node:child_process'

export const isWin = process.platform === 'win32'

/** Как запустить строку-команду: PowerShell на Windows, bash на Linux. */
export function shellArgv(command: string): string[] {
  return isWin
    ? ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      // вывод в UTF-8, чтобы русский текст не превращался в «кракозябры»
      `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ${command}`]
    : ['bash', '-c', command]
}

export const SHELL_NAME = isWin ? 'PowerShell (Windows)' : 'bash (Linux)'

/** Параметры spawn: на Linux — своя группа процессов (чтобы остановить всё дерево), на Windows — без окна консоли. */
export const spawnOpts = isWin ? { windowsHide: true } : { detached: true }

/** Остановить процесс вместе с дочерними. */
export function killTree(pid: number | undefined, signal: NodeJS.Signals = 'SIGKILL') {
  if (!pid) return
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
    else process.kill(-pid, signal)
  } catch {
    // уже завершился
  }
}

/** Есть ли программа в системе. */
export function which(cmd: string): boolean {
  return isWin
    ? spawnSync('where', [cmd], { windowsHide: true }).status === 0
    : spawnSync('bash', ['-c', `command -v ${cmd}`]).status === 0
}

// Git для задач агента: своя ветка на каждый чат, коммит после каждого ответа, слияние и pull request.
import { spawnSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { GitInfo } from '@shared/types'

/** Если в системе не настроены имя и почта для git — подписываем коммиты агента сами. */
function identity(root: string): string[] {
  const has = (k: string) => spawnSync('git', ['config', k], { cwd: root, encoding: 'utf-8' }).stdout.trim()
  return has('user.email') && has('user.name') ? [] : ['-c', 'user.name=Mouse King Pro', '-c', 'user.email=agent@venice.local']
}

function git(root: string, ...args: string[]) {
  if (args[0] === 'commit' || args[0] === 'merge') args = [...identity(root), ...args]
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf-8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 60_000, windowsHide: true })
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}

export const isRepo = (root: string) => existsSync(root) && git(root, 'rev-parse', '--is-inside-work-tree').out === 'true'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/[а-яё]/gi, (c) => {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' }
  return map[c.toLowerCase()] ?? ''
}).replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-+$/, '') || 'task'

export const branchFor = (chatId: string, title: string) => `venice/${slug(title)}-${chatId.slice(0, 6)}`

/** Перед работой агента: переходим на ветку чата (создаём от текущей). Незакоммиченные правки пользователя переезжают с нами. */
export function ensureBranch(root: string, branch: string): { base: string } | null {
  if (!isRepo(root)) return null
  const cur = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').out
  if (cur === branch) return { base: git(root, 'config', `branch.${branch}.venice-base`).out || 'main' }
  const exists = git(root, 'rev-parse', '--verify', '--quiet', branch).ok
  const r = exists ? git(root, 'switch', branch) : git(root, 'switch', '-c', branch)
  if (!r.ok) return null
  if (!exists) git(root, 'config', `branch.${branch}.venice-base`, cur === 'HEAD' ? 'main' : cur)
  return { base: cur }
}

/** Коммит только тех файлов, что менял агент в этом ответе. */
export function commit(root: string, files: string[], message: string): string | null {
  if (!isRepo(root) || !files.length) return null
  const rel = files.filter((f) => f.startsWith(root)).map((f) => relative(root, f))
  if (!rel.length) return null
  git(root, 'add', '-A', '--', ...rel)
  if (git(root, 'diff', '--cached', '--quiet').ok) return null
  const r = git(root, 'commit', '-m', message, '--', ...rel)
  return r.ok ? git(root, 'rev-parse', '--short', 'HEAD').out : null
}

export function info(root: string, branch: string): GitInfo {
  if (!isRepo(root)) return { repo: false }
  const current = git(root, 'rev-parse', '--abbrev-ref', 'HEAD').out
  const base = git(root, 'config', `branch.${branch}.venice-base`).out || 'main'
  const exists = git(root, 'rev-parse', '--verify', '--quiet', branch).ok
  const log = exists ? git(root, 'log', '--format=%h\t%s\t%ct', `${base}..${branch}`, '-n', '30').out : ''
  const remote = git(root, 'remote', 'get-url', 'origin')
  return {
    repo: true, branch, current, base, exists, remote: remote.ok ? remote.out : '',
    commits: log ? log.split('\n').map((l) => { const [hash, subject, when] = l.split('\t'); return { hash, subject, when } }) : [],
    dirty: git(root, 'status', '--porcelain').out.split('\n').filter(Boolean).length,
  }
}

export function init(root: string): boolean {
  if (isRepo(root)) return true
  const r = git(root, 'init', '-b', 'main')
  if (!r.ok) return false
  if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), 'node_modules/\n.venv/\n__pycache__/\n.env\n')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Начальное состояние', '--allow-empty')
  return true
}

export function merge(root: string, branch: string): string {
  const base = git(root, 'config', `branch.${branch}.venice-base`).out || 'main'
  const sw = git(root, 'switch', base)
  if (!sw.ok) return 'Не удалось перейти на ' + base + ': ' + sw.err
  const r = git(root, 'merge', '--no-ff', '-m', `Слияние ${branch}`, branch)
  if (!r.ok) {
    git(root, 'merge', '--abort')
    git(root, 'switch', branch)
    return 'Конфликт при слиянии — остаёмся на ветке задачи. ' + r.err.slice(0, 400)
  }
  return `Ветка ${branch} влита в ${base}`
}

/** Отправка ветки на GitHub/GitLab; ссылку на создание pull request сервер присылает сам. */
export function push(root: string, branch: string): { ok: boolean; text: string; url?: string } {
  const r = git(root, 'push', '-u', 'origin', branch)
  const all = r.out + '\n' + r.err
  const url = /(https:\/\/\S+(?:pull\/new|merge_requests\/new)\S*)/.exec(all)?.[1]
  return { ok: r.ok, text: r.ok ? 'Ветка отправлена' : all.slice(-500), url }
}

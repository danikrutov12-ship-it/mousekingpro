// Поиск по смыслу в коде проекта: куски файлов → эмбеддинги Venice → ближайшие к запросу.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { APP_DIR } from './config'

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', 'dist', 'build', 'out', '.next', '.cache', 'target', 'vendor', 'uploads', 'generated'])
const CODE = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.php', '.rb', '.swift', '.vue', '.svelte', '.html', '.css', '.scss', '.sql', '.sh', '.yaml', '.yml', '.toml', '.json', '.md', '.txt', '.lua', '.dart'])
const LINES = 60
const OVERLAP = 10
const MAX_CHUNKS = 6000

interface Chunk { file: string; start: number; end: number; text: string; vec: number[] }
interface Index { model: string; files: Record<string, string>; chunks: Chunk[] }

const indexPath = (root: string) => join(APP_DIR, 'index', createHash('sha1').update(root).digest('hex').slice(0, 16) + '.json')

function walk(dir: string, out: string[] = []): string[] {
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const n of names) {
    if (n.startsWith('.') && n !== '.github') continue
    const full = join(dir, n)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (!SKIP.has(n)) walk(full, out)
    } else if (CODE.has(extname(n).toLowerCase()) && st.size < 400_000) out.push(full)
  }
  return out
}

const cosine = (a: number[], b: number[]) => {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return dot / (Math.sqrt(na * nb) || 1)
}

type Embed = (texts: string[]) => Promise<number[][]>

/** Обновить индекс: пересчитываем только изменившиеся файлы. */
async function refresh(root: string, model: string, embed: Embed, progress: (s: string) => void): Promise<Index> {
  const path = indexPath(root)
  let idx: Index = { model, files: {}, chunks: [] }
  try {
    const saved = JSON.parse(readFileSync(path, 'utf-8')) as Index
    if (saved.model === model) idx = saved
  } catch {
    // индекса ещё нет
  }
  const files = walk(root)
  const fresh: Record<string, string> = {}
  const changed: string[] = []
  for (const f of files) {
    const st = statSync(f)
    const sig = `${st.size}:${st.mtimeMs}`
    const rel = relative(root, f)
    fresh[rel] = sig
    if (idx.files[rel] !== sig) changed.push(rel)
  }
  const keep = idx.chunks.filter((c) => fresh[c.file] && !changed.includes(c.file))
  const todo: Omit<Chunk, 'vec'>[] = []
  for (const rel of changed) {
    const lines = readFileSync(join(root, rel), 'utf-8').split('\n')
    for (let s = 0; s < lines.length; s += LINES - OVERLAP) {
      const text = lines.slice(s, s + LINES).join('\n').trim()
      if (text.length > 20) todo.push({ file: rel, start: s + 1, end: Math.min(lines.length, s + LINES), text })
      if (s + LINES >= lines.length) break
    }
  }
  if (keep.length + todo.length > MAX_CHUNKS) todo.splice(Math.max(0, MAX_CHUNKS - keep.length))
  const done: Chunk[] = []
  for (let i = 0; i < todo.length; i += 32) {
    progress(`Индексирую проект для поиска по смыслу: ${Math.min(i + 32, todo.length)} из ${todo.length}`)
    const batch = todo.slice(i, i + 32)
    const vecs = await embed(batch.map((c) => `${c.file}\n${c.text}`.slice(0, 4000)))
    batch.forEach((c, j) => done.push({ ...c, vec: vecs[j].map((x) => Math.round(x * 1e4) / 1e4) }))
  }
  idx = { model, files: fresh, chunks: [...keep, ...done] }
  mkdirSync(join(APP_DIR, 'index'), { recursive: true })
  writeFileSync(path, JSON.stringify(idx))
  return idx
}

export async function search(root: string, query: string, k: number, model: string, embed: Embed, progress: (s: string) => void): Promise<string> {
  if (!existsSync(root)) return 'Папка проекта не найдена'
  const idx = await refresh(root, model, embed, progress)
  if (!idx.chunks.length) return 'В проекте нет текстовых файлов кода для поиска'
  const [q] = await embed([query])
  const top = idx.chunks.map((c) => ({ c, score: cosine(q, c.vec) })).sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(k, 20)))
  return top.map(({ c, score }) => `${c.file}:${c.start}-${c.end} (сходство ${score.toFixed(2)})\n${c.text.split('\n').slice(0, 14).join('\n')}`).join('\n\n---\n\n') +
    `\n\n(Проиндексировано фрагментов: ${idx.chunks.length}. Открой нужные места через read_file с offset.)`
}

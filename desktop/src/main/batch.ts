// Пакетная обработка фото: одно действие к множеству файлов, по 2 одновременно, с прогрессом и итоговой папкой.
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { nativeImage } from 'electron'
import type { BatchOp, BatchStatus } from '@shared/types'
import * as gallery from './gallery'
import * as images from './images'
import { freePath } from './store'
import { Venice } from './venice'

const runs = new Map<string, BatchStatus & { cancel: boolean }>()

/** Локальное сжатие и смена формата — бесплатно, без Venice. */
function convert(src: string, op: Extract<BatchOp, { kind: 'convert' }>, dir: string, projectId?: string): string {
  let img = nativeImage.createFromPath(src)
  if (img.isEmpty()) throw new Error('не удалось прочитать картинку')
  const { width, height } = img.getSize()
  if (op.maxSide > 0 && Math.max(width, height) > op.maxSide) {
    const k = op.maxSide / Math.max(width, height)
    img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' })
  }
  const ext = op.format === 'jpeg' ? 'jpg' : 'png'
  const out = freePath(dir, basename(src).replace(/\.[^.]+$/, '') + '.' + ext)
  writeFileSync(out, op.format === 'jpeg' ? img.toJPEG(Math.max(10, Math.min(100, op.quality))) : img.toPNG())
  const parent = gallery.ensure(src, projectId)
  gallery.add({ path: out, prompt: parent.prompt, source: 'batch', parent: parent.id, projectId })
  return out
}

export function start(api: Venice, paths: string[], op: BatchOp, baseDir: string, opts: { projectId?: string; safe: boolean; vision: string },
  onProgress: (s: BatchStatus) => void, onSpend: (usd: number) => void): string {
  const id = randomBytes(4).toString('hex')
  const stamp = new Date().toLocaleString('sv-SE').replace(/[: ]/g, '-').slice(0, 16)
  const outDir = join(baseDir, `batch-${stamp}`)
  mkdirSync(outDir, { recursive: true })
  const st = { id, total: paths.length, done: 0, failed: 0, current: '', running: true, outDir, outputs: [] as string[], errors: [] as string[], texts: [] as { path: string; text: string }[], cost: 0, cancel: false }
  runs.set(id, st)
  const ctx = { projectId: opts.projectId, safe: opts.safe, dir: outDir }
  const emit = () => onProgress({ ...st })
  const queue = [...paths]
  const worker = async () => {
    while (queue.length && !st.cancel) {
      const src = queue.shift()!
      st.current = basename(src)
      emit()
      try {
        let cost: number | null = null
        if (op.kind === 'convert') st.outputs.push(convert(src, op, outDir, opts.projectId))
        else if (op.kind === 'describe') {
          const r = await images.describe(api, src, op.task, opts.vision)
          st.texts.push({ path: src, text: r.text })
          cost = r.cost
        } else {
          const r = op.kind === 'upscale' ? await images.upscale(api, src, op.scale, ctx)
            : op.kind === 'background' ? await images.background(api, src, ctx)
            : await images.edit(api, src, op.prompt, op.model, ctx)
          st.outputs.push(...r.paths)
          cost = r.cost
        }
        if (cost) {
          st.cost += cost
          onSpend(cost)
        }
      } catch (e) {
        st.failed++
        st.errors.push(`${basename(src)}: ${(e as Error).message.slice(0, 200)}`)
      }
      st.done++
      emit()
    }
  }
  Promise.all([worker(), worker()]).then(() => {
    st.running = false
    st.current = ''
    // описания — ещё и файлом рядом, чтобы удобно скопировать
    if (st.texts.length) writeFileSync(join(outDir, 'описания.txt'), st.texts.map((t) => `${basename(t.path)}\n${t.text}\n`).join('\n'), 'utf-8')
    emit()
  })
  return id
}

export function cancel(id: string) {
  const st = runs.get(id)
  if (st) st.cancel = true
}

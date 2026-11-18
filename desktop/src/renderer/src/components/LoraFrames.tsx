import { Check, Film, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { hashDistance, type LoraStage, type StageInfo } from '@shared/lora'
import { toast } from '../lib/actions'
import { api } from '../lib/api'
import { Modal } from './Modal'

interface Cand { t: number; sharp: number; hash: string; thumb: string }

/** Резкость (дисперсия лапласиана) и dHash кадра — те же формулы, что в main/lora.ts. */
function metrics(ctx: CanvasRenderingContext2D, w: number, h: number): { sharp: number; hash: string } {
  const px = ctx.getImageData(0, 0, w, h).data
  const g = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]
  let s = 0, s2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = g[i - 1] + g[i + 1] + g[i - w] + g[i + w] - 4 * g[i]
      s += l
      s2 += l * l
      n++
    }
  }
  const t = document.createElement('canvas')
  t.width = 9
  t.height = 8
  const tc = t.getContext('2d', { willReadFrequently: true })!
  tc.drawImage(ctx.canvas, 0, 0, 9, 8)
  const q = tc.getImageData(0, 0, 9, 8).data
  const v = (x: number, y: number) => 0.299 * q[(y * 9 + x) * 4] + 0.587 * q[(y * 9 + x) * 4 + 1] + 0.114 * q[(y * 9 + x) * 4 + 2]
  let hash = ''
  for (let y = 0; y < 8; y++) {
    let b = 0
    for (let x = 0; x < 8; x++) b = (b << 1) | (v(x, y) > v(x + 1, y) ? 1 : 0)
    hash += b.toString(16).padStart(2, '0')
  }
  return { sharp: n ? Math.round(s2 / n - (s / n) ** 2) : 0, hash }
}

const seek = (v: HTMLVideoElement, t: number) => new Promise<void>((ok) => {
  const done = () => {
    v.removeEventListener('seeked', done)
    ok()
  }
  v.addEventListener('seeked', done)
  v.currentTime = t
})

/** Лучшие кадры: по убыванию резкости, без похожих друг на друга и не ближе 0.8 с. */
function pickBest(c: Cand[], n: number): number[] {
  const order = c.map((x, i) => i).sort((a, b) => c[b].sharp - c[a].sharp)
  const out: number[] = []
  for (const i of order) {
    if (out.length >= n) break
    if (out.some((j) => Math.abs(c[j].t - c[i].t) < 0.8 || hashDistance(c[j].hash, c[i].hash) <= 8)) continue
    out.push(i)
  }
  return out.sort((a, b) => c[a].t - c[b].t)
}

/** Отбор кадров из видео: сканируем, предлагаем самые резкие и разные, пользователь отмечает нужные. */
export function LoraFrames({ projectId, videos, stages, stage: stage0, onDone }: {
  projectId: string; videos: string[]; stages: StageInfo[]; stage: LoraStage; onDone(): void
}) {
  const [idx, setIdx] = useState(0)
  const [phase, setPhase] = useState<'load' | 'scan' | 'pick' | 'save'>('load')
  const [progress, setProgress] = useState(0)
  const [cands, setCands] = useState<Cand[]>([])
  const [chosen, setChosen] = useState<number[]>([])
  const [count, setCount] = useState(12)
  const [stage, setStage] = useState<LoraStage>(stage0)
  const vid = useRef<HTMLVideoElement>(null)
  const url = useRef('')
  const path = videos[idx]
  const name = path?.split(/[\\/]/).pop()

  useEffect(() => {
    if (!path) return
    let alive = true
    setPhase('load')
    setCands([])
    setChosen([])
    setProgress(0)
    ;(async () => {
      try {
        const bytes = await api.lora.readVideo(path)
        if (!alive) return
        URL.revokeObjectURL(url.current)
        url.current = URL.createObjectURL(new Blob([bytes as BlobPart]))
        const v = vid.current!
        v.src = url.current
        await new Promise<void>((ok, fail) => {
          v.onloadeddata = () => ok()
          v.onerror = () => fail(new Error('видео не открылось — формат не поддерживается'))
        })
        setPhase('scan')
        const d = v.duration || 0
        const step = Math.max(0.4, d / 160)
        const w = Math.min(512, v.videoWidth)
        const h = Math.round((v.videoHeight / v.videoWidth) * w)
        const c = document.createElement('canvas')
        c.width = w
        c.height = h
        const ctx = c.getContext('2d', { willReadFrequently: true })!
        const out: Cand[] = []
        for (let t = Math.min(0.2, d / 2); t < d - 0.05; t += step) {
          if (!alive) return
          await seek(v, t)
          ctx.drawImage(v, 0, 0, w, h)
          const m = metrics(ctx, w, h)
          out.push({ t, ...m, thumb: c.toDataURL('image/jpeg', 0.6) })
          setProgress(Math.min(1, t / d))
        }
        if (!alive) return
        setCands(out)
        const n = Math.min(count, Math.max(1, Math.ceil(d / 2)))
        setChosen(pickBest(out, n))
        setPhase('pick')
      } catch (e) {
        toast(`${name}: ${(e as Error).message}`, 'error')
        next()
      }
    })()
    return () => {
      alive = false
    }
  }, [path])

  useEffect(() => () => URL.revokeObjectURL(url.current), [])

  const next = () => {
    if (idx + 1 < videos.length) setIdx(idx + 1)
    else onDone()
  }

  const save = async () => {
    const v = vid.current!
    setPhase('save')
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d')!
    const files: { data: Uint8Array; origin: string }[] = []
    for (const i of chosen) {
      await seek(v, cands[i].t)
      ctx.drawImage(v, 0, 0)
      const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), 'image/png'))
      files.push({ data: new Uint8Array(await blob.arrayBuffer()), origin: `${name} @ ${cands[i].t.toFixed(1)} с` })
    }
    const r = await api.lora.addData(projectId, files, stage, 'video')
    toast(`Из «${name}» добавлено кадров: ${r.added}`, 'ok')
    next()
  }

  const toggle = (i: number) => setChosen((x) => (x.includes(i) ? x.filter((j) => j !== i) : [...x, i].sort((a, b) => cands[a].t - cands[b].t)))

  return (
    <Modal open onClose={onDone} width={1040} icon={<Film size={18} />}
      title={`Кадры из видео${videos.length > 1 ? ` (${idx + 1} из ${videos.length})` : ''}: ${name}`}
      footer={phase === 'pick' ? <>
        <span className="sub" style={{ marginRight: 'auto' }}>
          Предложены самые резкие и непохожие кадры. Нажмите на кадр, чтобы добавить или убрать. Видео с телефона мягче фото — лучше меньше, но резче.
        </span>
        <label className="lora-inline">Этап
          <select className="input" value={stage} onChange={(e) => setStage(e.target.value as LoraStage)}>
            {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <button className="btn ghost" onClick={next}>Пропустить</button>
        <button className="btn primary" disabled={!chosen.length} onClick={save}><Check size={14} />Добавить {chosen.length}</button>
      </> : undefined}>
      <video ref={vid} muted playsInline preload="auto" style={{ display: 'none' }} />
      {phase !== 'pick' ? (
        <div className="lora-scan">
          <Loader2 size={22} className="spin" />
          <div>{phase === 'load' ? 'Открываю видео…' : phase === 'scan' ? `Ищу резкие кадры… ${Math.round(progress * 100)}%` : 'Сохраняю кадры в полном размере…'}</div>
          {phase === 'scan' && <div className="lora-bar"><span style={{ width: `${progress * 100}%` }} /></div>}
        </div>
      ) : (
        <div className="lora-frames-body">
          <div className="lora-inline" style={{ marginBottom: 10 }}>
            Предложить
            <input type="range" className="range" min={4} max={40} value={count} onChange={(e) => {
              const n = Number(e.target.value)
              setCount(n)
              setChosen(pickBest(cands, n))
            }} />
            <b>{count}</b> кадров из {cands.length} просмотренных
          </div>
          <div className="lora-frames">
            {cands.map((c, i) => (
              <button key={i} className={`lora-frame ${chosen.includes(i) ? 'on' : ''}`} onClick={() => toggle(i)} title={`${c.t.toFixed(1)} с · резкость ${c.sharp}`}>
                <img src={c.thumb} />
                <span className="t">{c.t.toFixed(1)} с</span>
                {chosen.includes(i) && <span className="g-check on"><Check size={14} /></span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  )
}

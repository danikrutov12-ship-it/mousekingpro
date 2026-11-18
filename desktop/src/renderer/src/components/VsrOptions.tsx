import { Eraser, Pause, Play, ScanText, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/types'
import { VSR_INLINE_MAX_BYTES, VSR_MAX_SECONDS, VSR_MODES, vsrAreasFor, vsrMode, type VsrArea } from '@shared/vsr'
import { saveSettings } from '../lib/actions'
import { api } from '../lib/api'
import { fileUrl, videoDuration } from '../lib/format'
import { set, useApp } from '../lib/store'
import { Modal } from './Modal'

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

/** «Убрать текст с видео»: алгоритм, рамки, предупреждения. */
export function VsrOptions({ video }: { video: Attachment | undefined }) {
  const modeId = useApp((s) => s.settings?.vsr_mode)
  const areas = useApp((s) => vsrAreasFor(video?.path, s))
  const [dur, setDur] = useState(0)
  const [s3, setS3] = useState<boolean | null>(null)
  const [editor, setEditor] = useState(false)
  const mode = vsrMode(modeId)
  useEffect(() => {
    api.runpod.s3().then((v) => setS3(!!v)).catch(() => setS3(false))
  }, [])
  useEffect(() => {
    setDur(0)
    if (video) videoDuration(video.path).then(setDur)
  }, [video?.path])
  return (
    <div className="pro-opts">
      <div className="pro-note">Удаляет субтитры, надписи и логотипы с видео до 10 минут — на вашем RunPod. Звук сохраняется.</div>
      <div className="options">
        {VSR_MODES.map((m) => (
          <label key={m.id} className={`chip-toggle ${m.id === mode.id ? 'on' : ''}`} title={m.note}>
            <input type="radio" checked={m.id === mode.id} onChange={() => saveSettings({ vsr_mode: m.id })} />{m.name}
          </label>
        ))}
      </div>
      <div className="pro-note">{mode.note}</div>
      <div className="options">
        <button className="btn" disabled={!video} onClick={() => setEditor(true)}>
          <ScanText size={14} />{areas.length ? `Рамок: ${areas.length} — изменить` : 'Выделить текст на видео'}
        </button>
        {areas.length > 0 && (
          <button className="btn ghost" onClick={() => set({ vsrAreas: [] })}><X size={14} />Убрать рамки</button>
        )}
      </div>
      {!video && <div className="opt-warn">Прикрепите видео (mp4, mov, webm, mkv), затем выделите на нём текст.</div>}
      {video && !areas.length && (
        <div className="opt-hint">
          Рамки нет — текст будет найден автоматически по всему кадру{mode.id === 'sttn-auto' ? ' (для этого STTN включит поиск текста)' : ''}. Рамка надёжнее: детектор может пропустить мелкие или стилизованные надписи.
        </div>
      )}
      {dur > VSR_MAX_SECONDS && <div className="opt-warn">Видео {fmtTime(dur)} — больше 10 минут. Обрежьте его или разбейте на части.</div>}
      {video && s3 === false && (video.size || 0) > VSR_INLINE_MAX_BYTES && (
        <div className="opt-warn">Видео больше 7 МБ: нужен S3-ключ RunPod (Настройки → RunPod / WaveSpeed), иначе файл не передать.</div>
      )}
      {editor && video && <VsrAreaEditor path={video.path} onClose={() => setEditor(false)} />}
    </div>
  )
}

/** Выделение рамок поверх кадра: ползунком ищем кадр с текстом, мышкой обводим. */
function VsrAreaEditor({ path, onClose }: { path: string; onClose(): void }) {
  const initial = useApp((s) => vsrAreasFor(path, s))
  const [rects, setRects] = useState<VsrArea[]>(initial)
  const [draft, setDraft] = useState<VsrArea | null>(null)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [playing, setPlaying] = useState(false)
  const vid = useRef<HTMLVideoElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const start = useRef<[number, number] | null>(null)

  const at = (e: React.PointerEvent): [number, number] => {
    const r = box.current!.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]
  }
  const norm = (a: [number, number], b: [number, number]): VsrArea => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])]
  const done = () => {
    set({ vsrFor: path, vsrAreas: rects })
    onClose()
  }
  const toggle = () => {
    const v = vid.current
    if (!v) return
    if (v.paused) v.play()
    else v.pause()
  }

  return (
    <Modal open onClose={onClose} title="Где текст на видео" icon={<ScanText size={18} />} width={980}
      footer={<>
        <span className="sub" style={{ marginRight: 'auto' }}>Обведите мышкой каждую надпись. Рамку лучше брать с небольшим запасом — субтитры разной длины.</span>
        <button className="btn ghost" disabled={!rects.length} onClick={() => setRects([])}><Trash2 size={14} />Очистить</button>
        <button className="btn primary" onClick={done}><Eraser size={14} />Готово{rects.length ? ` (${rects.length})` : ''}</button>
      </>}>
      <div className="vsr-editor">
        <div className="vsr-stage">
          <div ref={box} className="vsr-box"
            onPointerDown={(e) => {
              if ((e.target as HTMLElement).closest('.vsr-x')) return
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              start.current = at(e)
              setDraft(norm(start.current, start.current))
            }}
            onPointerMove={(e) => start.current && setDraft(norm(start.current, at(e)))}
            onPointerUp={(e) => {
              if (!start.current) return
              const r = norm(start.current, at(e))
              start.current = null
              setDraft(null)
              if (r[2] - r[0] > 0.01 && r[3] - r[1] > 0.01) setRects((x) => [...x, r])
            }}>
            <video ref={vid} src={fileUrl(path)} muted playsInline preload="auto"
              onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
              onTimeUpdate={(e) => setT(e.currentTarget.currentTime)}
              onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} />
            {rects.map((r, i) => (
              <div key={i} className="vsr-rect" style={{ left: `${r[0] * 100}%`, top: `${r[1] * 100}%`, width: `${(r[2] - r[0]) * 100}%`, height: `${(r[3] - r[1]) * 100}%` }}>
                <button className="vsr-x" title="Убрать рамку" onClick={() => setRects((x) => x.filter((_, j) => j !== i))}><X size={11} /></button>
              </div>
            ))}
            {draft && <div className="vsr-rect draft" style={{ left: `${draft[0] * 100}%`, top: `${draft[1] * 100}%`, width: `${(draft[2] - draft[0]) * 100}%`, height: `${(draft[3] - draft[1]) * 100}%` }} />}
          </div>
        </div>
        <div className="vsr-seek">
          <button className="icon-btn sm" onClick={toggle} title={playing ? 'Пауза' : 'Смотреть'}>{playing ? <Pause size={14} /> : <Play size={14} />}</button>
          <input type="range" className="range" min={0} max={dur || 1} step={0.04} value={t}
            onChange={(e) => {
              const v = vid.current
              if (v) v.currentTime = Number(e.target.value)
              setT(Number(e.target.value))
            }} />
          <span className="sub mono">{fmtTime(t)} / {fmtTime(dur)}</span>
        </div>
      </div>
    </Modal>
  )
}

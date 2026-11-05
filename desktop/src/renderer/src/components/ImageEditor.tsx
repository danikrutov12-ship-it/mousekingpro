import { FlipHorizontal, Loader2, RotateCcw, RotateCw, Save, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from '../lib/actions'
import { api } from '../lib/api'
import { fileUrl, baseName } from '../lib/format'

const ASPECTS: [string, number | null][] = [['Свободно', null], ['1:1', 1], ['4:5 пост', 4 / 5], ['9:16 сторис', 9 / 16], ['16:9', 16 / 9], ['3:2', 3 / 2]]

interface Crop { x: number; y: number; w: number; h: number } // доли от размера (после поворота)

/** Локальный редактор: обрезка, поворот, отражение, цвет, размер и формат. Без запросов к Venice. */
export function ImageEditor({ path, onClose, onSaved }: { path: string; onClose(): void; onSaved(newPath: string): void }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [rot, setRot] = useState(0)
  const [flip, setFlip] = useState(false)
  const [aspect, setAspect] = useState<number | null>(null)
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, w: 1, h: 1 })
  const [adj, setAdj] = useState({ brightness: 100, contrast: 100, saturate: 100 })
  const [format, setFormat] = useState<'png' | 'jpeg' | 'webp'>(/\.png$/i.test(path) ? 'png' : 'jpeg')
  const [quality, setQuality] = useState(90)
  const [maxSide, setMaxSide] = useState(0)
  const [saving, setSaving] = useState(false)
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ mode: 'move' | 'resize'; sx: number; sy: number; start: Crop } | null>(null)

  useEffect(() => {
    const i = new Image()
    i.onload = () => setImg(i)
    i.src = fileUrl(path)
  }, [path])

  const ow = img ? (rot % 180 ? img.naturalHeight : img.naturalWidth) : 1
  const oh = img ? (rot % 180 ? img.naturalWidth : img.naturalHeight) : 1
  const filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturate}%)`

  /** Рисуем картинку с поворотом, отражением и цветом на холст нужного размера. */
  const draw = (c: HTMLCanvasElement, scale: number) => {
    if (!img) return
    c.width = Math.round(ow * scale)
    c.height = Math.round(oh * scale)
    const ctx = c.getContext('2d')!
    ctx.filter = filter
    ctx.translate(c.width / 2, c.height / 2)
    ctx.rotate((rot * Math.PI) / 180)
    if (flip) ctx.scale(-1, 1)
    ctx.drawImage(img, (-img.naturalWidth * scale) / 2, (-img.naturalHeight * scale) / 2, img.naturalWidth * scale, img.naturalHeight * scale)
  }

  useEffect(() => {
    if (!img || !canvas.current || !stage.current) return
    const box = stage.current.getBoundingClientRect()
    draw(canvas.current, Math.min((box.width - 20) / ow, (box.height - 20) / oh, 1))
  }, [img, rot, flip, filter])

  // выбор пропорции — самая большая рамка нужной формы по центру
  const applyAspect = (a: number | null) => {
    setAspect(a)
    if (!a) return setCrop({ x: 0, y: 0, w: 1, h: 1 })
    const ratio = a / (ow / oh)
    const [w, h] = ratio > 1 ? [1, 1 / ratio] : [ratio, 1]
    setCrop({ x: (1 - w) / 2, y: (1 - h) / 2, w, h })
  }
  useEffect(() => applyAspect(aspect), [rot])

  const onMove = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d || !canvas.current) return
    const r = canvas.current.getBoundingClientRect()
    const dx = (e.clientX - d.sx) / r.width
    const dy = (e.clientY - d.sy) / r.height
    if (d.mode === 'move') {
      setCrop({ ...d.start, x: Math.max(0, Math.min(1 - d.start.w, d.start.x + dx)), y: Math.max(0, Math.min(1 - d.start.h, d.start.y + dy)) })
    } else {
      let w = Math.max(0.05, Math.min(1 - d.start.x, d.start.w + dx))
      let h = Math.max(0.05, Math.min(1 - d.start.y, d.start.h + dy))
      if (aspect) {
        h = (w * (ow / oh)) / aspect
        if (d.start.y + h > 1) {
          h = 1 - d.start.y
          w = (h * aspect) / (ow / oh)
        }
      }
      setCrop({ ...d.start, w, h })
    }
  }

  const save = async () => {
    if (!img) return
    setSaving(true)
    const full = document.createElement('canvas')
    draw(full, 1)
    const cx = Math.round(crop.x * ow)
    const cy = Math.round(crop.y * oh)
    const cw = Math.round(crop.w * ow)
    const ch = Math.round(crop.h * oh)
    const k = maxSide > 0 && Math.max(cw, ch) > maxSide ? maxSide / Math.max(cw, ch) : 1
    const out = document.createElement('canvas')
    out.width = Math.round(cw * k)
    out.height = Math.round(ch * k)
    const ctx = out.getContext('2d')!
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(full, cx, cy, cw, ch, 0, 0, out.width, out.height)
    const blob: Blob = await new Promise((r) => out.toBlob((b) => r(b!), `image/${format}`, quality / 100))
    try {
      const p = await api.gallery.saveImage(path, new Uint8Array(await blob.arrayBuffer()), format === 'jpeg' ? 'jpg' : format)
      toast(`Сохранено новой версией: ${baseName(p)} (${out.width}×${out.height})`, 'ok')
      onSaved(p)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
    setSaving(false)
  }

  const slider = (key: keyof typeof adj, label: string) => (
    <label className="ed-slider"><span>{label}</span>
      <input type="range" className="range" min={0} max={200} value={adj[key]} onChange={(e) => setAdj({ ...adj, [key]: Number(e.target.value) })} />
      <em>{adj[key] - 100 > 0 ? '+' : ''}{adj[key] - 100}</em>
    </label>
  )

  return (
    <div className="viewer-scrim" style={{ zIndex: 95 }}>
      <div className="editor-modal">
        <div className="ed-stage" ref={stage} onMouseMove={onMove} onMouseUp={() => (drag.current = null)} onMouseLeave={() => (drag.current = null)}>
          {!img && <Loader2 className="spin" />}
          <div className="ed-canvas-wrap">
            <canvas ref={canvas} />
            {img && (
              <div className="ed-crop" style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
                onMouseDown={(e) => (drag.current = { mode: 'move', sx: e.clientX, sy: e.clientY, start: crop })}>
                <span className="ed-handle" onMouseDown={(e) => {
                  e.stopPropagation()
                  drag.current = { mode: 'resize', sx: e.clientX, sy: e.clientY, start: crop }
                }} />
              </div>
            )}
          </div>
        </div>
        <div className="ed-side">
          <div className="row-end"><b style={{ flex: 1 }}>Редактор</b><button className="icon-btn sm" onClick={onClose}><X size={16} /></button></div>
          <div className="list-title">Кадрирование</div>
          <div className="chips-row">{ASPECTS.map(([l, a]) => <button key={l} className={`filter ${aspect === a ? 'on' : ''}`} onClick={() => applyAspect(a)}>{l}</button>)}</div>
          <div className="row-end" style={{ marginTop: 8 }}>
            <button className="btn" title="Повернуть влево" onClick={() => setRot((rot + 270) % 360)}><RotateCcw size={15} /></button>
            <button className="btn" title="Повернуть вправо" onClick={() => setRot((rot + 90) % 360)}><RotateCw size={15} /></button>
            <button className={`btn ${flip ? 'primary' : ''}`} title="Отразить" onClick={() => setFlip(!flip)}><FlipHorizontal size={15} /></button>
          </div>
          <div className="list-title">Цвет</div>
          {slider('brightness', 'Яркость')}
          {slider('contrast', 'Контраст')}
          {slider('saturate', 'Насыщенность')}
          <div className="list-title">Сохранение</div>
          <div className="seg">{(['png', 'jpeg', 'webp'] as const).map((f) => <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}</div>
          {format !== 'png' && <label className="ed-slider"><span>Качество</span><input type="range" className="range" min={40} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} /><em>{quality}</em></label>}
          <label className="ed-slider"><span>Длинная сторона</span>
            <select className="input" style={{ height: 30, padding: '0 8px' }} value={maxSide} onChange={(e) => setMaxSide(Number(e.target.value))}>
              <option value={0}>как есть</option><option value={4096}>4096</option><option value={2048}>2048</option><option value={1080}>1080</option><option value={800}>800</option>
            </select>
          </label>
          <div className="sub">Итог: {Math.round(crop.w * ow * (maxSide && Math.max(crop.w * ow, crop.h * oh) > maxSide ? maxSide / Math.max(crop.w * ow, crop.h * oh) : 1))} × {Math.round(crop.h * oh * (maxSide && Math.max(crop.w * ow, crop.h * oh) > maxSide ? maxSide / Math.max(crop.w * ow, crop.h * oh) : 1))} px</div>
          <div style={{ flex: 1 }} />
          <button className="btn primary" disabled={!img || saving} onClick={save}>{saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />}Сохранить новой версией</button>
          <div className="sub">Оригинал не меняется.</div>
        </div>
      </div>
    </div>
  )
}

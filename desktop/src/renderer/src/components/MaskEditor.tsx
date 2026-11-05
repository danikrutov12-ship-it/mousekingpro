import { Brush, Eraser, RotateCcw, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { fileUrl } from '../lib/format'

/** Кисть: закрашиваете область, которую нужно изменить. Получается маска (белое — менять, чёрное — не трогать). */
export function MaskEditor({ path, onDone, onClose }: { path: string; onDone(mask: Uint8Array): void; onClose(): void }) {
  const view = useRef<HTMLCanvasElement>(null)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [size, setSize] = useState(40)
  const [erase, setErase] = useState(false)
  const [painted, setPainted] = useState(false)
  const mask = useRef<HTMLCanvasElement>(document.createElement('canvas'))
  const last = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const i = new Image()
    i.onload = () => {
      mask.current.width = i.naturalWidth
      mask.current.height = i.naturalHeight
      const m = mask.current.getContext('2d')!
      m.fillStyle = '#000'
      m.fillRect(0, 0, i.naturalWidth, i.naturalHeight)
      setImg(i)
    }
    i.src = fileUrl(path)
  }, [path])

  const redraw = () => {
    const c = view.current
    if (!c || !img) return
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    ctx.drawImage(img, 0, 0, c.width, c.height)
    // поверх — выделенная область полупрозрачным акцентом
    const tmp = document.createElement('canvas')
    tmp.width = c.width
    tmp.height = c.height
    const t = tmp.getContext('2d')!
    t.drawImage(mask.current, 0, 0, c.width, c.height)
    t.globalCompositeOperation = 'source-in'
    const d = t.getImageData(0, 0, c.width, c.height)
    for (let i = 0; i < d.data.length; i += 4) {
      const white = d.data[i] > 128
      d.data[i] = 224; d.data[i + 1] = 110; d.data[i + 2] = 70; d.data[i + 3] = white ? 140 : 0
    }
    ctx.putImageData(blend(ctx.getImageData(0, 0, c.width, c.height), d), 0, 0)
  }

  useEffect(() => {
    const c = view.current
    if (!c || !img) return
    const box = c.parentElement!.getBoundingClientRect()
    const k = Math.min((box.width - 20) / img.naturalWidth, (box.height - 20) / img.naturalHeight, 1)
    c.width = Math.round(img.naturalWidth * k)
    c.height = Math.round(img.naturalHeight * k)
    redraw()
  }, [img])

  const stroke = (e: React.MouseEvent) => {
    if (e.buttons !== 1 || !view.current || !img) return
    const r = view.current.getBoundingClientRect()
    const k = img.naturalWidth / r.width
    const p = { x: (e.clientX - r.left) * k, y: (e.clientY - r.top) * k }
    const m = mask.current.getContext('2d')!
    m.strokeStyle = m.fillStyle = erase ? '#000' : '#fff'
    m.lineWidth = size * k
    m.lineCap = m.lineJoin = 'round'
    m.beginPath()
    const from = last.current || p
    m.moveTo(from.x, from.y)
    m.lineTo(p.x, p.y)
    m.stroke()
    last.current = p
    setPainted(true)
    redraw()
  }

  const clear = () => {
    const m = mask.current.getContext('2d')!
    m.fillStyle = '#000'
    m.fillRect(0, 0, mask.current.width, mask.current.height)
    setPainted(false)
    redraw()
  }

  const done = async () => {
    const blob: Blob = await new Promise((r) => mask.current.toBlob((b) => r(b!), 'image/png'))
    onDone(new Uint8Array(await blob.arrayBuffer()))
  }

  return (
    <div className="viewer-scrim" style={{ zIndex: 96 }}>
      <div className="editor-modal">
        <div className="ed-stage">
          <canvas ref={view} style={{ cursor: 'crosshair' }} onMouseMove={stroke} onMouseDown={(e) => {
            last.current = null
            stroke(e)
          }} onMouseUp={() => (last.current = null)} />
        </div>
        <div className="ed-side">
          <div className="row-end"><b style={{ flex: 1 }}>Что изменить</b><button className="icon-btn sm" onClick={onClose}><X size={16} /></button></div>
          <div className="sub">Закрасьте область, которую нужно поменять. Всё остальное модель постарается оставить как есть.</div>
          <div className="seg" style={{ marginTop: 8 }}>
            <button className={!erase ? 'on' : ''} onClick={() => setErase(false)}><Brush size={14} />Кисть</button>
            <button className={erase ? 'on' : ''} onClick={() => setErase(true)}><Eraser size={14} />Ластик</button>
          </div>
          <label className="ed-slider"><span>Размер</span><input type="range" className="range" min={5} max={150} value={size} onChange={(e) => setSize(Number(e.target.value))} /><em>{size}</em></label>
          <button className="btn ghost" onClick={clear}><RotateCcw size={14} />Очистить</button>
          <div style={{ flex: 1 }} />
          <div className="sub">Лучше всего маску понимают Nano Banana, GPT Image, Flux и Seedream. Qwen Edit тоже работает, но иногда трогает лишнее.</div>
          <button className="btn primary" disabled={!painted} onClick={done}>Готово — описать изменение</button>
        </div>
      </div>
    </div>
  )
}

function blend(base: ImageData, over: ImageData): ImageData {
  for (let i = 0; i < base.data.length; i += 4) {
    const a = over.data[i + 3] / 255
    if (!a) continue
    base.data[i] = base.data[i] * (1 - a) + over.data[i] * a
    base.data[i + 1] = base.data[i + 1] * (1 - a) + over.data[i + 1] * a
    base.data[i + 2] = base.data[i + 2] * (1 - a) + over.data[i + 2] * a
  }
  return base
}

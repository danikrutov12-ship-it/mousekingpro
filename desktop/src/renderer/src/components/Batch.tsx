import { Eraser, FileImage, FolderOpen, Loader2, MessageSquareText, Square, Wand2, ZoomIn } from 'lucide-react'
import { useEffect, useState } from 'react'
import { money } from '@shared/pricing'
import type { BatchOp, BatchStatus } from '@shared/types'
import { refreshBalance } from '../lib/actions'
import { api } from '../lib/api'
import { fileUrl } from '../lib/format'
import { get } from '../lib/store'
import { Modal } from './Modal'

type Kind = BatchOp['kind'] | 'upscale4'
const OPS: [Kind, string, typeof ZoomIn, number | null, string][] = [
  ['upscale', 'Увеличить ×2', ZoomIn, 0.02, 'Больше пикселей и резкости'],
  ['upscale4', 'Увеличить ×4', ZoomIn, 0.08, 'Для печати и крупных форматов'],
  ['background', 'Убрать фон', Eraser, null, 'Прозрачный PNG — для товаров и стикеров'],
  ['edit', 'Изменить по описанию', Wand2, 0.04, 'Одна инструкция ко всем фото: стиль, фон, цвет'],
  ['convert', 'Сжать и сменить формат', FileImage, 0, 'Бесплатно, на компьютере: JPG/PNG, размер'],
  ['describe', 'Описать', MessageSquareText, 0.001, 'Подписи, alt-тексты или текст с фото'],
]

/** Пакетная обработка: одно действие ко многим фото, цена заранее, прогресс и папка с результатом. */
export function BatchDialog({ paths, onClose }: { paths: string[]; onClose(): void }) {
  const [kind, setKind] = useState<Kind>('upscale')
  const [prompt, setPrompt] = useState('')
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [quality, setQuality] = useState(85)
  const [maxSide, setMaxSide] = useState(2048)
  const [task, setTask] = useState<'caption' | 'alt' | 'ocr' | 'critique'>('caption')
  const [st, setSt] = useState<BatchStatus | null>(null)
  const [id, setId] = useState('')
  useEffect(() => api.batch.onProgress((s) => s.id === id && setSt(s)), [id])
  useEffect(() => {
    if (st && !st.running) refreshBalance()
  }, [st?.running])
  const price = OPS.find(([k]) => k === kind)![3]
  const total = price == null ? null : price * paths.length
  const op = (): BatchOp => kind === 'upscale4' ? { kind: 'upscale', scale: 4 } : kind === 'upscale' ? { kind: 'upscale', scale: 2 }
    : kind === 'edit' ? { kind: 'edit', prompt, model: 'qwen-edit-uncensored' }
    : kind === 'convert' ? { kind: 'convert', format, quality, maxSide } : kind === 'describe' ? { kind: 'describe', task } : { kind: 'background' }
  const start = async () => {
    const pid = get().current?.projectId
    setId(await api.batch.start(paths, op(), pid))
  }
  const running = st?.running
  return (
    <Modal open onClose={() => !running && onClose()} title={`Пакетная обработка · ${paths.length} фото`} width={680}
      footer={st ? (
        running ? <button className="btn" onClick={() => api.batch.cancel(id)}><Square size={13} />Остановить</button>
          : <><button className="btn" onClick={() => api.shell.open(st.outDir)}><FolderOpen size={15} />Открыть папку</button><button className="btn primary" onClick={onClose}>Готово</button></>
      ) : (
        <><button className="btn ghost" onClick={onClose}>Отмена</button>
          <button className="btn primary" disabled={kind === 'edit' && !prompt.trim()} onClick={start}>
            Запустить{total ? ` · ≈ ${money(total)}` : total === 0 ? ' · бесплатно' : ''}
          </button></>
      )}>
      <div className="modal-body">
        <div className="batch-thumbs">{paths.slice(0, 12).map((p) => <img key={p} src={fileUrl(p)} />)}{paths.length > 12 && <span>+{paths.length - 12}</span>}</div>
        {!st ? (
          <>
            <div className="batch-ops">
              {OPS.map(([k, label, Icon, p, hint]) => (
                <button key={k} className={`batch-op ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>
                  <Icon size={17} /><b>{label}</b><span>{hint}</span>
                  <em>{p == null ? 'цена Venice' : p === 0 ? 'бесплатно' : `${money(p)} за фото`}</em>
                </button>
              ))}
            </div>
            {kind === 'edit' && <textarea className="textarea" style={{ marginTop: 12 }} autoFocus placeholder="Что сделать с каждым фото: «белый фон, мягкая тень», «в стиле акварели»…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />}
            {kind === 'convert' && (
              <div className="row-end" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <div className="seg">{(['jpeg', 'png'] as const).map((f) => <button key={f} className={format === f ? 'on' : ''} onClick={() => setFormat(f)}>{f.toUpperCase()}</button>)}</div>
                {format === 'jpeg' && <label className="sub">Качество {quality}<input type="range" className="range" min={40} max={100} value={quality} onChange={(e) => setQuality(Number(e.target.value))} style={{ width: 140, marginLeft: 8 }} /></label>}
                <label className="sub">Длинная сторона, px <input className="input" type="number" style={{ width: 100, marginLeft: 6 }} value={maxSide} onChange={(e) => setMaxSide(Number(e.target.value) || 0)} /></label>
              </div>
            )}
            {kind === 'describe' && (
              <div className="seg" style={{ marginTop: 12 }}>
                {([['caption', 'Подписи для соцсетей'], ['alt', 'Alt-тексты'], ['ocr', 'Текст с фото'], ['critique', 'Разбор']] as const).map(([k, l]) =>
                  <button key={k} className={task === k ? 'on' : ''} onClick={() => setTask(k)}>{l}</button>)}
              </div>
            )}
            <div className="hint" style={{ marginTop: 10 }}>Оригиналы не меняются: результат сохранится в отдельную папку и появится в галерее как новые версии.</div>
          </>
        ) : (
          <div className="batch-progress">
            <div className="plan-bar" style={{ height: 8 }}><span style={{ width: `${(st.done / st.total) * 100}%` }} /></div>
            <div className="row-end" style={{ marginTop: 8 }}>
              <b>{st.done} из {st.total}</b>
              {running && <span className="sub"><Loader2 size={13} className="spin" /> {st.current}</span>}
              <div style={{ flex: 1 }} />
              {st.cost > 0 && <span className="sub">потрачено {money(st.cost)}</span>}
            </div>
            {st.failed > 0 && <div className="error-card" style={{ marginTop: 10 }}>Не получилось: {st.failed}<br />{st.errors.slice(0, 5).join('\n')}</div>}
            {!running && <div className="hint" style={{ marginTop: 10 }}>Готово. Папка: {st.outDir}{st.texts.length ? ' (описания — в файле «описания.txt»)' : ''}</div>}
            {st.texts.length > 0 && (
              <div className="batch-texts">{st.texts.map((t) => <div key={t.path}><img src={fileUrl(t.path)} /><p className="selectable">{t.text}</p></div>)}</div>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}

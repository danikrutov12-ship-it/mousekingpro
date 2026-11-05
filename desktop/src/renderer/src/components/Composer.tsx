import { ArrowUp, Archive, Brain, BrainOff, Check, ChevronDown, Search, SlidersHorizontal, File, FileText, Folder, Image, Loader2, MessageSquare, Mic, Paperclip, Square, Video, X } from 'lucide-react'
import { AnimatePresence, LayoutGroup, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { imagePrice, money } from '@shared/pricing'
import type { Attachment, EditModel, Mode } from '@shared/types'
import { attachFiles, imageSize, loadEditModels, modelFor, pickAttachments, pickModel, saveSettings, send, stop, toast } from '../lib/actions'
import { api } from '../lib/api'
import { fileUrl, humanSize } from '../lib/format'
import { get, set, useApp } from '../lib/store'
import { defaults, MediaOptions } from './MediaOptions'
import { ContextRing } from './Jobs'
import { ModelPicker } from './ModelPicker'
import { Popover } from './Popover'
import { PromptTools } from './PromptTools'
import { aspectForPhoto } from '@shared/video'

export const MODES: [Mode, string, typeof MessageSquare][] = [
  ['text', 'Чат', MessageSquare], ['image', 'Картинка', Image], ['video', 'Видео', Video],
]
const PLACEHOLDER: Record<Mode, string> = {
  text: 'Чем могу помочь?', image: 'Опишите картинку…', video: 'Опишите видео…',
}

function AttachIcon({ a }: { a: Attachment }) {
  if (a.kind === 'image') return <img className="attach-thumb" src={fileUrl(a.path)} />
  const Icon = { archive: Archive, video: Video, folder: Folder, text: FileText, binary: File, image: Image }[a.kind]
  return <span className="attach-thumb"><Icon size={16} /></span>
}

function attachSub(a: Attachment) {
  if (a.kind === 'archive') return `архив · ${a.count} файлов`
  if (a.kind === 'folder') return 'папка'
  return humanSize(a.size || 0)
}

/** Модель правки фото: та же кнопка, что у генерации, но со списком моделей правки. */
function EditModelButton() {
  const current = useApp((s) => s.settings?.edit_model || 'qwen-edit-uncensored')
  const [models, setModels] = useState<EditModel[]>([])
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const btn = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    loadEditModels().then(setModels)
  }, [])
  const cur = models.find((m) => m.id === current)
  const list = models.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
  return (
    <>
      <button ref={btn} className="model-btn" title="Модель правки фото" onClick={() => setOpen(!open)}>
        <span>Правка: {cur?.name || current}</span><ChevronDown size={14} />
      </button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} className="picker" align="end">
        <div className="picker-search"><Search size={16} /><input autoFocus placeholder={`Модели правки фото (${models.length})…`} value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="picker-list">
          {list.map((m) => (
            <button key={m.id} className={`pick ${m.id === current ? 'hl' : ''}`} onClick={() => {
              saveSettings({ edit_model: m.id })
              setOpen(false)
            }}>
              <div className="pick-main">
                <div className="pick-name">{m.name}{m.uncensored && <span className="tag accent">без цензуры</span>}</div>
                <div className="pick-meta">{[m.price != null ? `${money(m.price)} за правку` : '', `до ${m.max} фото`].filter(Boolean).join('  ·  ')}</div>
              </div>
              {m.id === current && <Check size={16} className="pick-check" />}
            </button>
          ))}
        </div>
      </Popover>
    </>
  )
}

/** Короткая сводка параметров генерации: «1024×1024 · 8 шагов · png». */
function summary(mode: Mode, p: Record<string, any>): string {
  const ratio = { auto: 'авто', adaptive: 'как у фото' } as Record<string, string>
  const parts: string[] = []
  if (mode === 'video') {
    if (p.duration) parts.push(String(p.duration).replace(/s$/, ' с'))
    if (p.resolution) parts.push(p.resolution)
    if (p.aspect_ratio) parts.push(ratio[p.aspect_ratio] || p.aspect_ratio)
    if (p.audio) parts.push('со звуком')
  } else {
    parts.push(p.aspect_ratio ? ratio[p.aspect_ratio] || p.aspect_ratio : `${p.width ?? 1024}×${p.height ?? 1024}`)
    if (p.resolution) parts.push(p.resolution)
    if (p.quality) parts.push({ low: 'низкое', medium: 'среднее', high: 'высокое' }[p.quality as string] || p.quality)
    if ((p.variants ?? 1) > 1) parts.push(`${p.variants} варианта`)
    if (p.seed != null) parts.push(`seed ${p.seed}`)
    if (p.negative_prompt) parts.push('есть исключения')
  }
  return 'Параметры: ' + parts.join(' · ')
}

export function ModeSwitch() {
  const mode = useApp((s) => s.mode)
  return (
    <LayoutGroup id="modes">
      <div className="modes">
        {MODES.map(([key, label, Icon]) => (
          <button key={key} className={`mode ${mode === key ? 'on' : ''}`} onClick={() => set({ mode: key })}>
            {mode === key && <motion.span layoutId="mode-pill" className="mode-pill" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
            <Icon size={14} /><span className="lbl">{label}</span>
          </button>
        ))}
      </div>
    </LayoutGroup>
  )
}

/** Голосовой ввод: запись с микрофона → распознавание Venice → текст в поле ввода. */
function MicButton() {
  const [state, setState] = useState<'idle' | 'rec' | 'busy'>('idle')
  const [secs, setSecs] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const timer = useRef<ReturnType<typeof setInterval>>(undefined)
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
      const r = new MediaRecorder(stream, { mimeType: mime })
      const chunks: Blob[] = []
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data)
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        clearInterval(timer.current)
        setState('busy')
        try {
          const bytes = new Uint8Array(await new Blob(chunks, { type: mime }).arrayBuffer())
          const text = await api.voice.transcribe(bytes, mime)
          if (text) set((s) => ({ draft: (s.draft ? s.draft.trimEnd() + ' ' : '') + text, focusTick: s.focusTick + 1 }))
          else toast('Речь не распознана', 'error')
        } catch (e) {
          toast('Не удалось распознать: ' + (e as Error).message, 'error')
        }
        setState('idle')
      }
      r.start()
      rec.current = r
      setSecs(0)
      timer.current = setInterval(() => setSecs((x) => x + 1), 1000)
      setState('rec')
    } catch (e) {
      toast('Нет доступа к микрофону: ' + (e as Error).message, 'error')
    }
  }
  return (
    <button className={`icon-btn mic ${state}`} title={state === 'rec' ? 'Остановить и распознать' : 'Сказать голосом'}
      onClick={() => (state === 'rec' ? rec.current?.stop() : state === 'idle' && start())}>
      {state === 'busy' ? <Loader2 size={17} className="spin" /> : <Mic size={17} />}
      {state === 'rec' && <span className="mic-time">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>}
    </button>
  )
}

/** Память в этом чате: можно выключить, как временный чат. */
function MemoryToggle() {
  const on = useApp((s) => s.memoryOn)
  const enabled = useApp((s) => s.settings?.memory_enabled)
  const fresh = useApp((s) => !!s.current?.isNew)
  if (!enabled || !fresh) return null
  return (
    <button className={`icon-btn ${on ? '' : 'mem-off'}`} title={on ? 'Чат с памятью: агент учитывает то, что вы просили запомнить. Нажмите, чтобы начать чат без памяти' : 'Чат без памяти: агент ничего не знает из прошлых чатов и ничего не запоминает'}
      onClick={() => set({ memoryOn: !on })}>
      {on ? <Brain size={17} /> : <BrainOff size={17} />}
    </button>
  )
}

/** Поле ввода: текст, вложения, режим, модель, параметры генерации и цена. */
export function Composer({ placement }: { placement: 'center' | 'bottom' }) {
  const mode = useApp((s) => s.mode)
  const draft = useApp((s) => s.draft)
  const attachments = useApp((s) => s.attachments)
  const attaching = useApp((s) => s.attaching)
  const focusTick = useApp((s) => s.focusTick)
  const models = useApp((s) => s.models[s.mode])
  const settings = useApp((s) => s.settings)
  const running = useApp((s) => !!(s.current && s.runs[s.current.chat.id]))
  const model = modelFor(mode)
  const refSetOn = useApp((s) => !!s.refSet)
  const [optsOpen, setOptsOpen] = useState(false)
  // новые режим или модель — параметры по умолчанию для неё (даже если панель параметров свёрнута)
  // фото к видео: пропорции «как у фото» (или ближайшие), чтобы модели не пришлось перестраивать кадр
  const firstPhoto = attachments.find((a) => a.kind === 'image')?.path
  const photoCount = attachments.filter((a) => a.kind === 'image').length
  const [photoRatio, setPhotoRatio] = useState(0)
  useEffect(() => {
    if (!firstPhoto) return setPhotoRatio(0)
    imageSize(firstPhoto).then((s) => setPhotoRatio(s.w / s.h)).catch(() => setPhotoRatio(0))
  }, [firstPhoto])
  useEffect(() => {
    setParams(defaults(mode, model, photoRatio))
  }, [mode, model?.id])
  useEffect(() => {
    if (mode !== 'video' || !photoRatio) return
    const ar = aspectForPhoto(model?.constraints?.aspect_ratios, photoRatio)
    if (ar) setParams((p) => ({ ...p, aspect_ratio: ar }))
  }, [photoRatio])
  const ctxUsed = useApp((s) => {
    const msgs = s.current?.chat.messages || []
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]._tokens) return msgs[i]._tokens![0]
    return 0
  })
  const [focused, setFocused] = useState(false)
  const [picker, setPicker] = useState(false)
  const [params, setParams] = useState<Record<string, any>>(() => defaults(mode, model))
  const [quote, setQuote] = useState<number | null | 'loading'>(null)
  const ta = useRef<HTMLTextAreaElement>(null)
  const modelBtn = useRef<HTMLButtonElement>(null)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 280) + 'px'
  }, [draft])

  useEffect(() => {
    ta.current?.focus()
    const el = ta.current
    if (el) el.setSelectionRange(el.value.length, el.value.length)
  }, [focusTick, mode])

  // цена видео — спрашиваем у Venice с задержкой, пока пользователь крутит параметры
  useEffect(() => {
    if (mode !== 'video' || !model) return setQuote(null)
    setQuote('loading')
    let alive = true
    const t = setTimeout(() => api.videoQuote({ model: model.id, ...params }).then((q) => alive && setQuote(q)), 450)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [mode, model?.id, JSON.stringify(params)])

  const editing = mode === 'image' && (attachments.some((a) => a.kind === 'image') || refSetOn)
  const price = editing ? null : mode === 'image' && model ? imagePrice(model, params) : mode === 'video' ? quote : null
  const canSend = !running && !attaching && (draft.trim() || attachments.length > 0)

  const submit = async () => {
    if (!canSend) return
    const text = draft.trim()
    const p = mode === 'text' ? undefined : Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== ''))
    set({ draft: '', attachments: [] })
    const ok = await send(text, attachments, p)
    if (!ok) set({ draft: text, attachments })
  }

  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    attachFiles(files)
  }

  return (
    <div className={`composer ${focused ? 'focused' : ''}`}>
      <AnimatePresence initial={false}>
        {(attachments.length > 0 || attaching) && (
          <motion.div className="attach-list" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            {attachments.map((a, i) => (
              <motion.div key={a.path + i} className="attach" layout initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                <AttachIcon a={a} />
                <div style={{ minWidth: 0 }}>
                  <div className="attach-name">{a.name}</div>
                  <div className="attach-sub">{attachSub(a)}</div>
                </div>
                <button className="x" onClick={() => set({ attachments: attachments.filter((_, j) => j !== i) })}><X size={12} /></button>
              </motion.div>
            ))}
            {attaching && <div className="attach"><span className="attach-thumb"><Loader2 size={16} className="spin" /></span><div className="attach-sub">Готовлю файлы…</div></div>}
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {mode !== 'text' && (
          <motion.div key={mode} initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22 }} style={{ overflow: 'hidden' }}>
            {!(mode === 'image' && (attachments.some((a) => a.kind === 'image') || refSetOn)) && (
              <>
                <button className="opts-summary" onClick={() => setOptsOpen(!optsOpen)}>
                  <SlidersHorizontal size={13} /><span>{summary(mode, params)}</span><ChevronDown size={13} style={{ transform: optsOpen ? 'rotate(180deg)' : undefined }} />
                </button>
                {optsOpen && <MediaOptions mode={mode} model={model} params={params} onChange={setParams} photos={photoCount} />}
              </>
            )}
            {mode === 'image' && <PromptTools />}
          </motion.div>
        )}
      </AnimatePresence>
      <textarea ref={ta} rows={1} value={draft} placeholder={PLACEHOLDER[mode]}
        onChange={(e) => set({ draft: e.target.value })}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onPaste={onPaste}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            submit()
          }
        }} />
      <div className="composer-row">
        <button className="icon-btn" title="Прикрепить файлы, архивы, картинки" onClick={pickAttachments}><Paperclip size={18} /></button>
        <MicButton />
        <MemoryToggle />
        {placement === 'bottom' && <ModeSwitch />}
        <div className="spacer" />
        {mode === 'text' && ctxUsed > 0 && model && (
          <ContextRing used={ctxUsed} budget={settings?.context_budget || 200_000} window={model.context} />
        )}
        {price != null && (
          <span className="price-tag" title="Сколько спишет Venice">
            {price === 'loading' ? '≈ …' : `≈ ${money(price)}`}
          </span>
        )}
        {editing ? <EditModelButton /> : (
          <button ref={modelBtn} className="model-btn" onClick={() => setPicker(!picker)} title={model?.id}>
            <span>{model?.name || (settings?.api_key ? 'Загружаю модели…' : 'Нужен API-ключ')}</span>
            <ChevronDown size={14} />
          </button>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {running ? (
            <motion.button key="stop" className="send stop" onClick={stop} title="Остановить"
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}>
              <Square size={13} fill="currentColor" />
            </motion.button>
          ) : (
            <motion.button key="send" className="send" onClick={submit} disabled={!canSend} title="Отправить (Enter)"
              initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.6, opacity: 0 }}>
              <ArrowUp size={18} strokeWidth={2.4} />
            </motion.button>
          )}
        </AnimatePresence>
      </div>
      <ModelPicker anchor={modelBtn} open={picker} onClose={() => setPicker(false)} models={models} mode={mode}
        current={model?.id} onPick={(m) => pickModel(get().mode, m)} />
    </div>
  )
}

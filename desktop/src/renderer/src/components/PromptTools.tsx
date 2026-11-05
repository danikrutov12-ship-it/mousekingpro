import { BookmarkPlus, Images, Library, Loader2, Palette, Plus, Sparkles, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EditModel, RefSet, SavedPrompt } from '@shared/types'
import { loadEditModels, saveSettings, toast } from '../lib/actions'
import { fileUrl } from '../lib/format'
import { api } from '../lib/api'
import { get, set, useApp } from '../lib/store'
import { Popover } from './Popover'

// постоянные пустые списки: селектор состояния должен возвращать одну и ту же ссылку
const NONE: RefSet[] = []
const NONE_P: SavedPrompt[] = []

/** Стили: дописываются к описанию — работают с любой моделью картинок. */
export const STYLES: [string, string][] = [
  ['Фото', 'фотореалистично, профессиональная съёмка, естественный свет, высокая детализация, 50 мм'],
  ['Кино', 'кинематографичный кадр, драматичный свет, глубина резкости, цветокоррекция как в кино, 35 мм'],
  ['Продукт', 'предметная съёмка товара, чистый фон, мягкий студийный свет, аккуратные тени, коммерческое фото'],
  ['Портрет', 'портретная съёмка, мягкий свет, размытый фон, 85 мм, естественные тона кожи'],
  ['Еда', 'фуд-фотография, аппетитно, натуральный свет из окна, вид сверху или 45°, свежие детали'],
  ['Аниме', 'в стиле аниме, чистые линии, яркие цвета, детализированный фон'],
  ['Акварель', 'акварельная живопись, мягкие переходы, текстура бумаги, лёгкие мазки'],
  ['Масло', 'картина маслом, крупные мазки, насыщенные цвета, классическая живопись'],
  ['3D', '3D-рендер, мягкий глобальный свет, пластичные материалы, высокое качество'],
  ['Изометрия', 'изометрическая иллюстрация, аккуратные детали, мягкие тени, пастельные цвета'],
  ['Минимализм', 'минимализм, много воздуха, простые формы, ограниченная палитра'],
  ['Неон', 'неоновый свет, ночная атмосфера, киберпанк, отражения на мокром асфальте'],
  ['Винтаж', 'плёночное фото, винтаж, зерно, тёплые выцветшие цвета, 1970-е'],
  ['Логотип', 'векторный логотип, плоский дизайн, простые формы, на белом фоне, без лишних деталей'],
]

/** Правка по фото: сколько фото уйдёт модели, какая модель правки, «не менять остальное». */
function RefBar() {
  const all = useApp((s) => s.attachments)
  const attached = all.filter((a) => a.kind === 'image')
  const refSet = useApp((s) => s.settings?.ref_sets.find((r) => r.id === s.refSet))
  const editModel = useApp((s) => s.settings?.edit_model || 'qwen-edit-uncensored')
  const keepRest = useApp((s) => s.keepRest)
  const [models, setModels] = useState<EditModel[]>([])
  useEffect(() => {
    loadEditModels().then(setModels)
  }, [])
  const count = attached.length + (refSet?.paths.length || 0)
  if (!count) return null
  const cur = models.find((m) => m.id === editModel)
  return (
    <div className="ref-bar">
      <div className="ref-thumbs">
        {[...attached.map((a) => a.path), ...(refSet?.paths || [])].slice(0, 8).map((p) => <img key={p} src={fileUrl(p)} />)}
      </div>
      <div className="ref-info">
        <b>{count === 1 ? 'Правка вашего фото' : `Работа по ${count} референсам`}</b>
        {refSet && <span className="chip">{refSet.name}<button onClick={() => set({ refSet: null })}><X size={11} /></button></span>}
        <span className="sub">{cur && count > cur.max ? `модель возьмёт первые ${cur.max}` : 'модель правки — внизу, рядом с кнопкой отправки'}</span>
      </div>
      <label className="ref-keep" title="Добавить к описанию просьбу не трогать лицо, фон, композицию и всё, о чём вы не просили">
        <input type="checkbox" checked={keepRest} onChange={(e) => set({ keepRest: e.target.checked })} />Не менять остальное
      </label>
    </div>
  )
}

/** Наборы референсов: до 10 фото одного человека, товара или стиля — подключаются к любому запросу. */
function RefSets() {
  const sets = useApp((s) => s.settings?.ref_sets) || NONE
  const active = useApp((s) => s.refSet)
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const btn = useRef<HTMLButtonElement>(null)
  const create = () => {
    const paths = get().attachments.filter((a) => a.kind === 'image').map((a) => a.path).slice(0, 10)
    if (!paths.length) return toast('Сначала прикрепите 1–10 фото (скрепка или перетаскивание)', 'error')
    if (!name.trim()) return toast('Назовите набор, например «Я» или «Кроссовки»', 'error')
    const id = Math.random().toString(36).slice(2, 9)
    saveSettings({ ref_sets: [...sets, { id, name: name.trim(), paths }] })
    set({ refSet: id, attachments: get().attachments.filter((a) => a.kind !== 'image') })
    setName('')
    setOpen(false)
    toast(`Набор «${name.trim()}» сохранён: ${paths.length} фото`, 'ok')
  }
  return (
    <>
      <button ref={btn} className={`pt-btn ${active ? 'on' : ''}`} onClick={() => setOpen(!open)}><Images size={14} /><span className="t">Референсы{active ? ': ' + sets.find((s) => s.id === active)?.name : ''}</span></button>
      <Popover anchor={btn} open={open} onClose={() => setOpen(false)} className="menu styles-pop">
        <div className="hint" style={{ padding: '6px 10px 8px', fontSize: 12, color: 'var(--muted)' }}>
          Набор — до 10 фото одного человека, товара или стиля. Модель будет опираться на них в каждом запросе.
        </div>
        {sets.map((r) => (
          <div key={r.id} className="lib-row">
            <button className={`menu-item ${active === r.id ? 'on' : ''}`} onClick={() => {
              set({ refSet: active === r.id ? null : r.id })
              setOpen(false)
            }}>
              <span className="ref-mini">{r.paths.slice(0, 3).map((p) => <img key={p} src={fileUrl(p)} />)}</span>{r.name}<span className="menu-sub">{r.paths.length} фото</span>
            </button>
            <button className="icon-btn sm" onClick={() => {
              saveSettings({ ref_sets: sets.filter((x) => x.id !== r.id) })
              if (active === r.id) set({ refSet: null })
            }}><Trash2 size={13} /></button>
          </div>
        ))}
        <div className="menu-sep" />
        <div className="row-end" style={{ padding: '4px 6px' }}>
          <input className="input" style={{ height: 30 }} placeholder="Новый набор из прикреплённых фото…" value={name} onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()} />
          <button className="btn" style={{ height: 30 }} onClick={create}><Plus size={14} /></button>
        </div>
      </Popover>
    </>
  )
}

export function PromptTools() {
  const draft = useApp((s) => s.draft)
  const prompts = useApp((s) => s.settings?.prompts) || NONE_P
  const [busy, setBusy] = useState(false)
  const [undo, setUndo] = useState<string | null>(null)
  const [lib, setLib] = useState(false)
  const [styles, setStyles] = useState(false)
  const libBtn = useRef<HTMLButtonElement>(null)
  const styleBtn = useRef<HTMLButtonElement>(null)
  const enhance = async () => {
    if (!draft.trim()) return toast('Сначала коротко опишите картинку', 'error')
    setBusy(true)
    try {
      const before = draft
      const text = await api.gallery.enhance(draft.trim())
      if (text) {
        set((s) => ({ draft: text, focusTick: s.focusTick + 1 }))
        setUndo(before)
      }
    } catch (e) {
      toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
    setBusy(false)
  }
  const addStyle = (suffix: string) => {
    setStyles(false)
    set((s) => ({ draft: (s.draft.trim() ? s.draft.trim().replace(/[.,\s]+$/, '') + ', ' : '') + suffix, focusTick: s.focusTick + 1 }))
  }
  const savePrompt = () => {
    const text = get().draft.trim()
    if (!text) return toast('Поле пустое — нечего сохранять', 'error')
    const title = text.split(/[,.\n]/)[0].slice(0, 40)
    saveSettings({ prompts: [...prompts, { id: Math.random().toString(36).slice(2, 9), title, text }] })
    toast('Промпт сохранён в библиотеку', 'ok')
  }
  return (
    <>
    <RefBar />
    <div className="prompt-tools">
      <RefSets />
      <button ref={styleBtn} className="pt-btn" onClick={() => setStyles(!styles)}><Palette size={14} /><span className="t">Стиль</span></button>
      <button className="pt-btn" disabled={busy} onClick={enhance} title="Модель допишет детали: свет, ракурс, стиль">
        {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}<span className="t">Улучшить описание</span>
      </button>
      {undo !== null && (
        <button className="pt-btn" title="Вернуть описание, как было до улучшения" onClick={() => {
          set((s) => ({ draft: undo, focusTick: s.focusTick + 1 }))
          setUndo(null)
        }}><Undo2 size={14} /><span className="t">Вернуть как было</span></button>
      )}
      <button ref={libBtn} className="pt-btn" onClick={() => setLib(!lib)}><Library size={14} /><span className="t">Мои промпты{prompts.length ? ` · ${prompts.length}` : ''}</span></button>
      <button className="pt-btn" onClick={savePrompt} title="Сохранить текущее описание в библиотеку"><BookmarkPlus size={14} /></button>
      <Popover anchor={styleBtn} open={styles} onClose={() => setStyles(false)} className="menu styles-pop">
        {STYLES.map(([name, suffix]) => <button key={name} className="menu-item" title={suffix} onClick={() => addStyle(suffix)}>{name}<span className="menu-sub">{suffix.split(',')[0]}</span></button>)}
      </Popover>
      <Popover anchor={libBtn} open={lib} onClose={() => setLib(false)} className="menu styles-pop">
        {!prompts.length && <div className="picker-empty" style={{ padding: 16 }}>Пока пусто. Напишите удачное описание и нажмите <BookmarkPlus size={13} /></div>}
        {prompts.map((p) => (
          <div key={p.id} className="lib-row">
            <button className="menu-item" title={p.text} onClick={() => {
              setLib(false)
              set((s) => ({ draft: p.text, focusTick: s.focusTick + 1 }))
            }}>{p.title}</button>
            <button className="icon-btn sm" onClick={() => saveSettings({ prompts: prompts.filter((x) => x.id !== p.id) })}><Trash2 size={13} /></button>
          </div>
        ))}
      </Popover>
    </div>
    </>
  )
}

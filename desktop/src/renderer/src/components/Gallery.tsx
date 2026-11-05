import {
  Check, CheckSquare, Columns2, Combine, Copy, Eraser, ExternalLink, Film, FolderOpen, Heart, Images, Layers, ListChecks, Loader2,
  MessageSquareText, Paintbrush, Save, Search, Shuffle, Trash2, Wand2, X, ZoomIn,
} from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { money } from '@shared/pricing'
import type { GalleryItem } from '@shared/types'
import { animate, KEEP_REST, openChat, refreshBalance, toast } from '../lib/actions'
import { api } from '../lib/api'
import { ago, fileUrl, baseName } from '../lib/format'
import { get, set, useApp } from '../lib/store'
import { BatchDialog } from './Batch'
import { Header } from './ChatPage'
import { ImageEditor } from './ImageEditor'
import { MaskEditor } from './MaskEditor'
import { Markdown } from './Markdown'
import { Modal } from './Modal'

const SOURCE: Record<GalleryItem['source'], string> = {
  generate: 'сгенерирована', upscale: 'увеличена', background: 'без фона', edit: 'правка', combine: 'объединение',
  local: 'ручная правка', own: 'своё фото', batch: 'пакетная обработка',
}
const FILTERS: [string, string, (i: GalleryItem) => boolean][] = [
  ['all', 'Все', () => true], ['fav', 'Избранное', (i) => !!i.favorite], ['gen', 'Сгенерированные', (i) => i.source === 'generate'],
  ['edits', 'Правки и версии', (i) => !!i.parent], ['own', 'Свои фото', (i) => i.source === 'own'],
]

let galleryCache: GalleryItem[] = []
export const reloadGallery = async () => {
  galleryCache = await api.gallery.list()
  window.dispatchEvent(new Event('gallery'))
}

function useGallery() {
  const [items, setItems] = useState(galleryCache)
  useEffect(() => {
    const on = () => setItems(galleryCache)
    window.addEventListener('gallery', on)
    reloadGallery()
    return () => window.removeEventListener('gallery', on)
  }, [])
  return items
}

/** Слайдер «было / стало»: две версии друг на друге, граница двигается мышью. */
function CompareSlider({ a, b }: { a: string; b: string }) {
  const [x, setX] = useState(50)
  const box = useRef<HTMLDivElement>(null)
  const move = (clientX: number) => {
    const r = box.current!.getBoundingClientRect()
    setX(Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100)))
  }
  return (
    <div ref={box} className="compare-slider" onMouseMove={(e) => e.buttons === 1 && move(e.clientX)} onMouseDown={(e) => move(e.clientX)}>
      <img src={fileUrl(b)} draggable={false} />
      <img src={fileUrl(a)} draggable={false} style={{ clipPath: `inset(0 ${100 - x}% 0 0)` }} />
      <div className="cs-line" style={{ left: `${x}%` }}><span>⟷</span></div>
      <span className="cs-tag left">было</span><span className="cs-tag right">стало</span>
    </div>
  )
}

const DESCRIBE: [string, string][] = [['caption', 'Подпись для соцсетей'], ['alt', 'Alt-текст'], ['ocr', 'Распознать текст'], ['critique', 'Разбор как фотограф'], ['prompt', 'Описать как промпт']]

/** Просмотр картинки: версии, сравнение, действия, описание моделью. */
export function Viewer({ item, items, onClose }: { item: GalleryItem; items: GalleryItem[]; onClose(): void }) {
  const [cur, setCur] = useState(item)
  const [compare, setCompare] = useState<GalleryItem | null>(null)
  const [busy, setBusy] = useState('')
  const [text, setText] = useState('')
  const [editPrompt, setEditPrompt] = useState<string | null>(null)
  const [editor, setEditor] = useState(false)
  const [maskOpen, setMaskOpen] = useState(false)
  const [mask, setMask] = useState<string | null>(null)
  const [keep, setKeep] = useState(true)
  const editModel = useApp((s) => s.settings?.edit_model || 'qwen-edit-uncensored')
  useEffect(() => setCur(item), [item])
  // дерево версий: корень цепочки и все его потомки
  const chain = useMemo(() => {
    const byId = new Map(items.map((i) => [i.id, i]))
    let root = cur
    while (root.parent && byId.get(root.parent)) root = byId.get(root.parent)!
    const out: { it: GalleryItem; depth: number }[] = []
    const walk = (it: GalleryItem, depth: number) => {
      out.push({ it, depth })
      items.filter((x) => x.parent === it.id).sort((a, b) => a.created - b.created).forEach((c) => walk(c, depth + 1))
    }
    walk(root, 0)
    return out
  }, [cur, items])
  const parent = items.find((i) => i.id === cur.parent)
  const run = async (name: string, fn: () => Promise<any>) => {
    setBusy(name)
    try {
      const r = await fn()
      await reloadGallery()
      refreshBalance()
      if (r?.paths?.length) {
        const fresh = galleryCache.find((i) => i.path === r.paths[0])
        if (fresh) setCur(fresh)
        toast(`Готово${r.cost ? ' · ' + money(r.cost) : ''}`, 'ok')
      }
    } catch (e) {
      toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
    }
    setBusy('')
  }
  const pid = cur.projectId
  return (
    <div className="viewer-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.div className="viewer" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}>
        <div className="viewer-main">
          {compare ? <CompareSlider a={compare.path} b={cur.path} /> : <img src={fileUrl(cur.path)} onClick={() => set({ lightbox: cur.path })} />}
          <button className="icon-btn viewer-close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="viewer-side">
          <div className="viewer-head">
            <span className="tag">{SOURCE[cur.source]}</span>
            {cur.cost != null && <span className="sub">{money(cur.cost)}</span>}
            <span className="sub">{ago(cur.created)}</span>
            <div style={{ flex: 1 }} />
            <button className={`icon-btn sm ${cur.favorite ? 'active' : ''}`} title="В избранное" onClick={() => run('fav', () => api.gallery.update(cur.id, { favorite: !cur.favorite }).then(() => setCur({ ...cur, favorite: !cur.favorite })))}>
              <Heart size={15} fill={cur.favorite ? 'currentColor' : 'none'} />
            </button>
          </div>
          {cur.prompt && <div className="viewer-prompt selectable">{cur.prompt}</div>}
          <div className="sub" style={{ marginBottom: 10 }}>
            {[cur.model, cur.seed != null ? `seed ${cur.seed}` : '', baseName(cur.path)].filter(Boolean).join(' · ')}
          </div>
          {chain.length > 1 && (
            <>
              <div className="list-title" style={{ margin: '6px 0' }}>Версии</div>
              <div className="versions">
                {chain.map(({ it, depth }) => (
                  <button key={it.id} className={`version ${it.id === cur.id ? 'on' : ''}`} style={{ marginLeft: depth * 12 }} onClick={() => {
                    setCur(it)
                    setCompare(null)
                  }}>
                    <img src={fileUrl(it.path)} /><span>{SOURCE[it.source]}</span>
                    {it.id !== cur.id && <span className="v-cmp" title="Сравнить с текущей" onClick={(e) => {
                      e.stopPropagation()
                      setCompare(compare?.id === it.id ? null : it)
                    }}><Columns2 size={13} /></span>}
                  </button>
                ))}
              </div>
              {compare && <div className="sub" style={{ marginTop: 6 }}>Сравнение: двигайте границу мышью. <a onClick={() => setCompare(null)}>Выйти</a></div>}
            </>
          )}
          <div className="list-title" style={{ margin: '12px 0 6px' }}>Действия</div>
          <div className="actions-grid">
            <button className="act" disabled={!!busy} onClick={() => run('x2', () => api.gallery.op({ kind: 'upscale', path: cur.path, scale: 2 }, pid))}><ZoomIn size={15} />Увеличить ×2<span>$0.02</span></button>
            <button className="act" disabled={!!busy} onClick={() => run('x4', () => api.gallery.op({ kind: 'upscale', path: cur.path, scale: 4 }, pid))}><ZoomIn size={15} />Увеличить ×4<span>$0.08</span></button>
            <button className="act" disabled={!!busy} onClick={() => run('bg', () => api.gallery.op({ kind: 'background', path: cur.path }, pid))}><Eraser size={15} />Убрать фон</button>
            <button className="act" disabled={!!busy} onClick={() => setEditPrompt('')}><Wand2 size={15} />Изменить по описанию</button>
            {cur.model && cur.prompt && cur.source === 'generate' && (
              <button className="act" disabled={!!busy} onClick={() => run('var', () => api.gallery.op({ kind: 'variations', id: cur.id }, pid))}><Shuffle size={15} />Ещё 4 похожих</button>
            )}
            <button className="act" onClick={() => setEditor(true)}><Paintbrush size={15} />Редактор: обрезка, цвет</button>
            <button className="act" onClick={() => {
              onClose()
              set({ view: { page: 'chat' } })
              animate(cur.path)
            }}><Film size={15} />Оживить в видео</button>
            {parent && <button className="act" onClick={() => setCompare(compare ? null : parent)}><Columns2 size={15} />Было / стало</button>}
          </div>
          {editPrompt !== null && (
            <div className="edit-inline">
              <textarea className="textarea" autoFocus placeholder="Что поменять: «сделай фон белым», «убери человека слева», «поменяй цвет куртки на синий»…" value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} />
              <div className="row-end" style={{ flexWrap: 'wrap' }}>
                <button className={`btn ${mask ? 'primary' : ''}`} onClick={() => setMaskOpen(true)}><Paintbrush size={14} />{mask ? 'Область выделена' : 'Выделить область кистью'}</button>
                {mask && <button className="icon-btn sm" title="Убрать выделение" onClick={() => setMask(null)}><X size={14} /></button>}
                <label className="ref-keep"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />Не менять остальное</label>
              </div>
              <div className="sub">Модель правки: {editModel} (меняется в поле ввода, когда прикреплено фото)</div>
              <div className="row-end">
                <div style={{ flex: 1 }} />
                <button className="btn ghost" onClick={() => {
                  setEditPrompt(null)
                  setMask(null)
                }}>Отмена</button>
                <button className="btn primary" disabled={!editPrompt.trim() || !!busy} onClick={() => {
                  const text = editPrompt.trim() + (keep ? KEEP_REST : '')
                  const m = mask
                  setEditPrompt(null)
                  setMask(null)
                  run('edit', () => m
                    ? api.gallery.op({ kind: 'combine', paths: [cur.path, m], model: editModel,
                      prompt: 'Второе изображение — служебная маска-разметка, а не часть картинки: белым на ней отмечено, ГДЕ менять первое изображение. ' +
                        'Белый цвет и форму маски в результат не переносить: внутри области сохрани естественное продолжение фона и освещения первого ' +
                        'изображения и внеси только нужное изменение, плавно вписав его. За пределами области всё должно остаться без изменений. Задача: ' + text }, pid)
                    : api.gallery.op({ kind: 'edit', path: cur.path, prompt: text, model: editModel }, pid))
                }}><Wand2 size={14} />Изменить</button>
              </div>
            </div>
          )}
          <div className="list-title" style={{ margin: '12px 0 6px' }}>Посмотреть моделью</div>
          <div className="chips-row">
            {DESCRIBE.map(([k, l]) => (
              <button key={k} className="filter" disabled={!!busy} onClick={async () => {
                setBusy('describe')
                try {
                  setText(await api.gallery.describe(cur.path, k))
                } catch (e) {
                  toast((e as Error).message, 'error')
                }
                setBusy('')
              }}>{l}</button>
            ))}
          </div>
          {busy && <div className="sub" style={{ margin: '10px 0' }}><Loader2 size={14} className="spin" /> Работаю…</div>}
          {text && (
            <div className="describe-out">
              <Markdown text={text} />
              <button className="meta-btn" style={{ opacity: 1 }} onClick={() => {
                navigator.clipboard.writeText(text)
                toast('Скопировано', 'ok')
              }}><Copy size={13} />Копировать</button>
            </div>
          )}
          <div className="viewer-foot">
            <button className="meta-btn" onClick={() => api.gallery.saveAs(cur.path).then((p) => p && toast('Сохранено: ' + p, 'ok'))}><Save size={13} />Сохранить как…</button>
            <button className="meta-btn" onClick={() => api.gallery.openWith(cur.path).then((a) => a && toast(`Открываю в ${a.toUpperCase()}`, 'ok'))}><ExternalLink size={13} />Открыть в редакторе</button>
            <button className="meta-btn" onClick={() => api.shell.reveal(cur.path)}><FolderOpen size={13} />В папке</button>
            {cur.chatId && cur.projectId && <button className="meta-btn" onClick={() => {
              onClose()
              openChat(cur.projectId!, cur.chatId!)
            }}><MessageSquareText size={13} />К чату</button>}
          </div>
        </div>
      </motion.div>
      {maskOpen && <MaskEditor path={cur.path} onClose={() => setMaskOpen(false)} onDone={async (bytes) => {
        setMask(await api.gallery.saveMask(bytes))
        setMaskOpen(false)
      }} />}
      {editor && <ImageEditor path={cur.path} onClose={() => setEditor(false)} onSaved={async (p) => {
        setEditor(false)
        await reloadGallery()
        const fresh = galleryCache.find((i) => i.path === p)
        if (fresh) setCur(fresh)
      }} />}
    </div>
  )
}

/** Объединение выбранных фото: первое — основа, остальные — что взять из них. */
function CombineDialog({ items, onClose }: { items: GalleryItem[]; onClose(): void }) {
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onClose={onClose} title="Объединить фото" icon={<Combine size={18} />} width={640}
      footer={<><button className="btn ghost" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!prompt.trim() || busy} onClick={async () => {
          setBusy(true)
          try {
            const r = await api.gallery.op({ kind: 'combine', paths: items.map((i) => i.path), prompt: prompt.trim(), model: get().settings?.edit_model || 'qwen-edit-uncensored' }, items[0].projectId)
            toast(`Готово${r.cost ? ' · ' + money(r.cost) : ''}`, 'ok')
            await reloadGallery()
            refreshBalance()
            onClose()
          } catch (e) {
            toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
          }
          setBusy(false)
        }}>{busy ? <Loader2 size={14} className="spin" /> : <Combine size={14} />}Объединить</button></>}>
      <div className="modal-body">
        <div className="combine-row">{items.map((i, n) => <div key={i.id}><img src={fileUrl(i.path)} /><span>{n === 0 ? 'основа' : `фото ${n + 1}`}</span></div>)}</div>
        <textarea className="textarea" autoFocus value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="Например: помести человека с фото 2 в интерьер с основы · одень модель в куртку с фото 2 · сохрани лицо, смени фон" />
      </div>
    </Modal>
  )
}

/** Просмотр из чата: та же карточка с версиями, сравнением и действиями. */
export function ViewerHost() {
  const path = useApp((s) => s.viewer)
  const [items, setItems] = useState<GalleryItem[]>([])
  useEffect(() => {
    if (!path) return
    // своё фото из файлов проекта — сначала добавляем в галерею
    api.gallery.ensure(path).then(reloadGallery).then(() => setItems(galleryCache))
  }, [path])
  const item = path ? items.find((i) => i.path === path) : null
  if (!path || !item) return null
  return <Viewer item={item} items={items} onClose={() => set({ viewer: null })} />
}

export function GalleryPage() {
  const items = useGallery()
  const projects = useApp((s) => s.projects)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState('all')
  const [project, setProject] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [sel, setSel] = useState<string[]>([])
  const [open, setOpen] = useState<GalleryItem | null>(null)
  const [batch, setBatch] = useState<string[] | null>(null)
  const [combine, setCombine] = useState(false)
  const list = useMemo(() => {
    const f = FILTERS.find(([k]) => k === filter)![2]
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((i) => f(i) && (!project || i.projectId === project) &&
      words.every((w) => `${i.prompt} ${i.model || ''} ${baseName(i.path)}`.toLowerCase().includes(w)))
  }, [items, q, filter, project])
  const toggle = (id: string) => setSel((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  const chosen = sel.map((id) => items.find((i) => i.id === id)!).filter(Boolean)
  return (
    <>
      <Header><div /></Header>
      <div className="page">
        <div className="page-inner" style={{ maxWidth: 1200 }}>
          <div className="page-head">
            <h1>Галерея</h1>
            <button className="btn" onClick={async () => {
              const paths = await api.gallery.pickImages()
              if (paths.length) setBatch(paths)
            }}><Layers size={16} />Пакетная обработка</button>
            <button className={`btn ${selecting ? 'primary' : ''}`} onClick={() => {
              setSelecting(!selecting)
              setSel([])
            }}><CheckSquare size={16} />{selecting ? 'Готово' : 'Выбрать'}</button>
          </div>
          <div className="gallery-tools">
            <div className="search-box" style={{ margin: 0, flex: 1 }}><Search size={16} />
              <input placeholder="Поиск по описанию, модели, имени файла…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="input" style={{ width: 200 }} value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">Все проекты</option>
              <option value={get().defaultProject?.id}>Общий</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div className="chips-row" style={{ margin: '12px 0 16px' }}>
            {FILTERS.map(([k, l]) => <button key={k} className={`filter ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>)}
            <span className="sub" style={{ marginLeft: 'auto' }}>{list.length} из {items.length}</span>
          </div>
          {!items.length ? (
            <div className="empty-state"><div className="big"><Images size={30} /></div><h3>Здесь будут все ваши картинки</h3>
              <p>Сгенерированные, увеличенные, отредактированные — из всех чатов.<br />Свои фото можно обработать пачкой: кнопка «Пакетная обработка».</p></div>
          ) : (
            <div className="gallery-grid">
              {list.map((it, n) => (
                <motion.button key={it.id} className={`g-item ${sel.includes(it.id) ? 'sel' : ''}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: Math.min(n, 30) * 0.015 }} onClick={() => (selecting ? toggle(it.id) : setOpen(it))}>
                  <img src={fileUrl(it.path)} loading="lazy" draggable={false} />
                  {it.favorite && <span className="g-fav"><Heart size={13} fill="currentColor" /></span>}
                  {it.parent && <span className="g-badge">{SOURCE[it.source]}</span>}
                  {selecting && <span className={`g-check ${sel.includes(it.id) ? 'on' : ''}`}>{sel.includes(it.id) && <Check size={14} />}</span>}
                  {!selecting && it.prompt && <span className="g-cap">{it.prompt}</span>}
                </motion.button>
              ))}
            </div>
          )}
        </div>
      </div>
      <AnimatePresence>
        {selecting && sel.length > 0 && (
          <motion.div className="sel-bar" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}>
            <b>Выбрано: {sel.length}</b>
            <button className="btn" onClick={() => setBatch(chosen.map((i) => i.path))}><ListChecks size={15} />Обработать пачкой</button>
            <button className="btn" disabled={sel.length < 2 || sel.length > 4} title="2–4 фото" onClick={() => setCombine(true)}><Combine size={15} />Объединить</button>
            <button className="btn" onClick={async () => {
              await Promise.all(sel.map((id) => api.gallery.update(id, { favorite: true })))
              reloadGallery()
            }}><Heart size={15} />В избранное</button>
            <button className="btn danger" onClick={async () => {
              await api.gallery.remove(sel, false)
              setSel([])
              reloadGallery()
              toast('Убрано из галереи (файлы остались на диске)', 'ok')
            }}><Trash2 size={15} />Убрать</button>
            <button className="icon-btn" onClick={() => setSel([])}><X size={16} /></button>
          </motion.div>
        )}
      </AnimatePresence>
      {open && <Viewer item={open} items={items} onClose={() => setOpen(null)} />}
      {batch && <BatchDialog paths={batch} onClose={() => {
        setBatch(null)
        reloadGallery()
      }} />}
      {combine && <CombineDialog items={chosen} onClose={() => {
        setCombine(false)
        setSelecting(false)
        setSel([])
      }} />}
    </>
  )
}


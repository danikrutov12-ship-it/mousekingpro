import { AlertTriangle, Brain, Check, ChevronLeft, ChevronRight, CheckSquare, Eye, EyeOff, Film, FolderInput, FolderOpen, ImagePlus, Plus, ShieldCheck, Trash2, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { ISSUE_TEXT, issuesOf, KINDS, MIN_SIDE, stagesFor, type LoraIssue, type LoraItem, type LoraKind, type LoraProject, type LoraStage, type LoraSummary } from '@shared/lora'
import { toast } from '../lib/actions'
import { api } from '../lib/api'
import { fileUrl } from '../lib/format'
import { Header } from './ChatPage'
import { LoraFrames } from './LoraFrames'
import { Modal } from './Modal'

const IMG = /\.(png|jpe?g|webp|bmp)$/i
const VID = /\.(mp4|mov|webm|mkv|m4v)$/i
const SOURCE: Record<string, string> = { photo: 'фото', import: 'импорт', video: 'видео', generated: 'сгенерировано' }
const errText = (e: unknown) => String((e as Error)?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Слово-триггер из имени: латиница без пробелов + редкое окончание, чтобы не совпасть с обычным словом. */
function triggerFrom(name: string) {
  const map: Record<string, string> = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ы: 'y', э: 'e', ю: 'yu', я: 'ya' }
  const base = name.toLowerCase().split('').map((c) => map[c] ?? c).join('').replace(/[^a-z0-9]+/g, '').slice(0, 10)
  return (base || 'person') + 'xz'
}

/** «Обучение LoRA»: проекты слева, набор выбранного проекта справа. */
export function LoraPage() {
  const [list, setList] = useState<LoraSummary[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const reload = () => api.lora.list().then((l) => {
    setList(l)
    if (!cur && l[0]) setCur(l[0].id)
  })
  useEffect(() => {
    reload()
  }, [])
  return (
    <>
      <Header><div /></Header>
      <div className="lora-page">
        <aside className="lora-list">
          <button className="btn primary" style={{ width: '100%' }} onClick={() => setCreating(true)}><Plus size={15} />Новый проект</button>
          {list.map((p) => (
            <button key={p.id} className={`lora-proj ${p.id === cur ? 'on' : ''}`} onClick={() => setCur(p.id)}>
              {p.cover ? <img src={fileUrl(p.cover)} /> : <span className="ph"><Brain size={16} /></span>}
              <span className="t"><b>{p.name}</b><span>{KINDS.find((k) => k.id === p.kind)?.name} · {p.count} фото</span></span>
            </button>
          ))}
          {!list.length && <div className="sub" style={{ padding: 8 }}>Проектов пока нет. Проект — это один персонаж, стиль, сцена или предмет со своим набором фото.</div>}
        </aside>
        <main className="lora-main">
          {cur ? <LoraWorkspace key={cur} id={cur} onChanged={reload} onDeleted={() => {
            setCur(null)
            reload()
          }} /> : (
            <div className="empty-state"><div className="big"><Brain size={30} /></div><h3>Обучение LoRA</h3>
              <p>Соберите набор фото персонажа по этапам — лицо, тело, приметы, разнообразие — или загрузите готовую папку.<br />Программа проверит качество кадров и подскажет, чего не хватает.</p>
              <button className="btn primary" onClick={() => setCreating(true)}><Plus size={15} />Новый проект</button></div>
          )}
        </main>
      </div>
      {creating && <NewProject onClose={() => setCreating(false)} onCreated={(p) => {
        setCreating(false)
        setCur(p.id)
        reload()
      }} />}
    </>
  )
}

const CONSENT_TEXT = 'Человек на фото — я сам или дал согласие на обучение модели по своей внешности'

function NewProject({ onClose, onCreated }: { onClose(): void; onCreated(p: LoraProject): void }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState<LoraKind>('character')
  const [trigger, setTrigger] = useState('')
  const [who, setWho] = useState<'fictional' | 'real' | ''>('')
  const [consent, setConsent] = useState(false)
  const ok = name.trim() && (kind !== 'character' || who === 'fictional' || (who === 'real' && consent))
  return (
    <Modal open onClose={onClose} title="Новый проект LoRA" icon={<Brain size={18} />} width={620}
      footer={<>
        <button className="btn ghost" onClick={onClose}>Отмена</button>
        <button className="btn primary" disabled={!ok} onClick={async () => {
          try {
            const p = await api.lora.create(name, kind, trigger || triggerFrom(name))
            if (kind === 'character' && who === 'real') await api.lora.update(p.id, { consent: { at: Date.now(), text: CONSENT_TEXT } })
            onCreated(p)
          } catch (e) {
            toast(errText(e), 'error')
          }
        }}><Check size={14} />Создать</button>
      </>}>
      <div className="lora-form">
        <div className="field"><label>Название</label>
          <input className="input" autoFocus placeholder="Например: Алина" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Что обучаем</label>
          <div className="lora-kinds">
            {KINDS.map((k) => (
              <button key={k.id} className={`lora-kind ${kind === k.id ? 'on' : ''}`} onClick={() => setKind(k.id)}><b>{k.name}</b><span>{k.note}</span></button>
            ))}
          </div></div>
        {kind === 'character' && (
          <div className="field"><label>Чья внешность</label>
            <div className="lora-kinds two">
              <button className={`lora-kind ${who === 'fictional' ? 'on' : ''}`} onClick={() => setWho('fictional')}><b>Вымышленный персонаж</b><span>Создан нейросетью или нарисован — реального человека с такой внешностью нет.</span></button>
              <button className={`lora-kind ${who === 'real' ? 'on' : ''}`} onClick={() => setWho('real')}><b>Реальный человек</b><span>Вы сами или человек, который согласился на обучение по своим фото.</span></button>
            </div>
            {who === 'real' && (
              <label className="lora-consent"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><ShieldCheck size={15} />{CONSENT_TEXT}</label>
            )}
          </div>
        )}
        <div className="field"><label>Слово-триггер</label>
          <input className="input mono" placeholder={triggerFrom(name || 'person')} value={trigger} onChange={(e) => setTrigger(e.target.value.replace(/\s+/g, ''))} />
          <div className="hint">Им LoRA вызывается в промпте. Редкое слово без пробелов, чтобы не совпало с обычным. Можно оставить предложенное.</div></div>
      </div>
    </Modal>
  )
}

function LoraWorkspace({ id, onChanged, onDeleted }: { id: string; onChanged(): void; onDeleted(): void }) {
  const [p, setP] = useState<LoraProject | null>(null)
  const [dir, setDir] = useState('')
  const [tab, setTab] = useState<LoraStage | 'all' | 'issues'>('all')
  const [selecting, setSelecting] = useState(false)
  const [sel, setSel] = useState<string[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [videos, setVideos] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  const [drag, setDrag] = useState(false)
  const load = () => api.lora.get(id).then((r) => {
    setP(r.project)
    setDir(r.dir)
  })
  useEffect(() => {
    load()
  }, [id])
  // для тестового режима (VA_SHOT): открыть отбор кадров без системного окна выбора файла
  useEffect(() => {
    const on = (e: Event) => setVideos((e as CustomEvent<string[]>).detail)
    window.addEventListener('lora:test-videos', on)
    return () => window.removeEventListener('lora:test-videos', on)
  }, [])
  const apply = (proj: LoraProject) => {
    setP(proj)
    onChanged()
  }
  const issues = useMemo(() => (p ? issuesOf(p.items) : new Map<string, LoraIssue[]>()), [p])
  if (!p) return null
  const stages = stagesFor(p.kind)
  const path = (it: LoraItem) => `${dir}/${it.file}`
  const included = p.items.filter((i) => !i.excluded)
  const problem = p.items.filter((i) => !i.excluded && issues.get(i.id)?.length)
  const shown = tab === 'all' ? p.items : tab === 'issues' ? problem : p.items.filter((i) => i.stage === tab)
  const addStage: LoraStage = tab === 'all' || tab === 'issues' ? (stages.some((s) => s.id === 'other') ? 'other' : stages[0].id) : tab

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      toast(errText(e), 'error')
    }
    setBusy('')
    await load()
    onChanged()
  }
  const addPaths = (paths: string[]) => {
    const imgs = paths.filter((x) => IMG.test(x))
    const vids = paths.filter((x) => VID.test(x))
    if (imgs.length) run('Добавляю фото…', async () => {
      const r = await api.lora.addFiles(id, imgs, addStage)
      toast(`Добавлено фото: ${r.added}${r.skipped.length ? `, пропущено: ${r.skipped.length}` : ''}`, 'ok')
    })
    if (vids.length) setVideos(vids)
  }
  const ids = (list: LoraItem[]) => list.map((i) => i.id)
  const act = async (fn: Promise<LoraProject>) => {
    try {
      apply(await fn)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  return (
    <div className={`lora-ws ${drag ? 'drag' : ''}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setDrag(false)
        addPaths([...e.dataTransfer.files].map((f) => api.attach.pathFor(f)).filter(Boolean))
      }}>
      <div className="lora-head">
        <input className="lora-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })}
          onBlur={() => act(api.lora.update(id, { name: p.name }))} />
        <span className="lora-tag">{KINDS.find((k) => k.id === p.kind)?.name}</span>
        {p.consent && <span className="lora-tag ok" title={p.consent.text}><ShieldCheck size={12} />согласие</span>}
        <label className="lora-inline">Триггер
          <input className="input mono" style={{ width: 150 }} value={p.trigger} onChange={(e) => setP({ ...p, trigger: e.target.value.replace(/\s+/g, '') })}
            onBlur={() => act(api.lora.update(id, { trigger: p.trigger }))} />
        </label>
        <button className="icon-btn" title="Открыть папку проекта" onClick={() => api.lora.open(id)}><FolderOpen size={17} /></button>
        <button className="icon-btn" title="Удалить проект" onClick={async () => {
          if (!confirm(`Удалить проект «${p.name}» вместе со всеми его фото? Исходные файлы на диске не затрагиваются.`)) return
          await api.lora.remove(id)
          onDeleted()
        }}><Trash2 size={17} /></button>
      </div>

      <div className="lora-stages">
        {stages.filter((s) => s.target > 0).map((s) => {
          const n = included.filter((i) => i.stage === s.id).length
          return (
            <button key={s.id} className={`lora-stage ${tab === s.id ? 'on' : ''} ${n >= s.target ? 'full' : ''}`} onClick={() => setTab(s.id)} title={s.hint}>
              <span className="row"><b>{s.name}</b><span>{n} / {s.target}</span></span>
              <span className="lora-bar"><span style={{ width: `${Math.min(100, (n / s.target) * 100)}%` }} /></span>
              <span className="hint">{n >= s.target ? 'Достаточно' : s.hint}</span>
            </button>
          )
        })}
      </div>

      <div className="lora-tools">
        <div className="chips-row">
          <button className={`filter ${tab === 'all' ? 'on' : ''}`} onClick={() => setTab('all')}>Все {p.items.length}</button>
          {stages.map((s) => {
            const n = p.items.filter((i) => i.stage === s.id).length
            return (s.target > 0 || n > 0) && <button key={s.id} className={`filter ${tab === s.id ? 'on' : ''}`} onClick={() => setTab(s.id)}>{s.name} {n}</button>
          })}
          {problem.length > 0 && <button className={`filter warn ${tab === 'issues' ? 'on' : ''}`} onClick={() => setTab('issues')}><AlertTriangle size={12} />С проблемами {problem.length}</button>}
        </div>
        <div className="lora-actions">
          <button className="btn" onClick={async () => addPaths(await api.lora.pick('images'))}><ImagePlus size={15} />Фото</button>
          <button className="btn" onClick={async () => {
            const [d] = await api.lora.pick('folder')
            if (d) run('Импортирую папку…', async () => {
              const r = await api.lora.importFolder(id, d)
              toast(`Импортировано фото: ${r.added}${r.notes ? ', заметки добавлены' : ''}${r.videos.length ? `. Видео: ${r.videos.length} — отберите из них кадры` : ''}`, 'ok')
              if (r.videos.length) setVideos(r.videos)
            })
          }}><FolderInput size={15} />Импорт папки</button>
          <button className="btn" onClick={async () => {
            const v = await api.lora.pick('videos')
            if (v.length) setVideos(v)
          }}><Film size={15} />Кадры из видео</button>
          <button className={`btn ${selecting ? 'primary' : ''}`} onClick={() => {
            setSelecting(!selecting)
            setSel([])
          }}><CheckSquare size={15} />{selecting ? 'Готово' : 'Выбрать'}</button>
        </div>
      </div>

      {busy && <div className="opt-hint" style={{ margin: '6px 0' }}>{busy}</div>}
      {tab !== 'all' && tab !== 'issues' && <div className="opt-hint" style={{ margin: '6px 0 10px' }}>{stages.find((s) => s.id === tab)?.hint}</div>}

      {!p.items.length ? (
        <div className="lora-drop">
          <ImagePlus size={28} />
          <b>Перетащите сюда фото или видео</b>
          <span>Или «Импорт папки» — подпапки с названиями face, body, tattoo и т. п. сами разложатся по этапам. Из видео программа отберёт самые резкие кадры.</span>
        </div>
      ) : (
        <div className="lora-grid">
          {shown.map((it) => {
            const iss = issues.get(it.id) || []
            return (
              <button key={it.id} className={`lora-item ${it.excluded ? 'off' : ''} ${sel.includes(it.id) ? 'sel' : ''}`}
                onClick={() => (selecting ? setSel((x) => (x.includes(it.id) ? x.filter((y) => y !== it.id) : [...x, it.id])) : setOpen(it.id))}>
                <img src={fileUrl(path(it))} loading="lazy" draggable={false} />
                {iss.length > 0 && !it.excluded && <span className="lora-warn" title={iss.map((x) => ISSUE_TEXT[x]).join('\n')}><AlertTriangle size={12} />{iss.length}</span>}
                {it.excluded && <span className="lora-off"><EyeOff size={12} />исключено</span>}
                <span className="lora-meta">{stages.find((s) => s.id === it.stage)?.name} · {SOURCE[it.source]}</span>
                {selecting && <span className={`g-check ${sel.includes(it.id) ? 'on' : ''}`}>{sel.includes(it.id) && <Check size={14} />}</span>}
              </button>
            )
          })}
        </div>
      )}

      <details className="lora-notes" open={!!p.notes}>
        <summary>Заметки к набору</summary>
        <textarea className="input" rows={5} placeholder="Особенности персонажа: актуальный цвет волос, татуировки, что важно сохранить. Пригодится на этапе подписей."
          value={p.notes} onChange={(e) => setP({ ...p, notes: e.target.value })} onBlur={() => act(api.lora.update(id, { notes: p.notes }))} />
      </details>

      <AnimatePresence>
        {selecting && sel.length > 0 && (
          <motion.div className="sel-bar" initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 40, opacity: 0 }}>
            <b>Выбрано: {sel.length}</b>
            <select className="input" value="" onChange={(e) => e.target.value && act(api.lora.items(id, sel, { stage: e.target.value as LoraStage }))}>
              <option value="">Перенести в этап…</option>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button className="btn" onClick={() => act(api.lora.items(id, sel, { excluded: true }))}><EyeOff size={15} />Исключить</button>
            <button className="btn" onClick={() => act(api.lora.items(id, sel, { excluded: false }))}><Eye size={15} />Вернуть</button>
            <button className="btn ghost danger" onClick={async () => {
              if (!confirm(`Удалить из проекта фото: ${sel.length}?`)) return
              await act(api.lora.removeItems(id, sel))
              setSel([])
            }}><Trash2 size={15} />Удалить</button>
            <button className="btn ghost" onClick={() => setSel(ids(shown))}>Все на экране</button>
            <button className="icon-btn sm" onClick={() => setSel([])}><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {open && <ItemViewer p={p} dir={dir} id={open} list={shown} issues={issues} stages={stages} onOpen={setOpen} onClose={() => setOpen(null)}
        onChange={(ids_, patch) => act(api.lora.items(id, ids_, patch))}
        onRemove={async (it) => {
          const i = shown.findIndex((x) => x.id === it)
          await act(api.lora.removeItems(id, [it]))
          setOpen(shown[i + 1]?.id || shown[i - 1]?.id || null)
        }} />}
      {videos.length > 0 && <LoraFrames projectId={id} videos={videos} stages={stages} stage={addStage} onDone={() => {
        setVideos([])
        load()
        onChanged()
      }} />}
    </div>
  )
}

function ItemViewer({ p, dir, id, list, issues, stages, onOpen, onClose, onChange, onRemove }: {
  p: LoraProject; dir: string; id: string; list: LoraItem[]; issues: Map<string, LoraIssue[]>; stages: ReturnType<typeof stagesFor>
  onOpen(id: string): void; onClose(): void; onChange(ids: string[], patch: Partial<LoraItem>): void; onRemove(id: string): void
}) {
  const it = p.items.find((x) => x.id === id)
  const i = list.findIndex((x) => x.id === id)
  const [caption, setCaption] = useState(it?.caption || '')
  useEffect(() => setCaption(it?.caption || ''), [id])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'TEXTAREA') return
      if (e.key === 'ArrowRight' && list[i + 1]) onOpen(list[i + 1].id)
      if (e.key === 'ArrowLeft' && list[i - 1]) onOpen(list[i - 1].id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [i, list])
  if (!it) return null
  const iss = issues.get(it.id) || []
  return (
    <Modal open onClose={onClose} width={1100} title={`${i + 1} из ${list.length}`}>
      <div className="lora-viewer">
        <div className="lora-viewer-img">
          <img src={fileUrl(`${dir}/${it.file}`)} />
          {list[i - 1] && <button className="lora-nav l" onClick={() => onOpen(list[i - 1].id)}><ChevronLeft size={22} /></button>}
          {list[i + 1] && <button className="lora-nav r" onClick={() => onOpen(list[i + 1].id)}><ChevronRight size={22} /></button>}
        </div>
        <div className="lora-viewer-side">
          <div className="lora-facts">
            <span>{it.w}×{it.h}{Math.min(it.w, it.h) < MIN_SIDE ? ' — мелкое' : ''}</span>
            <span>резкость {it.sharp}</span>
            <span>{SOURCE[it.source]}</span>
          </div>
          {it.origin && <div className="sub" style={{ wordBreak: 'break-all' }}>{it.origin}</div>}
          {iss.map((x) => <div key={x} className="opt-warn">{ISSUE_TEXT[x]}</div>)}
          <div className="field"><label>Этап</label>
            <select className="input" value={it.stage} onChange={(e) => onChange([it.id], { stage: e.target.value as LoraStage })}>
              {stages.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></div>
          <div className="field"><label>Подпись для обучения</label>
            <textarea className="input" rows={6} placeholder="Заполнится на этапе подписей (скоро). Можно написать вручную: что на фото, кроме самой внешности, — одежда, поза, место, свет."
              value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={() => caption !== it.caption && onChange([it.id], { caption })} /></div>
          <div className="lora-viewer-actions">
            <button className="btn" onClick={() => onChange([it.id], { excluded: !it.excluded })}>{it.excluded ? <><Eye size={15} />Вернуть в обучение</> : <><EyeOff size={15} />Исключить</>}</button>
            <button className="btn ghost danger" onClick={() => onRemove(it.id)}><Trash2 size={15} />Удалить</button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

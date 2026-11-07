import { Ban, CheckCircle2, Info, Plus, ShieldCheck, X, Zap } from 'lucide-react'
import { proModel } from '@shared/runpod'
import type { Model } from '@shared/types'
import { saveSettings } from '../lib/actions'
import { set, useApp } from '../lib/store'

type Opts = NonNullable<import('@shared/types').Settings['pro_opts']>
const ASPECTS = ['1:1', '3:4', '4:3', '2:3', '3:2', '9:16', '16:9']

/** Параметры «Картинки Pro»: негатив (с явной пометкой, работает ли он), быстрый режим, сила img2img, размер, LoRA, ×2. */
export function ProOptions({ model, photos }: { model: Model | null; photos: number }) {
  const opts: Opts = useApp((s) => s.settings?.pro_opts) || {}
  const negative = useApp((s) => s.proNegative)
  const configured = useApp((s) => !!s.settings?.runpod_endpoint)
  if (!model) return null
  const m = proModel(model.id)
  const upd = (patch: Partial<Opts>) => saveSettings({ pro_opts: { ...opts, ...patch } })
  const fast = !!(m.fast && opts.fast)
  const negOk = m.negative(fast)
  const loras = opts.loras || []
  const negNote = negOk ? <><CheckCircle2 size={13} />Негатив работает</>
    : m.fast && fast ? <><Info size={13} />В быстром режиме негатив не учитывается — выключите «Быстро»</>
      : <><Info size={13} />{m.name} не поддерживает негатив — поле не учитывается</>

  return (
    <div className="pro-opts">
      {!configured && (
        <div className="opt-warn">RunPod ещё не подключён: Настройки → RunPod (ключ и ID эндпоинта).</div>
      )}
      <div className="pro-note">{m.note}</div>
      {m.kind === 'edit' && !photos && <div className="opt-warn">{m.name} правит фото — прикрепите от 1 до {m.maxRefs}.</div>}
      {photos > m.maxRefs && <div className="opt-warn">{m.name} возьмёт первые {m.maxRefs} фото из {photos}.</div>}

      <div className={`pro-neg ${negOk ? '' : 'off'}`}>
        <Ban size={13} />
        <input placeholder="Негатив (необязательно): чего не должно быть — размытие, лишние пальцы, надписи…" value={negative}
          onChange={(e) => set({ proNegative: e.target.value })} />
        {negative && <button className="icon-btn sm" title="Очистить" onClick={() => set({ proNegative: '' })}><X size={12} /></button>}
      </div>
      <div className={`pro-neg-note ${negOk ? 'ok' : ''}`}>{negNote}</div>

      <div className="options">
        {m.kind === 'edit' && (
          <label className={`chip-toggle ${opts.keep !== false ? 'on' : ''}`}
            title="Из генерации берётся только то, что изменилось (одежда, предмет). Лицо, кожа, свет и фон остаются пикселями исходного фото в полном качестве. Выключите для смены позы, ракурса или всей сцены.">
            <input type="checkbox" checked={opts.keep !== false} onChange={(e) => upd({ keep: e.target.checked })} /><ShieldCheck size={13} />Сохранять исходник
          </label>
        )}
        {m.fast && (
          <label className={`chip-toggle ${fast ? 'on' : ''}`} title="4 шага вместо 40: в ~8 раз быстрее и дешевле, но без негатива и чуть грубее">
            <input type="checkbox" checked={fast} onChange={(e) => upd({ fast: e.target.checked })} /><Zap size={13} />Быстро
          </label>
        )}
        {m.kind === 'gen' && photos > 0 && (
          <label className="ed-slider pro-strength" title="Насколько перерисовать фото: меньше — ближе к оригиналу">
            <span>Изменить фото на</span>
            <input type="range" className="range" min={0.2} max={0.9} step={0.05} value={opts.strength ?? 0.5}
              onChange={(e) => upd({ strength: Number(e.target.value) })} />
            <em>{Math.round((opts.strength ?? 0.5) * 100)}%</em>
          </label>
        )}
        {m.kind === 'gen' && !photos && (
          <select className="input" style={{ width: 'auto', height: 30, padding: '0 8px' }} value={opts.aspect || '1:1'} onChange={(e) => upd({ aspect: e.target.value })}>
            {ASPECTS.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <label className={`chip-toggle ${opts.upscale ? 'on' : ''}`} title="Увеличить результат в 2 раза (4x-UltraSharp)">
          <input type="checkbox" checked={!!opts.upscale} onChange={(e) => upd({ upscale: e.target.checked })} />Увеличить ×2
        </label>
      </div>

      {m.lora && (
        <div className="pro-loras">
          {loras.map((l, i) => (
            <div key={i} className="pro-lora">
              <input className="input mono" placeholder="имя_файла.safetensors" value={l.name}
                onChange={(e) => upd({ loras: loras.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)) })} />
              <input type="range" className="range" min={0} max={1.5} step={0.05} value={l.weight}
                onChange={(e) => upd({ loras: loras.map((x, j) => (j === i ? { ...x, weight: Number(e.target.value) } : x)) })} />
              <em>{l.weight.toFixed(2)}</em>
              <button className="icon-btn sm" title="Убрать LoRA" onClick={() => upd({ loras: loras.filter((_, j) => j !== i) })}><X size={12} /></button>
            </div>
          ))}
          {loras.length < 3 && (
            <button className="meta-btn" style={{ opacity: 1 }} onClick={() => upd({ loras: [...loras, { name: '', weight: 0.8 }] })}>
              <Plus size={13} />LoRA {loras.length ? '' : '(необязательно — файл должен лежать на диске RunPod в models/loras)'}
            </button>
          )}
          {loras.some((l) => l.name) && <div className="sub">LoRA должна быть сделана для семейства этой модели, иначе не подействует или испортит картинку.</div>}
        </div>
      )}
    </div>
  )
}

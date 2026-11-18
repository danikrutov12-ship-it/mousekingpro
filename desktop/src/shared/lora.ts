// «Обучение LoRA»: проекты (персонаж, стиль, сцена, предмет) и их наборы фото. Общее для интерфейса и основного процесса.

export type LoraKind = 'character' | 'style' | 'scene' | 'object'
export type LoraStage = 'face' | 'body' | 'details' | 'variety' | 'other'
export type LoraSource = 'photo' | 'import' | 'video' | 'generated'

export interface LoraItem {
  id: string
  /** имя файла в папке images проекта */
  file: string
  source: LoraSource
  stage: LoraStage
  /** подпись для обучения (заполняется на этапе подписей) */
  caption: string
  /** не брать в обучение, но оставить в проекте */
  excluded?: boolean
  w: number
  h: number
  /** резкость: дисперсия лапласиана на уменьшенной копии (больше — резче) */
  sharp: number
  /** перцептивный хеш (dHash, 16 hex) — для поиска дублей */
  hash: string
  /** откуда взято: исходный путь или «видео @ 12.4 с» */
  origin?: string
  added: number
}

export interface LoraProject {
  id: string
  name: string
  kind: LoraKind
  /** слово-триггер, которым LoRA вызывается в промпте */
  trigger: string
  notes: string
  /** согласие человека на обучение по его внешности (для персонажа-реального человека) */
  consent?: { at: number; text: string }
  created: number
  updated: number
  items: LoraItem[]
}

export interface LoraSummary { id: string; name: string; kind: LoraKind; count: number; cover?: string; updated: number }

export const KINDS: { id: LoraKind; name: string; note: string }[] = [
  { id: 'character', name: 'Персонаж', note: 'Конкретная внешность: лицо, волосы, фигура, приметы. Самый требовательный тип — собирается по этапам.' },
  { id: 'style', name: 'Стиль', note: 'Манера изображения: цвет, свет, фактура, обработка. Фото — разные сюжеты в одном стиле.' },
  { id: 'scene', name: 'Сцена', note: 'Место или обстановка: интерьер, локация. Фото — одно место с разных точек и при разном свете.' },
  { id: 'object', name: 'Предмет / одежда', note: 'Вещь, которую нужно воспроизводить точно. Фото — с разных сторон, на разном фоне.' },
]

export interface StageInfo { id: LoraStage; name: string; hint: string; target: number }

/** Этапы набора: для персонажа — цепочка «лицо → тело → приметы → разнообразие». */
export function stagesFor(kind: LoraKind): StageInfo[] {
  if (kind === 'character') {
    return [
      { id: 'face', name: 'Лицо', target: 12, hint: 'Крупные планы: анфас, три четверти слева и справа, профиль, разные выражения. Лицо — не меньше трети кадра, без рук и волос на лице.' },
      { id: 'body', name: 'Тело', target: 12, hint: 'По пояс и в полный рост, разные позы, сидя и стоя. Одежда разная — иначе LoRA запомнит один комплект.' },
      { id: 'details', name: 'Приметы', target: 4, hint: 'Татуировки, родинки, макияж, причёска — крупно и чётко. Подписи к ним важнее, чем к остальным фото.' },
      { id: 'variety', name: 'Разнообразие', target: 8, hint: 'Другие места, свет и время суток. Без этого LoRA запомнит одну комнату вместе с человеком.' },
      { id: 'other', name: 'Без этапа', target: 0, hint: 'Ещё не разложенные фото — перенесите в нужный этап или исключите.' },
    ]
  }
  return [
    { id: 'other', name: 'Набор', target: kind === 'style' ? 25 : 15, hint: 'Разные сюжеты и ракурсы, хорошее качество.' },
    { id: 'variety', name: 'Разнообразие', target: 0, hint: 'Необычные кадры, которые расширяют набор.' },
  ]
}

export const MIN_SIDE = 768
export const SHARP_MIN = 40

/** Разница двух dHash в битах. */
export function hashDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

export type LoraIssue = 'small' | 'blurry' | 'duplicate'
export const ISSUE_TEXT: Record<LoraIssue, string> = {
  small: `Мелкое: меньше ${MIN_SIDE} px по короткой стороне — модель выучит мыло`,
  blurry: 'Размытое или пережатое — для обучения нужна резкость',
  duplicate: 'Почти такое же фото уже есть — дубли перекашивают обучение',
}

/** Проблемы каждого фото набора (дубль — второе и следующие из похожих). */
export function issuesOf(items: LoraItem[]): Map<string, LoraIssue[]> {
  const out = new Map<string, LoraIssue[]>()
  const seen: LoraItem[] = []
  for (const it of items) {
    const list: LoraIssue[] = []
    if (Math.min(it.w, it.h) < MIN_SIDE) list.push('small')
    if (it.sharp < SHARP_MIN) list.push('blurry')
    if (!it.excluded && seen.some((s) => hashDistance(s.hash, it.hash) <= 5)) list.push('duplicate')
    if (!it.excluded) seen.push(it)
    out.set(it.id, list)
  }
  return out
}

/** Этап по пути при импорте папки: 01_face/front → лицо, 02_body → тело, tattoos/makeup → приметы. */
export function stageFromPath(rel: string): LoraStage {
  const p = rel.toLowerCase()
  if (/face|лиц|portrait|портрет|head|голов/.test(p)) return 'face'
  if (/body|тел|full|waist|рост|пояс|pose|поз/.test(p)) return 'body'
  if (/tattoo|тату|makeup|макияж|detail|детал|hair|волос|nail|ногт/.test(p)) return 'details'
  if (/variety|разн|location|локац|outdoor|улиц/.test(p)) return 'variety'
  return 'other'
}

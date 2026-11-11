// Небольшое глобальное хранилище состояния на useSyncExternalStore.
import { useSyncExternalStore } from 'react'
import type {
  Attachment, Balance, Chat, ChatSummary, Job, MemoryItem, Mode, ModelsResult, Project, Settings, UpdateState,
} from '@shared/types'

export interface Artifact { kind: 'html' | 'svg' | 'mermaid' | 'file'; title: string; code?: string; path?: string }
export type PanelTab = 'preview' | 'changes' | 'terminal' | 'files' | 'git'
export type Panel = { tab: PanelTab; artifact?: Artifact; file?: string } | null

export interface Run { text: string; status: string; outputs: Record<string, string> }

export type View = { page: 'chat' } | { page: 'projects' } | { page: 'gallery' } | { page: 'project'; projectId: string }

export interface ApprovalReq { id: string; chatId: string; title: string; details: string; danger?: string }
export interface Toast { id: number; text: string; kind?: 'error' | 'ok' }

export interface State {
  ready: boolean
  settings: Settings | null
  models: ModelsResult
  modelsLoading: boolean
  balance: Balance | null
  defaultProject: Project | null
  projects: Project[]
  view: View
  current: { projectId: string; chat: Chat; isNew: boolean } | null
  recents: ChatSummary[]
  runs: Record<string, Run>
  jobs: Job[]
  panel: Panel
  memoryOn: boolean          // память в текущем (новом) чате
  memories: MemoryItem[]
  compare: { index: number } | null
  viewer: string | null // путь картинки, открытой в просмотре галереи
  refSet: string | null // выбранный набор референсов
  keepRest: boolean     // при правке по фото: не менять остальное
  avoid: string         // при правке по фото: чего не должно быть (аналог негативного промпта)
  proNegative: string   // «Картинка Pro»: негативный промпт
  faceBase: string | null  // фейсвап: фото-основа, куда вставляется лицо
  faceDonor: string | null // фейсвап: фото, откуда берётся лицо
  approvals: ApprovalReq[]
  mode: Mode
  draft: string
  attachments: Attachment[]
  attaching: boolean
  focusTick: number
  palette: boolean
  settingsOpen: boolean
  lightbox: string | null
  toasts: Toast[]
  win: { maximized: boolean; focused: boolean; dark: boolean }
  update: UpdateState | null
  updateHidden: string // версия, плашку которой закрыли «Позже»
}

let state: State = {
  ready: false,
  settings: null,
  models: { text: [], image: [], video: [], pro: [], errors: '' },
  modelsLoading: false,
  balance: null,
  defaultProject: null,
  projects: [],
  view: { page: 'chat' },
  current: null,
  recents: [],
  runs: {},
  jobs: [],
  panel: null,
  memoryOn: true,
  memories: [],
  compare: null,
  viewer: null,
  refSet: null,
  keepRest: true,
  avoid: '',
  proNegative: '',
  faceBase: null,
  faceDonor: null,
  approvals: [],
  mode: 'text',
  draft: '',
  attachments: [],
  attaching: false,
  focusTick: 0,
  palette: false,
  settingsOpen: false,
  lightbox: null,
  toasts: [],
  update: null,
  updateHidden: '',
  win: { maximized: false, focused: true, dark: false },
}

const listeners = new Set<() => void>()

export const get = () => state

export function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const next = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export function useApp<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => select(state),
  )
}

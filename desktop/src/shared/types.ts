// Общие типы основного процесса и интерфейса. Формат чатов и проектов совместим с версией на Python.

export type Mode = 'text' | 'image' | 'video' | 'pro'
export type Theme = 'light' | 'dark' | 'system'

export interface Settings {
  api_key: string
  base_url: string
  text_model: string
  image_model: string
  video_model: string
  pro_model: string
  runpod_endpoint: string
  /** последние настройки «Картинки Pro» */
  pro_opts?: { keep?: boolean; hires?: boolean; detail?: boolean; maxq?: boolean; fast?: boolean; strength?: number; upscale?: boolean; aspect?: string; loras?: { name: string; weight: number }[]; restore?: boolean; restoreWeight?: number; faceIndex?: number; allFaces?: boolean; swapModel?: string }
  temperature: number
  max_steps: number
  tool_mode: 'auto' | 'native' | 'text'
  venice_system_prompt: boolean
  venice_web_search: 'off' | 'auto' | 'on'
  safe_mode: boolean
  theme: Theme
  sidebar: boolean
  user_name?: string
  user_instructions?: string // «Ваши инструкции»: учитываются во всех чатах
  context_budget: number      // сколько токенов истории отправлять модели, остальное сжимается
  auto_safe_commands: boolean // команды только для чтения (ls, cat, grep, git status…) — без вопроса
  allowed_commands: string[]  // свои команды без вопроса, по началу строки: «npm test», «pytest»
  limit_chat_usd: number      // лимит расходов на один чат, 0 — без лимита
  limit_day_usd: number       // лимит расходов в день, 0 — без лимита
  servers: Server[]
  tts_model: string
  tts_voice: string
  stt_model: string
  memory_enabled: boolean     // память между чатами (в каждом чате её можно выключить)
  mcp_servers: McpServer[]
  git_auto: boolean           // ветка на чат и коммит после каждого ответа (если папка проекта — git-репозиторий)
  telegram: { enabled: boolean; chat_id?: number; name?: string; current?: { projectId: string; chatId: string }; mode?: 'chat' | 'image'; imagesChat?: string }
  schedules: Schedule[]
  fast_model: string          // дешёвая модель для помощников и сводок контекста
  embedding_model: string
  notifications: boolean
  browser_auto: boolean       // клики и ввод в браузере агента — без вопроса
  autostart: boolean
  prompts: SavedPrompt[]      // библиотека удачных промптов
  ref_sets: RefSet[]          // наборы референсов (до 10 фото): человек, товар, стиль
  edit_model: string          // модель правки по фото
  vision_model: string        // модель со зрением для описаний фото (пусто — автоматически)
}

export interface Price { usd: number; diem?: number }

export interface GalleryItem {
  id: string
  path: string
  prompt: string
  model?: string
  params?: Record<string, any>
  source: 'generate' | 'upscale' | 'background' | 'edit' | 'combine' | 'local' | 'own' | 'batch' | 'video'
  parent?: string      // id версии, из которой сделана эта
  projectId?: string
  chatId?: string
  created: number
  cost?: number
  seed?: number
  favorite?: boolean
  hash?: string        // sha256 содержимого — одно и то же фото не заводим дважды
  aliases?: string[]   // другие пути к тому же файлу (повторные вложения)
}

export interface SavedPrompt { id: string; title: string; text: string }
export interface RefSet { id: string; name: string; paths: string[] }
export interface EditModel { id: string; name: string; price: number | null; max: number; uncensored: boolean }

export type BatchOp =
  | { kind: 'upscale'; scale: 2 | 4 }
  | { kind: 'background' }
  | { kind: 'edit'; prompt: string; model: string }
  | { kind: 'convert'; format: 'jpeg' | 'png'; quality: number; maxSide: number }
  | { kind: 'describe'; task: 'caption' | 'alt' | 'ocr' | 'critique' }

export interface BatchStatus {
  id: string; total: number; done: number; failed: number; current: string; running: boolean
  outDir: string; outputs: string[]; errors: string[]; texts: { path: string; text: string }[]; cost: number
}

export interface McpServer { id: string; name: string; command: string; args?: string[]; env?: Record<string, string>; enabled: boolean; trusted?: boolean }
export interface McpStatus { id: string; connected: boolean; tools: string[]; error?: string }
export interface MemoryItem { id: string; text: string; created: number; projectId?: string }
export interface Schedule {
  id: string; name: string; prompt: string; projectId?: string
  every: 'minutes' | 'hour' | 'day' | 'week'; minutes?: number; time?: string; weekday?: number
  enabled: boolean; auto_approve: boolean; telegram: boolean; created: number; last?: number
}
export interface GitInfo {
  repo: boolean; branch?: string; current?: string; base?: string; exists?: boolean; remote?: string; dirty?: number
  commits?: { hash: string; subject: string; when: string }[]
}
export interface CompareResult { model: string; name: string; text: string; cost: number | null; error?: boolean }

/** Сервер для деплоя. Пароль хранится отдельно в зашифрованных секретах (server:<id>). */
export interface Server {
  id: string
  name: string
  host: string
  port: number
  user: string
  auth: 'key' | 'password'
  key_path?: string
  deploy_path?: string
  notes?: string
}

export interface Model {
  id: string
  type: Mode
  name: string
  description: string
  uncensored: boolean
  tools: boolean
  vision: boolean
  reasoning: boolean
  web_search: boolean
  context: number | null
  constraints: Record<string, any>
  pricing: Record<string, any>
}

export interface ModelsResult { text: Model[]; image: Model[]; video: Model[]; pro: Model[]; errors: string }

export interface Project {
  id: string
  name: string
  folder: string
  description?: string
  instructions?: string
  created: number
  default?: boolean
  chat_count?: number
  updated?: number
}

export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string | ContentPart[] | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  _name?: string            // имя инструмента у результата
  _display?: string         // текст пользователя без служебных вставок
  _attachments?: string[]   // имена вложений
  _photos?: string[]        // полные пути прикреплённых фото и видео — показываются в ленте картинками
  _mode?: string            // подпись режима генерации
  _media?: string[]         // пути к картинкам и видео
  _error?: boolean
  _cost?: number            // USD
  _tokens?: [number, number]
  _denied?: boolean
  _hidden?: boolean         // служебное сообщение пользователя (например, «продолжай»), в ленте не показывается
  _stopped?: boolean        // отметка: выполнение остановлено
  _limit?: boolean          // отметка: достигнут лимит шагов
  _change?: FileChange      // какой файл изменил этот шаг (для отката)
  _undone?: boolean         // изменение откатили
  _id?: string
  _alts?: (Message[] | null)[] // варианты продолжения с этого сообщения (правка, повтор); null — текущий
  _alt?: number
  _gen?: { mode: Mode; model: string; params?: Record<string, any> } // как повторить генерацию картинки/видео
  _op?: MediaOp             // действие с фото (для «Повторить»)
  _images?: string[]        // картинки для модели (скриншоты браузера), пути к файлам
  _spend?: 'chat' | 'day'   // отметка: остановлено лимитом расходов
}

export interface ChangeSummary { path: string; backup: string | null; callIds: string[]; undone: boolean }
export interface SearchHit { project_id: string; chat_id: string; title: string; snippet: string; updated: number }
export interface Secret { name: string; preview: string }
export type MediaOp =
  | { kind: 'upscale'; path: string; scale: 2 | 4 }
  | { kind: 'background'; path: string }
  | { kind: 'edit'; path: string; prompt: string; model: string }
  | { kind: 'combine'; paths: string[]; prompt: string; model: string }

/** Изменение файла агентом: backup — копия прежней версии, null — файл был создан с нуля. */
export interface FileChange { path: string; backup: string | null }

export interface Job {
  id: string
  name: string
  command: string
  cwd: string
  chatId: string
  started: number
  ended?: number
  status: 'running' | 'done' | 'failed' | 'stopped'
  code: number | null
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface Chat {
  id: string
  title: string
  created: number
  updated: number
  messages: Message[]
  memory?: boolean // false — чат без памяти
}

export interface ChatSummary {
  id: string
  title: string
  updated: number
  project_id: string
  project_name?: string | null
}

export interface Attachment {
  kind: 'text' | 'image' | 'video' | 'archive' | 'binary' | 'folder'
  name: string
  path: string
  rel?: string
  size?: number
  text?: string
  truncated?: boolean
  extracted?: string
  count?: number
  tree?: string
}

export interface KnowledgeFile { name: string; path: string; size: number }

export interface SendRequest {
  projectId: string
  chatId: string
  isNew: boolean
  text: string
  attachments: Attachment[]
  mode: Mode
  model: Model
  params?: Record<string, any>
  searchModel?: string | null
  resume?: boolean // продолжить прерванную задачу без нового сообщения
  ignoreLimit?: boolean // продолжить, несмотря на лимит расходов
  fork?: { index: number; kind: 'edit' | 'regenerate' } // новая ветка с сообщения пользователя index
  op?: MediaOp // действие с картинкой: увеличить, убрать фон, изменить
  memory?: boolean // использовать память в этом чате (для нового чата)
  refPaths?: string[] // фото набора референсов для reference-to-video
  pro?: import('./runpod').ProParams // «Картинка Pro» на RunPod
}

// События запуска агента/генерации, которые основной процесс шлёт в интерфейс
export type RunEvent =
  | { type: 'start'; chatId: string; projectId: string; chat: Chat }
  | { type: 'delta'; chatId: string; text: string }
  | { type: 'message'; chatId: string; message: Message }
  | { type: 'status'; chatId: string; status: string }
  | { type: 'output'; chatId: string; callId: string; text: string }
  | { type: 'approval'; chatId: string; id: string; title: string; details: string; danger?: string }
  | { type: 'done'; chatId: string }
  | { type: 'approval_done'; chatId: string; id: string }

export type ApprovalAnswer = 'yes' | 'always' | 'no'

export interface Balance { USD?: number; DIEM?: number; BUNDLED_CREDITS?: number }

/** Обновление программы: installer — AppImage/установщик Windows, source — git-копия исходников, manual — только ссылка. */
export interface UpdateState {
  status: 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error'
  current: string
  mode: 'installer' | 'source' | 'manual'
  version?: string
  notes?: string
  url?: string
  percent?: number
  error?: string
}

export interface Api {
  settings: { get(): Promise<Settings>; set(patch: Partial<Settings>): Promise<Settings> }
  models(): Promise<ModelsResult>
  balance(): Promise<Balance | null>
  videoQuote(params: Record<string, any>): Promise<number | null>
  projects: {
    list(): Promise<Project[]>
    default(): Promise<Project>
    get(id: string): Promise<Project | null>
    create(data: { name: string; description: string; folder?: string }): Promise<Project>
    save(project: Project): Promise<void>
    remove(id: string): Promise<void>
    knowledge(id: string): Promise<KnowledgeFile[]>
    addFiles(id: string, paths?: string[]): Promise<KnowledgeFile[]>
    removeFile(id: string, path: string): Promise<KnowledgeFile[]>
    pickFolder(): Promise<string | null>
  }
  chats: {
    recent(): Promise<ChatSummary[]>
    list(projectId: string): Promise<ChatSummary[]>
    load(projectId: string, chatId: string): Promise<Chat | null>
    create(): Promise<Chat>
    rename(projectId: string, chatId: string, title: string): Promise<void>
    undo(projectId: string, chatId: string, callIds: string[]): Promise<Chat | null>
    switchAlt(projectId: string, chatId: string, index: number, alt: number): Promise<Chat | null>
    search(query: string): Promise<SearchHit[]>
    changes(projectId: string, chatId: string): Promise<ChangeSummary[]>
    diff(path: string, backup: string | null): Promise<string>
    remove(projectId: string, chatId: string): Promise<void>
  }
  attach: {
    pick(projectId: string): Promise<Attachment[]>
    paths(projectId: string, paths: string[]): Promise<{ items: Attachment[]; errors: string[] }>
    pathFor(file: File): string
    data(projectId: string, name: string, bytes: Uint8Array): Promise<{ items: Attachment[]; errors: string[] }>
  }
  run: {
    send(req: SendRequest): Promise<void>
    stop(chatId: string): Promise<void>
    active(): Promise<string[]>
    approve(id: string, answer: ApprovalAnswer): Promise<void>
    onEvent(cb: (e: RunEvent) => void): () => void
  }
  jobs: {
    list(): Promise<Job[]>
    log(id: string, lines?: number): Promise<string | null>
    stop(id: string): Promise<void>
    clear(): Promise<void>
    onChange(cb: () => void): () => void
  }
  secrets: {
    list(): Promise<Secret[]>
    set(name: string, value: string): Promise<void>
    remove(name: string): Promise<void>
    available(): Promise<boolean>
  }
  servers: { test(server: Server): Promise<string> }
  files: {
    read(path: string): Promise<string | null>
    mtime(path: string): Promise<number>
    artifact(html: string): Promise<string>
  }
  voice: {
    speak(text: string): Promise<string>
    transcribe(bytes: Uint8Array, mime: string): Promise<string>
    voices(model: string): Promise<string[]>
    models(): Promise<{ tts: { id: string; name: string }[]; stt: { id: string; name: string }[]; edit: EditModel[] }>
  }
  spend(): Promise<{ today: number; limitDay: number }>
  install(): Promise<string>
  memory: { list(): Promise<MemoryItem[]>; add(text: string, projectId?: string): Promise<void>; update(id: string, text: string): Promise<void>; remove(id: string): Promise<void> }
  mcp: { status(): Promise<McpStatus[]>; test(s: McpServer): Promise<McpStatus> }
  git: {
    info(projectId: string, chatId: string): Promise<GitInfo>
    init(projectId: string): Promise<boolean>
    merge(projectId: string, chatId: string): Promise<string>
    push(projectId: string, chatId: string): Promise<{ ok: boolean; text: string; url?: string }>
  }
  firefox: {
    status(): Promise<FirefoxStatus>
    pair(): Promise<void>
    unpair(): Promise<void>
    /** открыть файл расширения в Firefox (установка); строка — что сделано, для подсказки */
    install(): Promise<string>
    onChange(cb: (s: FirefoxStatus) => void): () => void
  }
  runpod: {
    status(): Promise<{ key: boolean; endpoint: string; balance: number | null; health: any; error?: string }>
    /** расходы RunPod с начала месяца; null — ключа нет */
    spend(): Promise<RunpodSpendInfo | null>
    setKey(key: string): Promise<void>
    removeKey(): Promise<void>
  }
  wavespeed: {
    status(): Promise<{ key: boolean; balance: number | null }>
    setKey(key: string): Promise<void>
    removeKey(): Promise<void>
  }
  telegram: { status(): Promise<{ running: boolean; error: string; bot?: string; code: string }>; setToken(token: string): Promise<string>; unlink(): Promise<void> }
  schedules: { run(id: string): Promise<void> }
  term: {
    create(cwd: string, cols: number, rows: number): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    kill(id: string): void
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string) => void): () => void
  }
  fs: { tree(dir: string): Promise<{ name: string; path: string; dir: boolean }[]>; write(path: string, text: string): Promise<void> }
  compare(text: string, models: string[]): Promise<CompareResult[]>
  gallery: {
    list(): Promise<GalleryItem[]>
    update(id: string, patch: Partial<GalleryItem>): Promise<void>
    remove(ids: string[], deleteFiles: boolean): Promise<void>
    op(op: MediaOp | { kind: 'variations'; id: string }, projectId?: string): Promise<{ paths: string[]; cost: number | null }>
    describe(path: string, task: string): Promise<string>
    enhance(prompt: string): Promise<string>
    saveImage(parentPath: string, bytes: Uint8Array, ext: string): Promise<string>
    saveAs(path: string): Promise<string | null>
    openWith(path: string): Promise<string>
    pickImages(): Promise<string[]>
    ensure(path: string): Promise<GalleryItem>
    saveMask(bytes: Uint8Array): Promise<string>
  }
  batch: {
    start(paths: string[], op: BatchOp, projectId?: string): Promise<string>
    cancel(id: string): void
    onProgress(cb: (s: BatchStatus) => void): () => void
  }
  onNav(cb: (to: { projectId: string; chatId: string }) => void): () => void
  onSettings(cb: (s: Settings) => void): () => void
  quit(): void
  shell: {
    open(path: string): Promise<void>
    reveal(path: string): Promise<void>
    external(url: string): Promise<void>
  }
  win: {
    minimize(): void
    toggleMaximize(): void
    close(): void
    onState(cb: (s: { maximized: boolean; focused: boolean; dark: boolean }) => void): () => void
  }
  /** Картинка в буфер обмена без пересжатия; false — формат не читается напрямую (webp и т. п.) */
  clipboardImage(path: string): Promise<boolean>
  clipboardImageData(png: Uint8Array): Promise<void>
  update: {
    state(): Promise<UpdateState>
    check(): Promise<UpdateState>
    download(): Promise<void>
    install(): Promise<void>
    onState(cb: (s: UpdateState) => void): () => void
  }
  version: string
  platform: string
  userName: string
}

export interface RunpodSpendInfo {
  today: number
  month: number
  disk: number
  perHour: number | null
  balance: number | null
  gpus: { name: string; usd: number; sec: number }[]
  /** картинок на своём RunPod с начала месяца */
  images: number
}

export interface FirefoxStatus {
  /** сервер слушает порт */
  listening: boolean
  error?: string
  connected: boolean
  /** версия Firefox и расширения */
  browser?: string
  /** ждём сопряжения до этого времени (ms) */
  pairingUntil?: number
  /** выданных токенов (сопряжённых профилей Firefox) */
  paired: number
}

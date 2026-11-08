// Агентный цикл: стриминг ответа, вызовы инструментов (нативные или текстовым протоколом), стоимость.
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { release, type } from 'node:os'
import { join, relative } from 'node:path'
import OpenAI from 'openai'
import { imagePrice, usd } from '@shared/pricing'
import type { ContentPart, FileChange, McpServer, Message, Model, Project, Settings } from '@shared/types'
import { expand, KNOWLEDGE_DIR } from './store'
import * as mcp from './mcp'
import * as memory from './memory'
import * as secrets from './secrets'
import * as semantic from './semantic'
import * as images from './images'
import * as firefox from './firefox'
import * as tools from './tools'
import { explain, Venice } from './venice'
import { SHELL_NAME } from './platform'

const SYSTEM_PROMPT = `You are Mouse King Pro, an AI assistant running inside a desktop app on the user's computer.
You can work with the user's files, folders, shell, archives and the web using tools.

Project: {project}
Project folder (working directory, relative paths resolve here): {root}
OS: {os}
Shell for run_command / start_background: {shell}
Current date: {date}

Guidelines:
- Explore with list_dir / find_files / search_files / read_file before changing anything.
- Read a file before editing it. Prefer edit_file for small changes, write_file for new files or full rewrites.
- Files the user attaches are saved into the project folder; their paths are given in the message. Work only with
  those. The uploads/ folder also keeps files from the user's OTHER chats: never browse or open them unless the user
  asks for a specific file. If something seems missing (e.g. the user says "these forms" but attached one picture),
  answer with what you have and ask for the rest instead of searching for it.
- Do only what the user asked. If the request is unclear, or the user only sent files without saying what to do,
  do NOT start working on your own: briefly describe what you received and ask what they want.
- Actions that modify files, run commands or download need user approval. If an action is denied, do not retry it as is.
- Commands run non-interactively: there is no stdin and nobody can type a password. Use non-interactive flags
  (-y, --yes, ssh -o BatchMode=yes, git with configured credentials). If something needs a password or 2FA, ask the user.
- For long work (deploys, builds, installs, servers, watchers) use start_background, then check it with job_status
  (use wait_seconds instead of polling often). Tell the user what is running in the background.
- For big codebases and archives: look at the structure first (list_dir, find_files), search with search_files, and read
  only the files and line ranges you need (read_file with offset/limit) instead of reading everything.
- The user may undo your file edits from the app, so keep edits focused; mention which files you changed.
- You can create and process images (generate_image, edit_image, combine_images, upscale_image, remove_background,
  describe_image). They cost real money: for several images say the estimated cost first; prefer cheap models unless asked.
- Never use sudo, pkexec, su or anything else that needs root; never write to disks or block devices (/dev/sd*,
  /dev/nvme*), partition, format or wipe them; never change system configuration, unless the user explicitly asked
  for exactly that in this chat. Even then: explain what will happen and which device will be affected, and wait
  for the user to confirm in a message before running it. If a task seems to require root, tell the user the
  command to run themselves instead.
- Never invent tool results. When the task is done, give a short summary of what you did.
- Reply in the user's language. Use Markdown; put code in fenced blocks.
{personal}{instructions}`

const TEXT_TOOLS_PROMPT = `

## Tools
To call a tool, write a block exactly like this (valid JSON inside):
<tool_call>
{"name": "read_file", "arguments": {"path": "main.py"}}
</tool_call>
You may write several blocks in one message. After writing tool calls, STOP and wait:
results arrive in the next message inside <tool_result> tags. Do not write <tool_result> yourself.
If you don't need a tool, just answer normally.

Available tools:
{tools}`

const KNOWLEDGE_BUDGET = 60_000
const CALL_RE = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g

export const stripToolCalls = (text: string) => text.replace(CALL_RE, '').trim()

export function textOf(content: Message['content']): string {
  if (Array.isArray(content)) return content.filter((p) => p.type === 'text').map((p) => (p as any).text).join('\n')
  return content || ''
}

const callId = () => 'call_' + randomBytes(5).toString('hex')

interface Call { id: string; name: string; arguments: string }

function parseTextCalls(text: string): Call[] {
  const calls: Call[] = []
  for (const m of text.matchAll(CALL_RE)) {
    const raw = m[1].trim().replace(/^```(?:json)?|```$/g, '').trim()
    try {
      const obj = JSON.parse(raw)
      let args = obj.arguments ?? obj.parameters ?? {}
      if (typeof args === 'string') args = JSON.parse(args)
      if (!obj.name) throw new Error('no name')
      calls.push({ id: callId(), name: obj.name, arguments: JSON.stringify(args) })
    } catch {
      calls.push({ id: callId(), name: 'invalid_tool_call', arguments: JSON.stringify({ raw: raw.slice(0, 1000) }) })
    }
  }
  return calls
}

function toolsDescription(schemas: any[] = tools.SCHEMAS): string {
  return schemas.map(({ function: fn }) => {
    const args = Object.entries(fn.parameters.properties)
      .map(([k, v]) => `${k}${fn.parameters.required.includes(k) ? '' : '?'}: ${(v as any).type}`).join(', ')
    return `- ${fn.name}(${args}) — ${fn.description}`
  }).join('\n')
}

export interface RunOptions {
  depth?: number         // 0 — основной агент, 1 — помощник
  memory?: boolean       // память между чатами в этом чате
  modelById?(id: string): Model | undefined
}

export interface RunHooks {
  /** null — можно тратить дальше; иначе причина остановки по лимиту расходов */
  spendBlock(): 'chat' | 'day' | null
  delta(text: string): void
  output(callId: string, text: string): void
  message(m: Message): void
  status(s: string): void
  approve(title: string, details: string, danger?: string): Promise<boolean>
}

export class AgentRun {
  private abort = new AbortController()
  private stopped = false
  private history: Message[]
  private native: boolean
  private root: string
  private venice: Venice
  private searchBilled = 0
  private usage: { tokens?: [number, number]; cost?: number | null } | null = null
  private schemas: any[] = tools.SCHEMAS
  private mcpRoute = new Map<string, [McpServer, string]>()
  private extraCost = 0           // помощники, эмбеддинги
  private pendingImages: string[] = []
  private summaryCache: { upto: number; text: string } | null = null
  /** сколько потратили помощники — родитель добавит это к своему шагу */
  get spentByHelpers() { return this.extraCost }

  constructor(
    private settings: Settings, private project: Project, messages: Message[],
    private model: Model, private hooks: RunHooks, private searchModel: string | null | undefined,
    private chatId: string, private opts: RunOptions = {},
  ) {
    this.history = messages.map((m) => ({ ...m }))
    const mode = settings.tool_mode
    this.native = mode === 'native' || (mode === 'auto' && model.tools)
    this.root = expand(project.folder)
    this.venice = new Venice(settings.api_key, settings.base_url)
  }

  stop() {
    this.stopped = true
    this.abort.abort()
  }

  get isStopped() {
    return this.stopped
  }

  private systemPrompt(): string {
    const instructions = (this.project.instructions || '').trim()
    const personal = (this.settings.user_instructions || '').trim()
    let prompt = SYSTEM_PROMPT
      .replace('{project}', this.project.name)
      .replace('{root}', this.root)
      .replace('{os}', `${type()} ${release()}`)
      .replace('{shell}', SHELL_NAME)
      .replace('{date}', new Date().toISOString().slice(0, 10))
      .replace('{personal}', personal
        ? `\n## The user's personal instructions (apply in every chat)\n${personal}\n` : '')
      .replace('{instructions}', instructions
        ? `\n## Project instructions from the user${personal ? ' (more specific: they win if they conflict with the personal ones)' : ''}\n${instructions}` : '')
    prompt += this.serversInfo()
    prompt += this.knowledge()
    if (this.opts.memory) prompt += memory.forPrompt(this.project.id)
    if (!this.native) prompt += TEXT_TOOLS_PROMPT.replace('{tools}', toolsDescription(this.schemas))
    return prompt
  }

  /** Серверы и имена секретов: модель знает, куда можно деплоить, но не видит паролей и токенов. */
  private serversInfo(): string {
    const servers = this.settings.servers || []
    const names = secrets.names()
    let out = ''
    if (servers.length) {
      out += '\n\n## The user\'s servers (use ssh_run / ssh_upload; credentials are handled by the app)\n' +
        servers.map((s) => `- ${s.name}: ${s.user}@${s.host}:${s.port || 22}` + (s.deploy_path ? `, deploy path ${s.deploy_path}` : '') +
          (s.notes ? ` — ${s.notes}` : '')).join('\n')
    }
    if (names.length) {
      out += '\n\n## Secrets\nAvailable as environment variables in run_command, start_background and ssh_run commands ' +
        '(values are hidden from you; never print them): ' + names.map((n) => '$' + n).join(', ')
    }
    return out
  }

  /** Файлы проекта: мелкие текстовые — целиком, остальные — списком путей. */
  private knowledge(): string {
    const folder = join(this.root, KNOWLEDGE_DIR)
    if (!existsSync(folder)) return ''
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d).sort()) {
        const full = join(d, f)
        if (statSync(full).isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(folder)
    if (!files.length) return ''
    let budget = KNOWLEDGE_BUDGET
    const inline: string[] = []
    const listed: string[] = []
    for (const f of files) {
      const r = relative(this.root, f)
      let data: Buffer | null = null
      try {
        if (statSync(f).size <= budget) data = readFileSync(f)
      } catch {
        data = null
      }
      if (data && !data.subarray(0, 8192).includes(0)) {
        inline.push(`<file path="${r}">\n${data.toString('utf-8')}\n</file>`)
        budget -= data.length
      } else listed.push(`- ${r}`)
    }
    let out = '\n\n## Project knowledge\nFiles the user added to this project. Use them as primary context.'
    if (inline.length) out += '\n\n' + inline.join('\n\n')
    if (listed.length) out += '\n\nOther project files (read them with tools when needed):\n' + listed.join('\n')
    return out
  }

  /**
   * История для модели: без служебных отметок, с результатами для всех вызовов инструментов
   * и со сжатием старых результатов, если история не помещается в бюджет контекста.
   */
  private async prepared(client: OpenAI): Promise<Message[]> {
    const list: Message[] = []
    const h = this.history.filter((m) => !m._error && !m._stopped && !m._limit)
    for (let i = 0; i < h.length; i++) {
      const m = h[i]
      list.push(m)
      if (m.role !== 'assistant' || !m.tool_calls?.length) continue
      // результаты этого шага идут сразу за ним; если работу прервали — дописываем недостающие
      const have = new Set<string>()
      while (h[i + 1]?.role === 'tool') {
        i++
        list.push(h[i])
        have.add(h[i].tool_call_id || '')
      }
      for (const tc of m.tool_calls) {
        if (!have.has(tc.id)) {
          list.push({ role: 'tool', tool_call_id: tc.id, _name: tc.function.name, content: 'Не выполнено: работа была прервана до этого шага.' })
        }
      }
    }
    return this.compact(list, client)
  }

  /** Сводка ранней части истории (кэшируется и дополняется по мере роста чата). */
  private async summarize(client: OpenAI, part: Message[], upto: number): Promise<string> {
    if (this.summaryCache && this.summaryCache.upto === upto) return this.summaryCache.text
    const from = this.summaryCache && this.summaryCache.upto < upto ? this.summaryCache.upto : 0
    const prev = from ? this.summaryCache!.text : ''
    const lines = part.slice(from).map((m) => {
      const calls = (m.tool_calls || []).map((c) => `${c.function.name}(${c.function.arguments.slice(0, 200)})`).join('; ')
      return `${m.role}${m._name ? ' ' + m._name : ''}: ${textOf(m.content).slice(0, 1200)}${calls ? ' → ' + calls : ''}`
    }).join('\n').slice(-80_000)
    const fast = this.settings.fast_model && this.opts.modelById?.(this.settings.fast_model)
    try {
      this.hooks.status('Пишу сводку ранней части чата…')
      const r: any = await client.chat.completions.create({
        model: fast ? fast.id : this.model.id, temperature: 0.2, max_tokens: 1500,
        messages: [
          { role: 'system', content: 'Сожми историю работы ИИ-агента в сводку на русском, до 300 слов: задачи пользователя, что сделано, ' +
            'какие файлы созданы/изменены (пути), важные выводы, решения и договорённости, что осталось. Только факты, без воды.' },
          { role: 'user', content: (prev ? `Предыдущая сводка:\n${prev}\n\nДальнейшая история:\n` : '') + lines },
        ],
      } as any)
      this.extraCost += usd(r.cost) || 0
      const text = String(r.choices?.[0]?.message?.content || '').trim() || prev
      this.summaryCache = { upto, text }
      return text
    } catch {
      return prev || '[ранняя часть истории скрыта]'
    }
  }

  /** Бюджет истории в токенах: настройка пользователя, но не больше 70% окна модели. */
  private budget(): number {
    const user = Number(this.settings.context_budget) || 200_000
    const window = this.model.context ? Math.floor(this.model.context * 0.7) : 100_000
    return Math.max(8_000, Math.min(user, window))
  }

  private async compact(list: Message[], client: OpenAI): Promise<Message[]> {
    const size = (m: Message) => {
      if (Array.isArray(m.content)) return m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length / 3 : 1200), 0)
      return ((m.content || '').length + JSON.stringify(m.tool_calls || '').length) / 3
    }
    const total = (l: Message[]) => l.reduce((n, m) => n + size(m), 0) + this.systemPrompt().length / 3
    const budget = this.budget()
    if (total(list) <= budget) return list

    this.hooks.status('Сжимаю контекст…')
    let out = list.map((m) => ({ ...m }))
    const toolIdx = out.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0)
    // 1) старые результаты инструментов укорачиваем, свежие оставляем целиком
    for (const keep of [8, 3, 0]) {
      for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - keep))) {
        const text = String(out[i].content || '')
        if (text.length > 700) {
          out[i].content = text.slice(0, 500) + `\n… [результат сокращён для экономии контекста: было ${text.length} символов. ` +
            'Если эти данные снова нужны — получи их заново инструментом.]'
        }
      }
      if (total(out) <= budget) return out
    }
    // 2) убираем картинки из старых сообщений
    const lastUser = out.map((m) => m.role === 'user').lastIndexOf(true)
    out.forEach((m, i) => {
      if (i < lastUser && Array.isArray(m.content)) m.content = textOf(m.content) + '\n[картинка убрана из контекста]'
    })
    if (total(out) <= budget) return out
    // 3) ранние ходы заменяем сводкой (её пишет быстрая модель); последние ходы остаются целиком
    const userIdx = out.map((m, i) => (m.role === 'user' && !m._hidden ? i : -1)).filter((i) => i > 0)
    // сначала находим, сколько ходов нужно свернуть (сводка ~2000 символов), потом пишем сводку один раз
    const placeholder: Message = { role: 'user', content: 'x'.repeat(2000) }
    const cut = userIdx.find((i) => total([placeholder, ...out.slice(i)]) <= budget) ?? userIdx[userIdx.length - 1]
    if (cut != null) {
      const summary = await this.summarize(client, out.slice(0, cut), cut)
      out = [{ role: 'user', _hidden: true, content: `[Сводка ранней части этого чата — подробности сокращены для экономии контекста]\n${summary}` }, ...out.slice(cut)]
    }
    return out
  }

  private async apiMessages(client: OpenAI): Promise<any[]> {
    const out: any[] = [{ role: 'system', content: this.systemPrompt() }]
    let resultsOpen = false
    const prepared = await this.prepared(client)
    const imageMsgs = prepared.filter((m) => m._images?.length).slice(-2)
    for (const m of prepared) {
      let content: string | ContentPart[] | null = m.content
      if (Array.isArray(content) && !this.model.vision) content = textOf(content)
      if (m._images?.length) {
        content = this.model.vision && imageMsgs.includes(m)
          ? [{ type: 'text', text: textOf(m.content) }, ...m._images.filter(existsSync).map((p) => ({ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,' + readFileSync(p).toString('base64') } }))]
          : textOf(m.content) + ' [картинка убрана из контекста]'
      }
      if (this.native) {
        const msg: any = {}
        for (const [k, v] of Object.entries(m)) if (!k.startsWith('_')) msg[k] = v
        msg.content = content ?? ''
        out.push(msg)
        continue
      }
      if (m.role === 'assistant') {
        let body = textOf(content)
        for (const tc of m.tool_calls || []) {
          let args: unknown = tc.function.arguments
          try {
            args = JSON.parse(tc.function.arguments || '{}')
          } catch {
            // оставляем строкой
          }
          body += `\n<tool_call>\n${JSON.stringify({ name: tc.function.name, arguments: args })}\n</tool_call>`
        }
        out.push({ role: 'assistant', content: body.trim() || '…' })
        resultsOpen = false
      } else if (m.role === 'tool') {
        const block = `<tool_result name="${m._name || ''}">\n${m.content}\n</tool_result>`
        if (resultsOpen) out[out.length - 1].content += '\n' + block
        else out.push({ role: 'user', content: block })
        resultsOpen = true
      } else {
        out.push({ role: m.role, content })
        resultsOpen = false
      }
    }
    return out
  }

  private add(m: Message) {
    this.history.push(m)
    this.hooks.message(m)
  }

  async run(): Promise<void> {
    const client = new OpenAI({ apiKey: this.settings.api_key, baseURL: this.settings.base_url, timeout: 600_000, maxRetries: 0 })
    const ctx: tools.ToolContext = {
      root: this.root,
      chatId: this.chatId,
      safe: (cmd) => tools.isSafeCommand(cmd, this.settings.allowed_commands || [], !!this.settings.auto_safe_commands),
      servers: this.settings.servers || [],
      env: secrets.env(),
      mask: secrets.mask,
      approve: (t, d, danger) => (this.stopped ? Promise.resolve(false) : this.hooks.approve(t, d, danger)),
      search: this.searchModel ? (q, n) => this.venice.webSearch(this.searchModel!, q, n) : undefined,
      signal: this.abort.signal,
      browserAuto: !!this.settings.browser_auto,
      counts: {},
      attachImage: (path) => this.pendingImages.push(path),
      semantic: (q, k) => semantic.search(this.root, q, k, this.settings.embedding_model || 'text-embedding-qwen3-0-6b',
        (texts) => this.embed(client, texts), (s) => this.hooks.status(s)),
      delegate: (this.opts.depth || 0) === 0 ? (task, label) => this.helper(task, label, ctx) : undefined,
      images: this.imageHooks(),
    }
    // набор инструментов: помощникам — без помощников, плана и памяти; подключения MCP — всем
    const depth = this.opts.depth || 0
    const drop = new Set([...(this.opts.memory ? [] : ['remember']), ...(depth > 0 ? ['delegate', 'remember', 'update_plan'] : [])])
    // инструменты Firefox пользователя — только когда расширение подключено
    const ff = firefox.connected()
    this.schemas = tools.SCHEMAS.filter((s) => !drop.has(s.function.name) && (ff || !s.function.name.startsWith('firefox_')))
    if ((this.settings.mcp_servers || []).some((s) => s.enabled)) {
      this.hooks.status('Подключаю MCP…')
      const { schemas, route } = await mcp.toolSchemas(this.settings.mcp_servers)
      this.schemas = [...this.schemas, ...schemas]
      this.mcpRoute = route
    }
    try {
      await this.loop(client, ctx)
    } finally {
      // отметка в истории: по ней интерфейс покажет «Продолжить»
      if (this.stopped) this.add({ role: 'assistant', content: '', _stopped: true })
    }
  }

  private async loop(client: OpenAI, ctx: tools.ToolContext): Promise<void> {
    try {
      for (let step = 0; step < Number(this.settings.max_steps || 40); step++) {
        if (this.stopped) return
        const block = this.hooks.spendBlock()
        if (block) {
          this.add({ role: 'assistant', content: '', _spend: block })
          return
        }
        this.hooks.status('Думаю…')
        const { content, calls } = await this.completeWithRetry(client)
        const msg: Message = { role: 'assistant', content }
        this.attachUsage(msg)
        if (calls.length) {
          msg.tool_calls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }))
        }
        if (content || calls.length) this.add(msg)
        if (!calls.length) return
        // помощники из одного шага работают параллельно, остальные инструменты — по очереди
        for (let i = 0; i < calls.length;) {
          let j = i + 1
          if (calls[i].name === 'delegate') while (j < calls.length && calls[j].name === 'delegate') j++
          const batch = calls.slice(i, j)
          const results = await Promise.all(batch.map((c) => this.runTool(c, { ...ctx })))
          batch.forEach((c, k) => this.add(results[k]))
          i = j
        }
        if (this.pendingImages.length && this.model.vision) {
          this.add({ role: 'user', _hidden: true, content: 'Скриншот страницы из браузера:', _images: this.pendingImages.splice(0) })
        }
        this.pendingImages = []
        if (this.stopped) return
      }
      this.add({ role: 'assistant', content: '', _limit: true })
    } catch (e: any) {
      if (this.stopped) return
      let text: string
      if (e instanceof OpenAI.APIError && e.status) {
        let body: any = e.error
        if (body && typeof body === 'object') body = body.error ?? body.message ?? JSON.stringify(body)
        text = explain(e.status, body || e.message)
      } else text = `${e?.name || 'Error'}: ${e?.message || e}`
      this.add({ role: 'assistant', content: text, _error: true })
    }
  }

  /** Один вызов инструмента → сообщение с результатом (изменённый файл, картинки, живой вывод). */
  private async runTool(c: Call, ctx: tools.ToolContext): Promise<Message> {
    let result: string
    let change: FileChange | undefined
    const media: string[] = []
    if (this.stopped) result = 'Отменено пользователем.'
    else {
      this.hooks.status(c.name)
      ctx.output = (text) => this.hooks.output(c.id, text)
      ctx.changed = (ch) => (change = ch)
      ctx.media = (p) => media.push(p)
      try {
        const args = JSON.parse(c.arguments || '{}')
        const route = this.mcpRoute.get(c.name)
        if (route) {
          const [server, tool] = route
          result = server.trusted || await ctx.approve(`Инструмент ${server.name}: ${tool}`, JSON.stringify(args, null, 2))
            ? await mcp.call(server, tool, args).catch((e) => `Ошибка MCP: ${(e as Error).message}`)
            : tools.DENIED
        } else result = await tools.execute(ctx, c.name, args)
      } catch (e) {
        result = `Ошибка: arguments — невалидный JSON (${(e as Error).message})`
      }
    }
    return {
      role: 'tool', tool_call_id: c.id, content: result, _name: c.name,
      ...(result === tools.DENIED ? { _denied: true } : {}), ...(change ? { _change: change } : {}), ...(media.length ? { _media: media } : {}),
    }
  }

  /** Помощник: отдельный агент с чистой историей; возвращает отчёт, его расходы добавляются к нашему шагу. */
  private async helper(task: string, label: string, ctx: tools.ToolContext): Promise<string> {
    const out = ctx.output
    const fast = this.settings.fast_model && this.opts.modelById?.(this.settings.fast_model)
    const model = fast && fast.tools ? fast : this.model
    const msgs: Message[] = []
    const sub = new AgentRun(this.settings, this.project, [{ role: 'user', content: task }], model, {
      spendBlock: this.hooks.spendBlock,
      delta: () => {},
      output: () => {},
      message: (m) => {
        msgs.push(m)
        for (const tc of m.tool_calls || []) out?.(`• ${tc.function.name} ${tc.function.arguments.slice(0, 120)}\n`)
      },
      status: () => {},
      approve: (t, d, danger) => this.hooks.approve(`[${label}] ${t}`, d, danger),
    }, this.searchModel, this.chatId, { depth: 1 })
    const stop = () => sub.stop()
    this.abort.signal.addEventListener('abort', stop)
    out?.(`Помощник «${label}» работает на ${model.name}…\n`)
    await sub.run()
    this.abort.signal.removeEventListener('abort', stop)
    this.extraCost += msgs.reduce((n, m) => n + (m._cost || 0), 0) + sub.spentByHelpers
    const steps = msgs.filter((m) => m.role === 'tool').length
    const final = [...msgs].reverse().find((m) => m.role === 'assistant' && !m._stopped && !m._limit && typeof m.content === 'string' && m.content)
    return `Отчёт помощника «${label}» (${steps} действий):\n${final ? String(final.content) : 'помощник не дал ответа' + (msgs.some((m) => m._error) ? ' (ошибка)' : '')}`
  }

  /** Инструменты картинок: результаты попадают в галерею, стоимость — в шаг агента. */
  private imageHooks(): tools.ImageHooks {
    const ctx = () => ({ projectId: this.project.id, chatId: this.chatId, safe: !!this.settings.safe_mode, dir: join(this.root, 'generated') })
    const paid = <T extends { cost: number | null }>(r: T) => {
      this.extraCost += r.cost || 0
      return r
    }
    const editModel = (m?: string) => m || 'qwen-edit-uncensored'
    return {
      generate: async (prompt, o) => {
        const all = await this.venice.listModels('image')
        const model = all.find((m) => m.id === o.model) || all.find((m) => m.id === this.settings.image_model) || all.find((m) => m.id === 'z-image-turbo') || all[0]
        const c = model.constraints || {}
        const params: Record<string, any> = { prompt, variants: o.variants || 1 }
        if (c.aspectRatios?.length) params.aspect_ratio = c.aspectRatios.includes(o.aspect_ratio) ? o.aspect_ratio : c.defaultAspectRatio || c.aspectRatios[0]
        if (c.resolutions?.length) params.resolution = c.defaultResolution || c.resolutions[0]
        if (o.seed != null) params.seed = o.seed
        const r = paid(await images.generate(this.venice, model, params, ctx()))
        return { paths: r.paths, cost: r.cost, model: model.name }
      },
      edit: async (p, prompt, m) => paid(await images.edit(this.venice, p, prompt, editModel(m), ctx())),
      combine: async (ps, prompt, m) => paid(await images.combine(this.venice, ps, prompt, editModel(m), ctx())),
      upscale: async (p, s) => paid(await images.upscale(this.venice, p, s, ctx())),
      background: async (p) => paid(await images.background(this.venice, p, ctx())),
      describe: async (p, task) => {
        const vision = this.model.vision ? this.model.id : (await this.venice.listModels('text')).find((m) => m.vision)?.id || this.model.id
        const r = await images.describe(this.venice, p, task, vision)
        this.extraCost += r.cost
        return r.text
      },
    }
  }

  private async embed(client: OpenAI, texts: string[]): Promise<number[][]> {
    const r: any = await client.embeddings.create({ model: this.settings.embedding_model || 'text-embedding-qwen3-0-6b', input: texts })
    this.extraCost += usd(r.cost) || 0
    return r.data.sort((a: any, b: any) => a.index - b.index).map((d: any) => d.embedding)
  }

  /** Стоимость шага (по данным Venice) плюс веб-поиски, сделанные с прошлого шага. */
  private attachUsage(msg: Message) {
    const search = this.venice.spent - this.searchBilled + this.extraCost
    this.searchBilled = this.venice.spent
    this.extraCost = 0
    const cost = this.usage?.cost
    if (cost != null || search) msg._cost = (cost || 0) + search
    if (this.usage?.tokens) msg._tokens = this.usage.tokens
  }

  /** Перегрузка Venice, сбой сети или 5xx до начала ответа — ждём и повторяем, а не обрываем задачу. */
  private async completeWithRetry(client: OpenAI): Promise<{ content: string; calls: Call[] }> {
    const waits = [3, 8, 20, 45]
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.complete(client)
      } catch (e: any) {
        const transient = e instanceof OpenAI.APIConnectionError ||
          (e instanceof OpenAI.APIError && [408, 409, 429, 500, 502, 503, 504, 529].includes(e.status as number)) ||
          /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|terminated/i.test(String(e?.message))
        if (!transient || attempt >= waits.length || this.stopped || this.partial) throw e
        for (let s = waits[attempt]; s > 0 && !this.stopped; s--) {
          this.hooks.status(`Venice не отвечает (${e.status || 'сеть'}) — повтор через ${s} с, попытка ${attempt + 2} из ${waits.length + 1}`)
          await new Promise((r) => setTimeout(r, 1000))
        }
      }
    }
  }

  private partial = false

  private async complete(client: OpenAI): Promise<{ content: string; calls: Call[] }> {
    const body: any = {
      model: this.model.id,
      messages: await this.apiMessages(client),
      stream: true,
      stream_options: { include_usage: true },
      temperature: Number(this.settings.temperature ?? 0.7),
      venice_parameters: {
        include_venice_system_prompt: !!this.settings.venice_system_prompt,
        enable_web_search: this.settings.venice_web_search || 'off',
        strip_thinking_response: true,
      },
    }
    if (this.native) body.tools = this.schemas
    else body.stop = ['<tool_result']

    this.usage = null
    this.partial = false
    const stream = await client.chat.completions.create(body, { signal: this.abort.signal })
    let content = ''
    const calls = new Map<number, Call>()
    try {
      for await (const chunk of stream as any) {
        if (chunk.usage) {
          this.usage = {
            tokens: [chunk.usage.prompt_tokens || 0, chunk.usage.completion_tokens || 0],
            cost: usd(chunk.cost),
          }
        }
        const delta = chunk.choices?.[0]?.delta
        if (!delta) continue
        if (delta.content) {
          this.partial = true
          content += delta.content
          this.hooks.delta(delta.content)
        }
        for (const tc of delta.tool_calls || []) {
          const slot = calls.get(tc.index ?? 0) || { id: '', name: '', arguments: '' }
          if (tc.id) slot.id = tc.id
          if (tc.function?.name) slot.name = tc.function.name
          if (tc.function?.arguments) slot.arguments += tc.function.arguments
          calls.set(tc.index ?? 0, slot)
        }
      }
    } catch (e) {
      if (!this.stopped) throw e
    }
    if (this.native) {
      const list = [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c).filter((c) => c.name)
      for (const c of list) c.id ||= callId()
      return { content, calls: this.stopped ? [] : list }
    }
    return { content: stripToolCalls(content), calls: this.stopped ? [] : parseTextCalls(content) }
  }
}

/** Генерация картинки или видео; возвращает сообщение ассистента с файлами и стоимостью. */
export async function generateMedia(
  settings: Settings, kind: 'image' | 'video', model: Model, params: Record<string, any>,
  outDir: string, root: string, status: (s: string) => void, stopped: () => boolean,
): Promise<Message> {
  const api = new Venice(settings.api_key, settings.base_url)
  try {
    let paths: string[]
    let cost: number | null
    if (kind === 'image') {
      status('Генерирую изображение…')
      cost = imagePrice(model, params)
      paths = await api.generateImage(params, outDir)
    } else {
      cost = await api.videoQuote(params).catch(() => null)
      paths = [await api.generateVideo(params, outDir, status, stopped)]
    }
    const rel = paths.map((p) => (p.startsWith(root) ? relative(root, p) : p))
    const msg: Message = { role: 'assistant', content: 'Готово — сохранено в ' + rel.join(', '), _media: paths }
    if (cost != null) msg._cost = cost
    return msg
  } catch (e) {
    return { role: 'assistant', content: (e as Error).message, _error: true }
  }
}

import { Check, Copy, Eye } from 'lucide-react'
import { memo, useEffect, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { HighlighterCore } from 'shiki/core'
import { openArtifact } from '../lib/actions'
import { api } from '../lib/api'

// Подсветка кода: shiki с JS-движком регулярных выражений, языки грузятся по требованию.
let highlighter: Promise<HighlighterCore> | null = null
const LANGS: Record<string, () => Promise<any>> = {
  python: () => import('shiki/langs/python.mjs'), javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'), tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'), json: () => import('shiki/langs/json.mjs'),
  bash: () => import('shiki/langs/bash.mjs'), html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'), sql: () => import('shiki/langs/sql.mjs'),
  rust: () => import('shiki/langs/rust.mjs'), go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'), c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'), csharp: () => import('shiki/langs/csharp.mjs'),
  php: () => import('shiki/langs/php.mjs'), ruby: () => import('shiki/langs/ruby.mjs'),
  swift: () => import('shiki/langs/swift.mjs'), kotlin: () => import('shiki/langs/kotlin.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'), toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'), diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'), xml: () => import('shiki/langs/xml.mjs'),
  lua: () => import('shiki/langs/lua.mjs'), ini: () => import('shiki/langs/ini.mjs'),
}
const ALIAS: Record<string, string> = {
  py: 'python', js: 'javascript', ts: 'typescript', sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash',
  yml: 'yaml', md: 'markdown', 'c++': 'cpp', cs: 'csharp', rb: 'ruby', kt: 'kotlin', docker: 'dockerfile', svg: 'xml',
}
const loaded = new Set<string>()

async function highlight(code: string, lang: string): Promise<string | null> {
  const name = ALIAS[lang] || lang
  if (!LANGS[name]) return null
  if (!highlighter) {
    highlighter = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] = await Promise.all([
        import('shiki/core'), import('shiki/engine/javascript'),
        import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark-dimmed.mjs'),
      ])
      return createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine() })
    })()
  }
  const h = await highlighter
  if (!loaded.has(name)) {
    await h.loadLanguage((await LANGS[name]()).default)
    loaded.add(name)
  }
  return h.codeToHtml(code, { lang: name, themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false })
}

export function CopyButton({ text, label = 'Копировать', className = 'code-copy' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button className={className} onClick={() => {
      navigator.clipboard.writeText(text)
      setDone(true)
      setTimeout(() => setDone(false), 1400)
    }}>
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label && <span>{done ? 'Скопировано' : label}</span>}
    </button>
  )
}

/** Что из блока кода можно показать вживую справа. */
export function previewKind(lang: string, code: string): 'html' | 'svg' | 'mermaid' | null {
  const l = lang.toLowerCase()
  if (l === 'mermaid') return 'mermaid'
  if (l === 'svg' || ((l === 'xml' || l === '') && /^\s*<svg[\s>]/i.test(code))) return 'svg'
  if ((l === 'html' || l === 'htm') && /<(html|body|div|section|main|canvas|svg|style|script|h1|p)\b/i.test(code)) return 'html'
  return null
}

const titleOf = (lang: string, code: string) =>
  /<title>([^<]{1,60})<\/title>/i.exec(code)?.[1] || { mermaid: 'Схема', svg: 'Рисунок SVG' }[lang.toLowerCase()] || 'Страница HTML'

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => highlight(code, lang).then((h) => alive && setHtml(h)).catch(() => {}), html ? 120 : 0)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code, lang])
  return (
    <div className="code">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <span style={{ display: 'flex', gap: 2 }}>
          {previewKind(lang, code) && (
            <button className="code-copy" onClick={() => openArtifact({ kind: previewKind(lang, code)!, code, title: titleOf(lang, code) })}>
              <Eye size={14} /><span>Предпросмотр</span>
            </button>
          )}
          <CopyButton text={code} />
        </span>
      </div>
      {html ? <div className="selectable" dangerouslySetInnerHTML={{ __html: html }} /> : <pre><code>{code}</code></pre>}
    </div>
  )
}

const components = {
  pre: ({ children }: { children?: ReactNode }) => {
    const child: any = Array.isArray(children) ? children[0] : children
    const cls: string = child?.props?.className || ''
    const code = String(child?.props?.children ?? '').replace(/\n$/, '')
    return <CodeBlock code={code} lang={cls.replace('language-', '')} />
  },
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a onClick={(e) => {
      e.preventDefault()
      if (href) api.shell.external(href)
    }} title={href}>{children}</a>
  ),
}

/** Markdown ответа: GFM, подсветка кода, внешние ссылки открываются в браузере. */
export const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`prose selectable ${streaming ? 'streaming' : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components as any}>{text}</ReactMarkdown>
    </div>
  )
})

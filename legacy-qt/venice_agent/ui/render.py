"""Превращение истории чата в HTML для веб-ленты."""

from __future__ import annotations

import html
import json
import re
from functools import lru_cache
from pathlib import Path

import markdown
from pygments.formatters import HtmlFormatter
from PySide6.QtCore import QUrl

from ..agent import strip_tool_calls, text_of
from ..api import money

IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv"}

TOOL_LABELS = {
    "list_dir": ("📁", "Просмотр папки"), "read_file": ("📄", "Чтение файла"),
    "write_file": ("✏️", "Запись файла"), "edit_file": ("✏️", "Правка файла"),
    "search_files": ("🔎", "Поиск в файлах"), "find_files": ("🔎", "Поиск файлов"),
    "run_command": ("⌨️", "Команда"), "extract_archive": ("📦", "Распаковка архива"),
    "web_search": ("🌐", "Поиск в интернете"), "fetch_url": ("🌐", "Открытие страницы"),
    "download_file": ("⬇️", "Загрузка файла"),
}


class CodeFormatter(HtmlFormatter):
    """Блок кода с шапкой: язык и кнопка «Копировать»."""

    def __init__(self, lang_str: str = "", **options):
        super().__init__(**options)
        self.lang = lang_str.removeprefix("language-")

    def format_unencoded(self, tokensource, outfile):
        outfile.write(f'<div class="codeblock"><div class="codehead"><span>{html.escape(self.lang or "код")}'
                      '</span><button class="copy">Копировать</button></div>')
        super().format_unencoded(tokensource, outfile)
        outfile.write("</div>")


MD_EXTENSIONS = ["fenced_code", "tables", "sane_lists", "nl2br", "codehilite"]
MD_CONFIG = {"codehilite": {"css_class": "highlight", "guess_lang": False,
                            "pygments_formatter": CodeFormatter}}


LIST_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+")


def _fix_lists(text: str) -> str:
    """Модели часто пишут список сразу после абзаца — Markdown без пустой строки его не видит."""
    out, in_code, prev = [], False, ""
    for line in text.split("\n"):
        if line.lstrip().startswith(("```", "~~~")):
            in_code = not in_code
        elif not in_code and LIST_ITEM.match(line) and prev.strip() and not LIST_ITEM.match(prev):
            out.append("")
        out.append(line)
        prev = line
    return "\n".join(out)


@lru_cache(maxsize=2048)
def md_to_html(text: str) -> str:
    return markdown.markdown(_fix_lists(text), extensions=MD_EXTENSIONS, extension_configs=MD_CONFIG)


def pygments_css(dark: bool) -> str:
    for style in (("github-dark", "monokai") if dark else ("friendly", "default")):
        try:
            return HtmlFormatter(style=style).get_style_defs(".highlight")
        except Exception:  # noqa: BLE001 — стиля нет в этой версии pygments
            continue
    return ""


def file_url(path: str) -> str:
    return QUrl.fromLocalFile(path).toString()


def summarize_args(arguments: str) -> str:
    try:
        args = json.loads(arguments or "{}")
    except ValueError:
        return arguments[:120]
    if not isinstance(args, dict):
        return str(args)[:120]
    # самое информативное значение — первым
    for key in ("path", "command", "query", "url", "pattern"):
        if key in args:
            v = str(args[key])
            return v if len(v) <= 90 else v[:90] + "…"
    parts = []
    for k, v in args.items():
        s = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        parts.append(f"{k}={s if len(s) <= 40 else s[:40] + '…'}")
    return ", ".join(parts)


def _media_html(paths: list[str]) -> str:
    out = []
    for p in paths:
        suffix = Path(p).suffix.lower()
        url = file_url(p)
        name = html.escape(Path(p).name)
        if suffix in IMAGE_SUFFIXES:
            out.append(f'<a class="media" href="{url}"><img src="{url}" alt="{name}"></a>')
        elif suffix in VIDEO_SUFFIXES:
            out.append(f'<div class="video"><video src="{url}" controls preload="metadata"></video>'
                       f'<a href="{url}">{name} — открыть в плеере</a></div>')
        else:
            out.append(f'<a class="file" href="{url}">📄 {name}</a>')
    return f'<div class="media-grid">{"".join(out)}</div>'


def _tool_card(call_id: str, name: str, args: str, result: str | None) -> str:
    icon, label = TOOL_LABELS.get(name, ("🔧", name))
    if result is None:
        state, body = "running", '<div class="tool-body muted">Выполняется…</div>'
    else:
        if result.startswith("Пользователь отклонил"):
            state = "denied"
        elif result.startswith(("Ошибка", "Сетевая ошибка")):
            state = "error"
        else:
            state = "ok"
        shown = result if len(result) <= 6000 else result[:6000] + "\n…"
        body = f'<pre class="tool-body">{html.escape(shown)}</pre>'
    badge = {"running": '<span class="spinner"></span>', "ok": "", "error": '<span class="badge err">ошибка</span>',
             "denied": '<span class="badge err">отклонено</span>'}[state]
    return (f'<details class="tool {state}" data-id="{html.escape(call_id)}"><summary>'
            f'<span class="ticon">{icon}</span><span class="tname">{html.escape(label)}</span>'
            f'<span class="targs">{html.escape(summarize_args(args))}</span>{badge}<span class="chev">›</span>'
            f'</summary>{body}</details>')


def _tokens(n: int) -> str:
    if n < 1000:
        return str(n)
    return f"{n / 1000:.1f}".replace(".", ",").replace(",0", "") + " тыс."


def _meta(cost: float | None, tokens: list[int]) -> str:
    """Подпись под ответом: стоимость и токены (подробности во всплывающей подсказке)."""
    bits, tip = [], []
    if cost is not None:
        bits.append(money(cost))
    if tokens[0] or tokens[1]:
        bits.append(f"{_tokens(tokens[0] + tokens[1])} токенов")
        tip.append(f"вход {tokens[0]:,} · ответ {tokens[1]:,}".replace(",", " "))
    if not bits:
        return ""
    return f'<span class="meta" title="{html.escape(" · ".join(tip))}">{" · ".join(bits)}</span>'


def render_chat(messages: list[dict], streaming: str | None = None, thinking: str = "Думаю…") -> str:
    """HTML ленты. streaming — текущий недописанный ответ (None, если агент не отвечает)."""
    results = {m.get("tool_call_id"): m.get("content", "") for m in messages if m["role"] == "tool"}
    parts: list[str] = []
    bot_open = False
    turn_cost: float | None = None
    turn_tokens = [0, 0]

    def open_bot():
        nonlocal bot_open, turn_cost, turn_tokens
        if not bot_open:
            parts.append('<div class="turn bot"><div class="content">')
            bot_open = True
            turn_cost, turn_tokens = None, [0, 0]

    def close_bot(actions: bool = True):
        nonlocal bot_open
        if bot_open:
            if actions:
                parts.append(f'<div class="actions">{_meta(turn_cost, turn_tokens)}'
                             '<button class="copy-msg">Копировать</button></div>')
            parts.append("</div></div>")
            bot_open = False

    for m in messages:
        role = m["role"]
        if role == "user":
            close_bot()
            text = m.get("_display")
            if text is None:
                text = text_of(m.get("content"))
            chips = "".join(f'<span class="chip">📎 {html.escape(n)}</span>' for n in m.get("_attachments", []))
            if m.get("_mode"):
                chips += f'<span class="chip">{html.escape(m["_mode"])}</span>'
            parts.append(f'<div class="turn user"><div class="bubble">{html.escape(text)}'
                         f'{f"<div class=chips>{chips}</div>" if chips else ""}</div></div>')
        elif role == "assistant":
            open_bot()
            if m.get("_cost") is not None:
                turn_cost = (turn_cost or 0.0) + m["_cost"]
            for i, n in enumerate(m.get("_tokens") or []):
                turn_tokens[i] += n or 0
            text = strip_tool_calls(text_of(m.get("content")))
            if m.get("_error"):
                parts.append(f'<div class="callout"><b>Ошибка</b><br>{html.escape(text)}</div>')
            elif text:
                parts.append(f'<div class="md">{md_to_html(text)}</div>')
            if m.get("_media"):
                parts.append(_media_html(m["_media"]))
            for tc in m.get("tool_calls") or []:
                parts.append(_tool_card(tc["id"], tc["function"]["name"], tc["function"]["arguments"],
                                        results.get(tc["id"])))

    if streaming is not None:
        open_bot()
        text = strip_tool_calls(streaming)
        if text:
            parts.append(f'<div class="md streaming">{md_to_html(text)}</div>')
        if "<tool_call>" in streaming:
            parts.append('<div class="thinking"><span class="spark">✳</span> Готовлю действие…</div>')
        elif not text:
            parts.append(f'<div class="thinking"><span class="spark">✳</span> {html.escape(thinking)}</div>')
        close_bot(actions=False)
    close_bot()
    return "".join(parts)

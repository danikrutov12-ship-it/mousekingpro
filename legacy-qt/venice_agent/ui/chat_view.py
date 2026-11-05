"""Лента чата на QtWebEngine: современная вёрстка, подсветка кода, обновление без мерцания."""

from __future__ import annotations

import json

from PySide6.QtCore import QUrl, Signal
from PySide6.QtGui import QColor
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView

from .render import pygments_css
from .theme import MONO, SANS, SERIF, font_face_css

TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><style>
{fontfaces}
:root {{ color-scheme: {scheme}; }}
* {{ box-sizing: border-box; }}
html, body {{ margin: 0; background: {bg}; color: {text}; }}
body {{ font: 15px/1.65 {sans}; -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }}
::selection {{ background: {accent}; color: #fff; }}
::-webkit-scrollbar {{ width: 10px; }}
::-webkit-scrollbar-thumb {{ background: {border}; border-radius: 5px; border: 2px solid {bg}; }}
::-webkit-scrollbar-thumb:hover {{ background: {dim}; }}
#chat {{ max-width: 780px; margin: 0 auto; padding: 24px 28px 36px; }}
a {{ color: {accent}; text-decoration: none; }}
a:hover {{ text-decoration: underline; }}

.turn {{ margin: 0 0 26px; animation: fade .18s ease-out; }}
@keyframes fade {{ from {{ opacity: 0; transform: translateY(4px); }} to {{ opacity: 1; transform: none; }} }}
.turn.user {{ display: flex; justify-content: flex-end; }}
.bubble {{ background: {user_bubble}; padding: 10px 16px; border-radius: 18px; max-width: 82%;
          white-space: pre-wrap; word-wrap: break-word; font-size: 15px; }}
.chips {{ margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; white-space: normal; }}
.chip {{ font-size: 12px; color: {muted}; background: {surface}; border: 1px solid {border};
        padding: 2px 8px; border-radius: 7px; }}

.turn.bot .content {{ font-family: {serif}; font-size: 17px; line-height: 1.72; letter-spacing: 0.005em; }}
.streaming > :last-child::after {{ content: ""; display: inline-block; width: 9px; height: 1.05em; margin-left: 3px;
    vertical-align: -0.15em; background: {accent}; border-radius: 2px; animation: blink 1s steps(2) infinite; }}
@keyframes blink {{ 50% {{ opacity: 0; }} }}
.md > :first-child {{ margin-top: 0; }}
.md p {{ margin: 0 0 14px; }}
.md h1, .md h2, .md h3, .md h4 {{ font-family: {serif}; font-weight: 600; line-height: 1.3; margin: 22px 0 10px; }}
.md h1 {{ font-size: 24px; }} .md h2 {{ font-size: 21px; }} .md h3 {{ font-size: 18px; }}
.md ul, .md ol {{ padding-left: 26px; margin: 0 0 14px; }}
.md li {{ margin: 4px 0; }}
.md blockquote {{ border-left: 3px solid {border}; margin: 0 0 14px; padding: 2px 16px; color: {muted}; }}
.md table {{ border-collapse: collapse; margin: 0 0 16px; font-family: {sans}; font-size: 14px; }}
.md th, .md td {{ border: 1px solid {border}; padding: 6px 12px; text-align: left; }}
.md th {{ background: {surface2}; }}
.md hr {{ border: none; border-top: 1px solid {border}; margin: 20px 0; }}
.md code {{ font-family: {mono}; font-size: 13.5px; background: {code_bg}; border: 1px solid {border};
           padding: 1px 5px; border-radius: 5px; }}

.codeblock {{ margin: 0 0 16px; border: 1px solid {border}; border-radius: 12px; overflow: hidden;
             background: {code_bg}; font-family: {sans}; }}
.codehead {{ display: flex; justify-content: space-between; align-items: center; padding: 6px 8px 6px 14px;
            font-size: 12px; color: {muted}; border-bottom: 1px solid {border}; }}
.codehead button, .actions button {{ font: 12px {sans}; color: {muted}; background: transparent; border: none;
            border-radius: 6px; padding: 4px 8px; cursor: pointer; }}
.codehead button:hover, .actions button:hover {{ background: {hover}; color: {text}; }}
.codeblock .highlight {{ background: transparent !important; }}
.codeblock pre {{ margin: 0; padding: 14px 16px; overflow-x: auto; font: 13px/1.6 {mono}; background: transparent; }}
.codeblock pre code {{ background: none; border: none; padding: 0; }}
{pygments}

.tool {{ font-family: {sans}; font-size: 13.5px; border: 1px solid {border}; border-radius: 12px;
        margin: 8px 0; background: {surface}; overflow: hidden; }}
.tool summary {{ list-style: none; display: flex; align-items: center; gap: 9px; padding: 8px 12px;
                cursor: pointer; color: {muted}; user-select: none; }}
.tool summary::-webkit-details-marker {{ display: none; }}
.tool summary:hover {{ background: {hover}; }}
.tname {{ color: {text}; font-weight: 500; white-space: nowrap; }}
.targs {{ font-family: {mono}; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }}
.chev {{ transition: transform .15s; font-size: 16px; }}
.tool[open] .chev {{ transform: rotate(90deg); }}
.tool-body {{ margin: 0; padding: 10px 14px; border-top: 1px solid {border}; background: {code_bg};
             font: 12px/1.55 {mono}; max-height: 340px; overflow: auto; white-space: pre-wrap; word-break: break-word; }}
.badge {{ font-size: 11px; padding: 1px 7px; border-radius: 6px; }}
.badge.err {{ color: {danger}; border: 1px solid {danger}; }}
.spinner {{ width: 12px; height: 12px; border: 2px solid {border}; border-top-color: {accent};
           border-radius: 50%; animation: spin .8s linear infinite; }}
@keyframes spin {{ to {{ transform: rotate(360deg); }} }}
.muted {{ color: {muted}; }}

.thinking {{ font-family: {sans}; color: {muted}; font-size: 14px; display: flex; align-items: center; gap: 8px; margin: 6px 0; }}
.spark {{ color: {accent}; font-size: 20px; display: inline-block; animation: pulse 1.6s ease-in-out infinite; }}
@keyframes pulse {{ 0%,100% {{ transform: rotate(0) scale(1); opacity: .65; }} 50% {{ transform: rotate(90deg) scale(1.15); opacity: 1; }} }}
.callout {{ font-family: {sans}; font-size: 14px; border: 1px solid {danger}; color: {danger}; border-radius: 12px;
           padding: 10px 14px; margin: 6px 0 12px; white-space: pre-wrap; }}

.media-grid {{ display: flex; flex-wrap: wrap; gap: 10px; margin: 6px 0 12px; }}
.media img {{ max-width: 100%; max-height: 520px; border-radius: 14px; display: block; border: 1px solid {border}; }}
.media-grid .media {{ flex: 1 1 300px; max-width: 100%; }}
.video {{ font-family: {sans}; font-size: 13px; width: 100%; }}
.video video {{ width: 100%; max-height: 480px; border-radius: 14px; background: #000; display: block; margin-bottom: 6px; }}
.file {{ font-family: {sans}; border: 1px solid {border}; border-radius: 10px; padding: 8px 12px; }}

.actions {{ display: flex; align-items: center; gap: 2px; margin: -4px 0 0 -8px; }}
.actions button {{ opacity: 0; transition: opacity .15s; }}
.turn.bot:hover .actions button {{ opacity: 1; }}
.actions .meta {{ font: 12px {sans}; color: {dim}; padding: 4px 8px; cursor: default; }}
</style></head><body><div id="chat"></div><script>
function enhance(root) {{
  root.querySelectorAll('.codeblock .copy').forEach(b => b.onclick = () => copy(b, b.closest('.codeblock').querySelector('pre').innerText));
  root.querySelectorAll('.copy-msg').forEach(b => b.onclick = () => {{
    const c = b.closest('.content').cloneNode(true);
    c.querySelectorAll('.actions, .tool, .codehead').forEach(x => x.remove());
    copy(b, c.innerText.trim());
  }});
}}
function copy(btn, text) {{
  navigator.clipboard.writeText(text);
  const old = btn.textContent; btn.textContent = 'Скопировано ✓';
  setTimeout(() => btn.textContent = old, 1400);
}}
function setChat(html, forceBottom) {{
  const el = document.getElementById('chat');
  const atBottom = forceBottom || (window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
  const open = [...el.querySelectorAll('details[open]')].map(d => d.dataset.id);
  el.innerHTML = html;
  open.forEach(id => {{ const d = el.querySelector(`details[data-id="${{CSS.escape(id)}}"]`); if (d) d.open = true; }});
  enhance(el);
  if (atBottom) window.scrollTo(0, document.body.scrollHeight);
}}
</script></body></html>"""


class ChatPage(QWebEnginePage):
    link_clicked = Signal(QUrl)

    def acceptNavigationRequest(self, url, nav_type, is_main_frame):
        if nav_type == QWebEnginePage.NavigationType.NavigationTypeLinkClicked:
            self.link_clicked.emit(url)
            return False
        return True


class ChatView(QWebEngineView):
    link_clicked = Signal(QUrl)

    def __init__(self, parent=None):
        super().__init__(parent)
        page = ChatPage(self)
        page.link_clicked.connect(self.link_clicked)
        self.setPage(page)
        s = page.settings()
        s.setAttribute(QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        s.setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanAccessClipboard, True)
        self._ready = False
        self._pending: tuple[str, bool] | None = None
        self.loadFinished.connect(self._on_loaded)

    def set_theme(self, c: dict, dark: bool) -> None:
        self._ready = False
        self.page().setBackgroundColor(QColor(c["bg"]))
        page = TEMPLATE.format(scheme="dark" if dark else "light", sans=SANS, serif=SERIF, mono=MONO,
                               fontfaces=font_face_css(),
                               pygments=pygments_css(dark), **c)
        self.setHtml(page, QUrl.fromLocalFile("/"))

    def _on_loaded(self, ok: bool) -> None:
        self._ready = True
        if self._pending is not None:
            self.set_content(*self._pending)

    def set_content(self, html: str, force_bottom: bool = False) -> None:
        if not self._ready:
            self._pending = (html, force_bottom)
            return
        self._pending = None
        self.page().runJavaScript(f"setChat({json.dumps(html)}, {str(force_bottom).lower()})")

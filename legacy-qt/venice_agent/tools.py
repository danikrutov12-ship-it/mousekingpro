"""Инструменты агента: файлы, папки, команды, архивы, веб."""

from __future__ import annotations

import base64
import difflib
import fnmatch
import html
import os
import re
import shutil
import signal
import subprocess
import tarfile
import zipfile
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable
from urllib.parse import parse_qs, urljoin, urlparse

import httpx

MAX_OUTPUT = 30_000
MAX_LIST = 500
MAX_MATCHES = 200
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".venv", "venv", ".mypy_cache",
    ".pytest_cache", ".idea", ".tox", ".cache",
}
ARCHIVE_SUFFIXES = (
    ".zip", ".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tar.xz", ".txz", ".rar", ".7z",
)
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0 Safari/537.36"
)
DENIED = (
    "Пользователь отклонил это действие. Не повторяй его в том же виде; "
    "спроси пользователя, как поступить."
)


class ToolError(Exception):
    pass


@dataclass
class ToolContext:
    root: Path
    # (заголовок, подробности) -> разрешил ли пользователь
    approve: Callable[[str, str], bool]
    # (запрос, сколько результатов) -> текст; поиск через Venice, если доступен
    search: Callable[[str, int], str] | None = None

    def resolve(self, p: str | None) -> Path:
        path = Path(p or ".").expanduser()
        if not path.is_absolute():
            path = self.root / path
        return path.resolve()

    def rel(self, path: Path) -> str:
        try:
            return str(path.relative_to(self.root)) or "."
        except ValueError:
            return str(path)

    def outside_note(self, path: Path) -> str:
        return "" if path.is_relative_to(self.root) else "  ⚠ ВНЕ ПАПКИ ПРОЕКТА"


def truncate(text: str, limit: int = MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [обрезано, всего {len(text)} символов]"


def human_size(n: int) -> str:
    for unit in ("Б", "КБ", "МБ", "ГБ"):
        if n < 1024:
            return f"{n:.0f} {unit}" if unit == "Б" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} ТБ"


def is_archive(path: Path | str) -> bool:
    return str(path).lower().endswith(ARCHIVE_SUFFIXES)


def make_diff(old: str, new: str, name: str) -> str:
    diff = difflib.unified_diff(
        old.splitlines(keepends=True), new.splitlines(keepends=True),
        fromfile=f"a/{name}", tofile=f"b/{name}",
    )
    return "".join(diff) or "(без изменений)"


def read_text(path: Path) -> str:
    with open(path, encoding="utf-8", errors="replace", newline="") as f:
        return f.read()


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        f.write(text)


def iter_files(base: Path):
    if base.is_file():
        yield base
        return
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
        for name in sorted(filenames):
            yield Path(dirpath) / name


def tree_preview(base: Path, limit: int = 100) -> str:
    lines = []
    for f in iter_files(base):
        lines.append(str(f.relative_to(base)))
        if len(lines) >= limit:
            lines.append("...")
            break
    return "\n".join(lines)


# ---------------------------------------------------------------- файлы

def list_dir(ctx: ToolContext, path: str = ".", depth: int = 2) -> str:
    base = ctx.resolve(path)
    if not base.is_dir():
        raise ToolError(f"Это не папка: {base}")
    depth = max(1, min(int(depth), 5))
    lines: list[str] = []

    def walk(d: Path, level: int) -> None:
        try:
            entries = sorted(d.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower()))
        except PermissionError:
            lines.append("  " * level + "[нет доступа]")
            return
        for e in entries:
            if len(lines) >= MAX_LIST:
                return
            if e.is_dir():
                lines.append("  " * level + e.name + "/")
                if e.name not in SKIP_DIRS and level + 1 < depth:
                    walk(e, level + 1)
            else:
                try:
                    size = e.stat().st_size
                except OSError:
                    size = 0
                lines.append(f"{'  ' * level}{e.name} ({human_size(size)})")

    walk(base, 0)
    if len(lines) >= MAX_LIST:
        lines.append(f"... [показаны первые {MAX_LIST} элементов]")
    return f"{base}\n" + ("\n".join(lines) or "(пусто)")


def read_file(ctx: ToolContext, path: str, offset: int = 1, limit: int = 2000) -> str:
    p = ctx.resolve(path)
    if not p.is_file():
        raise ToolError(f"Файл не найден: {p}")
    if p.stat().st_size > 50 * 1024 * 1024:
        raise ToolError(f"Файл слишком большой ({human_size(p.stat().st_size)})")
    data = p.read_bytes()
    if b"\0" in data[:8192]:
        return f"Бинарный файл {p} ({human_size(len(data))}), как текст не читается."
    lines = data.decode("utf-8", errors="replace").splitlines()
    offset = max(1, int(offset))
    limit = max(1, min(int(limit), 5000))
    chunk = lines[offset - 1: offset - 1 + limit]
    out = "\n".join(f"{i:>5}\t{line}" for i, line in enumerate(chunk, start=offset))
    rest = len(lines) - (offset - 1 + len(chunk))
    if rest > 0:
        out += f"\n... [ещё {rest} строк, продолжи с offset={offset + len(chunk)}]"
    return truncate(out or "(пустой файл)")


def write_file(ctx: ToolContext, path: str, content: str) -> str:
    p = ctx.resolve(path)
    if p.is_dir():
        raise ToolError(f"Это папка: {p}")
    exists = p.is_file()
    details = make_diff(read_text(p), content, ctx.rel(p)) if exists else content
    title = ("Перезаписать файл" if exists else "Создать файл") + f": {p}" + ctx.outside_note(p)
    if not ctx.approve(title, truncate(details, 20_000)):
        return DENIED
    write_text(p, content)
    return f"Файл записан: {p} ({len(content.splitlines())} строк)"


def edit_file(ctx: ToolContext, path: str, old_string: str, new_string: str,
              replace_all: bool = False) -> str:
    p = ctx.resolve(path)
    if not p.is_file():
        raise ToolError(f"Файл не найден: {p}")
    if not old_string:
        raise ToolError("old_string пустой. Для нового файла используй write_file.")
    text = read_text(p)
    count = text.count(old_string)
    if count == 0:
        raise ToolError(
            "old_string не найден. Прочитай файл заново и скопируй фрагмент точно, "
            "с отступами, без номеров строк."
        )
    if count > 1 and not replace_all:
        raise ToolError(
            f"old_string встречается {count} раз. Добавь контекст или укажи replace_all=true."
        )
    new = text.replace(old_string, new_string) if replace_all else text.replace(old_string, new_string, 1)
    title = f"Изменить файл: {p}" + ctx.outside_note(p)
    if not ctx.approve(title, truncate(make_diff(text, new, ctx.rel(p)), 20_000)):
        return DENIED
    write_text(p, new)
    return f"Файл изменён: {p} (замен: {count if replace_all else 1})"


def search_files(ctx: ToolContext, pattern: str, path: str = ".", glob: str | None = None,
                 ignore_case: bool = False) -> str:
    base = ctx.resolve(path)
    try:
        rx = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    except re.error as e:
        raise ToolError(f"Неверное регулярное выражение: {e}")
    results: list[str] = []
    for f in iter_files(base):
        if glob and not fnmatch.fnmatch(f.name, glob):
            continue
        try:
            if f.stat().st_size > 2_000_000:
                continue
            data = f.read_bytes()
        except OSError:
            continue
        if b"\0" in data[:4096]:
            continue
        for n, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            if rx.search(line):
                results.append(f"{ctx.rel(f)}:{n}: {line.strip()[:300]}")
                if len(results) >= MAX_MATCHES:
                    break
        if len(results) >= MAX_MATCHES:
            results.append(f"... [показаны первые {MAX_MATCHES} совпадений]")
            break
    return truncate("\n".join(results) or "Совпадений нет.")


def find_files(ctx: ToolContext, pattern: str, path: str = ".") -> str:
    base = ctx.resolve(path)
    if not base.is_dir():
        raise ToolError(f"Это не папка: {base}")
    results = []
    for f in iter_files(base):
        rel = f.relative_to(base).as_posix()
        if fnmatch.fnmatch(rel if "/" in pattern else f.name, pattern):
            results.append(ctx.rel(f))
            if len(results) >= MAX_LIST:
                results.append("...")
                break
    return "\n".join(results) or "Ничего не найдено."


# ---------------------------------------------------------------- команды

def run_command(ctx: ToolContext, command: str, timeout: int = 120) -> str:
    timeout = max(1, min(int(timeout), 1800))
    if not ctx.approve(f"Выполнить команду (папка: {ctx.root})", command):
        return DENIED
    proc = subprocess.Popen(
        command, shell=True, cwd=ctx.root, stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    )
    try:
        out, _ = proc.communicate(timeout=timeout)
        status = f"Код выхода: {proc.returncode}"
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        out, _ = proc.communicate()
        status = f"Остановлено по таймауту ({timeout} с)"
    text = out.decode("utf-8", errors="replace")
    return truncate(f"{status}\n{text}".rstrip())


# ---------------------------------------------------------------- архивы

def default_extract_dir(src: Path) -> Path:
    name = src.name
    for suffix in sorted(ARCHIVE_SUFFIXES, key=len, reverse=True):
        if name.lower().endswith(suffix):
            name = name[: -len(suffix)]
            break
    target = src.parent / (name or "archive")
    n = 1
    while target.exists():
        target = src.parent / f"{name}_{n}"
        n += 1
    return target


def extract(src: Path, target: Path) -> int:
    """Распаковывает архив в target, возвращает число файлов."""
    if not src.is_file():
        raise ToolError(f"Архив не найден: {src}")
    target.mkdir(parents=True, exist_ok=True)
    root = target.resolve()
    lower = src.name.lower()
    if lower.endswith(".zip"):
        with zipfile.ZipFile(src) as zf:
            for member in zf.infolist():
                if not (root / member.filename).resolve().is_relative_to(root):
                    raise ToolError(f"Опасный путь в архиве: {member.filename}")
            zf.extractall(root)
    elif lower.endswith((".rar", ".7z")):
        tool = next((t for t in ("7z", "7za", "bsdtar", "unrar") if shutil.which(t)), None)
        if tool is None:
            raise ToolError("Для rar/7z нужна утилита 7z, bsdtar или unrar (например: sudo apt install 7zip)")
        cmd = {
            "7z": ["7z", "x", "-y", f"-o{root}", str(src)],
            "7za": ["7za", "x", "-y", f"-o{root}", str(src)],
            "bsdtar": ["bsdtar", "-xf", str(src), "-C", str(root)],
            "unrar": ["unrar", "x", "-o+", str(src), str(root) + "/"],
        }[tool]
        res = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
        if res.returncode != 0:
            raise ToolError(f"{tool} завершился с ошибкой:\n{res.stdout[-2000:]}{res.stderr[-2000:]}")
    else:
        try:
            with tarfile.open(src) as tf:
                tf.extractall(root, filter="data")
        except tarfile.TarError as e:
            raise ToolError(f"Не удалось распаковать: {e}")
    return sum(1 for _ in iter_files(root))


def extract_archive(ctx: ToolContext, path: str, destination: str | None = None) -> str:
    src = ctx.resolve(path)
    target = ctx.resolve(destination) if destination else default_extract_dir(src)
    if not ctx.approve(f"Распаковать архив: {src.name}", f"Куда: {target}{ctx.outside_note(target)}"):
        return DENIED
    count = extract(src, target)
    return f"Распаковано в {target}: файлов {count}\n{tree_preview(target)}"


# ---------------------------------------------------------------- веб

class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "head"}
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
             "section", "article", "header", "footer", "pre", "blockquote", "table", "ul", "ol"}

    def __init__(self, base_url: str):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.parts: list[str] = []
        self.skip = 0
        self.title = ""
        self._in_title = False
        self._href: str | None = None
        self._link_text: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "title":
            self._in_title = True
        if tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
        if tag.startswith("h") and tag[1:].isdigit():
            self.parts.append("#" * int(tag[1:]) + " ")
        if tag == "li":
            self.parts.append("- ")
        if tag == "a":
            href = dict(attrs).get("href")
            if href and not href.startswith(("#", "javascript:")):
                self._href = urljoin(self.base_url, href)
                self._link_text = []

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP and self.skip:
            self.skip -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")
        if tag == "a" and self._href:
            text = " ".join("".join(self._link_text).split())
            if text:
                self.parts.append(f"[{text}]({self._href})")
            self._href = None

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self.skip:
            return
        if self._href is not None:
            self._link_text.append(data)
        else:
            self.parts.append(data)

    def text(self) -> str:
        raw = "".join(self.parts)
        lines = [" ".join(line.split()) for line in raw.splitlines()]
        out, blank = [], False
        for line in lines:
            if line:
                out.append(line)
                blank = False
            elif not blank:
                out.append("")
                blank = True
        return "\n".join(out).strip()


def html_to_text(page: str, base_url: str) -> tuple[str, str]:
    parser = _TextExtractor(base_url)
    parser.feed(page)
    return parser.title.strip(), parser.text()


def _strip_tags(s: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]+>", "", s)).split())


def _bing_href(href: str) -> str:
    """Bing заворачивает ссылки в bing.com/ck/a?...&u=a1<base64 адреса>."""
    href = html.unescape(href)
    if "bing.com/ck/a" in href:
        u = parse_qs(urlparse(href).query).get("u", [""])[0]
        if u.startswith("a1"):
            b64 = u[2:] + "=" * (-len(u[2:]) % 4)
            try:
                return base64.urlsafe_b64decode(b64).decode()
            except ValueError:
                pass
    return href


def _search_bing(query: str, limit: int) -> list[tuple[str, str, str]]:
    r = httpx.get("https://www.bing.com/search", params={"q": query},
                  headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True)
    r.raise_for_status()
    out = []
    for block in re.split(r'<li class="b_algo"', r.text)[1:]:
        link = re.search(r'<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', block, re.S)
        if not link:
            continue
        snippet = re.search(r"<p[^>]*>(.*?)</p>", block, re.S)
        out.append((_strip_tags(link.group(2)), _bing_href(link.group(1)),
                    _strip_tags(snippet.group(1)) if snippet else ""))
        if len(out) >= limit:
            break
    return out


def _search_duckduckgo(query: str, limit: int) -> list[tuple[str, str, str]]:
    r = httpx.post("https://html.duckduckgo.com/html/", data={"q": query},
                   headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True)
    r.raise_for_status()
    page = r.text
    links = list(re.finditer(r'<a([^>]*class="result__a"[^>]*)>(.*?)</a>', page, re.S))
    out = []
    for i, m in enumerate(links):
        href_m = re.search(r'href="([^"]+)"', m.group(1))
        if not href_m:
            continue
        href = html.unescape(href_m.group(1))
        if "uddg=" in href:
            href = parse_qs(urlparse(href).query).get("uddg", [href])[0]
        if "duckduckgo.com/y.js" in href:  # реклама
            continue
        end = links[i + 1].start() if i + 1 < len(links) else len(page)
        sn = re.search(r'class="result__snippet"[^>]*>(.*?)</a>', page[m.end():end], re.S)
        out.append((_strip_tags(m.group(2)), href, _strip_tags(sn.group(1)) if sn else ""))
        if len(out) >= limit:
            break
    return out


def web_search(ctx: ToolContext, query: str, max_results: int = 8) -> str:
    limit = max(1, min(int(max_results), 20))
    errors = []
    if ctx.search is not None:
        try:
            return ctx.search(query, limit)
        except Exception as e:  # noqa: BLE001 — падаем на запасные поисковики
            errors.append(f"venice: {e}")
    for engine in (_search_bing, _search_duckduckgo):
        try:
            results = engine(query, limit)
        except httpx.HTTPError as e:
            errors.append(f"{engine.__name__}: {e}")
            continue
        if results:
            return "\n".join(f"{i}. {title}\n   {url}\n   {snippet}"
                             for i, (title, url, snippet) in enumerate(results, 1))
    note = f" Ошибки: {'; '.join(errors)}" if errors else ""
    return "Результатов нет (поисковики могли ограничить запросы). Попробуй fetch_url с прямым адресом." + note


def fetch_url(ctx: ToolContext, url: str, max_chars: int = 20_000) -> str:
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    r = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=30, follow_redirects=True)
    ctype = r.headers.get("content-type", "")
    head = f"URL: {r.url}\nСтатус: {r.status_code}\n"
    if "html" in ctype:
        title, text = html_to_text(r.text, str(r.url))
        head += f"Заголовок: {title}\n"
    elif ctype.startswith("text/") or "json" in ctype or "xml" in ctype or "javascript" in ctype:
        text = r.text
    else:
        return head + f"Тип: {ctype}, размер {human_size(len(r.content))}. Чтобы сохранить файл, используй download_file."
    return head + "\n" + truncate(text, max(1000, min(int(max_chars), 100_000)))


def download_file(ctx: ToolContext, url: str, path: str) -> str:
    p = ctx.resolve(path)
    if not ctx.approve(f"Скачать файл: {p}{ctx.outside_note(p)}", url):
        return DENIED
    p.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    with httpx.stream("GET", url, headers={"User-Agent": USER_AGENT}, timeout=60,
                      follow_redirects=True) as r:
        r.raise_for_status()
        with open(p, "wb") as f:
            for chunk in r.iter_bytes():
                size += len(chunk)
                if size > 1024 * 1024 * 1024:
                    raise ToolError("Файл больше 1 ГБ, загрузка прервана")
                f.write(chunk)
    return f"Сохранено: {p} ({human_size(size)})"


# ---------------------------------------------------------------- реестр

def _schema(name: str, description: str, props: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


_S = {"type": "string"}
_I = {"type": "integer"}
_B = {"type": "boolean"}

TOOLS: dict[str, tuple[Callable, dict]] = {
    "list_dir": (list_dir, _schema(
        "list_dir", "List files and folders as a tree. Relative paths are resolved against the project folder.",
        {"path": {**_S, "description": "Folder path, default '.'"},
         "depth": {**_I, "description": "Tree depth 1-5, default 2"}}, [])),
    "read_file": (read_file, _schema(
        "read_file", "Read a text file. Returns lines prefixed with line numbers (the numbers are not part of the file).",
        {"path": _S, "offset": {**_I, "description": "First line, 1-based"},
         "limit": {**_I, "description": "Max lines, default 2000"}}, ["path"])),
    "write_file": (write_file, _schema(
        "write_file", "Create a file or overwrite it completely. Requires user approval.",
        {"path": _S, "content": {**_S, "description": "Full new file content"}}, ["path", "content"])),
    "edit_file": (edit_file, _schema(
        "edit_file", "Replace an exact text fragment in a file. old_string must match exactly and be unique "
                     "unless replace_all is true. Requires user approval.",
        {"path": _S, "old_string": _S, "new_string": _S, "replace_all": _B},
        ["path", "old_string", "new_string"])),
    "search_files": (search_files, _schema(
        "search_files", "Search file contents with a regular expression (like grep).",
        {"pattern": _S, "path": _S, "glob": {**_S, "description": "Filename filter, e.g. '*.py'"},
         "ignore_case": _B}, ["pattern"])),
    "find_files": (find_files, _schema(
        "find_files", "Find files by name pattern, e.g. '*.py' or 'src/*.js'.",
        {"pattern": _S, "path": _S}, ["pattern"])),
    "run_command": (run_command, _schema(
        "run_command", "Run a shell command (bash) in the project folder. Requires user approval.",
        {"command": _S, "timeout": {**_I, "description": "Seconds, default 120"}}, ["command"])),
    "extract_archive": (extract_archive, _schema(
        "extract_archive", "Extract zip/tar/tar.gz/rar/7z archive. Requires user approval.",
        {"path": _S, "destination": {**_S, "description": "Target folder; default is next to the archive"}},
        ["path"])),
    "web_search": (web_search, _schema(
        "web_search", "Search the internet. Returns titles, URLs and snippets.",
        {"query": _S, "max_results": _I}, ["query"])),
    "fetch_url": (fetch_url, _schema(
        "fetch_url", "Open a web page and return its text content with links.",
        {"url": _S, "max_chars": _I}, ["url"])),
    "download_file": (download_file, _schema(
        "download_file", "Download a file from a URL to a path. Requires user approval.",
        {"url": _S, "path": _S}, ["url", "path"])),
}

SCHEMAS = [schema for _, schema in TOOLS.values()]


def execute(ctx: ToolContext, name: str, args: dict) -> str:
    entry = TOOLS.get(name)
    if entry is None:
        return f"Ошибка: неизвестный инструмент «{name}». Доступны: {', '.join(TOOLS)}"
    if not isinstance(args, dict):
        return "Ошибка: arguments должен быть JSON-объектом"
    try:
        return entry[0](ctx, **args)
    except TypeError as e:
        return f"Ошибка аргументов: {e}"
    except ToolError as e:
        return f"Ошибка: {e}"
    except httpx.HTTPError as e:
        return f"Сетевая ошибка: {e}"
    except Exception as e:  # noqa: BLE001 — модель должна увидеть любую ошибку
        return f"Ошибка: {type(e).__name__}: {e}"

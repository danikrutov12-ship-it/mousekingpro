"""Агентный цикл и генерация медиа в фоновых потоках."""

from __future__ import annotations

import json
import platform
import re
import time
import uuid
from pathlib import Path

import httpx
from openai import APIStatusError, OpenAI
from PySide6.QtCore import QThread, Signal

from . import tools
from .api import VeniceAPI, explain, image_price, usd
from .storage import KNOWLEDGE_DIR

SYSTEM_PROMPT = """You are Venice Agent, an AI assistant running inside a desktop app on the user's computer.
You can work with the user's files, folders, shell, archives and the web using tools.

Project: {project}
Project folder (working directory, relative paths resolve here): {root}
OS: {os}
Current date: {date}

Guidelines:
- Explore with list_dir / find_files / search_files / read_file before changing anything.
- Read a file before editing it. Prefer edit_file for small changes, write_file for new files or full rewrites.
- Files the user attaches are saved into the project folder; their paths are given in the message.
- Actions that modify files, run commands or download need user approval. If an action is denied, do not retry it as is.
- Never invent tool results. When the task is done, give a short summary of what you did.
- Reply in the user's language. Use Markdown; put code in fenced blocks.
{instructions}"""

TEXT_TOOLS_PROMPT = """

## Tools
To call a tool, write a block exactly like this (valid JSON inside):
<tool_call>
{{"name": "read_file", "arguments": {{"path": "main.py"}}}}
</tool_call>
You may write several blocks in one message. After writing tool calls, STOP and wait:
results arrive in the next message inside <tool_result> tags. Do not write <tool_result> yourself.
If you don't need a tool, just answer normally.

Available tools:
{tools}"""

KNOWLEDGE_BUDGET = 60_000  # символов файлов проекта прямо в системном промпте

CALL_RE = re.compile(r"<tool_call>\s*(.*?)\s*(?:</tool_call>|\Z)", re.S)


def strip_tool_calls(text: str) -> str:
    return CALL_RE.sub("", text).strip()


def parse_text_calls(text: str) -> list[dict]:
    calls = []
    for m in CALL_RE.finditer(text):
        raw = re.sub(r"^```(?:json)?|```$", "", m.group(1).strip()).strip()
        try:
            obj = json.loads(raw)
            name = obj["name"]
            args = obj.get("arguments", obj.get("parameters", {}))
            if isinstance(args, str):
                args = json.loads(args)
            arguments = json.dumps(args, ensure_ascii=False)
        except (ValueError, KeyError, TypeError):
            name, arguments = "invalid_tool_call", json.dumps({"raw": raw[:1000]}, ensure_ascii=False)
        calls.append({"id": f"call_{uuid.uuid4().hex[:10]}", "name": name, "arguments": arguments})
    return calls


def tools_description() -> str:
    lines = []
    for schema in tools.SCHEMAS:
        fn = schema["function"]
        params = fn["parameters"]
        args = ", ".join(
            f"{k}{'' if k in params['required'] else '?'}: {v['type']}"
            for k, v in params["properties"].items()
        )
        lines.append(f"- {fn['name']}({args}) — {fn['description']}")
    return "\n".join(lines)


def text_of(content) -> str:
    if isinstance(content, list):
        return "\n".join(p.get("text", "") for p in content if p.get("type") == "text")
    return content or ""


class AgentThread(QThread):
    text_delta = Signal(str)        # кусок текущего ответа
    message_added = Signal(dict)    # сообщение для истории чата
    status = Signal(str)            # строка состояния
    approval_needed = Signal(str, str)
    failed = Signal(str)

    def __init__(self, settings: dict, project: dict, messages: list[dict], model: dict | None,
                 auto_approve: bool = False, search_model: str | None = None):
        super().__init__()
        self.settings = settings
        self.project = project
        self.history = [dict(m) for m in messages]
        self.model_id = model["id"] if model else settings["text_model"]
        self.vision = bool(model and model.get("vision"))
        mode = settings.get("tool_mode", "auto")
        self.native = mode == "native" or (mode == "auto" and bool(model and model.get("tools")))
        self.auto_approve = auto_approve
        self.approval_result = "no"
        self._stop = False
        self._stream = None
        self.root = Path(project["folder"]).expanduser().resolve()
        search = None
        self.search_api = VeniceAPI(settings["api_key"], settings["base_url"])
        self._search_billed = 0.0
        self._usage: dict | None = None
        if search_model:
            api = self.search_api
            search = lambda query, limit: api.web_search(search_model, query, limit)  # noqa: E731
        self.ctx = tools.ToolContext(root=self.root, approve=self._approve, search=search)

    def stop(self) -> None:
        self._stop = True
        stream = self._stream
        if stream is not None:
            try:
                stream.close()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------ разрешения

    def _approve(self, title: str, details: str) -> bool:
        if self._stop:
            return False
        if self.auto_approve:
            return True
        self.approval_result = "no"
        self.approval_needed.emit(title, details)  # BlockingQueuedConnection: ждём ответа из GUI
        if self.approval_result == "always":
            self.auto_approve = True
        return self.approval_result in ("yes", "always")

    # ------------------------------------------------------------ сообщения для API

    def _system_prompt(self) -> str:
        instructions = self.project.get("instructions", "").strip()
        prompt = SYSTEM_PROMPT.format(
            project=self.project["name"], root=self.root,
            os=f"{platform.system()} {platform.release()}",
            date=time.strftime("%Y-%m-%d"),
            instructions=f"\n## Project instructions from the user\n{instructions}" if instructions else "",
        )
        prompt += self._knowledge()
        if not self.native:
            prompt += TEXT_TOOLS_PROMPT.format(tools=tools_description())
        return prompt

    def _knowledge(self) -> str:
        """Файлы проекта: мелкие текстовые — целиком, остальные — списком путей."""
        folder = self.root / KNOWLEDGE_DIR
        if not folder.is_dir():
            return ""
        files = sorted(f for f in folder.rglob("*") if f.is_file())
        if not files:
            return ""
        budget = KNOWLEDGE_BUDGET
        inline, listed = [], []
        for f in files:
            rel = f.relative_to(self.root)
            try:
                data = f.read_bytes() if f.stat().st_size <= budget else b""
            except OSError:
                data = b""
            if data and b"\0" not in data[:8192]:
                inline.append(f'<file path="{rel}">\n{data.decode("utf-8", errors="replace")}\n</file>')
                budget -= len(data)
            else:
                listed.append(f"- {rel}")
        out = "\n\n## Project knowledge\nFiles the user added to this project. Use them as primary context."
        if inline:
            out += "\n\n" + "\n\n".join(inline)
        if listed:
            out += "\n\nOther project files (read them with tools when needed):\n" + "\n".join(listed)
        return out

    def _api_messages(self) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": self._system_prompt()}]
        for m in self.history:
            if m.get("_error"):
                continue
            content = m.get("content")
            if isinstance(content, list) and not self.vision:
                content = text_of(content)
            if self.native:
                msg = {k: v for k, v in m.items() if not k.startswith("_")}
                msg["content"] = content if content is not None else ""
                out.append(msg)
            elif m["role"] == "assistant":
                body = text_of(content)
                for tc in m.get("tool_calls") or []:
                    fn = tc["function"]
                    try:
                        args = json.loads(fn["arguments"] or "{}")
                    except ValueError:
                        args = fn["arguments"]
                    call = json.dumps({"name": fn["name"], "arguments": args}, ensure_ascii=False)
                    body += f"\n<tool_call>\n{call}\n</tool_call>"
                out.append({"role": "assistant", "content": body.strip() or "…"})
            elif m["role"] == "tool":
                block = f'<tool_result name="{m.get("_name", "")}">\n{m["content"]}\n</tool_result>'
                if out[-1]["role"] == "user" and out[-1].get("_results"):
                    out[-1]["content"] += "\n" + block
                else:
                    out.append({"role": "user", "content": block, "_results": True})
            else:
                out.append({"role": m["role"], "content": content})
        for msg in out:
            msg.pop("_results", None)
        return out

    def _add(self, msg: dict) -> None:
        self.history.append(msg)
        self.message_added.emit(msg)

    # ------------------------------------------------------------ цикл

    def run(self) -> None:
        try:
            client = OpenAI(api_key=self.settings["api_key"], base_url=self.settings["base_url"],
                            timeout=httpx.Timeout(600, connect=20))
            for _ in range(int(self.settings.get("max_steps", 40))):
                if self._stop:
                    return
                self.status.emit("Думаю…")
                content, calls = self._complete(client)
                msg = {"role": "assistant", "content": content}
                self._attach_usage(msg)
                if calls:
                    msg["tool_calls"] = [
                        {"id": c["id"], "type": "function",
                         "function": {"name": c["name"], "arguments": c["arguments"]}}
                        for c in calls
                    ]
                if content or calls:
                    self._add(msg)
                if not calls:
                    return
                for c in calls:
                    if self._stop:
                        result = "Отменено пользователем."
                    else:
                        self.status.emit(f"🔧 {c['name']}…")
                        result = self._run_tool(c)
                    self._add({"role": "tool", "tool_call_id": c["id"], "content": result, "_name": c["name"]})
                if self._stop:
                    return
            self._add({"role": "assistant",
                       "content": "_Достигнут лимит шагов. Напишите «продолжай», чтобы продолжить._"})
        except APIStatusError as e:
            if not self._stop:
                body = e.body
                if isinstance(body, dict):
                    body = body.get("error") or body.get("message")
                self.failed.emit(explain(e.status_code, body or e.message))
        except Exception as e:  # noqa: BLE001
            if not self._stop:
                self.failed.emit(f"{type(e).__name__}: {e}")
        finally:
            self._stream = None

    def _run_tool(self, call: dict) -> str:
        if call["name"] == "invalid_tool_call":
            return ("Ошибка: не удалось разобрать вызов инструмента. Внутри <tool_call> должен быть "
                    'валидный JSON вида {"name": "...", "arguments": {...}}.')
        try:
            args = json.loads(call["arguments"] or "{}")
        except ValueError as e:
            return f"Ошибка: arguments — невалидный JSON ({e})"
        return tools.execute(self.ctx, call["name"], args)

    def _attach_usage(self, msg: dict) -> None:
        """Стоимость шага (по данным Venice) плюс веб-поиски, сделанные с прошлого шага."""
        search = self.search_api.spent - self._search_billed
        self._search_billed = self.search_api.spent
        usage = self._usage or {}
        cost = usage.get("cost")
        if cost is not None or search:
            msg["_cost"] = (cost or 0.0) + search
        if usage.get("tokens"):
            msg["_tokens"] = usage["tokens"]

    def _complete(self, client: OpenAI) -> tuple[str, list[dict]]:
        venice_params = {
            "include_venice_system_prompt": bool(self.settings.get("venice_system_prompt")),
            "enable_web_search": self.settings.get("venice_web_search", "off"),
            "strip_thinking_response": True,
        }
        kwargs = dict(
            model=self.model_id, messages=self._api_messages(), stream=True,
            stream_options={"include_usage": True},
            temperature=float(self.settings.get("temperature", 0.7)),
            extra_body={"venice_parameters": venice_params},
        )
        if self.native:
            kwargs["tools"] = tools.SCHEMAS
        else:
            kwargs["stop"] = ["<tool_result"]

        stream = client.chat.completions.create(**kwargs)
        self._stream = stream
        content = ""
        calls: dict[int, dict] = {}
        self._usage = None
        try:
            for chunk in stream:
                if self._stop:
                    break
                if chunk.usage:  # последний чанк: токены и списанная сумма
                    self._usage = {
                        "tokens": [chunk.usage.prompt_tokens, chunk.usage.completion_tokens],
                        "cost": usd((chunk.model_extra or {}).get("cost")),
                    }
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                if delta.content:
                    content += delta.content
                    self.text_delta.emit(delta.content)
                for tc in delta.tool_calls or []:
                    slot = calls.setdefault(tc.index or 0, {"id": "", "name": "", "arguments": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] = tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["arguments"] += tc.function.arguments
        except Exception:
            if not self._stop:
                raise
        finally:
            self._stream = None

        if self.native:
            result = [c for _, c in sorted(calls.items()) if c["name"]]
            for c in result:
                c["id"] = c["id"] or f"call_{uuid.uuid4().hex[:10]}"
            return content, result
        return strip_tool_calls(content), parse_text_calls(content)


class MediaThread(QThread):
    """Генерация изображения или видео."""

    status = Signal(str)
    done = Signal(list, object)    # пути к файлам, стоимость в USD (или None)
    failed = Signal(str)

    def __init__(self, settings: dict, kind: str, params: dict, out_dir: Path, model: dict | None = None):
        super().__init__()
        self.api = VeniceAPI(settings["api_key"], settings["base_url"])
        self.model = model or {}
        self.kind = kind
        self.params = params
        self.out_dir = out_dir
        self._stop = False

    def stop(self) -> None:
        self._stop = True

    def run(self) -> None:
        try:
            if self.kind == "image":
                self.status.emit("Генерирую изображение…")
                cost = image_price(self.model, self.params)
                paths = self.api.generate_image(self.params, self.out_dir)
            else:
                try:
                    cost = self.api.video_quote(self.params)
                except Exception:  # noqa: BLE001 — без цены видео всё равно делаем
                    cost = None
                paths = [self.api.generate_video(self.params, self.out_dir, self.status.emit,
                                                 lambda: self._stop)]
            self.done.emit([str(p) for p in paths], cost)
        except Exception as e:  # noqa: BLE001
            self.failed.emit(f"{e}")

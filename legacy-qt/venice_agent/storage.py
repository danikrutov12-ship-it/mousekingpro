"""Хранение проектов и чатов в JSON-файлах."""

from __future__ import annotations

import json
import shutil
import time
import uuid
from pathlib import Path

from .config import APP_DIR

DEFAULT_PROJECT_NAME = "Общий"
KNOWLEDGE_DIR = "knowledge"  # файлы проекта, которые агент видит в каждом чате


def _now() -> float:
    return time.time()


class Store:
    def __init__(self, base: Path = APP_DIR):
        self.base = base / "projects"
        self.base.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------ проекты

    def projects(self) -> list[dict]:
        out = []
        for f in self.base.glob("*/project.json"):
            try:
                out.append(json.loads(f.read_text("utf-8")))
            except (OSError, json.JSONDecodeError):
                continue
        return sorted(out, key=lambda p: p.get("created", 0))

    def project(self, project_id: str) -> dict | None:
        try:
            return json.loads((self.base / project_id / "project.json").read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    def default_project(self) -> dict:
        """Проект для обычных чатов (вне проектов). Создаётся при первом запуске."""
        projects = self.projects()
        for p in projects:
            if p.get("default"):
                return p
        # старые установки: первым был создан «Общий» — он и становится проектом по умолчанию
        legacy = next((p for p in projects if p["name"] == DEFAULT_PROJECT_NAME), None)
        if legacy:
            legacy["default"] = True
            self.save_project(legacy)
            return legacy
        p = self.create_project(DEFAULT_PROJECT_NAME, str(Path.home() / "VeniceAgent" / DEFAULT_PROJECT_NAME))
        p["default"] = True
        self.save_project(p)
        return p

    def user_projects(self) -> list[dict]:
        """Проекты пользователя (без проекта по умолчанию) со статистикой, свежие сверху."""
        out = []
        for p in self.projects():
            if p.get("default"):
                continue
            chats = self.chats(p["id"])
            p = dict(p, chat_count=len(chats),
                     updated=max([c["updated"] for c in chats] + [p.get("created", 0)]))
            out.append(p)
        return sorted(out, key=lambda p: p["updated"], reverse=True)

    def create_project(self, name: str, folder: str, instructions: str = "", description: str = "") -> dict:
        project = {
            "id": uuid.uuid4().hex[:12], "name": name, "folder": folder, "description": description,
            "instructions": instructions, "created": _now(),
        }
        Path(folder).expanduser().mkdir(parents=True, exist_ok=True)
        self.save_project(project)
        return project

    def save_project(self, project: dict) -> None:
        d = self.base / project["id"]
        (d / "chats").mkdir(parents=True, exist_ok=True)
        clean = {k: v for k, v in project.items() if k not in ("chat_count", "updated")}
        (d / "project.json").write_text(json.dumps(clean, ensure_ascii=False, indent=2), "utf-8")

    def delete_project(self, project_id: str) -> None:
        """Удаляет проект и его чаты из приложения (папка с файлами не трогается)."""
        shutil.rmtree(self.base / project_id, ignore_errors=True)

    @staticmethod
    def knowledge_dir(project: dict) -> Path:
        return Path(project["folder"]).expanduser() / KNOWLEDGE_DIR

    def knowledge_files(self, project: dict) -> list[Path]:
        d = self.knowledge_dir(project)
        return sorted((f for f in d.rglob("*") if f.is_file()), key=lambda f: f.name.lower()) if d.is_dir() else []

    # ------------------------------------------------------------ чаты

    def chats(self, project_id: str) -> list[dict]:
        out = []
        for f in (self.base / project_id / "chats").glob("*.json"):
            try:
                chat = json.loads(f.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            out.append({"id": chat["id"], "title": chat.get("title", ""), "updated": chat.get("updated", 0),
                        "project_id": project_id})
        return sorted(out, key=lambda c: c["updated"], reverse=True)

    def all_chats(self, limit: int = 200) -> list[dict]:
        """Недавние чаты из всех проектов."""
        out = []
        for p in self.projects():
            for c in self.chats(p["id"]):
                c["project_name"] = None if p.get("default") else p["name"]
                out.append(c)
        return sorted(out, key=lambda c: c["updated"], reverse=True)[:limit]

    def new_chat(self) -> dict:
        t = _now()
        return {"id": uuid.uuid4().hex[:12], "title": "Новый чат", "created": t, "updated": t, "messages": []}

    def load_chat(self, project_id: str, chat_id: str) -> dict:
        return json.loads((self.base / project_id / "chats" / f"{chat_id}.json").read_text("utf-8"))

    def save_chat(self, project_id: str, chat: dict) -> None:
        chat["updated"] = _now()
        path = self.base / project_id / "chats" / f"{chat['id']}.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(chat, ensure_ascii=False), "utf-8")
        tmp.replace(path)

    def delete_chat(self, project_id: str, chat_id: str) -> None:
        (self.base / project_id / "chats" / f"{chat_id}.json").unlink(missing_ok=True)

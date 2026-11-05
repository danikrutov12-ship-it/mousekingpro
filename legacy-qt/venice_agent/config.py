"""Настройки приложения и пути к данным."""

from __future__ import annotations

import json
import os
from pathlib import Path

APP_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "venice-agent"
SETTINGS_FILE = APP_DIR / "settings.json"

DEFAULTS = {
    "api_key": "",
    "base_url": "https://api.venice.ai/api/v1",
    "text_model": "deepseek-v4-1-flash-1017-uncensored",
    "image_model": "",
    "video_model": "",
    "temperature": 0.7,
    "max_steps": 40,
    "tool_mode": "auto",            # auto | native | text
    "venice_system_prompt": False,  # добавлять ли системный промпт Venice
    "venice_web_search": "off",     # off | auto | on — встроенный веб-поиск Venice
    "safe_mode": False,             # размытие 18+ на картинках
    "theme": "light",               # light | dark
    "files_panel": False,           # показывать панель файлов
    "sidebar": True,                # показывать боковую панель
    "mac_frame": True,              # окно без системной рамки, кнопки-«светофор» как в macOS
}


def load_settings() -> dict:
    settings = dict(DEFAULTS)
    if SETTINGS_FILE.is_file():
        try:
            settings.update(json.loads(SETTINGS_FILE.read_text("utf-8")))
        except (OSError, json.JSONDecodeError):
            pass
    if not settings["api_key"]:
        settings["api_key"] = os.environ.get("VENICE_API_KEY", "")
    return settings


def save_settings(settings: dict) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), "utf-8")
    SETTINGS_FILE.chmod(0o600)  # там лежит API-ключ

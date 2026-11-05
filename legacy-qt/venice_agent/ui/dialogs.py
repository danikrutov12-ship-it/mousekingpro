"""Диалоги: настройки, проект, подтверждение действий агента."""

from __future__ import annotations

import html
import re
from pathlib import Path

from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDialog, QDoubleSpinBox, QFileDialog, QFormLayout, QHBoxLayout, QLabel,
    QLineEdit, QPlainTextEdit, QPushButton, QSpinBox, QTextBrowser, QVBoxLayout,
)

from .theme import MONO, PALETTES


class _Dialog(QDialog):
    """Базовый диалог: заголовок, отступы, удаление после закрытия
    (иначе дочерний диалог роняет Qt при выходе из приложения)."""

    def __init__(self, title: str, subtitle: str = "", parent=None):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.layout_ = QVBoxLayout(self)
        self.layout_.setContentsMargins(24, 20, 24, 18)
        self.layout_.setSpacing(12)
        self.layout_.addWidget(QLabel(title, objectName="DialogTitle"))
        if subtitle:
            sub = QLabel(subtitle, objectName="Muted")
            sub.setWordWrap(True)
            self.layout_.addWidget(sub)

    def exec(self) -> int:
        result = super().exec()
        self.deleteLater()
        return result

    def add_buttons(self, *buttons: QPushButton) -> None:
        row = QHBoxLayout()
        row.addStretch()
        for b in buttons:
            row.addWidget(b)
        self.layout_.addSpacing(4)
        self.layout_.addLayout(row)


def _button(text: str, kind: str = "") -> QPushButton:
    b = QPushButton(text)
    if kind:
        b.setObjectName(kind)
    return b


class SettingsDialog(_Dialog):
    def __init__(self, settings: dict, parent=None):
        super().__init__("Настройки", "Ключ хранится только на этом компьютере.", parent)
        self.setMinimumWidth(560)
        form = QFormLayout()
        form.setSpacing(10)

        self.api_key = QLineEdit(settings["api_key"])
        self.api_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.api_key.setPlaceholderText("venice.ai → Settings → API")
        show = QCheckBox("показать")
        show.toggled.connect(lambda on: self.api_key.setEchoMode(
            QLineEdit.EchoMode.Normal if on else QLineEdit.EchoMode.Password))
        key_row = QHBoxLayout()
        key_row.addWidget(self.api_key, 1)
        key_row.addWidget(show)
        form.addRow("API-ключ Venice", key_row)

        self.theme = QComboBox()
        self.theme.addItem("Светлая", "light")
        self.theme.addItem("Тёмная", "dark")
        self.theme.setCurrentIndex(max(0, self.theme.findData(settings.get("theme", "light"))))
        form.addRow("Тема", self.theme)

        self.mac_frame = QCheckBox("Окно в стиле macOS (без системной рамки)")
        self.mac_frame.setChecked(bool(settings.get("mac_frame", True)))
        form.addRow("", self.mac_frame)

        self.base_url = QLineEdit(settings["base_url"])
        form.addRow("Адрес API", self.base_url)

        self.temperature = QDoubleSpinBox()
        self.temperature.setRange(0, 2)
        self.temperature.setSingleStep(0.1)
        self.temperature.setValue(float(settings["temperature"]))
        form.addRow("Температура", self.temperature)

        self.max_steps = QSpinBox()
        self.max_steps.setRange(1, 500)
        self.max_steps.setValue(int(settings["max_steps"]))
        form.addRow("Макс. шагов агента", self.max_steps)

        self.tool_mode = QComboBox()
        for value, label in (("auto", "Авто — по возможностям модели"),
                             ("native", "Нативный function calling"),
                             ("text", "Текстовый протокол (любая модель)")):
            self.tool_mode.addItem(label, value)
        self.tool_mode.setCurrentIndex(max(0, self.tool_mode.findData(settings["tool_mode"])))
        form.addRow("Вызов инструментов", self.tool_mode)

        self.web_search = QComboBox()
        for value, label in (("off", "Выключен"), ("auto", "Авто"), ("on", "Всегда")):
            self.web_search.addItem(label, value)
        self.web_search.setCurrentIndex(max(0, self.web_search.findData(settings["venice_web_search"])))
        form.addRow("Веб-поиск в ответах", self.web_search)

        self.venice_prompt = QCheckBox("Добавлять системный промпт Venice")
        self.venice_prompt.setChecked(bool(settings["venice_system_prompt"]))
        form.addRow("", self.venice_prompt)
        self.safe_mode = QCheckBox("Safe mode для изображений (размывать 18+)")
        self.safe_mode.setChecked(bool(settings["safe_mode"]))
        form.addRow("", self.safe_mode)
        self.layout_.addLayout(form)

        cancel, save = _button("Отмена"), _button("Сохранить", "Primary")
        cancel.clicked.connect(self.reject)
        save.clicked.connect(self.accept)
        save.setDefault(True)
        self.add_buttons(cancel, save)

    def values(self) -> dict:
        return {
            "api_key": self.api_key.text().strip(),
            "theme": self.theme.currentData(),
            "mac_frame": self.mac_frame.isChecked(),
            "base_url": self.base_url.text().strip() or "https://api.venice.ai/api/v1",
            "temperature": self.temperature.value(),
            "max_steps": self.max_steps.value(),
            "tool_mode": self.tool_mode.currentData(),
            "venice_web_search": self.web_search.currentData(),
            "venice_system_prompt": self.venice_prompt.isChecked(),
            "safe_mode": self.safe_mode.isChecked(),
        }


PROJECTS_ROOT = Path.home() / "VeniceAgent"


def auto_project_folder(name: str) -> Path:
    """Папка для нового проекта: ~/VeniceAgent/<название>, без запрещённых в путях символов."""
    safe = re.sub(r'[\\/:*?"<>|]+', " ", name).strip(" .") or "Проект"
    folder, n = PROJECTS_ROOT / safe, 2
    while folder.exists() and any(folder.iterdir()):
        folder, n = PROJECTS_ROOT / f"{safe} {n}", n + 1
    return folder


class ProjectDialog(_Dialog):
    """Создание и настройка проекта: название, описание, (необязательно) своя папка."""

    def __init__(self, project: dict | None = None, parent=None):
        super().__init__("Настройки проекта" if project else "Создать проект", "", parent)
        self.setMinimumWidth(560)
        self.delete_requested = False
        self.is_new = not project
        project = project or {}
        # своя папка: у существующего проекта — его папка, у нового — None (создадим автоматически)
        self.custom_folder: str | None = project.get("folder")

        self.layout_.addWidget(QLabel("Над чем вы работаете?", objectName="FieldLabel"))
        self.name = QLineEdit(project.get("name", ""))
        self.name.setPlaceholderText("Назовите проект")
        self.name.textChanged.connect(self._update_folder)
        self.layout_.addWidget(self.name)

        self.layout_.addSpacing(4)
        self.layout_.addWidget(QLabel("Чего вы хотите добиться?", objectName="FieldLabel"))
        self.description = QPlainTextEdit(project.get("description", ""))
        self.description.setPlaceholderText("Опишите проект, цели, тему и т. д.")
        self.description.setFixedHeight(110)
        self.layout_.addWidget(self.description)

        row = QHBoxLayout()
        row.setSpacing(10)
        self.folder_label = QLabel(objectName="Muted")
        self.folder_label.setWordWrap(True)
        row.addWidget(self.folder_label, 1)
        self.folder_btn = _button("", "Link")
        self.folder_btn.clicked.connect(self._folder_action)
        row.addWidget(self.folder_btn)
        self.layout_.addLayout(row)

        buttons = []
        if project:
            delete = _button("Удалить проект", "Danger")
            delete.clicked.connect(self._delete)
            buttons.append(delete)
        cancel = _button("Отмена")
        save = _button("Сохранить" if project else "Создать проект", "Primary")
        save.setDefault(True)
        cancel.clicked.connect(self.reject)
        save.clicked.connect(self._accept)
        self.add_buttons(*buttons, cancel, save)
        self._update_folder()
        self.name.setFocus()

    def _folder(self) -> str:
        return self.custom_folder or str(auto_project_folder(self.name.text().strip()))

    def _update_folder(self, *_):
        folder = self._folder().replace(str(Path.home()), "~", 1)
        self.folder_label.setText(f"Папка проекта: {folder}")
        if self.custom_folder and self.is_new:
            self.folder_btn.setText("Создать автоматически")
        else:
            self.folder_btn.setText("Изменить папку…" if self.custom_folder else "Выбрать свою папку…")

    def _folder_action(self):
        if self.custom_folder and self.is_new:
            self.custom_folder = None
        else:
            d = QFileDialog.getExistingDirectory(self, "Папка проекта", self.custom_folder or str(Path.home()))
            if not d:
                return
            self.custom_folder = d
            if not self.name.text().strip():
                self.name.setText(Path(d).name)
        self._update_folder()

    def _accept(self):
        if self.name.text().strip():
            self.accept()
        else:
            self.name.setFocus()

    def _delete(self):
        self.delete_requested = True
        self.accept()

    def values(self) -> dict:
        return {
            "name": self.name.text().strip(),
            "description": self.description.toPlainText().strip(),
            "folder": str(Path(self._folder()).expanduser()),
        }


class InstructionsDialog(_Dialog):
    def __init__(self, project_name: str, text: str, parent=None):
        super().__init__("Инструкции проекта",
                         f"Агент будет следовать им во всех чатах проекта «{project_name}».", parent)
        self.setMinimumSize(620, 460)
        self.text = QPlainTextEdit(text)
        self.text.setPlaceholderText(
            "Например: «Отвечай кратко. Пиши код на Python 3.12 с аннотациями типов. "
            "Перед изменением файлов показывай план.»")
        self.layout_.addWidget(self.text, 1)
        cancel, save = _button("Отмена"), _button("Сохранить", "Primary")
        cancel.clicked.connect(self.reject)
        save.clicked.connect(self.accept)
        self.add_buttons(cancel, save)

    def value(self) -> str:
        return self.text.toPlainText().strip()


def _mix(fg: str, bg: str, t: float) -> str:
    """Цвет fg, наложенный на bg с непрозрачностью t (Qt не понимает #RRGGBBAA в rich text)."""
    a, b = (int(fg[i:i + 2], 16) for i in (1, 3, 5)), (int(bg[i:i + 2], 16) for i in (1, 3, 5))
    return "#" + "".join(f"{round(x * t + y * (1 - t)):02x}" for x, y in zip(a, b))


def _diff_html(details: str, c: dict) -> str:
    """Подсветка unified diff; обычный текст (команда, новый файл) — как есть."""
    is_diff = details.startswith("--- ") or "\n@@ " in details
    rows = []
    for line in details.splitlines():
        esc = html.escape(line) or "&nbsp;"
        style = ""
        if is_diff:
            if line.startswith("+") and not line.startswith("+++"):
                style = f"background:{_mix(c['ok'], c['code_bg'], 0.14)};color:{c['ok']};"
            elif line.startswith("-") and not line.startswith("---"):
                style = f"background:{_mix(c['danger'], c['code_bg'], 0.14)};color:{c['danger']};"
            elif line.startswith("@@"):
                style = f"color:{c['accent']};"
            elif line.startswith(("---", "+++")):
                style = f"color:{c['muted']};"
        rows.append(f'<div style="{style}white-space:pre;">{esc}</div>')
    return f'<div style="font-family:{MONO};font-size:12px;">{"".join(rows)}</div>'


class ApprovalDialog(_Dialog):
    def __init__(self, title: str, details: str, parent=None, theme: str = "light"):
        super().__init__("Разрешить действие?", title, parent)
        self.setMinimumSize(820, 520)
        self.result_value = "no"

        view = QTextBrowser(objectName="Diff")
        view.setLineWrapMode(QTextBrowser.LineWrapMode.NoWrap)
        view.setHtml(_diff_html(details, PALETTES.get(theme, PALETTES["light"])))
        self.layout_.addWidget(view, 1)

        deny = _button("Отклонить")
        always = _button("Разрешать всё в этом чате")
        allow = _button("Разрешить", "Primary")
        allow.setDefault(True)
        deny.clicked.connect(lambda: self._finish("no"))
        always.clicked.connect(lambda: self._finish("always"))
        allow.clicked.connect(lambda: self._finish("yes"))
        self.add_buttons(deny, always, allow)

    def _finish(self, value: str):
        self.result_value = value
        self.accept()

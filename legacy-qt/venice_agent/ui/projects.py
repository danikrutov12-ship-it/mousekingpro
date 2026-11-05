"""Страницы «Проекты» (сетка карточек) и страница отдельного проекта."""

from __future__ import annotations

import time
from pathlib import Path

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QFrame, QGridLayout, QHBoxLayout, QLabel, QLineEdit, QPushButton, QScrollArea, QSizePolicy,
    QToolButton, QVBoxLayout, QWidget,
)

from .. import tools
from . import icons

PAGE_WIDTH = 1040


def human_ago(ts: float) -> str:
    sec = max(0, time.time() - ts)
    if sec < 60:
        return "только что"
    if sec < 3600:
        return f"{int(sec // 60)} мин назад"
    if sec < 86400:
        return f"{int(sec // 3600)} ч назад"
    days = int(sec // 86400)
    if days == 1:
        return "вчера"
    if days < 30:
        return f"{days} дн назад"
    return time.strftime("%d.%m.%Y", time.localtime(ts))


def _chats_word(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        return f"{n} чат"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return f"{n} чата"
    return f"{n} чатов"


def _scroll_page() -> tuple[QScrollArea, QVBoxLayout]:
    """Прокручиваемая страница с колонкой контента по центру."""
    area = QScrollArea()
    area.setWidgetResizable(True)
    area.setFrameShape(QFrame.Shape.NoFrame)
    area.setObjectName("PageScroll")
    holder = QWidget(objectName="PageBody")
    outer = QHBoxLayout(holder)
    outer.setContentsMargins(32, 18, 32, 32)
    outer.addStretch(1)
    column = QWidget()
    column.setMaximumWidth(PAGE_WIDTH)
    column.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    outer.addWidget(column, 100)
    outer.addStretch(1)
    v = QVBoxLayout(column)
    v.setContentsMargins(0, 0, 0, 0)
    v.setSpacing(0)
    area.setWidget(holder)
    return area, v


def _clear(layout) -> None:
    while layout.count():
        item = layout.takeAt(0)
        if item.widget():
            item.widget().deleteLater()
        elif item.layout():
            _clear(item.layout())


class Clickable(QFrame):
    clicked = Signal()

    def __init__(self, object_name: str):
        super().__init__(objectName=object_name)
        self.setAttribute(Qt.WidgetAttribute.WA_Hover)
        self.setCursor(Qt.CursorShape.PointingHandCursor)

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton and self.rect().contains(e.position().toPoint()):
            self.clicked.emit()
        super().mouseReleaseEvent(e)


class ProjectsPage(QWidget):
    open_project = Signal(str)
    create_project = Signal()

    def __init__(self):
        super().__init__()
        self.projects: list[dict] = []
        self.colors: dict = {}
        self.search_icon = None
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        area, v = _scroll_page()
        outer.addWidget(area)

        top = QHBoxLayout()
        top.addWidget(QLabel("Проекты", objectName="PageTitle"))
        top.addStretch()
        self.new_btn = QPushButton("  Новый проект", objectName="Primary")
        self.new_btn.clicked.connect(self.create_project)
        top.addWidget(self.new_btn)
        v.addLayout(top)
        v.addSpacing(18)

        self.search = QLineEdit(objectName="SearchField", placeholderText="Поиск проектов…")
        self.search.textChanged.connect(self._fill)
        v.addWidget(self.search)
        v.addSpacing(10)
        self.sort_label = QLabel(objectName="Muted")
        v.addWidget(self.sort_label)
        v.addSpacing(10)

        self.grid = QGridLayout()
        self.grid.setSpacing(14)
        v.addLayout(self.grid)
        v.addStretch()

    def set_projects(self, projects: list[dict], colors: dict):
        self.projects, self.colors = projects, colors
        self.new_btn.setIcon(icons.icon("plus", "#ffffff", 16))
        if self.search_icon is None:
            self.search_icon = self.search.addAction(icons.icon("search", colors["dim"], 16),
                                                     QLineEdit.ActionPosition.LeadingPosition)
        else:
            self.search_icon.setIcon(icons.icon("search", colors["dim"], 16))
        self._fill()

    def _fill(self, *_):
        _clear(self.grid)
        q = self.search.text().strip().lower()
        items = [p for p in self.projects if not q or q in f"{p['name']} {p.get('description', '')}".lower()]
        self.sort_label.setText(f"{len(items)} из {len(self.projects)} · сначала недавние" if q
                                else "Сначала недавние" if items else "")
        if not self.projects:
            empty = QFrame(objectName="EmptyCard")
            ev = QVBoxLayout(empty)
            ev.setContentsMargins(28, 34, 28, 34)
            ev.setSpacing(8)
            icon = QLabel(alignment=Qt.AlignmentFlag.AlignCenter)
            icon.setPixmap(icons.pixmap("folder", self.colors.get("dim", "#999"), 34, 1.4))
            ev.addWidget(icon)
            ev.addWidget(QLabel("Пока нет проектов", objectName="CardTitle", alignment=Qt.AlignmentFlag.AlignCenter))
            hint = QLabel("Проект объединяет чаты, инструкции и файлы на одну тему —\n"
                          "агент учитывает их в каждом чате проекта.", objectName="Muted",
                          alignment=Qt.AlignmentFlag.AlignCenter)
            ev.addWidget(hint)
            self.grid.addWidget(empty, 0, 0, 1, 2)
            return
        for i, p in enumerate(items):
            card = Clickable("ProjectCard")
            card.clicked.connect(lambda pid=p["id"]: self.open_project.emit(pid))
            cv = QVBoxLayout(card)
            cv.setContentsMargins(18, 16, 18, 14)
            cv.setSpacing(6)
            cv.addWidget(QLabel(p["name"], objectName="CardTitle"))
            desc = QLabel(p.get("description") or "Без описания", objectName="CardDesc")
            desc.setWordWrap(True)
            desc.setMaximumHeight(desc.fontMetrics().lineSpacing() * 2 + 2)
            cv.addWidget(desc)
            cv.addStretch()
            cv.addWidget(QLabel(f"Обновлён {human_ago(p['updated'])} · {_chats_word(p['chat_count'])}",
                                objectName="CardMeta"))
            card.setMinimumHeight(128)
            self.grid.addWidget(card, i // 2, i % 2)


class ProjectPage(QWidget):
    back = Signal()
    open_chat = Signal(str)
    edit_instructions = Signal()
    add_files = Signal()
    remove_file = Signal(str)
    open_file = Signal(str)
    project_settings = Signal()
    open_folder = Signal()

    def __init__(self):
        super().__init__()
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        area, v = _scroll_page()
        outer.addWidget(area)

        self.back_btn = QPushButton(" Все проекты", objectName="Link")
        self.back_btn.clicked.connect(self.back)
        row = QHBoxLayout()
        row.addWidget(self.back_btn)
        row.addStretch()
        v.addLayout(row)
        v.addSpacing(10)

        body = QHBoxLayout()
        body.setSpacing(28)
        v.addLayout(body)

        # ---- левая колонка: заголовок, композер, чаты
        left = QVBoxLayout()
        left.setSpacing(0)
        title_row = QHBoxLayout()
        self.title = QLabel(objectName="PageTitle")
        self.title.setWordWrap(True)
        title_row.addWidget(self.title, 1)
        self.more_btn = QToolButton(toolTip="Настройки проекта")
        self.more_btn.clicked.connect(self.project_settings)
        title_row.addWidget(self.more_btn, 0, Qt.AlignmentFlag.AlignTop)
        left.addLayout(title_row)
        self.description = QLabel(objectName="PageSubtitle")
        self.description.setWordWrap(True)
        left.addWidget(self.description)
        left.addSpacing(20)
        self.composer_slot = QVBoxLayout()
        left.addLayout(self.composer_slot)
        left.addSpacing(26)
        self.chats_box = QVBoxLayout()
        self.chats_box.setSpacing(0)
        left.addLayout(self.chats_box)
        left.addStretch()
        body.addLayout(left, 1)

        # ---- правая колонка: инструкции и файлы
        right_w = QWidget()
        right_w.setFixedWidth(320)
        right = QVBoxLayout(right_w)
        right.setContentsMargins(0, 0, 0, 0)
        right.setSpacing(14)

        self.instr_card = QFrame(objectName="SideCard")
        ic = QVBoxLayout(self.instr_card)
        ic.setContentsMargins(16, 12, 10, 14)
        head = QHBoxLayout()
        head.addWidget(QLabel("Инструкции", objectName="CardTitle"))
        head.addStretch()
        self.instr_btn = QToolButton(toolTip="Изменить инструкции")
        self.instr_btn.clicked.connect(self.edit_instructions)
        head.addWidget(self.instr_btn)
        ic.addLayout(head)
        self.instr_text = QLabel(objectName="CardDesc")
        self.instr_text.setWordWrap(True)
        self.instr_text.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
        ic.addWidget(self.instr_text)
        right.addWidget(self.instr_card)

        self.files_card = QFrame(objectName="SideCard")
        fc = QVBoxLayout(self.files_card)
        fc.setContentsMargins(16, 12, 10, 14)
        fc.setSpacing(6)
        head = QHBoxLayout()
        head.addWidget(QLabel("Файлы проекта", objectName="CardTitle"))
        head.addStretch()
        self.folder_btn = QToolButton(toolTip="Открыть папку проекта")
        self.folder_btn.clicked.connect(self.open_folder)
        head.addWidget(self.folder_btn)
        self.add_btn = QToolButton(toolTip="Добавить файлы")
        self.add_btn.clicked.connect(self.add_files)
        head.addWidget(self.add_btn)
        fc.addLayout(head)
        self.files_hint = QLabel(objectName="CardDesc")
        self.files_hint.setWordWrap(True)
        fc.addWidget(self.files_hint)
        self.files_list = QVBoxLayout()
        self.files_list.setSpacing(2)
        fc.addLayout(self.files_list)
        right.addWidget(self.files_card)
        right.addStretch()
        body.addWidget(right_w, 0, Qt.AlignmentFlag.AlignTop)

    def set_project(self, project: dict, chats: list[dict], files: list[Path], colors: dict):
        muted = colors["muted"]
        self.back_btn.setIcon(icons.icon("chevron-left", colors["accent"], 15))
        self.more_btn.setIcon(icons.icon("dots", muted, 18, hover=colors["text"]))
        self.instr_btn.setIcon(icons.icon("pen", muted, 16, hover=colors["text"]))
        self.add_btn.setIcon(icons.icon("plus", muted, 18, hover=colors["text"]))
        self.folder_btn.setIcon(icons.icon("external", muted, 16, hover=colors["text"]))

        self.title.setText(project["name"])
        self.description.setText(project.get("description", ""))
        self.description.setVisible(bool(project.get("description")))

        instr = project.get("instructions", "").strip()
        if instr:
            short = instr if len(instr) <= 280 else instr[:280].rstrip() + "…"
            self.instr_text.setText(short)
            self.instr_text.setObjectName("CardBody")
        else:
            self.instr_text.setText("Добавьте инструкции — например, стиль ответов или правила оформления кода.")
            self.instr_text.setObjectName("CardDesc")
        self.instr_text.style().unpolish(self.instr_text)
        self.instr_text.style().polish(self.instr_text)

        # файлы
        _clear(self.files_list)
        if files:
            total = sum(f.stat().st_size for f in files if f.exists())
            self.files_hint.setText(f"{len(files)} · {tools.human_size(total)} — агент видит их в каждом чате проекта")
        else:
            self.files_hint.setText("Добавьте документы, код или заметки — агент будет учитывать их "
                                    "в каждом чате проекта.")
        root = Path(project["folder"]).expanduser()
        for f in files:
            self.files_list.addWidget(_FileRow(f, root, colors, self.remove_file, self.open_file))

        # чаты
        _clear(self.chats_box)
        header = QLabel("Чаты проекта" if chats else "", objectName="SectionTitle")
        self.chats_box.addWidget(header)
        if not chats:
            empty = QLabel("Начните первый чат в этом проекте — напишите сообщение выше.", objectName="Muted")
            self.chats_box.addWidget(empty)
            return
        self.chats_box.addSpacing(8)
        for c in chats:
            row = Clickable("ChatCard")
            row.clicked.connect(lambda cid=c["id"]: self.open_chat.emit(cid))
            rl = QVBoxLayout(row)
            rl.setContentsMargins(14, 11, 14, 11)
            rl.setSpacing(2)
            rl.addWidget(QLabel(c["title"] or "Без названия", objectName="ChatCardTitle"))
            rl.addWidget(QLabel(f"Последнее сообщение {human_ago(c['updated'])}", objectName="CardMeta"))
            self.chats_box.addWidget(row)


class _FileRow(QFrame):
    def __init__(self, path: Path, root: Path, colors: dict, remove_signal, open_signal):
        super().__init__(objectName="FileRow")
        self.setAttribute(Qt.WidgetAttribute.WA_Hover)
        h = QHBoxLayout(self)
        h.setContentsMargins(6, 4, 2, 4)
        h.setSpacing(8)
        ic = QLabel()
        ic.setPixmap(icons.pixmap("file", colors["muted"], 15))
        h.addWidget(ic)
        name = QPushButton(path.name, objectName="FileName")
        name.setToolTip(str(path.relative_to(root)) if path.is_relative_to(root) else str(path))
        name.setCursor(Qt.CursorShape.PointingHandCursor)
        name.clicked.connect(lambda: open_signal.emit(str(path)))
        h.addWidget(name, 1)
        try:
            size = tools.human_size(path.stat().st_size)
        except OSError:
            size = ""
        h.addWidget(QLabel(size, objectName="CardMeta"))
        self.remove = QToolButton(objectName="RowAction", toolTip="Убрать из проекта")
        self.remove.setIcon(icons.icon("x", colors["muted"], 14, hover=colors["danger"]))
        self.remove.setIconSize(icons.qsize(14))
        self.remove.clicked.connect(lambda: remove_signal.emit(str(path)))
        self.remove.setVisible(False)
        h.addWidget(self.remove)

    def enterEvent(self, e):
        self.remove.setVisible(True)
        super().enterEvent(e)

    def leaveEvent(self, e):
        self.remove.setVisible(False)
        super().leaveEvent(e)

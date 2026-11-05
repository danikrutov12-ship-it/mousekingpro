"""Главное окно: боковая панель, чат, страницы проектов, композер, панель файлов."""

from __future__ import annotations

import base64
import getpass
import mimetypes
import shutil
import time
from pathlib import Path

from PySide6.QtCore import QDir, QEvent, Qt, QThread, QTimer, QUrl, Signal, Slot
from PySide6.QtGui import QAction, QActionGroup, QDesktopServices
from PySide6.QtWidgets import (
    QAbstractButton, QApplication, QFileDialog, QFileSystemModel, QFrame, QHBoxLayout, QInputDialog,
    QLabel, QListWidget, QListWidgetItem, QMainWindow, QMenu, QMessageBox, QPlainTextEdit, QPushButton,
    QSizePolicy, QSplitter, QStackedWidget, QTextBrowser, QToolButton, QTreeView, QVBoxLayout, QWidget,
)

from .. import tools
from ..agent import AgentThread, MediaThread
from ..api import MODEL_TYPES, VeniceAPI, image_price, money
from ..config import load_settings, save_settings
from ..storage import Store
from . import icons
from .chat_view import ChatView
from .chrome import EdgeGrips, TrafficLights, WindowMover, toggle_maximized
from .dialogs import ApprovalDialog, InstructionsDialog, ProjectDialog, SettingsDialog
from .media_options import MediaOptions
from .projects import ProjectPage, ProjectsPage
from .render import IMAGE_SUFFIXES, VIDEO_SUFFIXES, render_chat
from .theme import apply_theme
from .widgets import ChatRow, ModelPicker

MODES = {"text": ("chat", "Текст"), "image": ("image", "Изображение"), "video": ("video", "Видео")}
PLACEHOLDERS = {
    "text": "Чем могу помочь?",
    "image": "Опишите изображение…",
    "video": "Опишите видео…",
}
SUGGESTIONS = {
    "text": [("folder", "Разбери проект", "Разбери структуру этого проекта и кратко опиши, что где лежит"),
             ("pen", "Напиши скрипт", "Напиши скрипт на Python, который "),
             ("search", "Поищи в интернете", "Найди в интернете "),
             ("archive", "Изучи архив", "Изучи прикреплённый архив и расскажи, что внутри")],
    "image": [("image", "Закат над Венецией", "Закат над каналами Венеции, гондолы, масляная живопись"),
              ("image", "Кофейня в изометрии", "Уютная кофейня в изометрии, мягкий свет, 3D-рендер"),
              ("image", "Кот-астронавт", "Портрет кота-астронавта, кинематографичный свет, 85 мм")],
    "video": [("video", "Гондола на рассвете", "Гондола медленно плывёт по каналу на рассвете, туман"),
              ("video", "Дождь на стекле", "Капли дождя стекают по стеклу, макросъёмка, огни города"),
              ("video", "Пролёт над горами", "Камера пролетает над горными вершинами в облаках")],
}
ATTACH_ICONS = {"archive": "archive", "image": "image", "video": "video", "text": "file", "binary": "file",
                "folder": "folder"}
MAX_INLINE_TEXT = 100_000
COMPOSER_WIDTH = 780
PAGE_EMPTY, PAGE_CHAT, PAGE_PROJECTS, PAGE_PROJECT = range(4)


def _greeting(name: str) -> str:
    h = time.localtime().tm_hour
    if 5 <= h < 12:
        word = "Доброе утро"
    elif 12 <= h < 18:
        word = "Добрый день"
    elif 18 <= h < 23:
        word = "Добрый вечер"
    else:
        word = "Доброй ночи"
    return f"{word}, {name}"


def _day_group(ts: float) -> str:
    today = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1))
    if ts >= today:
        return "Сегодня"
    days = (today - ts) / 86400
    if days <= 1:
        return "Вчера"
    if days <= 7:
        return "Последние 7 дней"
    if days <= 30:
        return "Последние 30 дней"
    return "Ранее"


def _data_url(path: Path) -> str:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode()}"


def _centered(widget: QWidget, width: int = COMPOSER_WIDTH) -> QHBoxLayout:
    widget.setMaximumWidth(width)
    widget.setSizePolicy(QSizePolicy.Policy.Expanding, widget.sizePolicy().verticalPolicy())
    row = QHBoxLayout()
    row.setContentsMargins(0, 0, 0, 0)
    row.addStretch(1)
    row.addWidget(widget, 100)
    row.addStretch(1)
    return row


class ChatInput(QPlainTextEdit):
    submit = Signal()
    focus_changed = Signal(bool)

    def __init__(self):
        super().__init__()
        self.setObjectName("ComposerInput")
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.document().contentsChanged.connect(self._fit)
        self._fit()

    def _fit(self):
        lines = max(1, int(self.document().documentLayout().documentSize().height()))
        h = min(lines, 10) * self.fontMetrics().lineSpacing() + 14
        self.setFixedHeight(max(h, 50))

    def keyPressEvent(self, e):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and not (
                e.modifiers() & Qt.KeyboardModifier.ShiftModifier):
            self.submit.emit()
            return
        super().keyPressEvent(e)

    def focusInEvent(self, e):
        super().focusInEvent(e)
        self.focus_changed.emit(True)

    def focusOutEvent(self, e):
        super().focusOutEvent(e)
        self.focus_changed.emit(False)


class ModelsThread(QThread):
    done = Signal(dict, str)

    def __init__(self, settings: dict):
        super().__init__()
        self.api = VeniceAPI(settings["api_key"], settings["base_url"])

    def run(self):
        result, errors = {}, []
        for t in MODEL_TYPES:
            try:
                result[t] = self.api.list_models(t)
            except Exception as e:  # noqa: BLE001
                errors.append(f"{t}: {e}")
        self.done.emit(result, "; ".join(errors))


class CallThread(QThread):
    """Короткий запрос к Venice в фоне (баланс, цена видео): done(результат) или done(None)."""
    done = Signal(object)

    def __init__(self, fn):
        super().__init__()
        self.fn = fn

    def run(self):
        try:
            self.done.emit(self.fn())
        except Exception:  # noqa: BLE001 — цена и баланс необязательны
            self.done.emit(None)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Venice Agent")
        self.resize(1380, 880)
        self.setAcceptDrops(True)

        self.settings = load_settings()
        self.store = Store()
        self.default_project = self.store.default_project()
        self.user_name = getpass.getuser()
        self.colors: dict = {}
        self.models: dict[str, list[dict]] = {t: [] for t in MODEL_TYPES}
        self._mode = "text"
        self._model: dict | None = None
        self.project: dict = self.default_project
        self.chat: dict | None = None
        self.page = PAGE_EMPTY
        self.worker: QThread | None = None
        self.worker_chat: dict | None = None
        self.worker_project: dict | None = None
        self.stream_text = ""
        self.attachments: list[dict] = []
        self.auto_approve: set[str] = set()
        self.models_thread: ModelsThread | None = None
        self.calls: list[CallThread] = []  # живые фоновые запросы (баланс, цена)
        self.quote_seq = 0
        self.quote_timer = QTimer(self, singleShot=True, interval=500)
        self.quote_timer.timeout.connect(self._request_quote)
        # (виджет, иконка, цвет из палитры или #hex, размер) — перекрашиваются при смене темы
        self._icons: list[tuple[QWidget, str, str, int]] = []

        self.render_timer = QTimer(self, singleShot=True, interval=70)
        self.render_timer.timeout.connect(self.render)

        self.mover = WindowMover(self)
        self._build_ui()
        self.grips = EdgeGrips(self)
        self.picker = ModelPicker(self)
        self.picker.picked.connect(self.set_model)
        self.apply_frame()
        self.apply_theme()
        self._set_project(self.default_project)
        self.new_chat()
        self.on_mode_changed()
        if not self.settings["api_key"]:
            QTimer.singleShot(300, self.open_settings)
        else:
            self.refresh_models()

    # ================================================================ иконки

    def _ic(self, widget: QWidget, name: str, color: str = "muted", size: int = 18) -> QWidget:
        self._icons.append((widget, name, color, size))
        if isinstance(widget, QAbstractButton):
            widget.setIconSize(icons.qsize(size))
        if self.colors:
            self._paint_icon(widget, name, color, size)
        return widget

    def _paint_icon(self, widget, name, color, size):
        c = self.colors
        col = c.get(color, color)
        if isinstance(widget, QAbstractButton):
            widget.setIcon(icons.icon(name, col, size, hover=c["text"] if color == "muted" else col))
        elif isinstance(widget, QLabel):
            widget.setPixmap(icons.pixmap(name, col, size))

    def _repaint_icons(self):
        alive = []
        for entry in self._icons:
            try:
                self._paint_icon(*entry)
                alive.append(entry)
            except RuntimeError:  # виджет уже удалён
                continue
        self._icons = alive

    # ================================================================ построение UI

    def _build_ui(self):
        root = QSplitter()
        root.setHandleWidth(0)
        self.sidebar = self._build_sidebar()
        root.addWidget(self.sidebar)
        root.addWidget(self._build_center())
        root.addWidget(self._build_files_panel())
        root.setSizes([272, 1000, 0])
        root.setCollapsible(1, False)
        self.splitter = root
        self.setCentralWidget(root)
        self.files_panel.setVisible(bool(self.settings.get("files_panel", False)))
        self.files_btn.setChecked(self.files_panel.isVisible())
        self.set_sidebar(self.settings.get("sidebar", True))
        self._update_buttons()

    def _traffic_lights(self) -> TrafficLights:
        lights = TrafficLights()
        lights.close_clicked.connect(self.close)
        lights.minimize_clicked.connect(self.showMinimized)
        lights.zoom_clicked.connect(lambda: toggle_maximized(self))
        return lights

    def _build_sidebar(self) -> QWidget:
        side = QFrame(objectName="Sidebar")
        side.setMinimumWidth(230)
        side.setMaximumWidth(360)
        v = QVBoxLayout(side)
        v.setContentsMargins(10, 10, 10, 10)
        v.setSpacing(2)

        # шапка: «светофор» (в режиме macOS), знак, название, свернуть панель — за неё можно тянуть окно
        top = QWidget(objectName="DragArea")
        top.installEventFilter(self.mover)
        tl = QVBoxLayout(top)
        tl.setContentsMargins(6, 2, 0, 8)
        tl.setSpacing(10)
        lights_row = QHBoxLayout()
        self.side_lights = self._traffic_lights()
        lights_row.addWidget(self.side_lights)
        lights_row.addStretch()
        collapse = self._ic(QToolButton(toolTip="Скрыть боковую панель"), "panel-left", size=18)
        collapse.clicked.connect(lambda: self.set_sidebar(False))
        lights_row.addWidget(collapse)
        tl.addLayout(lights_row)
        brand = QHBoxLayout()
        brand.setSpacing(8)
        brand.addWidget(self._ic(QLabel(), "star", "accent", 20))
        brand.addWidget(QLabel("Venice Agent", objectName="Brand"))
        brand.addStretch()
        tl.addLayout(brand)
        v.addWidget(top)

        new_chat = QPushButton(objectName="NavButton")
        nl = QHBoxLayout(new_chat)
        nl.setContentsMargins(6, 0, 8, 0)
        nl.setSpacing(10)
        plus_box = QLabel(objectName="NewChatIcon", alignment=Qt.AlignmentFlag.AlignCenter)
        self._ic(plus_box, "plus", "#ffffff", 16)
        nl.addWidget(plus_box)
        nl.addWidget(QLabel("Новый чат"))
        nl.addStretch()
        new_chat.setMinimumHeight(40)
        new_chat.clicked.connect(lambda: self.new_chat())
        v.addWidget(new_chat)

        self.projects_nav = QPushButton(objectName="NavButton", checkable=True)
        pl = QHBoxLayout(self.projects_nav)
        pl.setContentsMargins(8, 0, 8, 0)
        pl.setSpacing(12)
        pl.addWidget(self._ic(QLabel(), "projects", "muted", 18))
        pl.addWidget(QLabel("Проекты"))
        pl.addStretch()
        self.projects_nav.setMinimumHeight(38)
        self.projects_nav.clicked.connect(self.show_projects)
        v.addWidget(self.projects_nav)

        v.addWidget(QLabel("Недавние", objectName="SectionLabel"))
        self.chat_list = QListWidget(objectName="ChatList")
        self.chat_list.itemClicked.connect(self.on_chat_clicked)
        self.chat_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.chat_list.customContextMenuRequested.connect(self.chat_menu)
        self.chat_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.chat_list.setVerticalScrollMode(QListWidget.ScrollMode.ScrollPerPixel)
        v.addWidget(self.chat_list, 1)

        user_row = QFrame(objectName="UserRow")
        ur = QHBoxLayout(user_row)
        ur.setContentsMargins(6, 10, 0, 0)
        ur.setSpacing(10)
        ur.addWidget(QLabel(self.user_name[:1].upper(), objectName="Avatar",
                            alignment=Qt.AlignmentFlag.AlignCenter))
        col = QVBoxLayout()
        col.setSpacing(0)
        col.addWidget(QLabel(self.user_name, objectName="UserName"))
        self.plan_label = QLabel("Venice API", objectName="Muted")
        col.addWidget(self.plan_label)
        ur.addLayout(col, 1)
        settings_btn = self._ic(QToolButton(toolTip="Настройки"), "sliders")
        settings_btn.clicked.connect(self.open_settings)
        ur.addWidget(settings_btn)
        v.addWidget(user_row)
        return side

    def _build_center(self) -> QWidget:
        center = QWidget(objectName="Center")
        v = QVBoxLayout(center)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)

        header = QFrame(objectName="Header")
        header.installEventFilter(self.mover)
        h = QHBoxLayout(header)
        h.setContentsMargins(14, 10, 12, 4)
        h.setSpacing(4)
        self.center_lights = self._traffic_lights()
        h.addWidget(self.center_lights)
        self.expand_btn = self._ic(QToolButton(toolTip="Показать боковую панель"), "panel-left")
        self.expand_btn.clicked.connect(lambda: self.set_sidebar(True))
        h.addWidget(self.expand_btn)
        h.addSpacing(6)
        self.crumb_btn = QPushButton(objectName="Crumb")
        self.crumb_btn.clicked.connect(lambda: self.open_project_page(self.project["id"]))
        h.addWidget(self.crumb_btn)
        self.crumb_sep = QLabel("/", objectName="CrumbSep")
        h.addWidget(self.crumb_sep)
        self.title_label = QLabel(objectName="ChatTitle")
        h.addWidget(self.title_label)
        h.addStretch()
        self.theme_btn = QToolButton(toolTip="Светлая / тёмная тема")
        self.theme_btn.setIconSize(icons.qsize(18))
        self.theme_btn.clicked.connect(self.toggle_theme)
        self.files_btn = self._ic(QToolButton(toolTip="Файлы проекта", checkable=True), "panel-right")
        self.files_btn.toggled.connect(self.toggle_files)
        h.addWidget(self.theme_btn)
        h.addWidget(self.files_btn)
        v.addWidget(header)

        self.composer = self._build_composer()
        self.composer_wrap = QWidget()
        self.composer_wrap.setLayout(_centered(self.composer))
        # композер не растягивается по высоте, даже если странице есть что ему отдать
        self.composer.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)
        self.composer_wrap.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum)

        self.stack = QStackedWidget()
        # --- PAGE_EMPTY: приветствие и композер по центру
        empty = QWidget()
        ev = QVBoxLayout(empty)
        ev.setContentsMargins(24, 0, 24, 0)
        ev.addStretch(3)
        greet = QHBoxLayout()
        greet.setSpacing(14)
        greet.addStretch()
        greet.addWidget(self._ic(QLabel(), "star", "accent", 34))
        self.greeting = QLabel(objectName="Greeting")
        greet.addWidget(self.greeting)
        greet.addStretch()
        ev.addLayout(greet)
        ev.addSpacing(26)
        self.empty_slot = QVBoxLayout()
        ev.addLayout(self.empty_slot)
        ev.addSpacing(14)
        self.suggest_box = QWidget()
        self.suggest_row = QHBoxLayout(self.suggest_box)
        self.suggest_row.setContentsMargins(0, 0, 0, 0)
        self.suggest_row.setSpacing(8)
        ev.addLayout(_centered(self.suggest_box))
        ev.addStretch(4)
        self.stack.addWidget(empty)

        # --- PAGE_CHAT: лента и композер снизу
        chat_page = QWidget()
        cv = QVBoxLayout(chat_page)
        cv.setContentsMargins(0, 0, 0, 8)
        cv.setSpacing(6)
        self.chat_view = ChatView()
        self.chat_view.link_clicked.connect(self.on_link)
        cv.addWidget(self.chat_view, 1)
        self.bottom_slot = QVBoxLayout()
        self.bottom_slot.setContentsMargins(24, 0, 24, 0)
        cv.addLayout(self.bottom_slot)
        cv.addWidget(QLabel("Модели могут ошибаться — проверяйте важное.", objectName="Disclaimer",
                            alignment=Qt.AlignmentFlag.AlignCenter))
        self.stack.addWidget(chat_page)

        # --- PAGE_PROJECTS и PAGE_PROJECT
        self.projects_page = ProjectsPage()
        self.projects_page.open_project.connect(self.open_project_page)
        self.projects_page.create_project.connect(self.new_project)
        self.stack.addWidget(self.projects_page)
        self.project_page = ProjectPage()
        self.project_page.back.connect(self.show_projects)
        self.project_page.open_chat.connect(lambda cid: self.open_chat(cid, self.project["id"]))
        self.project_page.edit_instructions.connect(self.edit_instructions)
        self.project_page.add_files.connect(self.add_project_files)
        self.project_page.remove_file.connect(self.remove_project_file)
        self.project_page.open_file.connect(lambda p: QDesktopServices.openUrl(QUrl.fromLocalFile(p)))
        self.project_page.project_settings.connect(self.edit_project)
        self.project_page.open_folder.connect(
            lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.store.knowledge_dir(self.project)))))
        self.stack.addWidget(self.project_page)

        v.addWidget(self.stack, 1)
        return center

    def _build_composer(self) -> QFrame:
        box = QFrame(objectName="Composer")
        v = QVBoxLayout(box)
        v.setContentsMargins(18, 14, 10, 10)
        v.setSpacing(8)

        self.chips_box = QWidget()
        self.chips_row = QHBoxLayout(self.chips_box)
        self.chips_row.setContentsMargins(0, 0, 0, 0)
        self.chips_row.setSpacing(6)
        v.addWidget(self.chips_box)

        self.options = MediaOptions()
        self.options.setObjectName("Options")
        self.options.changed.connect(self.update_price)
        v.addWidget(self.options)

        self.input = ChatInput()
        self.input.submit.connect(self.send)
        self.input.focus_changed.connect(self._composer_focus)
        v.addWidget(self.input)

        row = QHBoxLayout()
        row.setSpacing(6)
        attach = self._ic(QToolButton(objectName="Attach", toolTip="Прикрепить файлы или архивы"), "plus", size=20)
        attach.clicked.connect(self.pick_files)
        row.addWidget(attach)

        self.mode_btn = QToolButton(objectName="Pill")
        self.mode_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        self.mode_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.mode_btn.setIconSize(icons.qsize(16))
        self.mode_menu = QMenu(self)
        group = QActionGroup(self)
        self.mode_actions: dict[str, QAction] = {}
        for key, (_, label) in MODES.items():
            act = QAction(label, self, checkable=True, checked=key == "text")
            act.triggered.connect(lambda _=False, k=key: self.set_mode(k))
            group.addAction(act)
            self.mode_menu.addAction(act)
            self.mode_actions[key] = act
        self.mode_btn.setMenu(self.mode_menu)
        row.addWidget(self.mode_btn)

        self.status = QLabel(objectName="Status")
        self.status.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        row.addSpacing(4)
        row.addWidget(self.status, 1)

        self.price_label = QLabel(objectName="Price", toolTip="Сколько спишет Venice за эту генерацию")
        self.price_label.hide()
        row.addWidget(self.price_label)

        self.model_btn = QToolButton(objectName="ModelPill")
        self.model_btn.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
        self.model_btn.setLayoutDirection(Qt.LayoutDirection.RightToLeft)  # стрелка справа от названия
        self._ic(self.model_btn, "chevron-down", size=15)
        self.model_btn.clicked.connect(self.open_model_picker)
        row.addWidget(self.model_btn)

        self.send_btn = self._ic(QToolButton(objectName="Send", toolTip="Отправить (Enter)"), "arrow-up", "#ffffff", 19)
        self.send_btn.clicked.connect(self.send)
        self.stop_btn = self._ic(QToolButton(objectName="Stop", toolTip="Остановить"), "stop", "bg", 18)
        self.stop_btn.clicked.connect(self.stop)
        row.addWidget(self.send_btn)
        row.addWidget(self.stop_btn)
        v.addLayout(row)
        self._update_chips()
        return box

    def _build_files_panel(self) -> QWidget:
        panel = QFrame(objectName="FilesPanel")
        panel.setMinimumWidth(260)
        self.files_panel = panel
        v = QVBoxLayout(panel)
        v.setContentsMargins(12, 12, 12, 12)
        top = QHBoxLayout()
        top.addWidget(QLabel("Папка проекта", objectName="PanelTitle"))
        top.addStretch()
        open_folder = self._ic(QToolButton(toolTip="Открыть папку в файловом менеджере"), "external", size=16)
        open_folder.clicked.connect(lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(self.project["folder"])))
        top.addWidget(open_folder)
        close = self._ic(QToolButton(toolTip="Скрыть панель"), "x", size=16)
        close.clicked.connect(lambda: self.files_btn.setChecked(False))
        top.addWidget(close)
        v.addLayout(top)
        self.folder_label = QLabel(objectName="Muted")
        self.folder_label.setWordWrap(True)
        v.addWidget(self.folder_label)

        split = QSplitter(Qt.Orientation.Vertical)
        self.fs_model = QFileSystemModel()
        self.fs_model.setFilter(QDir.Filter.AllEntries | QDir.Filter.NoDotAndDotDot | QDir.Filter.Hidden)
        self.tree = QTreeView()
        self.tree.setModel(self.fs_model)
        for col in (1, 2, 3):
            self.tree.hideColumn(col)
        self.tree.setHeaderHidden(True)
        self.tree.clicked.connect(self.preview_file)
        self.tree.doubleClicked.connect(
            lambda idx: QDesktopServices.openUrl(QUrl.fromLocalFile(self.fs_model.filePath(idx))))
        self.tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.tree.customContextMenuRequested.connect(self.tree_menu)
        self.preview = QTextBrowser(objectName="Preview")
        self.preview.setLineWrapMode(QTextBrowser.LineWrapMode.NoWrap)
        self.preview.setPlaceholderText("Выберите файл для предпросмотра")
        split.addWidget(self.tree)
        split.addWidget(self.preview)
        split.setSizes([480, 280])
        v.addWidget(split, 1)
        return panel

    # ================================================================ окно, тема и панели

    def apply_frame(self):
        """Окно в стиле macOS: без системной рамки, «светофор» в углу."""
        mac = bool(self.settings.get("mac_frame", True))
        was_visible = self.isVisible()
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint, mac)
        self.mover.enabled = self.grips.enabled = mac
        self.grips.update()
        self._update_lights()
        if was_visible:
            self.show()

    def _update_lights(self):
        mac = bool(self.settings.get("mac_frame", True))
        sidebar = self.sidebar.isVisible() if self.isVisible() else self.settings.get("sidebar", True)
        self.side_lights.setVisible(mac)
        self.center_lights.setVisible(mac and not sidebar)

    def changeEvent(self, e):
        if e.type() == QEvent.Type.ActivationChange and hasattr(self, "side_lights"):
            self.side_lights.update()
            self.center_lights.update()
        elif e.type() == QEvent.Type.WindowStateChange and hasattr(self, "grips"):
            self.grips.update()
        super().changeEvent(e)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        if hasattr(self, "grips"):
            self.grips.update()

    def apply_theme(self):
        name = self.settings.get("theme", "light")
        self.colors = apply_theme(QApplication.instance(), name)
        self.side_lights.dark = self.center_lights.dark = name == "dark"
        self._repaint_icons()
        self.theme_btn.setIcon(icons.icon("moon" if name == "light" else "sun", self.colors["muted"], 18,
                                          hover=self.colors["text"]))
        self._update_mode_button()
        self.chat_view.set_theme(self.colors, dark=name == "dark")
        self._update_suggestions()
        self._update_chips()
        self._refresh_chat_list()
        if self.page == PAGE_PROJECTS:
            self.show_projects()
        elif self.page == PAGE_PROJECT:
            self.open_project_page(self.project["id"])
        else:
            self.render()

    def toggle_theme(self):
        self.settings["theme"] = "dark" if self.settings.get("theme", "light") == "light" else "light"
        save_settings(self.settings)
        self.apply_theme()

    def set_sidebar(self, visible: bool):
        self.sidebar.setVisible(visible)
        self.expand_btn.setVisible(not visible)
        self.settings["sidebar"] = visible
        save_settings(self.settings)
        self._update_lights()

    def toggle_files(self, on: bool):
        self.files_panel.setVisible(on)
        if on:
            sizes = self.splitter.sizes()
            if sizes[2] < 200:
                self.splitter.setSizes([sizes[0], max(500, sizes[1] - 340), 340])
        self.settings["files_panel"] = on
        save_settings(self.settings)

    def _composer_focus(self, on: bool):
        self.composer.setProperty("focused", on)
        self.composer.style().unpolish(self.composer)
        self.composer.style().polish(self.composer)

    def _show_page(self, page: int):
        """Переключает страницу; композер один — переезжает туда, где он нужен."""
        self.page = page
        slot = {PAGE_EMPTY: self.empty_slot, PAGE_CHAT: self.bottom_slot,
                PAGE_PROJECT: self.project_page.composer_slot}.get(page)
        if slot is not None and slot.indexOf(self.composer_wrap) < 0:
            slot.addWidget(self.composer_wrap)  # Qt сам убирает виджет из прежнего layout
        self.stack.setCurrentIndex(page)
        self.projects_nav.setChecked(page in (PAGE_PROJECTS, PAGE_PROJECT))
        self._update_title()

    def _update_suggestions(self):
        while self.suggest_row.count():
            item = self.suggest_row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.suggest_row.addStretch()
        for icon_name, label, prompt in SUGGESTIONS[self._mode]:
            b = QPushButton(label, objectName="Suggestion")
            if self.colors:
                b.setIcon(icons.icon(icon_name, self.colors["muted"], 16))
                b.setIconSize(icons.qsize(16))
            b.clicked.connect(lambda _=False, t=prompt: self._use_suggestion(t))
            self.suggest_row.addWidget(b)
        self.suggest_row.addStretch()

    def _use_suggestion(self, text: str):
        self.input.setPlainText(text)
        self.input.setFocus()
        cursor = self.input.textCursor()
        cursor.movePosition(cursor.MoveOperation.End)
        self.input.setTextCursor(cursor)

    # ================================================================ проекты

    def _set_project(self, project: dict):
        """Текущий проект: от него зависят папка агента и панель файлов."""
        self.project = project
        folder = Path(project["folder"]).expanduser()
        folder.mkdir(parents=True, exist_ok=True)
        self.folder_label.setText(str(folder))
        self.fs_model.setRootPath(str(folder))
        self.tree.setRootIndex(self.fs_model.index(str(folder)))

    def show_projects(self):
        self.projects_page.set_projects(self.store.user_projects(), self.colors)
        self._show_page(PAGE_PROJECTS)

    def open_project_page(self, project_id: str):
        project = self.store.project(project_id)
        if project is None:
            self.show_projects()
            return
        if project.get("default"):
            self.new_chat()
            return
        if self.project["id"] != project["id"]:
            self.clear_attachments()
        self._set_project(project)
        # новый чат этого проекта начнётся из композера на странице проекта
        if not (self.chat and not self.chat["messages"] and self.chat.get("_project") == project["id"]):
            self.chat = self.store.new_chat()
            self.chat["_project"] = project["id"]
        self.project_page.set_project(project, self.store.chats(project["id"]),
                                      self.store.knowledge_files(project), self.colors)
        self._show_page(PAGE_PROJECT)
        self.chat_list.clearSelection()
        self.input.setFocus()

    def new_project(self):
        dlg = ProjectDialog(parent=self)
        if dlg.exec():
            v = dlg.values()
            p = self.store.create_project(v["name"], v["folder"], description=v["description"])
            self.open_project_page(p["id"])

    def edit_project(self):
        if self.project.get("default"):
            return
        dlg = ProjectDialog(self.project, self)
        if not dlg.exec():
            return
        if dlg.delete_requested:
            if QMessageBox.question(
                    self, "Удалить проект",
                    f"Удалить проект «{self.project['name']}» и все его чаты?\n"
                    f"Файлы в папке {self.project['folder']} останутся на месте.") \
                    == QMessageBox.StandardButton.Yes:
                if self.worker_project and self.worker_project["id"] == self.project["id"]:
                    QMessageBox.information(self, "Проект занят", "Сначала остановите агента в чате этого проекта.")
                    return
                self.store.delete_project(self.project["id"])
                self._set_project(self.default_project)
                self._refresh_chat_list()
                self.show_projects()
            return
        self.project.update(dlg.values())
        Path(self.project["folder"]).expanduser().mkdir(parents=True, exist_ok=True)
        self.store.save_project(self.project)
        self._refresh_chat_list()
        self.open_project_page(self.project["id"])

    def edit_instructions(self):
        dlg = InstructionsDialog(self.project["name"], self.project.get("instructions", ""), self)
        if dlg.exec():
            self.project["instructions"] = dlg.value()
            self.store.save_project(self.project)
            self.open_project_page(self.project["id"])

    def add_project_files(self):
        paths, _ = QFileDialog.getOpenFileNames(self, "Добавить файлы в проект", str(Path.home()))
        if not paths:
            return
        target = self.store.knowledge_dir(self.project)
        target.mkdir(parents=True, exist_ok=True)
        for src in map(Path, paths):
            dest, n = target / src.name, 1
            while dest.exists():
                dest, n = target / f"{src.stem}_{n}{src.suffix}", n + 1
            shutil.copy2(src, dest)
        self.open_project_page(self.project["id"])

    def remove_project_file(self, path: str):
        p = Path(path)
        if not p.is_relative_to(self.store.knowledge_dir(self.project)):
            return
        if QMessageBox.question(self, "Убрать файл", f"Убрать «{p.name}» из проекта?\nКопия файла в папке "
                                                    f"проекта будет удалена, оригинал останется на месте.") \
                == QMessageBox.StandardButton.Yes:
            p.unlink(missing_ok=True)
            self.open_project_page(self.project["id"])

    # ================================================================ чаты

    def _refresh_chat_list(self):
        self.chat_list.clear()
        if not self.colors:
            return
        chats = self.store.all_chats()
        if not chats:
            item = QListWidgetItem()
            item.setFlags(Qt.ItemFlag.NoItemFlags)
            label = QLabel("Здесь появятся ваши чаты", objectName="EmptyChats")
            item.setSizeHint(label.sizeHint())
            self.chat_list.addItem(item)
            self.chat_list.setItemWidget(item, label)
            return
        trash = icons.icon("trash", self.colors["muted"], 15, hover=self.colors["danger"])
        group = None
        for c in chats:
            g = _day_group(c["updated"])
            if g != group:
                group = g
                header = QListWidgetItem()
                header.setFlags(Qt.ItemFlag.NoItemFlags)
                label = QLabel(g, objectName="GroupHeader")
                header.setSizeHint(label.sizeHint())
                self.chat_list.addItem(header)
                self.chat_list.setItemWidget(header, label)
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, (c["id"], c["project_id"]))
            row = ChatRow(c["id"], c["title"] or "Без названия", trash)
            if c.get("project_name"):
                row.setToolTip(f"{c['title']}\nПроект: {c['project_name']}")
            row.delete_clicked.connect(lambda cid, pid=c["project_id"]: self.delete_chat(cid, pid))
            item.setSizeHint(row.sizeHint())
            self.chat_list.addItem(item)
            self.chat_list.setItemWidget(item, row)
            if self.page == PAGE_CHAT and self.chat and c["id"] == self.chat["id"]:
                item.setSelected(True)

    def new_chat(self, project: dict | None = None):
        self._set_project(project or self.default_project)
        self.chat = self.store.new_chat()
        self.clear_attachments()
        self._show_page(PAGE_EMPTY)
        self.render()
        self._refresh_chat_list()
        self.input.setFocus()

    def open_chat(self, chat_id: str, project_id: str):
        if self.worker_chat and self.worker_chat["id"] == chat_id:
            self.chat = self.worker_chat
            project = self.worker_project
        else:
            project = self.store.project(project_id)
            try:
                self.chat = self.store.load_chat(project_id, chat_id)
            except (OSError, ValueError) as e:
                QMessageBox.warning(self, "Ошибка", f"Не удалось открыть чат: {e}")
                return
        if project is None:
            return
        if self.project["id"] != project["id"]:
            self.clear_attachments()
        self._set_project(project)
        self._show_page(PAGE_CHAT)
        self._refresh_chat_list()
        self.render(force_bottom=True)

    def on_chat_clicked(self, item: QListWidgetItem):
        data = item.data(Qt.ItemDataRole.UserRole)
        if data:
            self.open_chat(*data)

    def delete_chat(self, chat_id: str, project_id: str):
        if self.worker_chat and self.worker_chat["id"] == chat_id:
            QMessageBox.information(self, "Чат занят", "Сначала остановите агента в этом чате.")
            return
        title = next((c["title"] for c in self.store.chats(project_id) if c["id"] == chat_id), "")
        if QMessageBox.question(self, "Удалить чат", f"Удалить «{title}»?") != QMessageBox.StandardButton.Yes:
            return
        self.store.delete_chat(project_id, chat_id)
        if self.chat and self.chat["id"] == chat_id:
            self.new_chat()
        else:
            self._refresh_chat_list()
            if self.page == PAGE_PROJECT:
                self.open_project_page(self.project["id"])

    def chat_menu(self, pos):
        item = self.chat_list.itemAt(pos)
        data = item.data(Qt.ItemDataRole.UserRole) if item else None
        if not data:
            return
        chat_id, project_id = data
        muted = self.colors["muted"]
        menu = QMenu(self)
        rename = menu.addAction(icons.icon("pen", muted, 16), "Переименовать")
        delete = menu.addAction(icons.icon("trash", muted, 16), "Удалить")
        action = menu.exec(self.chat_list.mapToGlobal(pos))
        if action == rename:
            chat = self.store.load_chat(project_id, chat_id)
            title, ok = QInputDialog.getText(self, "Переименовать чат", "Название:", text=chat["title"])
            if ok and title.strip():
                chat["title"] = title.strip()
                self.store.save_chat(project_id, chat)
                if self.chat and self.chat["id"] == chat_id:
                    self.chat["title"] = chat["title"]
                self._refresh_chat_list()
                self._update_title()
        elif action == delete:
            self.delete_chat(chat_id, project_id)

    def _save_chat(self, chat: dict, project: dict):
        self.store.save_chat(project["id"], chat)
        self._refresh_chat_list()

    def _update_title(self):
        in_chat = self.page == PAGE_CHAT and self.chat and self.chat["messages"]
        title = self.chat["title"] if in_chat else ""
        crumb = in_chat and not self.project.get("default")
        self.crumb_btn.setText(self.project["name"] if crumb else "")
        self.crumb_btn.setVisible(bool(crumb))
        self.crumb_sep.setVisible(bool(crumb))
        self.title_label.setText(title)
        self.setWindowTitle(f"{title} — Venice Agent" if title else "Venice Agent")

    def render(self, force_bottom: bool = False):
        if not self.chat or self.page not in (PAGE_EMPTY, PAGE_CHAT):
            return
        empty = not self.chat["messages"]
        if (self.page == PAGE_EMPTY) != empty:
            self._show_page(PAGE_EMPTY if empty else PAGE_CHAT)
        self._update_title()
        if empty:
            self.greeting.setText(_greeting(self.user_name.capitalize()))
            return
        busy = self.worker is not None and self.worker_chat is self.chat
        streaming = self.stream_text if busy else None
        label = "Думаю…" if isinstance(self.worker, AgentThread) else "Генерирую…"
        self.chat_view.set_content(render_chat(self.chat["messages"], streaming, label), force_bottom)

    def schedule_render(self):
        if not self.render_timer.isActive():
            self.render_timer.start()

    def on_link(self, url: QUrl):
        QDesktopServices.openUrl(url)

    # ================================================================ режимы и модели

    @property
    def mode(self) -> str:
        return self._mode

    def set_mode(self, mode: str):
        self._mode = mode
        self.on_mode_changed()

    def _update_mode_button(self):
        icon_name, label = MODES[self._mode]
        self.mode_btn.setText(label)
        if self.colors:
            self.mode_btn.setIcon(icons.icon(icon_name, self.colors["muted"], 16, hover=self.colors["text"]))
            for key, act in self.mode_actions.items():
                act.setIcon(icons.icon(MODES[key][0], self.colors["muted"], 16))
        self.mode_actions[self._mode].setChecked(True)

    def current_model(self) -> dict | None:
        return self._model

    def _models_for_mode(self) -> list[dict]:
        saved = self.settings.get(f"{self._mode}_model", "")
        models = list(self.models.get(self._mode) or [])
        if saved and not any(m["id"] == saved for m in models):
            models.insert(0, {"id": saved, "name": saved, "constraints": {}})
        return models

    def refresh_models(self):
        if not self.settings["api_key"] or (self.models_thread and self.models_thread.isRunning()):
            return
        self.status.setText("Загружаю модели…")
        self.models_thread = ModelsThread(self.settings)
        self.models_thread.done.connect(self.on_models_loaded)
        self.models_thread.start()

    def on_models_loaded(self, models: dict, errors: str):
        for t in MODEL_TYPES:
            if models.get(t):
                self.models[t] = models[t]
        total = sum(len(v) for v in self.models.values())
        self.plan_label.setText(f"Venice API · {total} моделей" if total else "Venice API")
        self.status.setText("⚠ Не удалось загрузить часть моделей" if errors else "")
        self.status.setToolTip(errors)
        self.on_mode_changed()
        self.refresh_balance()

    def on_mode_changed(self):
        self._update_mode_button()
        models = self._models_for_mode()
        saved = self.settings.get(f"{self._mode}_model", "")
        model = next((m for m in models if m["id"] == saved), models[0] if models else None)
        self.input.setPlaceholderText(PLACEHOLDERS[self._mode])
        self._update_suggestions()
        self.set_model(model)

    def open_model_picker(self):
        models = self._models_for_mode()
        if not models:
            QMessageBox.information(self, "Модели", "Список моделей пуст — проверьте API-ключ в настройках.")
            return
        self.picker.open(models, self._mode, (self._model or {}).get("id", ""), self.model_btn, self.colors)

    def set_model(self, model: dict | None):
        self._model = model
        mode = self._mode
        if model:
            self.settings[f"{mode}_model"] = model["id"]
            save_settings(self.settings)
            self.model_btn.setText(model["name"])
            tip = model["id"]
            if mode == "text":
                tm = self.settings["tool_mode"]
                native = tm == "native" or (tm == "auto" and model.get("tools"))
                tip += "\nИнструменты: " + ("нативные" if native else "текстовый протокол")
            self.model_btn.setToolTip(tip)
        else:
            self.model_btn.setText("Выбрать модель")
        self.options.set_model(mode, model)

    # ================================================================ вложения

    def pick_files(self):
        paths, _ = QFileDialog.getOpenFileNames(self, "Прикрепить файлы", str(Path.home()))
        self.add_attachments([Path(p) for p in paths])

    def dragEnterEvent(self, e):
        if e.mimeData().hasUrls():
            e.acceptProposedAction()

    def dropEvent(self, e):
        self.add_attachments([Path(u.toLocalFile()) for u in e.mimeData().urls() if u.isLocalFile()])

    def add_attachments(self, paths: list[Path]):
        if not paths:
            return
        root = Path(self.project["folder"]).expanduser().resolve()
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            for src in paths:
                try:
                    self.attachments.append(self._prepare_attachment(src.resolve(), root))
                except Exception as e:  # noqa: BLE001
                    QMessageBox.warning(self, "Вложение", f"{src.name}: {e}")
        finally:
            QApplication.restoreOverrideCursor()
        self._update_chips()
        self.input.setFocus()

    def _prepare_attachment(self, src: Path, root: Path) -> dict:
        if src.is_dir():
            return {"kind": "folder", "name": src.name + "/", "path": str(src)}
        if src.is_relative_to(root):
            dest = src
        else:
            uploads = root / "uploads"
            uploads.mkdir(exist_ok=True)
            dest = uploads / src.name
            n = 1
            while dest.exists():
                dest = uploads / f"{src.stem}_{n}{src.suffix}"
                n += 1
            shutil.copy2(src, dest)
        att = {"name": src.name, "path": str(dest), "rel": str(dest.relative_to(root))
               if dest.is_relative_to(root) else str(dest), "size": dest.stat().st_size}
        suffix = dest.suffix.lower()
        if tools.is_archive(dest):
            target = tools.default_extract_dir(dest)
            count = tools.extract(dest, target)
            att.update(kind="archive", extracted=str(target.relative_to(root)) if target.is_relative_to(root)
                       else str(target), count=count, tree=tools.tree_preview(target, 80))
        elif suffix in IMAGE_SUFFIXES:
            att["kind"] = "image"
        elif suffix in VIDEO_SUFFIXES:
            att["kind"] = "video"
        else:
            data = dest.read_bytes()[: MAX_INLINE_TEXT + 1]
            if b"\0" in data[:8192]:
                att["kind"] = "binary"
            else:
                att["kind"] = "text"
                att["truncated"] = len(data) > MAX_INLINE_TEXT
                att["text"] = data[:MAX_INLINE_TEXT].decode("utf-8", errors="replace")
        return att

    def _update_chips(self):
        while self.chips_row.count():
            item = self.chips_row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for i, a in enumerate(self.attachments):
            chip = QToolButton(objectName="ChipBtn", text=f"{a['name']}   ✕", toolTip="Убрать вложение")
            chip.setToolButtonStyle(Qt.ToolButtonStyle.ToolButtonTextBesideIcon)
            if self.colors:
                chip.setIcon(icons.icon(ATTACH_ICONS[a["kind"]], self.colors["muted"], 15))
                chip.setIconSize(icons.qsize(15))
            chip.clicked.connect(lambda _=False, idx=i: self.remove_attachment(idx))
            self.chips_row.addWidget(chip)
        self.chips_row.addStretch()
        self.chips_box.setVisible(bool(self.attachments))

    def remove_attachment(self, index: int):
        if 0 <= index < len(self.attachments):
            del self.attachments[index]
        self._update_chips()

    def clear_attachments(self):
        self.attachments = []
        self._update_chips()

    def _attachment_notes(self) -> str:
        notes = []
        for a in self.attachments:
            kind = a["kind"]
            if kind == "text":
                more = "\n[файл обрезан — дочитай через read_file]" if a["truncated"] else ""
                notes.append(f'<file path="{a["rel"]}">\n{a["text"]}{more}\n</file>')
            elif kind == "archive":
                notes.append(f"[Архив {a['name']} сохранён как {a['rel']} и распакован в {a['extracted']}/ "
                             f"({a['count']} файлов):\n{a['tree']}]")
            elif kind == "folder":
                notes.append(f"[Пользователь указал папку: {a['path']}]")
            elif kind == "image":
                notes.append(f"[Прикреплено изображение: {a['rel']}]")
            else:
                notes.append(f"[Прикреплён файл: {a['rel']} ({tools.human_size(a['size'])})]")
        return "\n\n".join(notes)

    # ================================================================ отправка

    def _update_buttons(self):
        busy = self.worker is not None
        self.send_btn.setVisible(not busy)
        self.stop_btn.setVisible(busy)

    def send(self):
        if self.worker is not None or not self.chat:
            return
        if not self.settings["api_key"]:
            self.open_settings()
            return
        text = self.input.toPlainText().strip()
        if not text and not self.attachments:
            return
        model = self.current_model()
        if model is None:
            QMessageBox.information(self, "Модель", "Выберите модель в поле ввода (список обновляется из Venice).")
            return
        if self.mode == "text":
            self._send_text(text, model)
        else:
            self._send_media(text, model)

    def _start_chat_message(self, msg: dict, title_text: str):
        if not self.chat["messages"]:
            self.chat["title"] = (title_text or "Вложения").splitlines()[0][:60]
        self.chat.pop("_project", None)
        self.chat["messages"].append(msg)
        self._save_chat(self.chat, self.project)
        self.input.clear()
        self.clear_attachments()
        self.worker_chat, self.worker_project = self.chat, self.project
        self.stream_text = ""
        self._show_page(PAGE_CHAT)
        self._refresh_chat_list()

    def _start_worker(self, worker: QThread):
        self.worker = worker
        self._update_buttons()
        worker.finished.connect(self.on_worker_finished)
        worker.start()
        self.render(force_bottom=True)

    def _send_text(self, text: str, model: dict):
        notes = self._attachment_notes()
        content = (text + ("\n\n" + notes if notes else "")).strip()
        images = [a for a in self.attachments if a["kind"] == "image"]
        if images and model.get("vision"):
            content = [{"type": "text", "text": content}] + [
                {"type": "image_url", "image_url": {"url": _data_url(Path(a["path"]))}} for a in images]
        msg = {"role": "user", "content": content, "_display": text}
        if self.attachments:
            msg["_attachments"] = [a["name"] for a in self.attachments]
        self._start_chat_message(msg, text)

        worker = AgentThread(self.settings, self.project, self.chat["messages"], model,
                             auto_approve=self.chat["id"] in self.auto_approve,
                             search_model=self._search_model(model))
        worker.text_delta.connect(self.on_text_delta)
        worker.message_added.connect(self.on_message_added)
        worker.status.connect(self.status.setText)
        worker.approval_needed.connect(self.on_approval, Qt.ConnectionType.BlockingQueuedConnection)
        worker.failed.connect(self.on_failed)
        self._start_worker(worker)

    def _send_media(self, text: str, model: dict):
        kind = self.mode
        params = {"model": model["id"], **self.options.params()}
        if text:
            params["prompt"] = text
        images = [a for a in self.attachments if a["kind"] == "image"]
        videos = [a for a in self.attachments if a["kind"] == "video"]
        if kind == "image":
            if not text:
                QMessageBox.information(self, "Промпт", "Опишите изображение.")
                return
            params["safe_mode"] = bool(self.settings["safe_mode"])
        else:
            mtype = self.options.model_type
            if images:
                params["image_url"] = _data_url(Path(images[0]["path"]))
            if videos:
                params["video_url"] = _data_url(Path(videos[0]["path"]))
            if mtype == "image-to-video" and not images:
                QMessageBox.information(self, "Нужна картинка", "Эта модель делает видео из изображения — прикрепите его (＋).")
                return
            if mtype == "video" and not videos:
                QMessageBox.information(self, "Нужно видео", "Эта модель обрабатывает видео — прикрепите видеофайл (＋).")
                return
        label = MODES[kind][1]
        shown = {k: v for k, v in params.items() if k not in ("model", "prompt", "image_url", "video_url")}
        msg = {"role": "user", "content": f"[{label} · {model['name']}] {text}", "_display": text,
               "_mode": f"{label} · {model['name']} · " + ", ".join(f"{k}={v}" for k, v in shown.items())}
        if self.attachments:
            msg["_attachments"] = [a["name"] for a in self.attachments]
        self._start_chat_message(msg, text)

        out_dir = Path(self.project["folder"]).expanduser() / "generated"
        worker = MediaThread(self.settings, kind, params, out_dir, model)
        worker.status.connect(self.status.setText)
        worker.done.connect(self.on_media_done)
        worker.failed.connect(self.on_failed)
        self._start_worker(worker)

    def _search_model(self, model: dict) -> str | None:
        """Модель для инструмента web_search: текущая, если умеет искать, иначе первая подходящая."""
        if model.get("web_search"):
            return model["id"]
        return next((m["id"] for m in self.models["text"] if m.get("web_search")), None)

    def stop(self):
        if self.worker is not None:
            self.worker.stop()
            self.status.setText("Останавливаю…")

    # ================================================================ события от потоков

    def _worker_append(self, msg: dict):
        chat, project = self.worker_chat, self.worker_project
        if chat is None or project is None:
            return
        chat["messages"].append(msg)
        self._save_chat(chat, project)
        if chat is self.chat:
            self.schedule_render()

    @Slot(str)
    def on_text_delta(self, delta: str):
        self.stream_text += delta
        if self.worker_chat is self.chat:
            self.schedule_render()

    @Slot(dict)
    def on_message_added(self, msg: dict):
        if msg["role"] == "assistant":
            self.stream_text = ""
        self._worker_append(msg)

    @Slot(list, object)
    def on_media_done(self, paths: list, cost):
        root = Path(self.worker_project["folder"]).expanduser()
        rel = [str(Path(p).relative_to(root)) if Path(p).is_relative_to(root) else p for p in paths]
        msg = {"role": "assistant", "content": "Готово — сохранено в " + ", ".join(rel), "_media": paths}
        if cost is not None:
            msg["_cost"] = cost
        self._worker_append(msg)

    @Slot(str)
    def on_failed(self, error: str):
        self._worker_append({"role": "assistant", "content": error, "_error": True})

    @Slot(str, str)
    def on_approval(self, title: str, details: str):
        dlg = ApprovalDialog(title, details, self, theme=self.settings.get("theme", "light"))
        dlg.exec()
        if self.worker is not None:
            self.worker.approval_result = dlg.result_value
        if dlg.result_value == "always" and self.worker_chat:
            self.auto_approve.add(self.worker_chat["id"])

    def on_worker_finished(self):
        self.worker = None
        self.stream_text = ""
        self.worker_chat = self.worker_project = None
        self._update_buttons()
        if not self.status.text().startswith("⚠"):
            self.status.setText("")
        self.render()
        self.refresh_balance()

    # ================================================================ деньги

    def _call(self, fn, on_done) -> None:
        thread = CallThread(fn)
        thread.done.connect(on_done)
        thread.finished.connect(lambda t=thread: self.calls.remove(t) if t in self.calls else None)
        self.calls.append(thread)
        thread.start()

    def refresh_balance(self):
        if not self.settings["api_key"]:
            return
        api = VeniceAPI(self.settings["api_key"], self.settings["base_url"])
        self._call(api.balance, self.on_balance)

    @Slot(object)
    def on_balance(self, balances):
        if not balances:
            return
        usd_left, diem = float(balances.get("USD") or 0), float(balances.get("DIEM") or 0)
        text = f"Баланс {money(usd_left)}" + (f" · {diem:g} DIEM" if diem else "")
        self.plan_label.setText(text)
        self.plan_label.setToolTip("Остаток на счету Venice API. Пополнить: venice.ai/settings/api")

    def update_price(self):
        """Цена генерации до отправки: картинки считаем по прайсу модели, видео спрашиваем у Venice."""
        model = self.current_model()
        self.quote_seq += 1
        if self._mode == "image" and model:
            price = image_price(model, self.options.params())
            self._show_price(price)
        elif self._mode == "video" and model and self.settings["api_key"]:
            self.price_label.setText("≈ …")
            self.price_label.show()
            self.quote_timer.start()
        else:
            self.price_label.hide()

    def _show_price(self, price):
        self.price_label.setVisible(price is not None)
        if price is not None:
            self.price_label.setText(f"≈ {money(price)}")

    def _request_quote(self):
        model = self.current_model()
        if self._mode != "video" or not model:
            return
        params = {"model": model["id"], **self.options.params()}
        api = VeniceAPI(self.settings["api_key"], self.settings["base_url"])
        seq = self.quote_seq
        self._call(lambda: api.video_quote(params),
                   lambda price, seq=seq: self._show_price(price) if seq == self.quote_seq else None)

    # ================================================================ файлы

    def preview_file(self, index):
        path = Path(self.fs_model.filePath(index))
        if path.is_dir():
            return
        if path.suffix.lower() in IMAGE_SUFFIXES:
            self.preview.setHtml(f'<img src="{QUrl.fromLocalFile(str(path)).toString()}" width="300">')
            return
        try:
            data = path.read_bytes()[:200_000]
        except OSError as e:
            self.preview.setPlainText(str(e))
            return
        if b"\0" in data[:8192]:
            self.preview.setPlainText(f"Бинарный файл, {tools.human_size(path.stat().st_size)}")
        else:
            self.preview.setPlainText(data.decode("utf-8", errors="replace"))

    def tree_menu(self, pos):
        index = self.tree.indexAt(pos)
        if not index.isValid():
            return
        path = Path(self.fs_model.filePath(index))
        muted = self.colors["muted"]
        menu = QMenu(self)
        menu.addAction(icons.icon("plus", muted, 16), "Прикрепить к сообщению", lambda: self.add_attachments([path]))
        menu.addAction(icons.icon("external", muted, 16), "Открыть в системе",
                       lambda: QDesktopServices.openUrl(QUrl.fromLocalFile(str(path))))
        menu.exec(self.tree.viewport().mapToGlobal(pos))

    # ================================================================ прочее

    def open_settings(self):
        dlg = SettingsDialog(self.settings, self)
        if dlg.exec():
            values = dlg.values()
            key_changed = values["api_key"] != self.settings["api_key"]
            theme_changed = values["theme"] != self.settings.get("theme", "light")
            frame_changed = values["mac_frame"] != self.settings.get("mac_frame", True)
            self.settings.update(values)
            save_settings(self.settings)
            if theme_changed:
                self.apply_theme()
            if frame_changed:
                self.apply_frame()
            self.set_model(self._model)
            if key_changed or not any(self.models.values()):
                self.refresh_models()

    def closeEvent(self, e):
        if self.worker is not None:
            self.worker.stop()
            self.worker.wait(3000)
        super().closeEvent(e)

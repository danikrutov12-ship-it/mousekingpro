"""Собственные виджеты: выбор модели, строка чата в боковой панели."""

from __future__ import annotations

from PySide6.QtCore import QPoint, Qt, Signal
from PySide6.QtWidgets import (
    QApplication, QFrame, QHBoxLayout, QLabel, QLineEdit, QListWidget, QListWidgetItem, QToolButton,
    QVBoxLayout, QWidget,
)

from ..api import image_price, money, text_price, usd
from . import icons


def model_price(model: dict, kind: str) -> str:
    """Цена для списка моделей: за 1 млн токенов (вход / ответ) или за картинку."""
    if kind == "text":
        price = text_price(model)
        return f"{money(price[0])} / {money(price[1])} за 1М токенов" if price else ""
    if kind == "image":
        resolutions = [usd(v) for v in ((model.get("pricing") or {}).get("resolutions") or {}).values()]
        prices = [p for p in [image_price(model, {}), *resolutions] if p is not None]
        return f"от {money(min(prices))} за картинку" if prices else ""
    return ""


def model_tags(model: dict, kind: str) -> list[tuple[str, bool]]:
    """Метки возможностей модели: (текст, акцентная ли)."""
    tags: list[tuple[str, bool]] = []
    if model.get("uncensored"):
        tags.append(("без цензуры", True))
    if kind == "text":
        if model.get("tools"):
            tags.append(("инструменты", False))
        if model.get("vision"):
            tags.append(("зрение", False))
        if model.get("reasoning"):
            tags.append(("рассуждение", False))
        if model.get("context"):
            tags.append((f"{model['context'] // 1000}K", False))

    elif kind == "video":
        mtype = (model.get("constraints") or {}).get("model_type")
        tags.append(({"text-to-video": "текст → видео", "image-to-video": "картинка → видео",
                      "video": "видео → видео"}.get(mtype, mtype or "видео"), False))
    return tags


class ModelPicker(QWidget):
    """Всплывающая панель выбора модели с поиском."""

    picked = Signal(dict)

    def __init__(self, parent=None):
        super().__init__(parent, Qt.WindowType.Popup | Qt.WindowType.FramelessWindowHint)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        frame = QFrame(objectName="ModelPicker")
        outer.addWidget(frame)
        v = QVBoxLayout(frame)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(0)
        self.search = QLineEdit(objectName="PickerSearch", placeholderText="Найти модель…")
        self.search.textChanged.connect(self._fill)
        self.search.returnPressed.connect(self._pick_first)
        v.addWidget(self.search)
        self.list = QListWidget(objectName="PickerList")
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.list.itemClicked.connect(self._on_click)
        v.addWidget(self.list)
        self.resize(400, 440)
        self.models: list[dict] = []
        self.kind = "text"
        self.current_id = ""
        self.colors: dict = {}

    def open(self, models: list[dict], kind: str, current_id: str, anchor: QWidget, colors: dict):
        self.models, self.kind, self.current_id, self.colors = models, kind, current_id, colors
        self.search.clear()
        self._fill()
        rows = sum(self.list.sizeHintForRow(i) for i in range(self.list.count()))
        self.resize(400, max(160, min(440, self.search.sizeHint().height() + rows + 16)))
        # над кнопкой, выровнять по правому краю; если сверху мало места — под ней
        top_right = anchor.mapToGlobal(QPoint(anchor.width(), 0))
        x = top_right.x() - self.width()
        y = top_right.y() - self.height() - 8
        screen = QApplication.screenAt(top_right) or QApplication.primaryScreen()
        area = screen.availableGeometry()
        if y < area.top():
            y = anchor.mapToGlobal(QPoint(0, anchor.height())).y() + 8
        x = max(area.left() + 8, min(x, area.right() - self.width() - 8))
        self.move(x, y)
        self.show()
        self.search.setFocus()

    def _fill(self, *_):
        query = self.search.text().strip().lower()
        self.list.clear()
        for m in self.models:
            hay = f"{m['name']} {m['id']} {m.get('description', '')}".lower()
            if query and query not in hay:
                continue
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, m)
            row = self._row(m)
            item.setSizeHint(row.sizeHint())
            self.list.addItem(item)
            self.list.setItemWidget(item, row)
            if m["id"] == self.current_id:
                self.list.setCurrentItem(item)
        if self.list.count() == 0:
            item = QListWidgetItem("Ничего не найдено")
            item.setFlags(Qt.ItemFlag.NoItemFlags)
            self.list.addItem(item)

    def _row(self, m: dict) -> QWidget:
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(10, 8, 10, 8)
        h.setSpacing(10)
        col = QVBoxLayout()
        col.setSpacing(3)
        top = QHBoxLayout()
        top.setSpacing(6)
        top.addWidget(QLabel(m["name"], objectName="PickerName"))
        for text, accent in model_tags(m, self.kind):
            top.addWidget(QLabel(text, objectName="TagAccent" if accent else "Tag"))
        top.addStretch()
        col.addLayout(top)
        desc = (m.get("description") or m["id"]).strip().splitlines()[0]
        price = model_price(m, self.kind)
        if price:
            desc = f"{price} · {desc}"
        dl = QLabel(objectName="PickerDesc")
        dl.setText(dl.fontMetrics().elidedText(desc, Qt.TextElideMode.ElideRight, 320))
        dl.setToolTip(m.get("description") or "")
        col.addWidget(dl)
        h.addLayout(col, 1)
        check = QLabel()
        if m["id"] == self.current_id:
            check.setPixmap(icons.pixmap("check", self.colors.get("accent", "#c8643b"), 16, 2))
        check.setFixedWidth(16)
        h.addWidget(check)
        return w

    def _on_click(self, item: QListWidgetItem):
        model = item.data(Qt.ItemDataRole.UserRole)
        if model:
            self.hide()
            self.picked.emit(model)

    def _pick_first(self):
        for i in range(self.list.count()):
            item = self.list.item(i)
            if item.data(Qt.ItemDataRole.UserRole):
                self._on_click(item)
                return


class ChatRow(QWidget):
    """Строка чата: название с многоточием и кнопка удаления при наведении."""

    delete_clicked = Signal(str)

    def __init__(self, chat_id: str, title: str, trash_icon):
        super().__init__()
        self.chat_id = chat_id
        self.full_title = title
        h = QHBoxLayout(self)
        h.setContentsMargins(10, 6, 4, 6)
        h.setSpacing(2)
        self.label = QLabel(objectName="ChatItemTitle")
        h.addWidget(self.label, 1)
        self.trash = QToolButton(objectName="RowAction", toolTip="Удалить чат")
        self.trash.setIcon(trash_icon)
        self.trash.setIconSize(icons.qsize(15))
        self.trash.clicked.connect(lambda: self.delete_clicked.emit(self.chat_id))
        self.trash.setVisible(False)
        h.addWidget(self.trash)
        self.setToolTip(title)

    def resizeEvent(self, e):
        super().resizeEvent(e)
        width = self.width() - 44  # место под кнопку удаления, чтобы текст не прыгал
        self.label.setText(self.label.fontMetrics().elidedText(self.full_title, Qt.TextElideMode.ElideRight, width))

    def enterEvent(self, e):
        self.trash.setVisible(True)
        super().enterEvent(e)

    def leaveEvent(self, e):
        self.trash.setVisible(False)
        super().leaveEvent(e)

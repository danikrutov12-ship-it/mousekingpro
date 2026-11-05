"""Окно в стиле macOS: кнопки-«светофор», перетаскивание за шапку, изменение размера за края."""

from __future__ import annotations

from PySide6.QtCore import QEvent, QObject, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QWidget

LIGHTS = (("close", "#ff5f57", "#e0443e"), ("minimize", "#febc2e", "#dea123"), ("zoom", "#28c840", "#1aab29"))
INACTIVE = "#d1cfc8"
INACTIVE_DARK = "#4a4945"
EDGE = 6  # ширина зоны изменения размера, px


class TrafficLights(QWidget):
    close_clicked = Signal()
    minimize_clicked = Signal()
    zoom_clicked = Signal()

    SIZE, GAP = 12, 8

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setFixedSize(self.SIZE * 3 + self.GAP * 2 + 4, self.SIZE + 8)
        self.setMouseTracking(True)
        self.hovered = False
        self.pressed: str | None = None
        self.dark = False

    def _rect(self, i: int) -> QRectF:
        return QRectF(2 + i * (self.SIZE + self.GAP), 4, self.SIZE, self.SIZE)

    def _hit(self, pos) -> str | None:
        for i, (name, *_ ) in enumerate(LIGHTS):
            if self._rect(i).adjusted(-3, -3, 3, 3).contains(QPointF(pos)):
                return name
        return None

    def paintEvent(self, _):
        p = QPainter(self)
        try:
            self._paint(p)
        finally:
            p.end()

    def _paint(self, p: QPainter) -> None:
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        active = self.window().isActiveWindow() or self.hovered
        for i, (name, color, edge) in enumerate(LIGHTS):
            r = self._rect(i)
            fill = QColor(color if active else (INACTIVE_DARK if self.dark else INACTIVE))
            if self.pressed == name:
                fill = fill.darker(120)
            p.setPen(QPen(QColor(edge if active else fill.darker(108)), 0.8))
            p.setBrush(fill)
            p.drawEllipse(r)
            if self.hovered:
                glyph = QPen(QColor(0, 0, 0, 150), 1.3)
                glyph.setCapStyle(Qt.PenCapStyle.RoundCap)
                p.setPen(glyph)
                c, d = r.center(), 2.6
                if name == "close":
                    p.drawLine(QPointF(c.x() - d, c.y() - d), QPointF(c.x() + d, c.y() + d))
                    p.drawLine(QPointF(c.x() - d, c.y() + d), QPointF(c.x() + d, c.y() - d))
                elif name == "minimize":
                    p.drawLine(QPointF(c.x() - d - 0.5, c.y()), QPointF(c.x() + d + 0.5, c.y()))
                else:
                    p.drawLine(QPointF(c.x() - d, c.y()), QPointF(c.x() + d, c.y()))
                    p.drawLine(QPointF(c.x(), c.y() - d), QPointF(c.x(), c.y() + d))

    def enterEvent(self, e):
        self.hovered = True
        self.update()
        super().enterEvent(e)

    def leaveEvent(self, e):
        self.hovered = False
        self.pressed = None
        self.update()
        super().leaveEvent(e)

    def mousePressEvent(self, e):
        self.pressed = self._hit(e.position())
        self.update()

    def mouseReleaseEvent(self, e):
        hit = self._hit(e.position())
        if hit and hit == self.pressed:
            {"close": self.close_clicked, "minimize": self.minimize_clicked, "zoom": self.zoom_clicked}[hit].emit()
        self.pressed = None
        self.update()


class WindowMover(QObject):
    """Фильтр для «шапок»: тянуть — двигает окно, двойной клик — развернуть/восстановить."""

    def __init__(self, window: QWidget):
        super().__init__(window)
        self.window = window
        self.enabled = True

    def eventFilter(self, obj, e):
        if not self.enabled:
            return False
        if e.type() == QEvent.Type.MouseButtonPress and e.button() == Qt.MouseButton.LeftButton:
            handle = self.window.windowHandle()
            if handle is not None:
                handle.startSystemMove()
                return True
        if e.type() == QEvent.Type.MouseButtonDblClick and e.button() == Qt.MouseButton.LeftButton:
            toggle_maximized(self.window)
            return True
        return False


class _Grip(QWidget):
    """Невидимая полоска у края окна: курсор изменения размера и системный resize по нажатию."""

    def __init__(self, window: QWidget, edges: Qt.Edge, shape: Qt.CursorShape):
        super().__init__(window)
        self.edges = edges
        self.setCursor(shape)
        self.setAttribute(Qt.WidgetAttribute.WA_NoSystemBackground)

    def mousePressEvent(self, e):
        handle = self.window().windowHandle()
        if e.button() == Qt.MouseButton.LeftButton and handle is not None:
            handle.startSystemResize(self.edges)


class EdgeGrips:
    """Восемь ручек по краям и углам окна без рамки."""

    def __init__(self, window: QWidget):
        self.window = window
        L, R, T, B = Qt.Edge.LeftEdge, Qt.Edge.RightEdge, Qt.Edge.TopEdge, Qt.Edge.BottomEdge
        C = Qt.CursorShape
        self.grips = {
            "l": _Grip(window, L, C.SizeHorCursor), "r": _Grip(window, R, C.SizeHorCursor),
            "t": _Grip(window, T, C.SizeVerCursor), "b": _Grip(window, B, C.SizeVerCursor),
            "tl": _Grip(window, T | L, C.SizeFDiagCursor), "br": _Grip(window, B | R, C.SizeFDiagCursor),
            "tr": _Grip(window, T | R, C.SizeBDiagCursor), "bl": _Grip(window, B | L, C.SizeBDiagCursor),
        }
        self.enabled = True

    def update(self) -> None:
        w, h, e, c = self.window.width(), self.window.height(), EDGE, EDGE * 2
        geo = {
            "l": (0, c, e, h - 2 * c), "r": (w - e, c, e, h - 2 * c),
            "t": (c, 0, w - 2 * c, e), "b": (c, h - e, w - 2 * c, e),
            "tl": (0, 0, c, c), "tr": (w - c, 0, c, c), "bl": (0, h - c, c, c), "br": (w - c, h - c, c, c),
        }
        show = self.enabled and not (self.window.isMaximized() or self.window.isFullScreen())
        for key, grip in self.grips.items():
            grip.setGeometry(*geo[key])
            grip.setVisible(show)
            grip.raise_()


def toggle_maximized(window: QWidget) -> None:
    window.showNormal() if window.isMaximized() else window.showMaximized()

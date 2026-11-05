"""Линейные SVG-иконки (24×24, обводка), перекрашиваемые под тему."""

from __future__ import annotations

from PySide6.QtCore import QByteArray, QRectF, QSize, Qt
from PySide6.QtGui import QGuiApplication, QIcon, QPainter, QPixmap
from PySide6.QtSvg import QSvgRenderer

PATHS = {
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "arrow-up": '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
    "stop": '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
    "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4'
           'M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/>',
    "moon": '<path d="M20.5 13.2A8.5 8.5 0 1 1 10.8 3.5a6.6 6.6 0 0 0 9.7 9.7z"/>',
    "folder": '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
    "panel-left": '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/>',
    "panel-right": '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M14.5 4.5v15"/>',
    "sliders": '<path d="M4 20v-6M4 10V4M12 20v-8M12 8V4M20 20v-4M20 12V4M2 14h4M10 8h4M18 16h4"/>',
    "chevron-down": '<path d="m7 10 5 5 5-5"/>',
    "chevron-left": '<path d="m14.5 6-6 6 6 6"/>',
    "dots": '<circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>'
            '<circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none"/>'
            '<circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
    "projects": '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.8l2 2h7.2a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'
                '<path d="M3.5 10.5h17"/>',
    "chat": '<path d="M20.5 14.5a2 2 0 0 1-2 2H8l-4.5 4V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"/>',
    "image": '<rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="9" cy="9" r="1.8"/>'
             '<path d="m20.5 15-4.8-4.8L5.5 20.5"/>',
    "video": '<rect x="2.5" y="6" width="13.5" height="12" rx="2.5"/><path d="m16 10.5 5.5-3.5v10L16 13.5"/>',
    "pen": '<path d="M12 20h8.5M16.3 3.7a2.1 2.1 0 0 1 3 3L7.5 18.5l-4 1 1-4z"/>',
    "trash": '<path d="M4 6.5h16M9 6.5V4.5h6v2M18.5 6.5l-.9 13a1.5 1.5 0 0 1-1.5 1.4H7.9a1.5 1.5 0 0 1-1.5-1.4l-.9-13"/>',
    "external": '<path d="M14 3.5h6.5V10M10.5 13.5l10-10M20.5 14v4.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2H10"/>',
    "x": '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
    "check": '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    "refresh": '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1L20.5 8.5M20.5 3.5v5h-5"/>',
    "search": '<circle cx="11" cy="11" r="6.5"/><path d="m20.5 20.5-4.6-4.6"/>',
    "file": '<path d="M14 3.5H6.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9z"/><path d="M14 3.5V9h5.5"/>',
    "archive": '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M5 8.5v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-10M10 12.5h4"/>',
    "star": '<path d="M12 2.5c.7 5.4 3.6 8.3 9.5 9.5-5.9 1.2-8.8 4.1-9.5 9.5-.7-5.4-3.6-8.3-9.5-9.5 5.9-1.2 8.8-4.1 9.5-9.5z" '
            'fill="currentColor" stroke="none"/>',
}


def svg(name: str, color: str, stroke: float = 1.7) -> bytes:
    body = PATHS[name].replace("currentColor", color)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="{color}" '
            f'stroke-width="{stroke}" stroke-linecap="round" stroke-linejoin="round">{body}</svg>').encode()


def pixmap(name: str, color: str, size: int = 18, stroke: float = 1.7) -> QPixmap:
    app = QGuiApplication.instance()
    ratio = app.devicePixelRatio() if app else 1.0
    pm = QPixmap(int(size * ratio), int(size * ratio))
    pm.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pm)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    QSvgRenderer(QByteArray(svg(name, color, stroke))).render(painter, QRectF(0, 0, pm.width(), pm.height()))
    painter.end()
    pm.setDevicePixelRatio(ratio)
    return pm


def icon(name: str, color: str, size: int = 18, hover: str | None = None) -> QIcon:
    ic = QIcon()
    ic.addPixmap(pixmap(name, color, size), QIcon.Mode.Normal)
    ic.addPixmap(pixmap(name, hover or color, size), QIcon.Mode.Active)
    return ic


def qsize(size: int) -> QSize:
    return QSize(size, size)

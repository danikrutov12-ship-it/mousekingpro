"""Тёплая минималистичная тема (светлая и тёмная): шрифты, палитра Qt и таблица стилей."""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QUrl
from PySide6.QtGui import QColor, QFontDatabase, QPalette
from PySide6.QtWidgets import QApplication

PALETTES = {
    "light": {
        "bg": "#faf9f5", "sidebar": "#f3f1ea", "surface": "#ffffff", "surface2": "#f0eee6",
        "hover": "#ebe8de", "selected": "#e4e0d4", "border": "#e2ded2", "border_strong": "#d3cebf",
        "text": "#29261f", "muted": "#6f6a5f", "dim": "#a39e91", "accent": "#c8643b",
        "accent_hover": "#b55531", "accent_soft": "#f4e3da", "user_bubble": "#efece3",
        "code_bg": "#f6f4ee", "danger": "#c2410c", "ok": "#4d7c0f", "shadow": "rgba(60,50,30,0.10)",
    },
    "dark": {
        "bg": "#262624", "sidebar": "#1f1e1d", "surface": "#30302e", "surface2": "#383835",
        "hover": "#353533", "selected": "#3f3f3c", "border": "#42413d", "border_strong": "#55534d",
        "text": "#ecebe6", "muted": "#a9a69c", "dim": "#7a776e", "accent": "#d4774f",
        "accent_hover": "#e08a63", "accent_soft": "#4a3329", "user_bubble": "#141413",
        "code_bg": "#1d1d1c", "danger": "#f87171", "ok": "#a3e635", "shadow": "rgba(0,0,0,0.35)",
    },
}

FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"
SANS = '"Inter", "Noto Sans", "Ubuntu", "Segoe UI", system-ui, sans-serif'
SERIF = '"Source Serif 4", "Noto Serif", "Georgia", "DejaVu Serif", serif'
DISPLAY = '"Source Serif 4 Display", "Source Serif 4", "Noto Serif", serif'
MONO = '"JetBrains Mono", "Fira Code", "Ubuntu Mono", "DejaVu Sans Mono", monospace'

# файл -> (семейство, вес, начертание) для @font-face в веб-ленте
FONT_FACES = {
    "Inter-Regular.ttf": ("Inter", 400, "normal"), "Inter-Medium.ttf": ("Inter", 500, "normal"),
    "Inter-SemiBold.ttf": ("Inter", 600, "normal"), "Inter-Bold.ttf": ("Inter", 700, "normal"),
    "Inter-Italic.ttf": ("Inter", 400, "italic"),
    "SourceSerif4-Regular.ttf": ("Source Serif 4", 400, "normal"),
    "SourceSerif4-Semibold.ttf": ("Source Serif 4", 600, "normal"),
    "SourceSerif4-Bold.ttf": ("Source Serif 4", 700, "normal"),
    "SourceSerif4-It.ttf": ("Source Serif 4", 400, "italic"),
    "JetBrainsMono-Regular.ttf": ("JetBrains Mono", 400, "normal"),
    "JetBrainsMono-Medium.ttf": ("JetBrains Mono", 500, "normal"),
    "JetBrainsMono-Bold.ttf": ("JetBrains Mono", 700, "normal"),
}

_fonts_loaded = False


def load_fonts() -> None:
    global _fonts_loaded
    if _fonts_loaded:
        return
    for f in sorted(FONT_DIR.glob("*.ttf")):
        QFontDatabase.addApplicationFont(str(f))
    _fonts_loaded = True


def font_face_css() -> str:
    rules = []
    for name, (family, weight, style) in FONT_FACES.items():
        path = FONT_DIR / name
        if path.is_file():
            rules.append(f'@font-face {{ font-family: "{family}"; src: url("{QUrl.fromLocalFile(str(path)).toString()}"); '
                         f"font-weight: {weight}; font-style: {style}; }}")
    return "\n".join(rules)


QSS = """
* {{ font-family: {sans}; font-size: 14px; color: {text}; outline: none; }}
QMainWindow, QDialog, #Center {{ background: {bg}; }}
QToolTip {{ background: {text}; color: {bg}; border: none; padding: 5px 9px; border-radius: 6px; font-size: 12px; }}
QLabel {{ background: transparent; }}

/* ---------- боковая панель */
#Sidebar {{ background: {sidebar}; border-right: 1px solid {border}; }}
#Brand {{ font-family: {serif}; font-size: 19px; font-weight: 600; letter-spacing: -0.2px; }}
#SectionLabel {{ color: {dim}; font-size: 12px; font-weight: 500; padding: 14px 10px 4px 10px; }}
#ChatList {{ background: transparent; border: none; }}
#ChatList::item {{ border-radius: 8px; margin: 0; padding: 0; }}
#ChatList::item:hover {{ background: {hover}; }}
#ChatList::item:selected {{ background: {selected}; }}
#ChatItemTitle {{ color: {text}; font-size: 13.5px; }}
#GroupHeader {{ color: {dim}; font-size: 11.5px; font-weight: 600; padding: 12px 10px 3px 10px; }}
#EmptyChats {{ color: {dim}; font-size: 13px; padding: 10px; }}
QPushButton#NavButton {{
    background: transparent; border: none; border-radius: 9px; padding: 8px 10px; text-align: left; font-weight: 500;
}}
QPushButton#NavButton:hover {{ background: {hover}; }}
#NewChatIcon {{ background: {accent}; border-radius: 12px;
               min-width: 24px; max-width: 24px; min-height: 24px; max-height: 24px; }}
#UserRow {{ border-top: 1px solid {border}; }}
#Avatar {{ background: {text}; color: {bg}; border-radius: 15px; font-weight: 600; font-size: 13px;
          min-width: 30px; max-width: 30px; min-height: 30px; max-height: 30px; }}
#UserName {{ font-weight: 500; }}

/* ---------- кнопки */
QPushButton {{ background: {surface}; border: 1px solid {border}; border-radius: 9px; padding: 7px 14px; }}
QPushButton:hover {{ background: {hover}; }}
QPushButton:disabled {{ color: {dim}; }}
QPushButton#Primary {{ background: {accent}; border: none; color: white; font-weight: 600; }}
QPushButton#Primary:hover {{ background: {accent_hover}; }}
QPushButton#Danger {{ background: transparent; border: 1px solid {danger}; color: {danger}; }}
QPushButton#Link {{ background: transparent; border: none; padding: 2px 0; color: {accent}; font-size: 12.5px; }}
QPushButton#Link:hover {{ color: {accent_hover}; text-decoration: underline; }}
QPushButton#Suggestion {{
    background: transparent; border: 1px solid {border}; border-radius: 11px; padding: 7px 13px; color: {muted};
}}
QPushButton#Suggestion:hover {{ color: {text}; background: {surface}; border: 1px solid {border_strong}; }}
QToolButton {{ background: transparent; border: none; border-radius: 8px; padding: 6px; color: {muted}; }}
QToolButton:hover {{ background: {hover}; color: {text}; }}
QToolButton:checked {{ background: {selected}; color: {text}; }}
QToolButton::menu-indicator {{ image: none; width: 0; }}
QToolButton#Pill {{ border: 1px solid {border}; border-radius: 10px; padding: 5px 10px; font-size: 13px; color: {muted}; }}
QToolButton#Pill:hover {{ border: 1px solid {border_strong}; color: {text}; background: transparent; }}
QToolButton#ProjectPill {{ border: 1px solid {border}; border-radius: 10px; padding: 7px 10px; font-size: 13.5px;
                          text-align: left; background: {surface}; }}
QToolButton#ProjectPill:hover {{ border: 1px solid {border_strong}; }}
QToolButton#ModelPill {{ border-radius: 9px; padding: 5px 8px 5px 10px; font-size: 13px; color: {muted}; }}
QToolButton#ModelPill:hover {{ color: {text}; }}
QToolButton#Send {{
    background: {accent}; border-radius: 10px; padding: 0;
    min-width: 34px; max-width: 34px; min-height: 34px; max-height: 34px;
}}
QToolButton#Send:hover {{ background: {accent_hover}; }}
QToolButton#Send:disabled {{ background: {accent_soft}; }}
QToolButton#Stop {{
    background: {text}; border-radius: 10px; padding: 0;
    min-width: 34px; max-width: 34px; min-height: 34px; max-height: 34px;
}}
QToolButton#Attach {{ border-radius: 10px; min-width: 34px; max-width: 34px; min-height: 34px; max-height: 34px; padding: 0; }}
QToolButton#ChipBtn {{ background: {surface2}; border: 1px solid {border}; border-radius: 9px; padding: 4px 8px;
                      font-size: 12.5px; color: {text}; }}
QToolButton#ChipBtn:hover {{ border: 1px solid {border_strong}; }}
QToolButton#RowAction {{ padding: 3px; border-radius: 6px; }}

/* ---------- центр */
#Header {{ background: {bg}; }}
#ChatTitle {{ font-size: 14px; font-weight: 500; color: {text}; }}
#Greeting {{ font-family: {display}; font-size: 42px; font-weight: 400; color: {text}; letter-spacing: -0.5px; }}
#Muted {{ color: {muted}; font-size: 12px; }}
#Status {{ color: {muted}; font-size: 12.5px; }}
#Price {{ color: {muted}; font-size: 12.5px; padding: 0 6px; }}
#Composer {{ background: {surface}; border: 1px solid {border}; border-radius: 22px; }}
#Composer[focused="true"] {{ border: 1px solid {border_strong}; }}
#ComposerInput {{ background: transparent; border: none; font-size: 15.5px; padding: 2px; }}
#Options {{ background: transparent; }}
#Disclaimer {{ color: {dim}; font-size: 11.5px; }}

/* ---------- выбор модели */
#ModelPicker {{ background: {surface}; border: 1px solid {border}; border-radius: 14px; }}
#PickerSearch {{ background: transparent; border: none; border-bottom: 1px solid {border}; border-radius: 0;
                padding: 10px 12px; font-size: 13.5px; }}
#PickerList {{ background: transparent; border: none; padding: 4px; }}
#PickerList::item {{ border-radius: 9px; margin: 1px 0; }}
#PickerList::item:hover {{ background: {hover}; }}
#PickerList::item:selected {{ background: {selected}; }}
#PickerName {{ font-weight: 500; font-size: 13.5px; }}
#PickerDesc {{ color: {muted}; font-size: 12px; }}
#Tag {{ color: {muted}; background: {surface2}; border-radius: 6px; padding: 1px 6px; font-size: 11px; }}
#TagAccent {{ color: {accent}; background: {accent_soft}; border-radius: 6px; padding: 1px 6px; font-size: 11px; }}

/* ---------- навигация, путь в шапке */
QPushButton#NavButton:checked {{ background: {selected}; }}
QPushButton#Crumb {{ background: transparent; border: none; padding: 3px 6px; border-radius: 6px; color: {muted};
                    font-size: 14px; }}
QPushButton#Crumb:hover {{ background: {hover}; color: {text}; }}
#CrumbSep {{ color: {dim}; padding: 0 2px; }}

/* ---------- страницы проектов */
#PageScroll, #PageBody {{ background: {bg}; border: none; }}
#PageTitle {{ font-family: {display}; font-size: 32px; color: {text}; }}
#PageSubtitle {{ color: {muted}; font-size: 14.5px; padding-top: 6px; }}
#SectionTitle {{ font-weight: 600; font-size: 14px; padding-bottom: 2px; }}
#FieldLabel {{ font-weight: 500; font-size: 13.5px; }}
QLineEdit#SearchField {{ padding: 9px 10px; border-radius: 11px; font-size: 14px; }}
#ProjectCard {{ background: {surface}; border: 1px solid {border}; border-radius: 14px; }}
#ProjectCard:hover {{ border: 1px solid {border_strong}; background: {surface}; }}
#EmptyCard {{ background: transparent; border: 1px dashed {border_strong}; border-radius: 14px; }}
#CardTitle {{ font-weight: 600; font-size: 14.5px; }}
#CardDesc {{ color: {muted}; font-size: 13px; }}
#CardBody {{ color: {text}; font-size: 13px; }}
#CardMeta {{ color: {dim}; font-size: 12px; }}
#SideCard {{ background: {surface}; border: 1px solid {border}; border-radius: 14px; }}
#ChatCard {{ background: transparent; border: none; border-top: 1px solid {border}; border-radius: 0; }}
#ChatCard:hover {{ background: {hover}; border-radius: 10px; }}
#ChatCardTitle {{ font-size: 14px; font-weight: 500; }}
#FileRow {{ border-radius: 8px; }}
#FileRow:hover {{ background: {hover}; }}
QPushButton#FileName {{ background: transparent; border: none; padding: 2px 0; text-align: left; font-size: 13px; }}
QPushButton#FileName:hover {{ color: {accent}; }}

/* ---------- поля */
QLineEdit, QPlainTextEdit, QTextEdit, QSpinBox, QDoubleSpinBox {{
    background: {surface}; border: 1px solid {border}; border-radius: 9px; padding: 6px 9px;
    selection-background-color: {accent}; selection-color: white;
}}
QLineEdit:focus, QPlainTextEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus {{ border: 1px solid {border_strong}; }}
QSpinBox::up-button, QSpinBox::down-button, QDoubleSpinBox::up-button, QDoubleSpinBox::down-button {{ width: 0; border: none; }}
QComboBox {{ background: {surface}; border: 1px solid {border}; border-radius: 9px; padding: 5px 10px; }}
QComboBox:hover {{ border: 1px solid {border_strong}; }}
QComboBox::drop-down {{ border: none; width: 20px; }}
QComboBox QAbstractItemView {{
    background: {surface}; border: 1px solid {border}; padding: 4px; selection-background-color: {hover};
    selection-color: {text};
}}
QCheckBox {{ spacing: 7px; color: {muted}; }}
QCheckBox::indicator {{ width: 15px; height: 15px; border-radius: 4px; border: 1px solid {dim}; background: {surface}; }}
QCheckBox::indicator:checked {{ background: {accent}; border: 1px solid {accent}; }}

/* ---------- меню */
QMenu {{ background: {surface}; border: 1px solid {border}; border-radius: 12px; padding: 6px; }}
QMenu::item {{ padding: 7px 26px 7px 10px; border-radius: 7px; }}
QMenu::item:selected {{ background: {hover}; color: {text}; }}
QMenu::separator {{ height: 1px; background: {border}; margin: 5px 6px; }}
QMenu::icon {{ padding-left: 6px; }}

/* ---------- панель файлов */
#FilesPanel {{ background: {sidebar}; border-left: 1px solid {border}; }}
#PanelTitle {{ font-weight: 600; }}
QTreeView {{ background: transparent; border: none; }}
QTreeView::item {{ padding: 4px 2px; border-radius: 6px; }}
QTreeView::item:hover {{ background: {hover}; }}
QTreeView::item:selected {{ background: {selected}; color: {text}; }}
#Preview {{ background: {surface}; border: 1px solid {border}; border-radius: 10px;
           font-family: {mono}; font-size: 12px; }}

/* ---------- скроллбары, сплиттер */
QScrollBar:vertical {{ background: transparent; width: 9px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: {border}; border-radius: 3px; min-height: 30px; }}
QScrollBar::handle:vertical:hover {{ background: {border_strong}; }}
QScrollBar:horizontal {{ background: transparent; height: 9px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: {border}; border-radius: 3px; min-width: 30px; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{ background: none; border: none; width: 0; height: 0; }}
QSplitter::handle {{ background: transparent; }}

/* ---------- диалоги */
#DialogTitle {{ font-family: {display}; font-size: 24px; }}
#Diff {{ background: {code_bg}; border: 1px solid {border}; border-radius: 10px; font-family: {mono}; font-size: 12px; }}
"""


def palette(name: str) -> dict:
    return PALETTES.get(name, PALETTES["light"])


def apply_theme(app: QApplication, name: str) -> dict:
    load_fonts()
    c = palette(name)
    app.setStyle("Fusion")
    pal = QPalette()
    for role, key in {
        QPalette.ColorRole.Window: "bg", QPalette.ColorRole.WindowText: "text",
        QPalette.ColorRole.Base: "surface", QPalette.ColorRole.AlternateBase: "surface2",
        QPalette.ColorRole.Text: "text", QPalette.ColorRole.Button: "surface",
        QPalette.ColorRole.ButtonText: "text", QPalette.ColorRole.Highlight: "accent",
        QPalette.ColorRole.ToolTipBase: "text", QPalette.ColorRole.ToolTipText: "bg",
        QPalette.ColorRole.PlaceholderText: "dim", QPalette.ColorRole.Link: "accent",
    }.items():
        pal.setColor(role, QColor(c[key]))
    pal.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    app.setPalette(pal)
    app.setStyleSheet(QSS.format(sans=SANS, serif=SERIF, display=DISPLAY, mono=MONO, **c))
    return c

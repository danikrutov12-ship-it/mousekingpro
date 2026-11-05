"""Параметры генерации изображений и видео, построенные по ограничениям модели."""

from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QHBoxLayout, QLabel, QLineEdit, QSpinBox, QVBoxLayout, QWidget,
)


def _combo(values, default=None) -> QComboBox:
    box = QComboBox()
    for v in values:
        box.addItem(str(v), v)
    if default is not None and (i := box.findData(default)) >= 0:
        box.setCurrentIndex(i)
    return box


def _spin(lo: int, hi: int, value: int, step: int = 1) -> QSpinBox:
    box = QSpinBox()
    box.setRange(lo, hi)
    box.setSingleStep(step)
    box.setValue(value)
    return box


class MediaOptions(QWidget):
    changed = Signal()  # изменился любой параметр (для пересчёта цены)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.kind = "text"
        self.model: dict | None = None
        self.fields: dict[str, QWidget] = {}
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.row = QHBoxLayout()
        self.hint = QLabel()
        self.hint.setStyleSheet("color: #6b7280;")
        self.hint.setWordWrap(True)
        self.negative = QLineEdit()
        self.negative.setPlaceholderText("Негативный промпт (чего не должно быть) — необязательно")
        layout.addLayout(self.row)
        layout.addWidget(self.negative)
        layout.addWidget(self.hint)

    @property
    def model_type(self) -> str:
        return (self.model or {}).get("constraints", {}).get("model_type", "")

    def _clear(self):
        while self.row.count():
            item = self.row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.fields = {}

    def _add(self, key: str, label: str, widget: QWidget):
        if label:
            self.row.addWidget(QLabel(label))
        self.row.addWidget(widget)
        self.fields[key] = widget
        if isinstance(widget, QComboBox):
            widget.currentIndexChanged.connect(lambda *_: self.changed.emit())
        elif isinstance(widget, QSpinBox):
            widget.valueChanged.connect(lambda *_: self.changed.emit())
        elif isinstance(widget, QCheckBox):
            widget.toggled.connect(lambda *_: self.changed.emit())

    def set_model(self, kind: str, model: dict | None):
        self.kind, self.model = kind, model
        self._clear()
        self.hint.clear()
        self.setVisible(kind in ("image", "video"))
        if kind == "image":
            self._build_image((model or {}).get("constraints", {}))
        elif kind == "video":
            self._build_video((model or {}).get("constraints", {}))
        self.row.addStretch()
        self.changed.emit()

    def _build_image(self, c: dict):
        if c.get("aspectRatios"):
            self._add("aspect_ratio", "Пропорции:", _combo(c["aspectRatios"], c.get("defaultAspectRatio")))
        else:
            step = int(c.get("widthHeightDivisor") or 8)
            self._add("width", "Ширина:", _spin(256, 1280, 1024, step))
            self._add("height", "Высота:", _spin(256, 1280, 1024, step))
        if c.get("resolutions"):
            self._add("resolution", "Разрешение:", _combo(c["resolutions"], c.get("defaultResolution")))
        if c.get("qualities"):
            self._add("quality", "Качество:", _combo(c["qualities"], c.get("defaultQuality")))
        steps = c.get("steps") or {}
        if int(steps.get("max") or 0) > 1:
            self._add("steps", "Шаги:", _spin(1, int(steps["max"]), int(steps.get("default") or 8)))
        self._add("variants", "Вариантов:", _spin(1, 4, 1))
        self._add("format", "Формат:", _combo(["png", "webp", "jpeg"], "png"))
        hide = QCheckBox("без водяного знака")
        hide.setChecked(True)
        self._add("hide_watermark", "", hide)

    def _build_video(self, c: dict):
        if c.get("durations"):
            self._add("duration", "Длительность:", _combo(c["durations"]))
        if c.get("resolutions"):
            self._add("resolution", "Разрешение:", _combo(c["resolutions"]))
        if c.get("aspect_ratios"):
            self._add("aspect_ratio", "Пропорции:", _combo(c["aspect_ratios"]))
        if c.get("audio_configurable"):
            audio = QCheckBox("со звуком")
            audio.setChecked(bool(c.get("audio", True)))
            self._add("audio", "", audio)
        hints = {
            "image-to-video": "Эта модель оживляет картинку: прикрепите изображение (📎).",
            "video": "Эта модель обрабатывает видео: прикрепите видеофайл (📎).",
            "text-to-video": "Видео по текстовому описанию. Можно прикрепить картинку-референс, если модель поддерживает.",
        }
        self.hint.setText(hints.get(c.get("model_type", ""), "") +
                          "  Генерация видео занимает от нескольких минут и списывает баланс Venice.")

    def params(self) -> dict:
        out: dict = {}
        for key, w in self.fields.items():
            if isinstance(w, QComboBox):
                out[key] = w.currentData()
            elif isinstance(w, QSpinBox):
                out[key] = w.value()
            elif isinstance(w, QCheckBox):
                out[key] = w.isChecked()
        if self.negative.text().strip():
            out["negative_prompt"] = self.negative.text().strip()
        return out

import os
import sys

# GTK3-тема Qt падает на новых GNOME (нет ключа xsettings 'antialiasing'),
# поэтому по умолчанию берём встроенную тему GNOME из самого Qt.
if sys.platform.startswith("linux"):
    os.environ.setdefault("QT_QPA_PLATFORMTHEME", "gnome")

from PySide6.QtWidgets import QApplication  # noqa: E402

from .ui.main_window import MainWindow  # noqa: E402


def main() -> None:
    app = QApplication(sys.argv)
    app.setApplicationName("Venice Agent")
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()

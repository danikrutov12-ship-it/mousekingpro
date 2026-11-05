// Пункт «Mouse King Pro» в меню приложений (GNOME и другие оболочки по стандарту freedesktop).
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { app } from 'electron'

// в собранном приложении (AppImage) значок лежит в resources, при запуске из исходников — в build/
export const ICON = app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(__dirname, '../../build/icon.png')

export function installDesktopEntry(): string {
  const data = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  const iconDir = app.isPackaged ? process.resourcesPath : resolve(__dirname, '../../build')
  const launcher = app.isPackaged && process.env.APPIMAGE ? process.env.APPIMAGE : resolve(__dirname, '../../../run.sh')
  for (const size of [256, 512]) {
    const dir = join(data, 'icons', 'hicolor', `${size}x${size}`, 'apps')
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(iconDir, size === 512 ? 'icon.png' : 'icon-256.png'), join(dir, 'mouse-king-pro.png'))
  }
  const apps = join(data, 'applications')
  mkdirSync(apps, { recursive: true })
  const file = join(apps, 'mouse-king-pro.desktop')
  // пункт меню под прежним названием больше не нужен
  rmSync(join(apps, 'venice-agent.desktop'), { force: true })
  writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Mouse King Pro',
    'Comment=ИИ-агент на моделях Venice: чат, код, файлы, картинки и видео',
    `Exec="${launcher}" %U`,
    'Icon=mouse-king-pro',
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=mouse-king-pro',
    'Keywords=AI;Venice;Mouse;King;Agent;Chat;ИИ;',
    '',
  ].join('\n'), 'utf-8')
  chmodSync(file, 0o755)
  spawnSync('update-desktop-database', [apps])
  spawnSync('gtk-update-icon-cache', ['-q', '-t', join(data, 'icons', 'hicolor')])
  return existsSync(file) ? file : ''
}

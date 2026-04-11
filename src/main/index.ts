/**
 * Basketweaver — Electron main process.
 *
 * Responsibilities:
 *   • Create the transparent, frameless, always-on-top overlay window
 *   • Tail the EQ log file and forward GameEvents to the renderer via IPC
 *   • Host the system tray
 *   • Handle file picker, opacity, and window resize requests
 */

import { app, BrowserWindow, ipcMain, dialog, screen } from 'electron'
import * as path from 'path'
import { Config } from '../shared/config'
import { IPC, type GameEvent } from '../shared/events'
import { LogReader } from './log-reader'
import { createTray, updateFightHistory } from './tray'
import { autoUpdater } from 'electron-updater'

// ── Persist last-used log path ────────────────────────────────

import * as fs   from 'fs'
import * as os   from 'os'

function configDir(): string {
  const d = path.join(process.env.APPDATA ?? os.homedir(), 'Basketweaver')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function loadLastLog(): string {
  try {
    const p = path.join(configDir(), 'last_log.txt')
    if (fs.existsSync(p)) {
      const v = fs.readFileSync(p, 'utf8').trim()
      if (fs.existsSync(v)) return v
    }
  } catch {}
  return ''
}

function saveLastLog(logPath: string): void {
  try {
    fs.writeFileSync(path.join(configDir(), 'last_log.txt'), logPath, 'utf8')
  } catch {}
}

// ── Persist user settings ─────────────────────────────────────

const SETTINGS_FILE = () => path.join(configDir(), 'settings.json')

let savedWindowPos: { x: number; y: number } | null = null

function loadSettings(): void {
  try {
    const p = SETTINGS_FILE()
    if (fs.existsSync(p)) {
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (typeof saved.OFFHAND_WEAPON_DELAY === 'number') Config.OFFHAND_WEAPON_DELAY = saved.OFFHAND_WEAPON_DELAY
      if (typeof saved.OFFHAND_WEAPON_NAME  === 'string') Config.OFFHAND_WEAPON_NAME  = saved.OFFHAND_WEAPON_NAME
      if (typeof saved.windowX === 'number' && typeof saved.windowY === 'number') {
        savedWindowPos = { x: saved.windowX, y: saved.windowY }
      }
    }
  } catch {}
}

export function saveSettings(): void {
  try {
    const pos = win ? win.getPosition() : null
    const data: Record<string, unknown> = {
      OFFHAND_WEAPON_DELAY: Config.OFFHAND_WEAPON_DELAY,
      OFFHAND_WEAPON_NAME:  Config.OFFHAND_WEAPON_NAME,
    }
    if (pos) { data.windowX = pos[0]; data.windowY = pos[1] }
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(data), 'utf8')
  } catch {}
}

/** Returns true if the window center will land inside any display's work area. */
function isPosVisible(x: number, y: number): boolean {
  const w = Config.WINDOW_WIDTH
  const h = Config.WINDOW_HEIGHT
  const cx = x + w / 2
  const cy = y + h / 2
  return screen.getAllDisplays().some(d => {
    const { x: dx, y: dy, width: dw, height: dh } = d.workArea
    return cx >= dx && cx <= dx + dw && cy >= dy && cy <= dy + dh
  })
}

export function resetWindowPosition(): void {
  if (!win) return
  const { x: dx, y: dy, width: dw, height: dh } = screen.getPrimaryDisplay().workArea
  const [w, h] = win.getSize()
  const nx = Math.trunc(dx + (dw - w) / 2)
  const ny = Math.trunc(dy + dh - h - 80)
  win.setPosition(nx, ny)
  saveSettings()
}

// ── App lifecycle ─────────────────────────────────────────────

let win:       BrowserWindow | null = null
let stopLog:   (() => void) | null  = null

function createWindow(): void {
  const { x: dx, y: dy, width: dw, height: dh } = screen.getPrimaryDisplay().workArea
  const w = Config.WINDOW_WIDTH
  const h = Config.WINDOW_HEIGHT

  const defaultX = Math.trunc(dx + (dw - w) / 2)
  const defaultY = Math.trunc(dy + dh - h - 80)
  const usePos = savedWindowPos && isPosVisible(savedWindowPos.x, savedWindowPos.y)
    ? savedWindowPos
    : { x: defaultX, y: defaultY }

  win = new BrowserWindow({
    width:  w,
    height: h,
    x: usePos.x,
    y: usePos.y,

    // Overlay properties
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,  // keep in taskbar so users can find it
    resizable:   false,
    movable:     true,

    // Renderer options
    webPreferences: {
      preload:        path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  // Set initial opacity
  win.setOpacity(Config.WINDOW_OPACITY)

  // Load the renderer — electron-vite sets ELECTRON_RENDERER_URL in dev mode
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  win.on('moved', () => saveSettings())
  win.on('close', () => saveSettings())
  win.on('closed', () => { win = null })
}

// ── Start log reader ──────────────────────────────────────────

function startReader(logPath: string): void {
  if (stopLog) { stopLog(); stopLog = null }

  const reader = new LogReader(logPath, Config, (ev: GameEvent) => {
    win?.webContents.send(IPC.GAME_EVENT, ev)
  })
  stopLog = reader.start()
  saveLastLog(logPath)
  console.log(`[Basketweaver] Tailing: ${logPath}`)
}

// ── File picker ───────────────────────────────────────────────

async function pickLogFile(): Promise<string | null> {
  if (!win) return null
  const result = await dialog.showOpenDialog(win, {
    title:      'Select EverQuest Log File',
    properties: ['openFile'],
    filters: [
      { name: 'Text log files', extensions: ['txt'] },
      { name: 'Log files',      extensions: ['log'] },
      { name: 'All files',      extensions: ['*']   },
    ],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

// ── IPC handlers ──────────────────────────────────────────────

function setupIPC(): void {
  ipcMain.on(IPC.QUIT, () => app.quit())

  ipcMain.on(IPC.SELECT_LOG, async () => {
    const p = await pickLogFile()
    if (p) {
      startReader(p)
      win?.webContents.send(IPC.LOG_SELECTED, p)
    }
  })

  ipcMain.on(IPC.SAVE_SETTINGS, () => saveSettings())

  ipcMain.on(IPC.FIGHT_HISTORY_UPDATE, (_e, fights: string[]) => updateFightHistory(fights))

  ipcMain.on(IPC.SET_OPACITY, (_e, val: number) => {
    Config.WINDOW_OPACITY = val
    win?.setOpacity(val)
  })

  ipcMain.on('resize-window', (_e, w: number, h: number) => {
    if (!win) return
    const [cx, cy] = win.getPosition()
    win.setSize(w, h)
    win.setPosition(cx, cy)
    win.setResizable(false)
  })

  ipcMain.on('move-window-delta', (_e, dx: number, dy: number) => {
    if (!win) return
    const [x, y] = win.getPosition()
    win.setPosition(x + dx, y + dy)
  })

  // Status reply from renderer (used by tray menu refresh)
  ipcMain.on(IPC.STATUS_REPLY, (_e, data: { inCombat: boolean }) => {
    // Forwarded — tray listener handles this
  })
}

// ── Auto-updater ──────────────────────────────────────────────

function setupAutoUpdater(): void {
  // Only run in packaged builds — not during dev
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  autoUpdater.on('update-available', (info) => {
    const current = app.getVersion()
    const next    = info.version
    dialog.showMessageBox({
      type:    'info',
      title:   'Update Available',
      message: `Basketweaver ${next} is available (you have ${current}).`,
      detail:  'Would you like to download and install it now?',
      buttons: ['Update Now', 'Later'],
      defaultId: 0,
      cancelId:  1,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.downloadUpdate()
      }
    })
  })

  autoUpdater.on('update-downloaded', () => {
    dialog.showMessageBox({
      type:    'info',
      title:   'Update Ready',
      message: 'Update downloaded. Basketweaver will restart to apply it.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId:  1,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall()
      }
    })
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message)
  })

  // Check silently — no dialog if already up to date
  autoUpdater.checkForUpdates().catch(err => {
    console.error('[Updater] Check failed:', err.message)
  })
}

// ── App entry ─────────────────────────────────────────────────

app.whenReady().then(async () => {
  loadSettings()
  setupIPC()
  createWindow()

  // Create tray
  createTray(win!, () => app.quit(), saveSettings, async () => {
    const p = await pickLogFile()
    if (p) {
      startReader(p)
      win?.webContents.send(IPC.LOG_SELECTED, p)
    }
  }, resetWindowPosition)

  // Check for updates (no-op in dev mode)
  setupAutoUpdater()

  // Start the log reader once the window is ready
  win!.webContents.on('did-finish-load', () => {
    const logPath = loadLastLog()
    if (logPath) {
      startReader(logPath)
      win?.webContents.send(IPC.LOG_SELECTED, logPath)
    } else {
      // Prompt for file
      pickLogFile().then(p => {
        if (p) {
          startReader(p)
          win?.webContents.send(IPC.LOG_SELECTED, p)
        }
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (stopLog) stopLog()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

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
import { createTray } from './tray'

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

function loadSettings(): void {
  try {
    const p = SETTINGS_FILE()
    if (fs.existsSync(p)) {
      const saved = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (typeof saved.OFFHAND_WEAPON_DELAY === 'number') Config.OFFHAND_WEAPON_DELAY = saved.OFFHAND_WEAPON_DELAY
      if (typeof saved.OFFHAND_WEAPON_NAME  === 'string') Config.OFFHAND_WEAPON_NAME  = saved.OFFHAND_WEAPON_NAME

    }
  } catch {}
}

export function saveSettings(): void {
  try {
    const data = {
      OFFHAND_WEAPON_DELAY: Config.OFFHAND_WEAPON_DELAY,
      OFFHAND_WEAPON_NAME:  Config.OFFHAND_WEAPON_NAME,
    }
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(data), 'utf8')
  } catch {}
}

// ── App lifecycle ─────────────────────────────────────────────

let win:       BrowserWindow | null = null
let stopLog:   (() => void) | null  = null

function createWindow(): void {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize
  const w = Config.WINDOW_WIDTH
  const h = Config.WINDOW_HEIGHT

  win = new BrowserWindow({
    width:  w,
    height: h,
    x: Math.trunc((sw - w) / 2),
    y: sh - h - 80,

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

// ── App entry ─────────────────────────────────────────────────

app.whenReady().then(async () => {
  loadSettings()
  setupIPC()
  createWindow()

  // Create tray
  createTray(win!, () => app.quit(), saveSettings)

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

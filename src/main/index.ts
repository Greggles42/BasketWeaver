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
import { ZealReader } from './zeal-reader'
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
      if (saved.OVERLAY_STYLE === 'refined' || saved.OVERLAY_STYLE === 'standard' || saved.OVERLAY_STYLE === 'highcontrast') {
        Config.OVERLAY_STYLE = saved.OVERLAY_STYLE
      }
      if (saved.TRACKING_SOURCE === 'log' || saved.TRACKING_SOURCE === 'zeal' || saved.TRACKING_SOURCE === 'hybrid') {
        Config.TRACKING_SOURCE = saved.TRACKING_SOURCE
      }
      if (typeof saved.windowX === 'number' && typeof saved.windowY === 'number') {
        savedWindowPos = { x: saved.windowX, y: saved.windowY }
      }
      if (typeof saved.DYNAMIC_WEAVING    === 'boolean') Config.DYNAMIC_WEAVING    = saved.DYNAMIC_WEAVING
      if (typeof saved.SHOW_OFFHAND_TIMER === 'boolean') Config.SHOW_OFFHAND_TIMER = saved.SHOW_OFFHAND_TIMER
      if (typeof saved.VOLUME_MASTER         === 'number')  Config.VOLUME_MASTER         = saved.VOLUME_MASTER
      if (typeof saved.VOLUME_PROC           === 'number')  Config.VOLUME_PROC           = saved.VOLUME_PROC
      if (typeof saved.VOLUME_EPIC           === 'number')  Config.VOLUME_EPIC           = saved.VOLUME_EPIC
      if (typeof saved.CRIT_DAMAGE_THRESHOLD === 'number')  Config.CRIT_DAMAGE_THRESHOLD = saved.CRIT_DAMAGE_THRESHOLD
      if (typeof saved.HUGE_ROUND_THRESHOLD  === 'number')  Config.HUGE_ROUND_THRESHOLD  = saved.HUGE_ROUND_THRESHOLD
      if (typeof saved.BUFF_SOUND_ENABLED    === 'boolean') Config.BUFF_SOUND_ENABLED    = saved.BUFF_SOUND_ENABLED
      if (typeof saved.AUDIO_ENABLED         === 'boolean') Config.AUDIO_ENABLED         = saved.AUDIO_ENABLED
      if (typeof saved.WINDOW_PINNED         === 'boolean') Config.WINDOW_PINNED         = saved.WINDOW_PINNED
    }
  } catch {}
}

export function saveSettings(): void {
  try {
    const pos = win ? win.getPosition() : null
    const data: Record<string, unknown> = {
      OFFHAND_WEAPON_DELAY: Config.OFFHAND_WEAPON_DELAY,
      OFFHAND_WEAPON_NAME:  Config.OFFHAND_WEAPON_NAME,
      OVERLAY_STYLE:        Config.OVERLAY_STYLE,
      TRACKING_SOURCE:      Config.TRACKING_SOURCE,
      DYNAMIC_WEAVING:      Config.DYNAMIC_WEAVING,
      SHOW_OFFHAND_TIMER:   Config.SHOW_OFFHAND_TIMER,
      VOLUME_MASTER:         Config.VOLUME_MASTER,
      VOLUME_PROC:           Config.VOLUME_PROC,
      VOLUME_EPIC:           Config.VOLUME_EPIC,
      CRIT_DAMAGE_THRESHOLD: Config.CRIT_DAMAGE_THRESHOLD,
      HUGE_ROUND_THRESHOLD:  Config.HUGE_ROUND_THRESHOLD,
      BUFF_SOUND_ENABLED:    Config.BUFF_SOUND_ENABLED,
      AUDIO_ENABLED:         Config.AUDIO_ENABLED,
      WINDOW_PINNED:         Config.WINDOW_PINNED,
    }
    if (pos) { data.windowX = pos[0]; data.windowY = pos[1] }
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(data), 'utf8')
  } catch {}
}

export function setOverlayStyle(style: 'refined' | 'standard' | 'highcontrast'): void {
  Config.OVERLAY_STYLE = style
  saveSettings()
  if (!win) return
  // Re-apply pass-through after reload (renderer will re-capture on next hover)
  win.setIgnoreMouseEvents(true, { forward: true })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    win.loadURL(`${devUrl}?overlayStyle=${style}`)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { overlayStyle: style } })
  }
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

export function createSettingsWindow(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
    return
  }

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../src/icon/basketweaver-icon-256.png')

  settingsWin = new BrowserWindow({
    width:  540,
    height: 740,
    title:  'Basketweaver Settings',
    icon:   iconPath,
    resizable:   false,
    minimizable: true,
    maximizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  settingsWin.setMenu(null)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    // Derive the settings page URL from the index URL
    const base = devUrl.replace(/[?#].*$/, '').replace(/\/[^/]*\.html$/, '')
    settingsWin.loadURL(`${base}/settings.html`)
  } else {
    settingsWin.loadFile(path.join(__dirname, '../renderer/settings.html'))
  }

  settingsWin.on('closed', () => { settingsWin = null })
}

// ── App lifecycle ─────────────────────────────────────────────

let win:       BrowserWindow | null = null
let settingsWin: BrowserWindow | null = null
let stopLog:   (() => void) | null  = null
let stopZeal:  (() => void) | null  = null
let lastLogPath = ''

function createWindow(): void {
  const { x: dx, y: dy, width: dw, height: dh } = screen.getPrimaryDisplay().workArea
  const w = Config.WINDOW_WIDTH
  const h = Config.WINDOW_HEIGHT

  const defaultX = Math.trunc(dx + (dw - w) / 2)
  const defaultY = Math.trunc(dy + dh - h - 80)
  const usePos = savedWindowPos && isPosVisible(savedWindowPos.x, savedWindowPos.y)
    ? savedWindowPos
    : { x: defaultX, y: defaultY }

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../src/icon/basketweaver-icon-256.png')

  win = new BrowserWindow({
    width:  w,
    height: h,
    x: usePos.x,
    y: usePos.y,
    icon: iconPath,

    // Overlay properties
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: false,  // keep in taskbar so users can find it
    resizable:   false,
    movable:     false,

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
    win.loadURL(`${devUrl}?overlayStyle=${Config.OVERLAY_STYLE}`)
    win.webContents.openDevTools({ mode: 'detach' })
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { overlayStyle: Config.OVERLAY_STYLE } })
  }

  win.on('moved', () => saveSettings())
  win.on('close', () => saveSettings())
  win.on('closed', () => { win = null })
}

// ── Reader management ─────────────────────────────────────────

function stopAllReaders(): void {
  if (stopLog)  { stopLog();  stopLog  = null }
  if (stopZeal) { stopZeal(); stopZeal = null }
}

function startReader(logPath: string): void {
  stopAllReaders()
  lastLogPath = logPath
  Config.TRACKING_SOURCE = 'log'
  saveSettings()

  const reader = new LogReader(logPath, Config, (ev: GameEvent) => {
    win?.webContents.send(IPC.GAME_EVENT, ev)
  })
  stopLog = reader.start()
  saveLastLog(logPath)
  console.log(`[Basketweaver] Tailing: ${logPath}`)
}

function startZealReader(): void {
  stopAllReaders()
  Config.TRACKING_SOURCE = 'zeal'
  saveSettings()

  const reader = new ZealReader(Config, (ev: GameEvent) => {
    win?.webContents.send(IPC.GAME_EVENT, ev)
  })
  stopZeal = reader.start()
  console.log('[Basketweaver] Zeal pipe tracking active')
}

function startHybridReader(): void {
  stopAllReaders()
  Config.TRACKING_SOURCE = 'hybrid'
  saveSettings()

  const zealReader = new ZealReader(Config, (ev: GameEvent) => {
    win?.webContents.send(IPC.GAME_EVENT, ev)
  })
  stopZeal = zealReader.start()

  if (lastLogPath) {
    const missReader = new LogReader(lastLogPath, Config, (ev: GameEvent) => {
      win?.webContents.send(IPC.GAME_EVENT, ev)
    }, { missOnly: true })
    stopLog = missReader.start()
  }
  console.log('[Basketweaver] Hybrid tracking active (Zeal hits + Log misses)')
}

export function setTrackingSource(source: 'log' | 'zeal' | 'hybrid'): void {
  if (source === 'zeal') {
    startZealReader()
  } else if (source === 'hybrid') {
    startHybridReader()
  } else {
    if (lastLogPath) {
      startReader(lastLogPath)
    } else {
      stopAllReaders()
      Config.TRACKING_SOURCE = 'log'
      saveSettings()
    }
  }
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

/** Handle a newly selected log file, respecting the current tracking mode. */
function handleLogSelected(p: string): void {
  lastLogPath = p
  saveLastLog(p)
  if (Config.TRACKING_SOURCE === 'hybrid') {
    startHybridReader()
  } else {
    startReader(p)
  }
  win?.webContents.send(IPC.LOG_SELECTED, p)
}

// ── IPC handlers ──────────────────────────────────────────────

function setupIPC(): void {
  ipcMain.on(IPC.QUIT, () => app.quit())

  ipcMain.on(IPC.SELECT_LOG, async () => {
    const p = await pickLogFile()
    if (p) handleLogSelected(p)
  })

  ipcMain.on(IPC.SAVE_SETTINGS, () => saveSettings())

  ipcMain.on(IPC.FIGHT_HISTORY_UPDATE, (_e, fights: { label: string, full: string }[]) => updateFightHistory(fights))

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

  // Mouse pass-through: by default the overlay ignores mouse input so clicks
  // go to the game underneath. When the renderer detects hover it captures
  // temporarily, then releases after mouseup or mouseleave.
  ipcMain.on(IPC.CAPTURE_MOUSE, () => win?.setIgnoreMouseEvents(false))
  ipcMain.on(IPC.RELEASE_MOUSE, () => win?.setIgnoreMouseEvents(true, { forward: true }))

  // Status reply from renderer (used by tray menu refresh)
  ipcMain.on(IPC.STATUS_REPLY, (_e, data: { inCombat: boolean }) => {
    // Forwarded — tray listener handles this
  })

  ipcMain.handle(IPC.SETTINGS_GET, () => ({
    APP_VERSION:              app.getVersion(),
    VOLUME_MASTER:            Config.VOLUME_MASTER,
    VOLUME_PROC:              Config.VOLUME_PROC,
    VOLUME_EPIC:              Config.VOLUME_EPIC,
    CRIT_DAMAGE_THRESHOLD:    Config.CRIT_DAMAGE_THRESHOLD,
    HUGE_ROUND_THRESHOLD:     Config.HUGE_ROUND_THRESHOLD,
    TRACKING_SOURCE:          Config.TRACKING_SOURCE,
    OVERLAY_STYLE:            Config.OVERLAY_STYLE,
    BASE_WEAPON_DELAY:        Config.BASE_WEAPON_DELAY,
    OFFHAND_WEAPON_DELAY:     Config.OFFHAND_WEAPON_DELAY,
    PUNCH_INTERVAL:           Config.PUNCH_INTERVAL,
    TARGET_POSITION_PCT:      Config.TARGET_POSITION_PCT,
    TARGET_OFFSET:            Config.TARGET_OFFSET,
    LATENCY_COMPENSATION:     Config.LATENCY_COMPENSATION,
    CLIP_AUTO:                Config.CLIP_AUTO,
    CLIP_DETECTION_WINDOW:    Config.CLIP_DETECTION_WINDOW,
    WINDOW_OPACITY:           Config.WINDOW_OPACITY,
    ORIENTATION:              Config.ORIENTATION,
    DYNAMIC_WEAVING:          Config.DYNAMIC_WEAVING,
    SHOW_OFFHAND_TIMER:       Config.SHOW_OFFHAND_TIMER,
    KEYSTROKE_GRADING:        Config.KEYSTROKE_GRADING,
    FIST_SOUND_ON_MISS:       Config.FIST_SOUND_ON_MISS,
    BUFF_SOUND_ENABLED:       Config.BUFF_SOUND_ENABLED,
    AUDIO_ENABLED:            Config.AUDIO_ENABLED,
    WINDOW_PINNED:            Config.WINDOW_PINNED,
  }))

  ipcMain.on(IPC.SETTINGS_SET, (_e, { key, value }: { key: string; value: unknown }) => {
    switch (key) {
      case 'VOLUME_MASTER':
      case 'VOLUME_PROC':
      case 'VOLUME_EPIC':
        (Config as any)[key] = value
        win?.webContents.send(IPC.SET_VOLUMES, {
          master: Config.VOLUME_MASTER,
          proc:   Config.VOLUME_PROC,
          epic:   Config.VOLUME_EPIC,
        })
        break

      case 'CRIT_DAMAGE_THRESHOLD':
      case 'HUGE_ROUND_THRESHOLD':
        (Config as any)[key] = value
        win?.webContents.send(IPC.SET_THRESHOLDS, {
          critDamage: Config.CRIT_DAMAGE_THRESHOLD,
          hugeRound:  Config.HUGE_ROUND_THRESHOLD,
        })
        break

      case 'TRACKING_SOURCE':
        setTrackingSource(value as 'log' | 'zeal' | 'hybrid')
        return  // setTrackingSource already calls saveSettings

      case 'OVERLAY_STYLE':
        setOverlayStyle(value as 'refined' | 'standard' | 'highcontrast')
        return  // setOverlayStyle already calls saveSettings

      case 'OFFHAND_WEAPON_DELAY':
        Config.OFFHAND_WEAPON_DELAY = value as number
        Config.OFFHAND_WEAPON_NAME  = ''
        win?.webContents.send(IPC.SET_OFFHAND_DELAY, { delay: value, name: '' })
        break

      case 'TARGET_POSITION_PCT':
        win?.webContents.send(IPC.SET_TARGET_POSITION, value)
        break

      case 'WINDOW_OPACITY':
        Config.WINDOW_OPACITY = value as number
        win?.setOpacity(value as number)
        break

      case 'AUDIO_ENABLED':
        if (Config.AUDIO_ENABLED !== value) {
          Config.AUDIO_ENABLED = value as boolean
          win?.webContents.send(IPC.TOGGLE_AUDIO)
        }
        break

      case 'BUFF_SOUND_ENABLED':
        if (Config.BUFF_SOUND_ENABLED !== value) {
          Config.BUFF_SOUND_ENABLED = value as boolean
          win?.webContents.send(IPC.TOGGLE_BUFF_SOUND)
        }
        break

      case 'FIST_SOUND_ON_MISS':
        if (Config.FIST_SOUND_ON_MISS !== value) {
          Config.FIST_SOUND_ON_MISS = value as boolean
          win?.webContents.send(IPC.TOGGLE_FIST_MISS_SOUND)
        }
        break

      case 'DYNAMIC_WEAVING':
        if (Config.DYNAMIC_WEAVING !== value) {
          Config.DYNAMIC_WEAVING = value as boolean
          win?.webContents.send(IPC.TOGGLE_DYNAMIC_WEAVING)
        }
        break

      case 'SHOW_OFFHAND_TIMER':
        if (Config.SHOW_OFFHAND_TIMER !== value) {
          Config.SHOW_OFFHAND_TIMER = value as boolean
          win?.webContents.send(IPC.TOGGLE_OFFHAND_TIMER)
        }
        break

      case 'ORIENTATION_VERTICAL': {
        const newOri = (value as boolean) ? 'vertical' : 'horizontal'
        if (Config.ORIENTATION !== newOri) {
          Config.ORIENTATION = newOri
          win?.webContents.send(IPC.TOGGLE_ORIENTATION)
        }
        break
      }

      case 'WINDOW_PINNED':
        if (Config.WINDOW_PINNED !== value) {
          Config.WINDOW_PINNED = value as boolean
          win?.webContents.send(IPC.TOGGLE_PIN)
        }
        break

      default:
        // Simple Config update (BASE_WEAPON_DELAY, PUNCH_INTERVAL, TARGET_OFFSET,
        // LATENCY_COMPENSATION, CLIP_AUTO, CLIP_DETECTION_WINDOW, KEYSTROKE_GRADING, etc.)
        if (key in Config) (Config as any)[key] = value
    }
    saveSettings()
  })

  ipcMain.on(IPC.OPEN_SETTINGS, () => createSettingsWindow())
  ipcMain.on('close-settings', () => settingsWin?.close())
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

function recomputeGoodWindow(): void {
  const fistDelay = Config.OFFHAND_WEAPON_DELAY / 10 / (1 + Config.HASTE_PCT / 100)
  Config.GOOD_WINDOW = Math.max(0.1, Config.PUNCH_INTERVAL - fistDelay) / 2
}

app.whenReady().then(async () => {
  loadSettings()
  recomputeGoodWindow()
  setupIPC()
  createWindow()

  // Create tray
  createTray(win!, () => app.quit(), saveSettings, async () => {
    const p = await pickLogFile()
    if (p) handleLogSelected(p)
  }, resetWindowPosition, setOverlayStyle, setTrackingSource, createSettingsWindow)

  // Check for updates (no-op in dev mode)
  setupAutoUpdater()

  // Start the log reader once the window is ready
  // Pass clicks through to the underlying game by default.
  // The renderer toggles this off while the mouse is over the canvas.
  win!.setIgnoreMouseEvents(true, { forward: true })

  win!.webContents.on('did-finish-load', () => {
    // Sync saved settings to renderer (renderer has its own Config instance)
    win!.webContents.send(IPC.SET_OFFHAND_DELAY, {
      delay: Config.OFFHAND_WEAPON_DELAY,
      name:  Config.OFFHAND_WEAPON_NAME,
    })
    if (!Config.DYNAMIC_WEAVING)    win!.webContents.send(IPC.TOGGLE_DYNAMIC_WEAVING)
    if (!Config.SHOW_OFFHAND_TIMER) win!.webContents.send(IPC.TOGGLE_OFFHAND_TIMER)

    // Sync audio volumes and thresholds to renderer
    win!.webContents.send(IPC.SET_VOLUMES, {
      master: Config.VOLUME_MASTER,
      proc:   Config.VOLUME_PROC,
      epic:   Config.VOLUME_EPIC,
    })
    win!.webContents.send(IPC.SET_THRESHOLDS, {
      critDamage: Config.CRIT_DAMAGE_THRESHOLD,
      hugeRound:  Config.HUGE_ROUND_THRESHOLD,
    })
    // Sync pinned state
    if (!Config.WINDOW_PINNED) win!.webContents.send(IPC.TOGGLE_PIN)

    if (Config.TRACKING_SOURCE === 'zeal') {
      startZealReader()
      return
    }
    if (Config.TRACKING_SOURCE === 'hybrid') {
      const logPath = loadLastLog()
      if (logPath) {
        lastLogPath = logPath
        saveLastLog(logPath)
        win?.webContents.send(IPC.LOG_SELECTED, logPath)
      }
      startHybridReader()
      return
    }
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
  stopAllReaders()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

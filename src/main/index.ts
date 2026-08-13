/**
 * Basketweaver — Electron main process.
 *
 * Responsibilities:
 *   • Create the transparent, frameless, always-on-top overlay window
 *   • Tail the EQ log file and forward GameEvents to the renderer via IPC
 *   • Host the system tray
 *   • Handle file picker, opacity, and window resize requests
 */

import { app, BrowserWindow, ipcMain, dialog, screen, shell } from 'electron'
import * as path from 'path'
import { performance } from 'perf_hooks'
import { Config } from '../shared/config'
import { IPC, EvType, type GameEvent, type HitRecord } from '../shared/events'

// Build-time constants injected by electron-vite define (see electron.vite.config.ts).
declare const __LEADERBOARD_WORKER_URL__: string
declare const __LEADERBOARD_API_KEY__:    string
import { LogReader } from './log-reader'
import { ZealReader } from './zeal-reader'
import { LeaderboardManager } from './leaderboard-manager'
import { createTray, updateFightHistory, updateTopRecords } from './tray'
import { autoUpdater } from 'electron-updater'
import type { EncounterRecord } from '../shared/leaderboard-types'

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

// ── Per-character weapon sets ─────────────────────────────────

interface WeaponSet {
  BASE_WEAPON_DELAY:   number
  BASE_WEAPON_NAME:    string
  MAINHAND_ATTACK_TYPE: string
  OFFHAND_WEAPON_DELAY: number
  OFFHAND_WEAPON_NAME:  string
}

const CHAR_WEAPONS_FILE = () => path.join(configDir(), 'character-weapons.json')

function loadAllCharacterWeapons(): Record<string, WeaponSet> {
  try {
    const p = CHAR_WEAPONS_FILE()
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {}
  return {}
}

function saveCharacterWeapons(): void {
  const charName = Config.LEADERBOARD_CHARACTER_NAME
  if (!charName) return
  try {
    const all = loadAllCharacterWeapons()
    all[charName] = {
      BASE_WEAPON_DELAY:    Config.BASE_WEAPON_DELAY,
      BASE_WEAPON_NAME:     Config.BASE_WEAPON_NAME,
      MAINHAND_ATTACK_TYPE: Config.MAINHAND_ATTACK_TYPE,
      OFFHAND_WEAPON_DELAY: Config.OFFHAND_WEAPON_DELAY,
      OFFHAND_WEAPON_NAME:  Config.OFFHAND_WEAPON_NAME,
    }
    fs.writeFileSync(CHAR_WEAPONS_FILE(), JSON.stringify(all, null, 2), 'utf8')
  } catch (err) {
    console.error('[CharWeapons] Failed to save:', err)
  }
}

function applyCharacterWeapons(charName: string, skipReaderRestart = false): void {
  const all = loadAllCharacterWeapons()
  const ws = all[charName]
  if (!ws) return

  const prevAttackType = Config.MAINHAND_ATTACK_TYPE
  Config.BASE_WEAPON_DELAY    = ws.BASE_WEAPON_DELAY
  Config.BASE_WEAPON_NAME     = ws.BASE_WEAPON_NAME
  Config.MAINHAND_ATTACK_TYPE = ws.MAINHAND_ATTACK_TYPE as 'crush' | 'slash' | 'pierce' | 'punch'
  Config.OFFHAND_WEAPON_DELAY = ws.OFFHAND_WEAPON_DELAY
  Config.OFFHAND_WEAPON_NAME  = ws.OFFHAND_WEAPON_NAME

  // Notify overlay renderer
  win?.webContents.send(IPC.SET_BASE_WEAPON_DELAY, ws.BASE_WEAPON_DELAY)
  win?.webContents.send(IPC.SET_OFFHAND_DELAY, { delay: ws.OFFHAND_WEAPON_DELAY, name: ws.OFFHAND_WEAPON_NAME })

  // Refresh settings window if open — it will re-read SETTINGS_GET on next open,
  // but if already open send a reload signal so weapon fields update immediately.
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('character-weapons-loaded', ws)
  }

  // Restart the log reader only when the attack type changed and not already restarting.
  // handleLogSelected always restarts the reader itself so we skip it there.
  if (!skipReaderRestart) {
    if (ws.MAINHAND_ATTACK_TYPE !== prevAttackType) {
      if (Config.TRACKING_SOURCE === 'hybrid') {
        startHybridReader()
      } else if (lastLogPath) {
        startReader(lastLogPath)
      }
    } else if (activeLogReader) {
      activeLogReader.updateAttackType(Config.MAINHAND_ATTACK_TYPE)
    }
  }

  console.log(`[CharWeapons] Loaded weapons for ${charName}: ${ws.BASE_WEAPON_NAME} / ${ws.OFFHAND_WEAPON_NAME}`)
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
      if (typeof saved.BASE_WEAPON_NAME     === 'string') Config.BASE_WEAPON_NAME     = saved.BASE_WEAPON_NAME
      if (saved.OVERLAY_STYLE === 'refined' || saved.OVERLAY_STYLE === 'highcontrast') {
        Config.OVERLAY_STYLE = saved.OVERLAY_STYLE
      } else if (saved.OVERLAY_STYLE === 'standard') {
        Config.OVERLAY_STYLE = 'refined'  // migrate old 'standard' setting to 'refined'
      }
      if (saved.TRACKING_SOURCE === 'log' || saved.TRACKING_SOURCE === 'hybrid') {
        Config.TRACKING_SOURCE = saved.TRACKING_SOURCE
      } else if (saved.TRACKING_SOURCE === 'zeal') {
        Config.TRACKING_SOURCE = 'hybrid'  // migrate old 'zeal' setting to 'hybrid'
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
      if (typeof saved.BUFF_SOUND_ENABLED         === 'boolean') Config.BUFF_SOUND_ENABLED         = saved.BUFF_SOUND_ENABLED
      if (typeof saved.AUDIO_ENABLED              === 'boolean') Config.AUDIO_ENABLED              = saved.AUDIO_ENABLED
      if (typeof saved.WINDOW_PINNED              === 'boolean') Config.WINDOW_PINNED              = saved.WINDOW_PINNED
      if (saved.ALWAYS_ON_TOP_MODE === 'standard' || saved.ALWAYS_ON_TOP_MODE === 'elevated' || saved.ALWAYS_ON_TOP_MODE === 'aggressive') {
        Config.ALWAYS_ON_TOP_MODE = saved.ALWAYS_ON_TOP_MODE
      }
      if (typeof saved.POSITIVE_AUDIO_IN_WINDOW   === 'boolean') Config.POSITIVE_AUDIO_IN_WINDOW   = saved.POSITIVE_AUDIO_IN_WINDOW
      if (typeof saved.LEADERBOARD_CHARACTER_NAME  === 'string')  Config.LEADERBOARD_CHARACTER_NAME  = saved.LEADERBOARD_CHARACTER_NAME
      if (typeof saved.LEADERBOARD_OPT_OUT         === 'boolean') Config.LEADERBOARD_OPT_OUT         = saved.LEADERBOARD_OPT_OUT
      if (typeof saved.AUTO_DETECT_LOG             === 'boolean') Config.AUTO_DETECT_LOG             = saved.AUTO_DETECT_LOG
      if (Array.isArray(saved.IGNORED_CHARACTERS)) {
        Config.IGNORED_CHARACTERS = saved.IGNORED_CHARACTERS.filter((v: unknown) => typeof v === 'string')
      }
      if (typeof saved.ROGUE_MODE_ENABLED      === 'boolean') Config.ROGUE_MODE_ENABLED      = saved.ROGUE_MODE_ENABLED
      if (typeof saved.ROGUE_BACKSTAB_SET_NAME === 'string')  Config.ROGUE_BACKSTAB_SET_NAME = saved.ROGUE_BACKSTAB_SET_NAME
      if (typeof saved.WEAVE_KEY_CODE     === 'number') Config.WEAVE_KEY_CODE     = saved.WEAVE_KEY_CODE
      if (typeof saved.WEAVE_KEY_DISPLAY  === 'string') Config.WEAVE_KEY_DISPLAY  = saved.WEAVE_KEY_DISPLAY
      if (typeof saved.WEAVE_KEY2_CODE    === 'number') Config.WEAVE_KEY2_CODE    = saved.WEAVE_KEY2_CODE
      if (typeof saved.WEAVE_KEY2_DISPLAY === 'string') Config.WEAVE_KEY2_DISPLAY = saved.WEAVE_KEY2_DISPLAY
      if (typeof saved.BASE_WEAPON_DELAY === 'number') Config.BASE_WEAPON_DELAY = saved.BASE_WEAPON_DELAY
      if (saved.MAINHAND_ATTACK_TYPE === 'crush' || saved.MAINHAND_ATTACK_TYPE === 'slash' ||
          saved.MAINHAND_ATTACK_TYPE === 'pierce' || saved.MAINHAND_ATTACK_TYPE === 'punch') {
        Config.MAINHAND_ATTACK_TYPE = saved.MAINHAND_ATTACK_TYPE
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
      BASE_WEAPON_DELAY:    Config.BASE_WEAPON_DELAY,
      BASE_WEAPON_NAME:     Config.BASE_WEAPON_NAME,
      OVERLAY_STYLE:        Config.OVERLAY_STYLE,
      TRACKING_SOURCE:      Config.TRACKING_SOURCE,
      DYNAMIC_WEAVING:      Config.DYNAMIC_WEAVING,
      SHOW_OFFHAND_TIMER:   Config.SHOW_OFFHAND_TIMER,
      VOLUME_MASTER:         Config.VOLUME_MASTER,
      VOLUME_PROC:           Config.VOLUME_PROC,
      VOLUME_EPIC:           Config.VOLUME_EPIC,
      CRIT_DAMAGE_THRESHOLD: Config.CRIT_DAMAGE_THRESHOLD,
      HUGE_ROUND_THRESHOLD:  Config.HUGE_ROUND_THRESHOLD,
      BUFF_SOUND_ENABLED:        Config.BUFF_SOUND_ENABLED,
      AUDIO_ENABLED:             Config.AUDIO_ENABLED,
      WINDOW_PINNED:             Config.WINDOW_PINNED,
      ALWAYS_ON_TOP_MODE:        Config.ALWAYS_ON_TOP_MODE,
      POSITIVE_AUDIO_IN_WINDOW:  Config.POSITIVE_AUDIO_IN_WINDOW,
      LEADERBOARD_CHARACTER_NAME: Config.LEADERBOARD_CHARACTER_NAME,
      LEADERBOARD_OPT_OUT:        Config.LEADERBOARD_OPT_OUT,
      IGNORED_CHARACTERS:         Config.IGNORED_CHARACTERS,
      ROGUE_MODE_ENABLED:         Config.ROGUE_MODE_ENABLED,
      ROGUE_BACKSTAB_SET_NAME:    Config.ROGUE_BACKSTAB_SET_NAME,
      MAINHAND_ATTACK_TYPE:       Config.MAINHAND_ATTACK_TYPE,
      AUTO_DETECT_LOG:            Config.AUTO_DETECT_LOG,
      WEAVE_KEY_CODE:             Config.WEAVE_KEY_CODE,
      WEAVE_KEY_DISPLAY:          Config.WEAVE_KEY_DISPLAY,
      WEAVE_KEY2_CODE:            Config.WEAVE_KEY2_CODE,
      WEAVE_KEY2_DISPLAY:         Config.WEAVE_KEY2_DISPLAY,
    }
    if (pos) { data.windowX = pos[0]; data.windowY = pos[1] }
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(data), 'utf8')
  } catch {}
}

export function setOverlayStyle(style: 'refined' | 'highcontrast'): void {
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

  // Keep above the DPS overlay, which is also always-on-top and can otherwise
  // reclaim the topmost z-order (e.g. when a setting change re-asserts it via
  // updateOverlayAlwaysOnTop), blocking clicks on whatever it visually covers.
  settingsWin.setAlwaysOnTop(true, 'floating')

  settingsWin.setMenu(null)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    // Derive the settings page URL from the index URL
    const base = devUrl.replace(/[?#].*$/, '').replace(/\/[^/]*\.html$/, '')
    settingsWin.loadURL(`${base}/settings.html`)
  } else {
    settingsWin.loadFile(path.join(__dirname, '../renderer/settings.html'))
  }

  settingsWin.on('closed', () => {
    settingsWin = null
    learnKeyHandler  = null
    learnKeyHandler2 = null
  })
}

// ── Auto log detection ────────────────────────────────────────

let autoDetectTimer: ReturnType<typeof setInterval> | null = null
const autoDetectPrevSizes = new Map<string, number>()

function normalizePath(p: string): string {
  return path.normalize(p).toLowerCase()
}

function startAutoDetect(): void {
  stopAutoDetect()
  const dir = lastLogPath ? path.dirname(lastLogPath) : null
  if (!dir) return

  autoDetectTimer = setInterval(() => {
    const currentNorm = normalizePath(lastLogPath)
    try {
      const files = fs.readdirSync(dir).filter(f => /^eqlog_.+\.txt$/i.test(f))
      for (const file of files) {
        const fullPath = path.join(dir, file)
        try {
          const stat = fs.statSync(fullPath)
          const prev = autoDetectPrevSizes.get(fullPath) ?? stat.size
          autoDetectPrevSizes.set(fullPath, stat.size)
          if (stat.size > prev && normalizePath(fullPath) !== currentNorm) {
            console.log(`[AutoDetect] Switching to active log: ${fullPath}`)
            handleLogSelected(fullPath)
            // Restart watcher with the new directory (may be same dir, but clears stale sizes)
            startAutoDetect()
            return
          }
        } catch {}
      }
    } catch {}
  }, 2000)
}

function stopAutoDetect(): void {
  if (autoDetectTimer) {
    clearInterval(autoDetectTimer)
    autoDetectTimer = null
  }
  autoDetectPrevSizes.clear()
}

// ── App lifecycle ─────────────────────────────────────────────

let win:          BrowserWindow | null = null
let settingsWin:  BrowserWindow | null = null
let leaderboardWin: BrowserWindow | null = null
let stopLog:       (() => void) | null  = null
let stopDamageLog: (() => void) | null  = null
let stopZeal:      (() => void) | null  = null
let activeZealReader: ZealReader | null = null
let activeLogReader: import('./log-reader').LogReader | null = null
let lastLogPath = ''
// The character identified from the log filename / Zeal pipe — distinct from
// Config.LEADERBOARD_CHARACTER_NAME, which the user can freely edit in Settings
// for leaderboard-submission purposes. Only this drives the ignore-list check.
let identifiedCharacterName = ''

let leaderboardManager: LeaderboardManager

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
    title: 'Basketweaver',

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
      autoplayPolicy:   'no-user-gesture-required',
    },
  })

  // Set initial opacity
  win.setOpacity(Config.WINDOW_OPACITY)
  updateOverlayAlwaysOnTop()

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
  win.on('closed', () => { win = null; stopAlwaysOnTopReassert() })
}

// ── Reader management ─────────────────────────────────────────

function stopAllReaders(): void {
  if (stopLog)       { stopLog();       stopLog       = null }
  if (stopDamageLog) { stopDamageLog(); stopDamageLog = null }
  if (stopZeal)      { stopZeal();      stopZeal      = null }
  activeLogReader = null
  activeZealReader = null
}

function forwardEvent(ev: GameEvent): void {
  // When a weapon is detected, update the active log reader's attack-type regexes
  // so miss patterns stay in sync (e.g. switching to a slash weapon mid-session).
  if (ev.type === EvType.WEAPON_DETECTED && activeLogReader) {
    activeLogReader.updateAttackType(Config.MAINHAND_ATTACK_TYPE)
  }
  win?.webContents.send(IPC.GAME_EVENT, ev)
}

function startReader(logPath: string): void {
  stopAllReaders()
  lastLogPath = logPath
  Config.TRACKING_SOURCE = 'log'
  saveSettings()

  const reader = new LogReader(logPath, Config, forwardEvent)
  activeLogReader = reader
  stopLog = reader.start()
  saveLastLog(logPath)
  console.log(`[Basketweaver] Tailing: ${logPath}`)
}

function startHybridReader(): void {
  stopAllReaders()
  Config.TRACKING_SOURCE = 'hybrid'
  saveSettings()

  // Zeal handles timing/state; strip damage from its hit events so that
  // the damageOnly log reader below is the sole source for DPS values.
  function forwardZealEvent(ev: GameEvent): void {
    if (ev.type === EvType.MAINHAND_CRUSH || ev.type === EvType.FIST_ATTACK || ev.type === EvType.BACKSTAB_ATTACK) {
      ev = { ...ev, data: { ...ev.data, damage: 0 } }
    } else if (ev.type === EvType.MISC_DAMAGE) {
      return  // suppressed; log reader emits LOG_DAMAGE for these
    }
    forwardEvent(ev)
  }

  const zealReader = new ZealReader(Config, forwardZealEvent, (name) => {
    identifiedCharacterName = name
    updateOverlayAlwaysOnTop()
    // ZealReader already populated Config.LEADERBOARD_CHARACTER_NAME (if the
    // user hadn't already set one). Propagate it to the overlay/settings
    // renderers — each runs its own Config instance — and persist it, so
    // leaderboard uploads have a character name even when no log file was
    // ever manually selected.
    win?.webContents.send(IPC.CHARACTER_DETECTED, Config.LEADERBOARD_CHARACTER_NAME)
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send(IPC.CHARACTER_DETECTED, Config.LEADERBOARD_CHARACTER_NAME)
    }
    saveSettings()
  }, configDir())
  activeZealReader = zealReader
  stopZeal = zealReader.start()

  if (lastLogPath) {
    // missOnly + noBandolier: log handles misses; Zeal pipe owns bandolier detection
    const missReader = new LogReader(lastLogPath, Config, forwardEvent,
      { missOnly: true, noBandolier: true })
    activeLogReader = missReader
    stopLog = missReader.start()

    // damageOnly: log is the authoritative source for all damage values
    const damageReader = new LogReader(lastLogPath, Config, forwardEvent,
      { damageOnly: true })
    stopDamageLog = damageReader.start()
  }
  console.log('[Basketweaver] Hybrid tracking active (Zeal hits + Log misses + Log damage)')
}

export function setTrackingSource(source: 'log' | 'hybrid'): void {
  if (source === 'hybrid') {
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

// ── Ignored characters / overlay always-on-top ──────────────────

function isCharacterIgnored(name: string): boolean {
  if (!name) return false
  const n = name.trim().toLowerCase()
  return Config.IGNORED_CHARACTERS.some(c => c.trim().toLowerCase() === n)
}

let alwaysOnTopReassertTimer: ReturnType<typeof setInterval> | null = null

function stopAlwaysOnTopReassert(): void {
  if (alwaysOnTopReassertTimer) {
    clearInterval(alwaysOnTopReassertTimer)
    alwaysOnTopReassertTimer = null
  }
}

/** Apply the overlay's always-on-top state per the configured mode. */
function applyAlwaysOnTop(enable: boolean): void {
  if (!win) return
  if (!enable) {
    stopAlwaysOnTopReassert()
    win.setAlwaysOnTop(false)
    return
  }
  const level = Config.ALWAYS_ON_TOP_MODE === 'standard' ? undefined : 'screen-saver'
  if (level) win.setAlwaysOnTop(true, level)
  else win.setAlwaysOnTop(true)

  if (Config.ALWAYS_ON_TOP_MODE === 'aggressive') {
    if (!alwaysOnTopReassertTimer) {
      alwaysOnTopReassertTimer = setInterval(() => {
        if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'screen-saver')
      }, 2000)
    }
  } else {
    stopAlwaysOnTopReassert()
  }
}

/** Keep the overlay's always-on-top state in sync with the active character and mode. */
function updateOverlayAlwaysOnTop(): void {
  if (!win) return
  applyAlwaysOnTop(!isCharacterIgnored(identifiedCharacterName))
}

/** Handle a newly selected log file, respecting the current tracking mode. */
function handleLogSelected(p: string): void {
  lastLogPath = p
  saveLastLog(p)
  // Auto-derive character name from log filename: eqlog_CharName_Server.txt
  const filename = path.basename(p)
  const m = filename.match(/^eqlog_([^_]+)_/i)
  if (m) {
    identifiedCharacterName = m[1]
    Config.LEADERBOARD_CHARACTER_NAME = m[1]
    applyCharacterWeapons(m[1], true)
  }
  updateOverlayAlwaysOnTop()
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

  ipcMain.on(IPC.TOP_RECORDS_UPDATE, (_e, data: { crits: HitRecord[], hugeRounds: HitRecord[] }) => {
    updateTopRecords(data.crits, data.hugeRounds)
  })

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

  ipcMain.handle(IPC.GET_LOG_CHARACTERS, () => {
    const dir = lastLogPath ? path.dirname(lastLogPath) : null
    if (!dir) return []
    try {
      const files = fs.readdirSync(dir).filter(f => /^eqlog_.+\.txt$/i.test(f))
      const names = new Set<string>()
      for (const file of files) {
        const m = file.match(/^eqlog_([^_]+)_/i)
        if (m) names.add(m[1])
      }
      return [...names].sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  })

  ipcMain.handle(IPC.ZEAL_STATUS_GET, () => {
    if (Config.TRACKING_SOURCE !== 'hybrid' || !activeZealReader) {
      return {
        pipeConnected: false, characterName: '', msSinceLastSwingData: null,
        eqProcessFound: false, lastPipeError: null, scanError: null,
      }
    }
    return activeZealReader.getStatus()
  })

  ipcMain.handle(IPC.ZEAL_LOG_OPEN, async () => {
    const logPath = path.join(configDir(), 'zeal-reader.log')
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, '', 'utf8')
    }
    const err = await shell.openPath(logPath)
    return err ? err : null
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
    BASE_WEAPON_NAME:         Config.BASE_WEAPON_NAME,
    OFFHAND_WEAPON_DELAY:     Config.OFFHAND_WEAPON_DELAY,
    PUNCH_INTERVAL:           Config.PUNCH_INTERVAL,
    TARGET_POSITION_PCT:      Config.TARGET_POSITION_PCT,
    TARGET_OFFSET:            Config.TARGET_OFFSET,
    LATENCY_COMPENSATION:     Config.LATENCY_COMPENSATION,
    CLIP_AUTO:                Config.CLIP_AUTO,
    CLIP_DETECTION_WINDOW:    Config.CLIP_DETECTION_WINDOW,
    WINDOW_OPACITY:           Config.WINDOW_OPACITY,
    DYNAMIC_WEAVING:          Config.DYNAMIC_WEAVING,
    SHOW_OFFHAND_TIMER:       Config.SHOW_OFFHAND_TIMER,
    KEYSTROKE_GRADING:        Config.KEYSTROKE_GRADING,
    SHOW_ALL_CRITS:               Config.SHOW_ALL_CRITS,
    POSITIVE_AUDIO_IN_WINDOW:     Config.POSITIVE_AUDIO_IN_WINDOW,
    FIST_SOUND_ON_MISS:       Config.FIST_SOUND_ON_MISS,
    BUFF_SOUND_ENABLED:       Config.BUFF_SOUND_ENABLED,
    AUDIO_ENABLED:            Config.AUDIO_ENABLED,
    WINDOW_PINNED:            Config.WINDOW_PINNED,
    ALWAYS_ON_TOP_MODE:       Config.ALWAYS_ON_TOP_MODE,
    AUTO_DETECT_LOG:          Config.AUTO_DETECT_LOG,
    LEADERBOARD_CHARACTER_NAME: Config.LEADERBOARD_CHARACTER_NAME,
    LEADERBOARD_OPT_OUT:        Config.LEADERBOARD_OPT_OUT,
    IGNORED_CHARACTERS:         Config.IGNORED_CHARACTERS,
    ROGUE_MODE_ENABLED:         Config.ROGUE_MODE_ENABLED,
    ROGUE_BACKSTAB_SET_NAME:    Config.ROGUE_BACKSTAB_SET_NAME,
    OFFHAND_CRUSH_ENABLED:        Config.OFFHAND_CRUSH_ENABLED,
    WEAVE_BANDOLIER_OFF_DELAY_MS: Config.WEAVE_BANDOLIER_OFF_DELAY_MS,
    AUDIO_DEBOUNCE_MS:            Config.AUDIO_DEBOUNCE_MS,
    WEAVE_WINDOW_MS:              Config.WEAVE_WINDOW_MS,
    DW_ROLL_FAIL_DELAY_MS:        Config.DW_ROLL_FAIL_DELAY_MS,
    INFERRED_DW_CHECKS:           Config.INFERRED_DW_CHECKS,
    MAINHAND_ATTACK_TYPE:         Config.MAINHAND_ATTACK_TYPE,
    WEAVE_KEY_CODE:               Config.WEAVE_KEY_CODE,
    WEAVE_KEY_DISPLAY:            Config.WEAVE_KEY_DISPLAY,
    WEAVE_KEY2_CODE:              Config.WEAVE_KEY2_CODE,
    WEAVE_KEY2_DISPLAY:           Config.WEAVE_KEY2_DISPLAY,
  }))

  ipcMain.on(IPC.SETTINGS_SET, (_e, { key, value }: { key: string; value: unknown }) => {
    switch (key) {
      case 'VOLUME_MASTER':
      case 'VOLUME_PROC':
      case 'VOLUME_EPIC':
      case 'AUDIO_DEBOUNCE_MS':
        (Config as any)[key] = value
        win?.webContents.send(IPC.SET_VOLUMES, {
          master:     Config.VOLUME_MASTER,
          proc:       Config.VOLUME_PROC,
          epic:       Config.VOLUME_EPIC,
          debounceMs: Config.AUDIO_DEBOUNCE_MS,
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
        setTrackingSource(value as 'log' | 'hybrid')
        return  // setTrackingSource already calls saveSettings

      case 'OVERLAY_STYLE':
        setOverlayStyle(value as 'refined' | 'highcontrast')
        return  // setOverlayStyle already calls saveSettings

      case 'OFFHAND_WEAPON_DELAY':
        Config.OFFHAND_WEAPON_DELAY = value as number
        win?.webContents.send(IPC.SET_OFFHAND_DELAY, { delay: value, name: Config.OFFHAND_WEAPON_NAME })
        saveCharacterWeapons()
        break

      case 'OFFHAND_WEAPON_NAME':
        Config.OFFHAND_WEAPON_NAME = value as string
        win?.webContents.send(IPC.SET_OFFHAND_DELAY, { delay: Config.OFFHAND_WEAPON_DELAY, name: value })
        saveCharacterWeapons()
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

      case 'WINDOW_PINNED':
        if (Config.WINDOW_PINNED !== value) {
          Config.WINDOW_PINNED = value as boolean
          win?.webContents.send(IPC.TOGGLE_PIN)
        }
        break

      case 'ALWAYS_ON_TOP_MODE':
        if (Config.ALWAYS_ON_TOP_MODE !== value) {
          Config.ALWAYS_ON_TOP_MODE = value as 'standard' | 'elevated' | 'aggressive'
          updateOverlayAlwaysOnTop()
        }
        break

      case 'SHOW_ALL_CRITS':
        Config.SHOW_ALL_CRITS = value as boolean
        win?.webContents.send(IPC.SET_SHOW_ALL_CRITS, value)
        break

      case 'KEYSTROKE_GRADING':
        Config.KEYSTROKE_GRADING = value as boolean
        win?.webContents.send(IPC.SET_KEYSTROKE_GRADING, value)
        break

      case 'POSITIVE_AUDIO_IN_WINDOW':
        Config.POSITIVE_AUDIO_IN_WINDOW = value as boolean
        win?.webContents.send(IPC.SET_POSITIVE_AUDIO_IN_WINDOW, value)
        break

      case 'PUNCH_INTERVAL':
        Config.PUNCH_INTERVAL = value as number
        win?.webContents.send(IPC.SET_PUNCH_INTERVAL, value)
        break

      case 'WEAVE_WINDOW_MS':
        Config.WEAVE_WINDOW_MS = value as number
        win?.webContents.send(IPC.SET_WEAVE_WINDOW_MS, value)
        break

      case 'DW_ROLL_FAIL_DELAY_MS':
        Config.DW_ROLL_FAIL_DELAY_MS = value as number
        win?.webContents.send(IPC.SET_DW_ROLL_FAIL_DELAY_MS, value)
        break

      case 'INFERRED_DW_CHECKS':
        Config.INFERRED_DW_CHECKS = value as boolean
        win?.webContents.send(IPC.SET_INFERRED_DW_CHECKS, value)
        break

      case 'BASE_WEAPON_DELAY':
        Config.BASE_WEAPON_DELAY = value as number
        win?.webContents.send(IPC.SET_BASE_WEAPON_DELAY, value)
        saveCharacterWeapons()
        break

      case 'BASE_WEAPON_NAME':
        Config.BASE_WEAPON_NAME = value as string
        saveCharacterWeapons()
        break

      case 'MAINHAND_ATTACK_TYPE':
        Config.MAINHAND_ATTACK_TYPE = value as 'crush' | 'slash' | 'pierce' | 'punch'
        // Restart reader to recompile verb patterns
        if (Config.TRACKING_SOURCE === 'hybrid') {
          startHybridReader()
        } else if (lastLogPath) {
          startReader(lastLogPath)
        }
        saveCharacterWeapons()
        break

      case 'LEADERBOARD_CHARACTER_NAME':
        (Config as any)[key] = value
        break

      case 'LEADERBOARD_OPT_OUT':
        Config.LEADERBOARD_OPT_OUT = value as boolean
        break

      case 'IGNORED_CHARACTERS':
        Config.IGNORED_CHARACTERS = Array.isArray(value)
          ? (value as unknown[]).filter((v): v is string => typeof v === 'string')
          : []
        updateOverlayAlwaysOnTop()
        break

      case 'ROGUE_MODE_ENABLED':
        if (Config.ROGUE_MODE_ENABLED !== value) {
          Config.ROGUE_MODE_ENABLED = value as boolean
          win?.webContents.send(IPC.TOGGLE_ROGUE_MODE)
        }
        break

      case 'ROGUE_BACKSTAB_SET_NAME':
        Config.ROGUE_BACKSTAB_SET_NAME = value as string
        break

      case 'AUTO_DETECT_LOG':
        Config.AUTO_DETECT_LOG = value as boolean
        if (Config.AUTO_DETECT_LOG) {
          startAutoDetect()
        } else {
          stopAutoDetect()
        }
        break

      case 'WEAVE_KEY_CODE':
        Config.WEAVE_KEY_CODE = value as number
        break

      case 'WEAVE_KEY_DISPLAY':
        Config.WEAVE_KEY_DISPLAY = value as string
        break

      case 'WEAVE_KEY2_CODE':
        Config.WEAVE_KEY2_CODE = value as number
        break

      case 'WEAVE_KEY2_DISPLAY':
        Config.WEAVE_KEY2_DISPLAY = value as string
        break

      default:
        // Simple Config update (BASE_WEAPON_DELAY, PUNCH_INTERVAL, TARGET_OFFSET,
        // LATENCY_COMPENSATION, CLIP_AUTO, CLIP_DETECTION_WINDOW, KEYSTROKE_GRADING, etc.)
        if (key in Config) (Config as any)[key] = value
    }
    saveSettings()
  })

  ipcMain.on(IPC.OPEN_SETTINGS, () => createSettingsWindow())
  ipcMain.on('close-settings', () => { learnKeyHandler = null; learnKeyHandler2 = null; settingsWin?.close() })
  setupWeaveKeyLearnIPC()

  // ── Leaderboard IPC ───────────────────────────────────────────

  ipcMain.on(IPC.LEADERBOARD_RECORD, async (_e, record: EncounterRecord) => {
    // Stamp authoritatively — never trust a version string from the renderer.
    record.appVersion = app.getVersion()
    leaderboardManager.addRecord(record)
    // Forward to leaderboard window if open
    if (leaderboardWin && !leaderboardWin.isDestroyed()) {
      leaderboardWin.webContents.send(IPC.LEADERBOARD_DATA, leaderboardManager.getAll())
    }
    // Upload automatically when a character is identified and mob is on the allowlist.
    // Worker URL and API key are embedded at build time — no user configuration required.
    if (Config.LEADERBOARD_OPT_OUT) {
      leaderboardManager.log(`[Leaderboard] Skipping upload for "${record.mobName}" (user opted out)`)
    } else if (!Config.LEADERBOARD_CHARACTER_NAME) {
      leaderboardManager.log(`[Leaderboard] Skipping upload for "${record.mobName}" (no character name identified)`)
    } else if (!__LEADERBOARD_WORKER_URL__ || !__LEADERBOARD_API_KEY__) {
      leaderboardManager.log(`[Leaderboard] Skipping upload for "${record.mobName}" (build is missing worker URL/API key)`)
    } else if (!LeaderboardManager.isOnlineEligible(record.mobName)) {
      leaderboardManager.log(`[Leaderboard] Skipping upload for "${record.mobName}" (not on allowlist)`)
    } else {
      const ok = await leaderboardManager.upload(record, __LEADERBOARD_WORKER_URL__, __LEADERBOARD_API_KEY__)
      leaderboardManager.log(`[Leaderboard] Upload ${ok ? 'OK' : 'FAILED'} for "${record.mobName}" (v${record.appVersion}, char "${record.characterName}")`)
    }
  })

  ipcMain.handle(IPC.LEADERBOARD_GET, () => leaderboardManager.getAll())

  ipcMain.on(IPC.LEADERBOARD_OPEN, () => createLeaderboardWindow())
}

export function createLeaderboardWindow(): void {
  if (leaderboardWin && !leaderboardWin.isDestroyed()) {
    leaderboardWin.focus()
    return
  }

  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../src/icon/basketweaver-icon-256.png')

  leaderboardWin = new BrowserWindow({
    width:  1380,
    height: 640,
    title:  'Basketweaver Leaderboard',
    icon:   iconPath,
    resizable:   true,
    minimizable: true,
    maximizable: true,
    skipTaskbar: false,
    webPreferences: {
      preload:          path.join(__dirname, '../preload/leaderboard.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
  })

  // Keep above the DPS overlay for the same reason as the settings window.
  leaderboardWin.setAlwaysOnTop(true, 'floating')

  leaderboardWin.setMenu(null)

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    const base = devUrl.replace(/[?#].*$/, '').replace(/\/[^/]*\.html$/, '')
    leaderboardWin.loadURL(`${base}/leaderboard.html`)
  } else {
    leaderboardWin.loadFile(path.join(__dirname, '../renderer/leaderboard.html'))
  }

  leaderboardWin.webContents.on('did-finish-load', () => {
    leaderboardWin?.webContents.send(IPC.LEADERBOARD_DATA, leaderboardManager.getAll())
    leaderboardWin?.webContents.send('leaderboard-config', {
      characterName:  Config.LEADERBOARD_CHARACTER_NAME,
      uploadEnabled:  !!(__LEADERBOARD_WORKER_URL__ && __LEADERBOARD_API_KEY__),
    })
  })

  leaderboardWin.on('closed', () => { leaderboardWin = null })
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

// ── Weave key global monitor ──────────────────────────────────

// Passive (non-consuming) global keyboard hook via uiohook-napi.
// When the configured WEAVE_KEY_CODE is pressed, a 'weave-key-pressed'
// IPC message is sent to the renderer so it can play audio and record
// the attempt even if the dual-wield roll fails (no log entry).
// Loaded dynamically so a missing native binary never crashes startup.
//
// IMPORTANT: uiohook-napi keycodes are native scan-code-based and are
// completely different from DOM KeyboardEvent.keyCode values.  The learn
// flow must capture the uiohook keycode directly in the main process.

type UiohookType = {
  on(evt: string, cb: (e: { keycode: number }) => void): void
  removeListener(evt: string, cb: (e: { keycode: number }) => void): void
  start(): void
  stop(): void
}
type UiohookKeyType = Record<string, number>

let uIOhookInstance: UiohookType | null = null
let uIOhookKeyMap: UiohookKeyType = {}

// Digit keys (1–0) are absent from UiohookKey — map their scan codes manually.
const UIOHOOK_DIGIT_NAMES: Record<number, string> = {
  2: '1', 3: '2', 4: '3', 5: '4', 6: '5',
  7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
}

// Reverse lookup: uiohook keycode → human-readable name
function uiohookKeyName(code: number): string {
  if (UIOHOOK_DIGIT_NAMES[code]) return UIOHOOK_DIGIT_NAMES[code]
  const entry = Object.entries(uIOhookKeyMap).find(([k, v]) => isNaN(Number(k)) && v === code)
  if (!entry) return `Key${code}`
  const name = entry[0]
  if (name.length === 1) return name           // single letter already fine
  return name
}

// One-shot learn handlers — set while settings window is in learn mode (one per key slot)
let learnKeyHandler:  ((e: { keycode: number }) => void) | null = null
let learnKeyHandler2: ((e: { keycode: number }) => void) | null = null

function startWeaveKeyMonitor(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('uiohook-napi') as { uIOhook: UiohookType; UiohookKey: UiohookKeyType }
    uIOhookKeyMap = mod.UiohookKey
    const hook = mod.uIOhook
    hook.on('keydown', (event) => {
      // Learn mode: capture one keycode and send it back to the settings window
      if (learnKeyHandler) {
        learnKeyHandler(event)
        return
      }
      if (learnKeyHandler2) {
        learnKeyHandler2(event)
        return
      }
      // Normal monitoring
      if ((Config.WEAVE_KEY_CODE !== 0 && event.keycode === Config.WEAVE_KEY_CODE) ||
          (Config.WEAVE_KEY2_CODE !== 0 && event.keycode === Config.WEAVE_KEY2_CODE)) {
        if (win && !win.isDestroyed()) {
          win.webContents.send('weave-key-pressed', performance.now())
        }
      }
    })
    hook.start()
    uIOhookInstance = hook
    console.log('[Basketweaver] Weave key monitor active')
  } catch (err) {
    console.warn('[Basketweaver] Weave key monitoring unavailable:', (err as Error).message)
  }
}

function setupWeaveKeyLearnIPC(): void {
  ipcMain.on('weave-key-learn-start', () => {
    learnKeyHandler2 = null   // cancel any in-progress key-2 learn
    if (!uIOhookInstance) {
      settingsWin?.webContents.send('weave-key-learned', null)
      return
    }
    learnKeyHandler = (event) => {
      learnKeyHandler = null
      const display = uiohookKeyName(event.keycode)
      Config.WEAVE_KEY_CODE    = event.keycode
      Config.WEAVE_KEY_DISPLAY = display
      saveSettings()
      settingsWin?.webContents.send('weave-key-learned', { keycode: event.keycode, display })
    }
  })

  ipcMain.on('weave-key-learn-cancel', () => {
    learnKeyHandler = null
  })

  ipcMain.on('weave-key-learn-start-2', () => {
    learnKeyHandler = null    // cancel any in-progress key-1 learn
    if (!uIOhookInstance) {
      settingsWin?.webContents.send('weave-key-learned-2', null)
      return
    }
    learnKeyHandler2 = (event) => {
      learnKeyHandler2 = null
      const display = uiohookKeyName(event.keycode)
      Config.WEAVE_KEY2_CODE    = event.keycode
      Config.WEAVE_KEY2_DISPLAY = display
      saveSettings()
      settingsWin?.webContents.send('weave-key-learned-2', { keycode: event.keycode, display })
    }
  })

  ipcMain.on('weave-key-learn-cancel-2', () => {
    learnKeyHandler2 = null
  })
}

// ── App entry ─────────────────────────────────────────────────

function recomputeGoodWindow(): void {
  const fistDelay = Config.OFFHAND_WEAPON_DELAY / 10 / (1 + Config.HASTE_PCT / 100)
  Config.GOOD_WINDOW = Math.max(0.1, Config.PUNCH_INTERVAL - fistDelay) / 2
}

app.setName('Basketweaver')
if (process.platform === 'win32') app.setAppUserModelId('com.basketweaver.app')

// Single-instance lock: if a second instance is launched with --open-settings,
// forward the request to the running instance.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--open-settings')) createSettingsWindow()
  })
}

app.whenReady().then(async () => {
  loadSettings()
  recomputeGoodWindow()
  leaderboardManager = new LeaderboardManager(configDir())
  setupIPC()
  createWindow()
  startWeaveKeyMonitor()

  // Add Settings to the Windows taskbar right-click Jump List (packaged only —
  // in dev mode process.execPath is the bare Electron binary, not the app)
  if (process.platform === 'win32' && app.isPackaged) {
    app.setUserTasks([{
      program:     process.execPath,
      arguments:   '--open-settings',
      iconPath:    process.execPath,
      iconIndex:   0,
      title:       'Settings',
      description: 'Open Basketweaver settings',
    }])
  }

  // Create tray
  createTray(win!, () => app.quit(), saveSettings, async () => {
    const p = await pickLogFile()
    if (p) handleLogSelected(p)
  }, resetWindowPosition, createSettingsWindow, createLeaderboardWindow)

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
    win!.webContents.send(IPC.SET_BASE_WEAPON_DELAY, Config.BASE_WEAPON_DELAY)
    if (!Config.DYNAMIC_WEAVING)    win!.webContents.send(IPC.TOGGLE_DYNAMIC_WEAVING)
    if (!Config.SHOW_OFFHAND_TIMER) win!.webContents.send(IPC.TOGGLE_OFFHAND_TIMER)

    // Sync audio volumes and thresholds to renderer
    win!.webContents.send(IPC.SET_VOLUMES, {
      master:     Config.VOLUME_MASTER,
      proc:       Config.VOLUME_PROC,
      epic:       Config.VOLUME_EPIC,
      debounceMs: Config.AUDIO_DEBOUNCE_MS,
    })
    win!.webContents.send(IPC.SET_THRESHOLDS, {
      critDamage: Config.CRIT_DAMAGE_THRESHOLD,
      hugeRound:  Config.HUGE_ROUND_THRESHOLD,
    })
    // Sync pinned state
    if (!Config.WINDOW_PINNED) win!.webContents.send(IPC.TOGGLE_PIN)
    // Sync show-all-crits and positive-audio-in-window states
    if (Config.SHOW_ALL_CRITS)           win!.webContents.send(IPC.SET_SHOW_ALL_CRITS, true)
    if (Config.POSITIVE_AUDIO_IN_WINDOW) win!.webContents.send(IPC.SET_POSITIVE_AUDIO_IN_WINDOW, true)
    if (Config.KEYSTROKE_GRADING)        win!.webContents.send(IPC.SET_KEYSTROKE_GRADING, true)
    if (Config.INFERRED_DW_CHECKS)       win!.webContents.send(IPC.SET_INFERRED_DW_CHECKS, true)

    if (Config.TRACKING_SOURCE === 'hybrid') {
      const logPath = loadLastLog()
      if (logPath) {
        lastLogPath = logPath
        saveLastLog(logPath)
        win?.webContents.send(IPC.LOG_SELECTED, logPath)
      }
      startHybridReader()
      if (Config.AUTO_DETECT_LOG) startAutoDetect()
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
    if (Config.AUTO_DETECT_LOG) startAutoDetect()
  })
})

app.on('window-all-closed', () => {
  stopAllReaders()
  stopAutoDetect()
  uIOhookInstance?.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

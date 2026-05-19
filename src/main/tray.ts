/**
 * System tray icon for Basketweaver.
 * Port of tray_icon.py, using Electron's native Tray + Menu API.
 */

import { Tray, Menu, MenuItem, nativeImage, BrowserWindow, ipcMain, clipboard, app } from 'electron'
import * as path from 'path'
import { IPC } from '../shared/events'
import { Config } from '../shared/config'

const INTERVALS       = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0]
const TARGET_OFFSETS  = [0, 25, 50, 75, 100, 125, 150, 200, 250]   // ms
const LATENCY_VALUES  = [0, 25, 50, 75, 100, 125, 150, 200]         // ms
const CLIP_WINDOWS    = [250, 500, 750, 1000, 1250, 1500, 2000]     // ms
const OPACITIES: Array<[string, number]> = [
  ['50%',  0.50], ['70%',  0.70], ['85%',  0.85], ['100%', 1.00],
]

let recentFights: { label: string, full: string }[] = []

export function updateFightHistory(fights: { label: string, full: string }[]): void {
  recentFights = fights
}

export function createTray(win: BrowserWindow, onQuit: () => void, onSave: () => void = () => {}, onSelectLog: () => void = () => {}, onResetPosition: () => void = () => {}, onSetOverlayStyle: (style: 'refined' | 'standard' | 'highcontrast') => void = () => {}, onSetTrackingSource: (source: 'log' | 'zeal' | 'hybrid') => void = () => {}, onOpenSettings: () => void = () => {}): Tray {
  // Create a simple 16×16 canvas-based tray icon
  const icon = buildTrayIcon()
  const tray = new Tray(icon)
  tray.setToolTip('Basketweaver')

  function rebuild() {
    try {
      tray.popUpContextMenu(buildMenu())
    } catch (err) {
      console.error('[Basketweaver] Tray menu error:', err)
    }
  }

  function buildMenu(): Menu {
    // Dynamic status (polled from renderer)
    let inCombat = false
    if (!win.isDestroyed()) win.webContents.send(IPC.REQUEST_STATUS)
    ipcMain.once(IPC.STATUS_REPLY, (_e, data: { inCombat: boolean }) => {
      inCombat = data.inCombat
    })

    const cfg = Config

    // ── Interval submenu ──────────────────────────────────
    const intervalItems = INTERVALS.map(v => new MenuItem({
      label:   `${v.toFixed(1)}s`,
      type:    'radio',
      checked: Math.abs(cfg.PUNCH_INTERVAL - v) < 0.01,
      click:   () => { cfg.PUNCH_INTERVAL = v },
    }))

    // ── Opacity submenu ───────────────────────────────────
    const opacityItems = OPACITIES.map(([label, val]) => new MenuItem({
      label,
      type:    'radio',
      checked: Math.abs(cfg.WINDOW_OPACITY - val) < 0.06,
      click:   () => {
        cfg.WINDOW_OPACITY = val
        win.setOpacity(val)
      },
    }))

    // ── Target offset submenu ─────────────────────────────
    const offsetItems = TARGET_OFFSETS.map(ms => new MenuItem({
      label:   `${ms} ms`,
      type:    'radio',
      checked: Math.abs(cfg.TARGET_OFFSET * 1000 - ms) < 13,
      click:   () => { cfg.TARGET_OFFSET = ms / 1000 },
    }))

    // ── Latency submenu ───────────────────────────────────
    const latencyItems = LATENCY_VALUES.map(ms => new MenuItem({
      label:   `${ms} ms`,
      type:    'radio',
      checked: Math.abs(cfg.LATENCY_COMPENSATION * 1000 - ms) < 13,
      click:   () => { cfg.LATENCY_COMPENSATION = ms / 1000 },
    }))

    // ── Clip window submenu ───────────────────────────────
    const clipItems: MenuItem[] = [
      new MenuItem({
        label:   'Auto (offhand delay)',
        type:    'radio',
        checked: cfg.CLIP_AUTO,
        click:   () => { cfg.CLIP_AUTO = true },
      }),
      ...CLIP_WINDOWS.map(ms => new MenuItem({
        label:   `${ms} ms`,
        type:    'radio',
        checked: !cfg.CLIP_AUTO && Math.abs(cfg.CLIP_DETECTION_WINDOW * 1000 - ms) < 13,
        click:   () => { cfg.CLIP_AUTO = false; cfg.CLIP_DETECTION_WINDOW = ms / 1000 },
      })),
    ]

    // ── Target position submenu ───────────────────────────
    const TARGET_POSITIONS: Array<[string, number]> = [
      ['10%  (far left/top)',    10],
      ['14%',                    14],
      ['18%  (default)',         18],
      ['22%',                    22],
      ['26%',                    26],
      ['30%',                    30],
      ['35%',                    35],
      ['40%  (center-left)',     40],
    ]
    const targetPosItems = TARGET_POSITIONS.map(([label, pct]) => new MenuItem({
      label,
      type:    'radio',
      checked: cfg.TARGET_POSITION_PCT === pct,
      click:   () => win.webContents.send(IPC.SET_TARGET_POSITION, pct),
    }))

    // ── Mainhand delay submenu ────────────────────────────
    const presetItems = Object.entries(cfg.WEAPON_PRESETS).map(([name, delay]) =>
      new MenuItem({
        label:   `${name}  (${(delay / 10).toFixed(1)}s)`,
        type:    'radio',
        checked: cfg.BASE_WEAPON_DELAY === delay,
        click:   () => { cfg.BASE_WEAPON_DELAY = delay },
      })
    )

    // ── Offhand delay submenu (16–28, every integer) ──────
    const offhandDelays = Array.from({ length: 13 }, (_, i) => 16 + i)
    const offhandLabel  = cfg.OFFHAND_WEAPON_NAME
      ? `Offhand Delay  [${cfg.OFFHAND_WEAPON_NAME}  ${(cfg.OFFHAND_WEAPON_DELAY / 10).toFixed(1)}s]`
      : `Offhand Delay  [${(cfg.OFFHAND_WEAPON_DELAY / 10).toFixed(1)}s]`
    const offhandItems = offhandDelays.map(d => new MenuItem({
      label:   `${(d / 10).toFixed(1)}s  (delay ${d})`,
      type:    'radio',
      checked: cfg.OFFHAND_WEAPON_DELAY === d,
      click:   () => {
        cfg.OFFHAND_WEAPON_DELAY = d
        cfg.OFFHAND_WEAPON_NAME  = ''
        onSave()
        win.webContents.send(IPC.SET_OFFHAND_DELAY, { delay: d, name: '' })
      },
    }))

    return Menu.buildFromTemplate([
      // ── Settings ─────────────────────────────────────────
      { label: 'Settings…',  click: () => onOpenSettings() },
      { type: 'separator' },
      // ── Status ───────────────────────────────────────────
      { label: `Status: ${inCombat ? 'IN COMBAT' : 'IDLE'}`, enabled: false },
      { type: 'separator' },
      // ── Actions ──────────────────────────────────────────
      { label: 'Select Log File…',      click: () => onSelectLog() },
      { label: 'Reset Track',           click: () => win.webContents.send(IPC.RESET_TRACK) },
      { label: 'Clear Buffs (AVT/SAV)', click: () => win.webContents.send(IPC.CLEAR_BUFFS) },
      {
        label:   'Buff Notification Sounds',
        type:    'checkbox',
        checked: Config.BUFF_SOUND_ENABLED,
        click:   () => {
          Config.BUFF_SOUND_ENABLED = !Config.BUFF_SOUND_ENABLED
          win.webContents.send(IPC.TOGGLE_BUFF_SOUND)
        },
      },
      { label: 'Reset Window Position', click: () => onResetPosition() },
      {
        label:   'Freeze Window Position',
        type:    'checkbox',
        checked: Config.WINDOW_PINNED,
        click:   () => {
          Config.WINDOW_PINNED = !Config.WINDOW_PINNED
          win.webContents.send(IPC.TOGGLE_PIN)
        },
      },
      {
        label: 'Recent Fights',
        submenu: recentFights.length === 0
          ? [{ label: 'No fights recorded yet', enabled: false }]
          : recentFights.map(({ label, full }) => ({
              label,
              click: () => clipboard.writeText(full),
            })),
      },
      { type: 'separator' },
      // ── Multi-option settings ─────────────────────────────
      { label: 'Tracking Source',
        submenu: (
          [
            ['Log File (default)',  'log'],
            ['Zeal Pipe',           'zeal'],
            ['Hybrid (Zeal + Log)', 'hybrid'],
          ] as Array<[string, 'log' | 'zeal' | 'hybrid']>
        ).map(([label, source]) => new MenuItem({
          label,
          type:    'radio',
          checked: cfg.TRACKING_SOURCE === source,
          click:   () => onSetTrackingSource(source),
        })),
      },
      { label: 'Overlay Style',
        submenu: (
          [
            ['Refined (default)', 'refined'],
            ['Standard',          'standard'],
            ['High Contrast',     'highcontrast'],
          ] as Array<[string, 'refined' | 'standard' | 'highcontrast']>
        ).map(([label, style]) => new MenuItem({
          label,
          type:    'radio',
          checked: cfg.OVERLAY_STYLE === style,
          click:   () => onSetOverlayStyle(style),
        })),
      },
      { label: 'Mainhand Delay',   submenu: presetItems },
      { label: offhandLabel,       submenu: offhandItems },
      { label: 'Interval',         submenu: intervalItems },
      { label: 'Target Position',  submenu: targetPosItems },
      { label: 'Target Offset',    submenu: offsetItems },
      { label: 'Latency Comp.',    submenu: latencyItems },
      { label: 'Clip Window',      submenu: clipItems },
      { label: 'Opacity',          submenu: opacityItems },
      { type: 'separator' },
      // ── Toggles ───────────────────────────────────────────
      {
        label:   'Audio',
        type:    'checkbox',
        checked: true,
        click:   () => win.webContents.send(IPC.TOGGLE_AUDIO),
      },
      {
        label:   'Orientation',
        type:    'checkbox',
        checked: cfg.ORIENTATION === 'vertical',
        click:   () => win.webContents.send(IPC.TOGGLE_ORIENTATION),
      },
      {
        label:   'Fist Sound on Miss',
        type:    'checkbox',
        checked: Config.FIST_SOUND_ON_MISS,
        click:   () => {
          Config.FIST_SOUND_ON_MISS = !Config.FIST_SOUND_ON_MISS
          win.webContents.send(IPC.TOGGLE_FIST_MISS_SOUND)
        },
      },
      {
        label:   'Dynamic Weaving',
        type:    'checkbox',
        checked: cfg.DYNAMIC_WEAVING,
        click:   () => {
          cfg.DYNAMIC_WEAVING = !cfg.DYNAMIC_WEAVING
          win.webContents.send(IPC.TOGGLE_DYNAMIC_WEAVING)
        },
      },
      {
        label:   'Offhand Swing Timer',
        type:    'checkbox',
        checked: cfg.SHOW_OFFHAND_TIMER,
        click:   () => {
          cfg.SHOW_OFFHAND_TIMER = !cfg.SHOW_OFFHAND_TIMER
          win.webContents.send(IPC.TOGGLE_OFFHAND_TIMER)
        },
      },
      {
        label:   'Keystroke Grading',
        type:    'checkbox',
        checked: Config.KEYSTROKE_GRADING,
        click:   () => {
          Config.KEYSTROKE_GRADING = !Config.KEYSTROKE_GRADING
        },
      },
      { type: 'separator' },
      { label: `Basketweaver v${app.getVersion()}`, enabled: false },
      { label: 'Quit Basketweaver', click: onQuit },
    ] as Electron.MenuItemConstructorOptions[])
  }

  tray.on('right-click', rebuild)
  tray.on('click', rebuild)

  return tray
}

/** Load the app icon as a nativeImage for the system tray. */
function buildTrayIcon(): Electron.NativeImage {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '../../src/icon/basketweaver-icon-256.png')
  return nativeImage.createFromPath(iconPath)
}

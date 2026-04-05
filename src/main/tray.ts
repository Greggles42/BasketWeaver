/**
 * System tray icon for Basketweaver.
 * Port of tray_icon.py, using Electron's native Tray + Menu API.
 */

import { Tray, Menu, MenuItem, nativeImage, BrowserWindow, ipcMain } from 'electron'
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

let highContrastEnabled  = false
let fistMissSoundEnabled = false

export function createTray(win: BrowserWindow, onQuit: () => void, onSave: () => void = () => {}): Tray {
  // Create a simple 16×16 canvas-based tray icon
  const icon = buildTrayIcon()
  const tray = new Tray(icon)
  tray.setToolTip('Basketweaver')

  function rebuild() {
    tray.popUpContextMenu(buildMenu())
  }

  function buildMenu(): Menu {
    // Dynamic status (polled from renderer)
    let inCombat = false
    win.webContents.send(IPC.REQUEST_STATUS)
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

    // ── Scale submenu ─────────────────────────────────────
    const SCALES: Array<[string, number]> = [['25%', 25], ['50%', 50], ['75%', 75], ['100%', 100]]
    const scaleItems = SCALES.map(([label, pct]) => new MenuItem({
      label,
      type:    'radio',
      checked: cfg.WINDOW_SCALE === pct,
      click:   () => win.webContents.send(IPC.SET_SCALE, pct),
    }))

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

    // ── Offhand delay submenu ─────────────────────────────
    const offhandDelays = [10, 12, 14, 16, 18, 20, 22, 24, 25, 26, 28, 30, 32, 33, 35, 38, 40]
    const offhandLabel  = cfg.OFFHAND_WEAPON_NAME
      ? `Offhand Delay  [${cfg.OFFHAND_WEAPON_NAME}  ${(cfg.OFFHAND_WEAPON_DELAY / 10).toFixed(1)}s]`
      : `Offhand Delay  [${(cfg.OFFHAND_WEAPON_DELAY / 10).toFixed(1)}s]`
    const offhandItems = offhandDelays.map(d => new MenuItem({
      label:   `${(d / 10).toFixed(1)}s  (delay ${d})`,
      type:    'radio',
      checked: cfg.OFFHAND_WEAPON_DELAY === d,
      click:   () => { cfg.OFFHAND_WEAPON_DELAY = d; cfg.OFFHAND_WEAPON_NAME = ''; onSave() },
    }))

    return Menu.buildFromTemplate([
      { label: `Status: ${inCombat ? 'IN COMBAT' : 'IDLE'}`, enabled: false },
      { type: 'separator' },
      { label: 'Select Log File…', click: () => win.webContents.send(IPC.SELECT_LOG) },
      { label: 'Reset Track',      click: () => win.webContents.send(IPC.RESET_TRACK) },
      { label: 'Window Size',     submenu: scaleItems },
      { label: 'Target Position', submenu: targetPosItems },
      { type: 'separator' },
      { label: 'Mainhand Delay', submenu: presetItems },
      { label: offhandLabel,     submenu: offhandItems },
      { label: 'Interval',       submenu: intervalItems },
      { label: 'Target Offset',  submenu: offsetItems },
      { label: 'Latency Comp.',  submenu: latencyItems },
      { label: 'Clip Window',    submenu: clipItems },
      {
        label:   'Audio',
        type:    'checkbox',
        checked: true,  // will be updated by toggle
        click:   () => win.webContents.send(IPC.TOGGLE_AUDIO),
      },
      {
        label:   'High Contrast',
        type:    'checkbox',
        checked: highContrastEnabled,
        click:   () => {
          highContrastEnabled = !highContrastEnabled
          win.webContents.send(IPC.TOGGLE_HIGH_CONTRAST)
        },
      },
      {
        label:   'Fist Sound on Miss',
        type:    'checkbox',
        checked: fistMissSoundEnabled,
        click:   () => {
          fistMissSoundEnabled = !fistMissSoundEnabled
          win.webContents.send(IPC.TOGGLE_FIST_MISS_SOUND)
        },
      },
      { label: 'Opacity', submenu: opacityItems },
      { type: 'separator' },
      { label: 'Quit Basketweaver', click: onQuit },
    ] as Electron.MenuItemConstructorOptions[])
  }

  tray.on('right-click', rebuild)
  tray.on('click', rebuild)

  return tray
}

/** Generate a simple 16×16 PNG icon as a nativeImage. */
function buildTrayIcon(): Electron.NativeImage {
  // 16×16 RGBA buffer — navy bg, blue ring, gold dot
  const size = 16
  const buf  = Buffer.alloc(size * size * 4, 0)

  function setPixel(x: number, y: number, r: number, g: number, b: number, a: number) {
    const i = (y * size + x) * 4
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a
  }

  const cx = 7.5, cy = 7.5
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      if (d <= 7) setPixel(x, y, 12, 14, 28, 255)      // bg
      if (d >= 4.5 && d <= 6.5) setPixel(x, y, 64, 150, 255, 255)  // ring
      if (d <= 2.5) setPixel(x, y, 255, 200, 40, 255)  // gold dot
    }
  }

  return nativeImage.createFromBuffer(buf, { width: size, height: size })
}

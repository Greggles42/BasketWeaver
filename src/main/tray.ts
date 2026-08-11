/**
 * System tray icon for Basketweaver.
 * Port of tray_icon.py, using Electron's native Tray + Menu API.
 */

import { Tray, Menu, MenuItem, nativeImage, BrowserWindow, ipcMain, clipboard, app } from 'electron'
import * as path from 'path'
import { IPC, type HitRecord } from '../shared/events'
import { Config } from '../shared/config'


let recentFights: { label: string, full: string }[] = []
let topCrits:     HitRecord[] = []
let topHugeRounds: HitRecord[] = []

export function updateFightHistory(fights: { label: string, full: string }[]): void {
  recentFights = fights
}

export function updateTopRecords(crits: HitRecord[], hugeRounds: HitRecord[]): void {
  topCrits      = crits
  topHugeRounds = hugeRounds
}

export function createTray(win: BrowserWindow, onQuit: () => void, onSave: () => void = () => {}, onSelectLog: () => void = () => {}, onResetPosition: () => void = () => {}, onOpenSettings: () => void = () => {}, onOpenLeaderboard: () => void = () => {}): Tray {
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

    // ── Mainhand delay submenu ────────────────────────────
    const presetItems = Object.entries(cfg.WEAPON_PRESETS).map(([name, { delay, attackType }]) =>
      new MenuItem({
        label:   `${name}  (${(delay / 10).toFixed(1)}s)`,
        type:    'radio',
        checked: cfg.BASE_WEAPON_DELAY === delay && cfg.BASE_WEAPON_NAME === name,
        click:   () => {
          cfg.BASE_WEAPON_DELAY    = delay
          cfg.BASE_WEAPON_NAME     = name
          cfg.MAINHAND_ATTACK_TYPE = attackType
        },
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
        label:   'Rogue Mode (Backstab Tracking) [Alpha]',
        type:    'checkbox',
        checked: Config.ROGUE_MODE_ENABLED,
        click:   () => {
          Config.ROGUE_MODE_ENABLED = !Config.ROGUE_MODE_ENABLED
          win.webContents.send(IPC.TOGGLE_ROGUE_MODE)
          onSave()
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
      {
        label: 'Top Crits',
        submenu: topCrits.length === 0
          ? [{ label: 'No crits recorded yet', enabled: false }]
          : topCrits.map((r, i) => ({
              label: `#${i + 1}  ${r.damage.toLocaleString()}  [${r.target || 'Unknown'}]  ${r.date}`,
              enabled: false,
            })),
      },
      {
        label: 'Top Huge Rounds',
        submenu: topHugeRounds.length === 0
          ? [{ label: 'No huge rounds recorded yet', enabled: false }]
          : topHugeRounds.map((r, i) => ({
              label: `#${i + 1}  ${r.damage.toLocaleString()}  [${r.target || 'Unknown'}]  ${r.date}`,
              enabled: false,
            })),
      },
      { type: 'separator' },
      // ── Weapon submenus ───────────────────────────────────
      { label: 'Mainhand Delay',   submenu: presetItems },
      { label: offhandLabel,       submenu: offhandItems },
      { type: 'separator' },
      // ── Toggles ───────────────────────────────────────────
      {
        label:   'Audio',
        type:    'checkbox',
        checked: true,
        click:   () => win.webContents.send(IPC.TOGGLE_AUDIO),
      },
      { type: 'separator' },
      { label: 'Leaderboard...', click: onOpenLeaderboard },
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

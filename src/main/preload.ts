/**
 * Preload script — the bridge between the renderer and the main process.
 * Exposes a safe, typed API on window.electronAPI.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type GameEvent } from '../shared/events'

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Main → renderer ─────────────────────────────────────
  onGameEvent: (cb: (ev: GameEvent) => void) =>
    ipcRenderer.on(IPC.GAME_EVENT, (_e, ev: GameEvent) => cb(ev)),

  onLogSelected: (cb: (path: string) => void) =>
    ipcRenderer.on(IPC.LOG_SELECTED, (_e, path: string) => cb(path)),

  onToggleAudio: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_AUDIO, () => cb()),

  onToggleOrientation: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_ORIENTATION, () => cb()),

  onToggleHighContrast: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_HIGH_CONTRAST, () => cb()),

  onSetScale: (cb: (pct: number) => void) =>
    ipcRenderer.on(IPC.SET_SCALE, (_e, pct: number) => cb(pct)),

  onSetTargetPosition: (cb: (pct: number) => void) =>
    ipcRenderer.on(IPC.SET_TARGET_POSITION, (_e, pct: number) => cb(pct)),

  onResetTrack: (cb: () => void) =>
    ipcRenderer.on(IPC.RESET_TRACK, () => cb()),

  onToggleFistMissSound: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_FIST_MISS_SOUND, () => cb()),

  sendFightHistory: (fights: string[]) =>
    ipcRenderer.send(IPC.FIGHT_HISTORY_UPDATE, fights),

  // ── Renderer → main ─────────────────────────────────────
  quit: () => ipcRenderer.send(IPC.QUIT),

  selectLog: () => ipcRenderer.send(IPC.SELECT_LOG),

  resizeWindow: (w: number, h: number) =>
    ipcRenderer.send('resize-window', w, h),

  moveWindow: (dx: number, dy: number) =>
    ipcRenderer.send('move-window-delta', dx, dy),

  replyStatus: (inCombat: boolean) =>
    ipcRenderer.send(IPC.STATUS_REPLY, { inCombat }),

  saveSettings: () =>
    ipcRenderer.send(IPC.SAVE_SETTINGS),
})

// Listen for status requests from tray
ipcRenderer.on(IPC.REQUEST_STATUS, () => {
  // The renderer will reply via replyStatus when it receives this
  // We dispatch a custom event so the overlay can respond
  window.dispatchEvent(new CustomEvent('request-status'))
})

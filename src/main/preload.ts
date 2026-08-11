/**
 * Preload script — the bridge between the renderer and the main process.
 * Exposes a safe, typed API on window.electronAPI.
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type GameEvent, type HitRecord } from '../shared/events'

contextBridge.exposeInMainWorld('electronAPI', {
  // ── Main → renderer ─────────────────────────────────────
  onGameEvent: (cb: (ev: GameEvent) => void) =>
    ipcRenderer.on(IPC.GAME_EVENT, (_e, ev: GameEvent) => cb(ev)),

  onLogSelected: (cb: (path: string) => void) =>
    ipcRenderer.on(IPC.LOG_SELECTED, (_e, path: string) => cb(path)),

  onCharacterDetected: (cb: (name: string) => void) =>
    ipcRenderer.on(IPC.CHARACTER_DETECTED, (_e, name: string) => cb(name)),

  onToggleAudio: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_AUDIO, () => cb()),

  onSetTargetPosition: (cb: (pct: number) => void) =>
    ipcRenderer.on(IPC.SET_TARGET_POSITION, (_e, pct: number) => cb(pct)),

  onResetTrack: (cb: () => void) =>
    ipcRenderer.on(IPC.RESET_TRACK, () => cb()),

  onToggleFistMissSound: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_FIST_MISS_SOUND, () => cb()),

  onToggleDynamicWeaving: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_DYNAMIC_WEAVING, () => cb()),

  onToggleOffhandTimer: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_OFFHAND_TIMER, () => cb()),

  onToggleLaneLines: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_LANE_LINES, () => cb()),

  onTogglePin: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_PIN, () => cb()),

  onClearBuffs: (cb: () => void) =>
    ipcRenderer.on(IPC.CLEAR_BUFFS, () => cb()),

  onToggleBuffSound: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_BUFF_SOUND, () => cb()),

  onToggleRogueMode: (cb: () => void) =>
    ipcRenderer.on(IPC.TOGGLE_ROGUE_MODE, () => cb()),

  onSetOffhandDelay: (cb: (delay: number, name: string) => void) =>
    ipcRenderer.on(IPC.SET_OFFHAND_DELAY, (_e, data: { delay: number; name: string }) => cb(data.delay, data.name)),

  onSetVolumes: (cb: (master: number, proc: number, epic: number, debounceMs: number) => void) =>
    ipcRenderer.on(IPC.SET_VOLUMES, (_e, d: { master: number; proc: number; epic: number; debounceMs: number }) =>
      cb(d.master, d.proc, d.epic, d.debounceMs)),

  onSetThresholds: (cb: (critDamage: number, hugeRound: number) => void) =>
    ipcRenderer.on(IPC.SET_THRESHOLDS, (_e, d: { critDamage: number; hugeRound: number }) =>
      cb(d.critDamage, d.hugeRound)),

  onSetShowAllCrits: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on(IPC.SET_SHOW_ALL_CRITS, (_e, enabled: boolean) => cb(enabled)),

  onSetKeystrokeGrading: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on(IPC.SET_KEYSTROKE_GRADING, (_e, enabled: boolean) => cb(enabled)),

  onSetPositiveAudioInWindow: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on(IPC.SET_POSITIVE_AUDIO_IN_WINDOW, (_e, enabled: boolean) => cb(enabled)),

  onSetWeaveWindowMs: (cb: (ms: number) => void) =>
    ipcRenderer.on(IPC.SET_WEAVE_WINDOW_MS, (_e, ms: number) => cb(ms)),

  onSetDwRollFailDelayMs: (cb: (ms: number) => void) =>
    ipcRenderer.on(IPC.SET_DW_ROLL_FAIL_DELAY_MS, (_e, ms: number) => cb(ms)),

  onSetInferredDwChecks: (cb: (enabled: boolean) => void) =>
    ipcRenderer.on(IPC.SET_INFERRED_DW_CHECKS, (_e, enabled: boolean) => cb(enabled)),

  onSetPunchInterval: (cb: (interval: number) => void) =>
    ipcRenderer.on(IPC.SET_PUNCH_INTERVAL, (_e, interval: number) => cb(interval)),

  onSetBaseWeaponDelay: (cb: (delay: number) => void) =>
    ipcRenderer.on(IPC.SET_BASE_WEAPON_DELAY, (_e, delay: number) => cb(delay)),

  onWeaveKeyPressed: (cb: (ts: number) => void) =>
    ipcRenderer.on('weave-key-pressed', (_e, ts: number) => cb(ts)),

  sendFightHistory: (fights: { label: string, full: string }[]) =>
    ipcRenderer.send(IPC.FIGHT_HISTORY_UPDATE, fights),

  sendTopRecords: (crits: HitRecord[], hugeRounds: HitRecord[]) =>
    ipcRenderer.send(IPC.TOP_RECORDS_UPDATE, { crits, hugeRounds }),

  sendLeaderboardRecord: (record: unknown) =>
    ipcRenderer.send(IPC.LEADERBOARD_RECORD, record),

  getLeaderboard: () => ipcRenderer.invoke(IPC.LEADERBOARD_GET),

  onLeaderboardOpen: (cb: () => void) =>
    ipcRenderer.on(IPC.LEADERBOARD_OPEN, () => cb()),

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

  captureMouse: () => ipcRenderer.send(IPC.CAPTURE_MOUSE),
  releaseMouse: () => ipcRenderer.send(IPC.RELEASE_MOUSE),
})

// Listen for status requests from tray
ipcRenderer.on(IPC.REQUEST_STATUS, () => {
  // The renderer will reply via replyStatus when it receives this
  // We dispatch a custom event so the overlay can respond
  window.dispatchEvent(new CustomEvent('request-status'))
})

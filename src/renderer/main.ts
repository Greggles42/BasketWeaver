/**
 * Renderer entry point.
 * Wires the Overlay to the canvas, keyboard input, and IPC events from main.
 */

import { Config } from '../shared/config'
import type { GameEvent, HitRecord } from '../shared/events'
import { RefinedOverlay } from './overlay-refined'
import { HighContrastOverlay } from './overlay-highcontrast'

declare global {
  interface Window {
    electronAPI: {
      onGameEvent:        (cb: (ev: GameEvent) => void) => void
      onLogSelected:      (cb: (path: string) => void) => void
      onCharacterDetected: (cb: (name: string) => void) => void
      onToggleAudio:        (cb: () => void) => void
      onSetTargetPosition:    (cb: (pct: number) => void) => void
      onResetTrack:           (cb: () => void) => void
      onToggleFistMissSound:    (cb: () => void) => void
      onToggleDynamicWeaving:   (cb: () => void) => void
      onToggleOffhandTimer:     (cb: () => void) => void
      onToggleLaneLines:        (cb: () => void) => void
      onTogglePin:              (cb: () => void) => void
      onClearBuffs:             (cb: () => void) => void
      onToggleBuffSound:        (cb: () => void) => void
      onToggleRogueMode:        (cb: () => void) => void
      onSetOffhandDelay:      (cb: (delay: number, name: string) => void) => void
      onSetVolumes:           (cb: (master: number, proc: number, epic: number, debounceMs: number) => void) => void
      onSetThresholds:        (cb: (critDamage: number, hugeRound: number) => void) => void
      sendFightHistory:       (fights: { label: string, full: string }[]) => void
      sendTopRecords:         (crits: HitRecord[], hugeRounds: HitRecord[]) => void
      onSetShowAllCrits:             (cb: (enabled: boolean) => void) => void
      onSetPositiveAudioInWindow:    (cb: (enabled: boolean) => void) => void
      onSetKeystrokeGrading:         (cb: (enabled: boolean) => void) => void
      onSetWeaveWindowMs:            (cb: (ms: number) => void) => void
      onSetDwRollFailDelayMs:        (cb: (ms: number) => void) => void
      onSetInferredDwChecks:         (cb: (enabled: boolean) => void) => void
      onSetPunchInterval:            (cb: (interval: number) => void) => void
      onWeaveKeyPressed:             (cb: (ts: number) => void) => void
      onLeaderboardRank:             (cb: (mobName: string, rank: number) => void) => void
      quit:               () => void
      selectLog:          () => void
      resizeWindow:       (w: number, h: number) => void
      moveWindow:         (dx: number, dy: number) => void
      replyStatus:        (inCombat: boolean) => void
      saveSettings:       () => void
      captureMouse:       () => void
      releaseMouse:       () => void
    }
  }
}

// ── Canvas setup ──────────────────────────────────────────────

const canvas = document.getElementById('overlay') as HTMLCanvasElement

function initCanvasSize() {
  canvas.width  = Config.WINDOW_WIDTH
  canvas.height = Config.WINDOW_HEIGHT
}

initCanvasSize()

// ── Create overlay ────────────────────────────────────────────

const overlayStyle = new URLSearchParams(location.search).get('overlayStyle') ?? 'refined'

const overlay: {
  start(): void
  handleGameEvent(ev: GameEvent): void
  handleKey(key: string): void
  applyTargetPosition(pct: number): void
  toggleLaneLines(): void
  toggleFistMissSound(): void
  toggleDynamicWeaving(): void
  toggleOffhandTimer(): void
  resetTrack(): void
  resetRogueMode(): void
  handleWeaveKeyPressed(ts: number): void
  applyDynamicWeaveWindow(delayTenths: number, name?: string): void
  readonly audio: import('./audio-manager').AudioManager
  readonly inCombat: boolean
  avatarActive: boolean
  savageryActive: boolean
  pinned: boolean
  logSelected: boolean
} = overlayStyle === 'highcontrast'
  ? new HighContrastOverlay(canvas)
  : new RefinedOverlay(canvas)

overlay.start()

// ── IPC → overlay ─────────────────────────────────────────────

window.electronAPI.onGameEvent(ev => overlay.handleGameEvent(ev))

window.electronAPI.onLogSelected(p => {
  const filename = p.replace(/\\/g, '/').split('/').pop() ?? ''
  const m = filename.match(/^eqlog_([^_]+)_/)
  if (m) { Config.LEADERBOARD_CHARACTER_NAME = m[1]; (overlay as any).charName = m[1] }
  overlay.logSelected = true
  ;(overlay as any).lastLogActivityTs = performance.now()  // reset stale-log timer
  ;(overlay as any).showBanner?.(`Log: ${filename}`, Config.C_GOOD, 3000)
})

window.electronAPI.onCharacterDetected(name => {
  if (!name) return
  Config.LEADERBOARD_CHARACTER_NAME = name
  ;(overlay as any).charName = name
})

window.electronAPI.onToggleAudio(() => {
  // Audio toggle is handled internally by AudioManager; trigger via key handler
  overlay.handleKey('m')
})

window.electronAPI.onSetTargetPosition((pct: number) => {
  overlay.applyTargetPosition(pct)
})

window.electronAPI.onResetTrack(() => {
  overlay.resetTrack()
})

window.electronAPI.onToggleFistMissSound(() => overlay.toggleFistMissSound())
window.electronAPI.onToggleDynamicWeaving(() => overlay.toggleDynamicWeaving())
window.electronAPI.onToggleOffhandTimer(() => overlay.toggleOffhandTimer())
window.electronAPI.onToggleLaneLines(() => overlay.toggleLaneLines())
// ── Buff sounds — preload wav files ──────────────────────────
const audio = overlay.audio
audio.loadFile('avatar',   './sounds/avatar.wav',   0.6)
audio.loadFile('savagery', './sounds/savagery.wav')
audio.loadFile('oh_snap',  './sounds/oh snap.wav')
audio.loadFile('epic',     './sounds/epic.wav')
audio.loadFile('hit_tick', './sounds/Hit tick.wav')

window.electronAPI.onClearBuffs(() => {
  overlay.avatarActive   = false
  overlay.savageryActive = false
})

window.electronAPI.onToggleBuffSound(() => {
  audio.buffSoundEnabled = !audio.buffSoundEnabled
})

window.electronAPI.onToggleRogueMode(() => overlay.resetRogueMode())

window.electronAPI.onTogglePin(() => {
  overlay.pinned = !overlay.pinned
  if (overlay.pinned) {
    window.electronAPI.releaseMouse()
  } else {
    window.electronAPI.captureMouse()
  }
})
window.electronAPI.onSetOffhandDelay((delay, name) => {
  overlay.applyDynamicWeaveWindow(delay, name)
})

window.electronAPI.onSetVolumes((master, proc, epic, debounceMs) => {
  audio.masterVolume = master
  audio.procVolume   = proc
  audio.epicVolume   = epic
  Config.AUDIO_DEBOUNCE_MS = debounceMs
})

window.electronAPI.onSetThresholds((critDamage, hugeRound) => {
  Config.CRIT_DAMAGE_THRESHOLD = critDamage
  Config.HUGE_ROUND_THRESHOLD  = hugeRound
})

window.electronAPI.onSetShowAllCrits((enabled) => {
  Config.SHOW_ALL_CRITS = enabled
})

window.electronAPI.onSetKeystrokeGrading((enabled) => {
  Config.KEYSTROKE_GRADING = enabled
})

window.electronAPI.onSetPositiveAudioInWindow((enabled) => {
  Config.POSITIVE_AUDIO_IN_WINDOW = enabled
})

window.electronAPI.onSetWeaveWindowMs((ms) => {
  Config.WEAVE_WINDOW_MS = ms
})

window.electronAPI.onSetDwRollFailDelayMs((ms) => {
  Config.DW_ROLL_FAIL_DELAY_MS = ms
})

window.electronAPI.onSetInferredDwChecks((enabled) => {
  Config.INFERRED_DW_CHECKS = enabled
})

window.electronAPI.onSetPunchInterval((interval) => {
  Config.PUNCH_INTERVAL = interval
})

window.electronAPI.onSetBaseWeaponDelay((delay) => {
  Config.BASE_WEAPON_DELAY = delay
})

window.electronAPI.onWeaveKeyPressed((ts: number) => {
  overlay.handleWeaveKeyPressed(ts)
})

window.electronAPI.onLeaderboardRank((mobName: string, rank: number) => {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉'
  ;(overlay as any).showBanner?.(`${medal} #${rank} Total DPS vs ${mobName}!`, '#ffd700', 6000)
  overlay.audio.playForce('fanfare')
})

// ── Status requests from tray ─────────────────────────────────

window.addEventListener('request-status', () => {
  window.electronAPI.replyStatus(overlay.inCombat)
})

// ── Keyboard input ─────────────────────────────────────────────

document.addEventListener('keydown', (e: KeyboardEvent) => {
  // Prevent browser defaults for game keys
  if (['ArrowUp', 'ArrowDown', ' ', 'Tab'].includes(e.key)) e.preventDefault()
  // Shift+T: hidden test — simulate a DW roll failure visual+audio without combat
  if (e.shiftKey && (e.key === 't' || e.key === 'T')) {
    ;(overlay as any).testDwRollFail?.()
    return
  }
  overlay.handleKey(e.key)
})

// ── Pointer events (drag vs click) ────────────────────────────
//
// Window dragging is handled entirely in JS to avoid the Windows modal-move-loop
// bug that occurs with -webkit-app-region: drag on always-on-top frameless windows.
// On mousedown we record the cursor position and timestamp.  If the cursor moves
// >= DRAG_THRESHOLD px before mouseup we start sending position deltas via IPC
// (main calls win.getPosition() + win.setPosition() on each message).
// If the mouse releases without meaningful movement it is treated as a weapon-swap
// click, fired with the original mousedown timestamp for rhythm precision.

const DRAG_THRESHOLD = 4  // px — movement needed to commit to a drag

let dragPending    = false
let dragging       = false
let lastScreenX    = 0
let lastScreenY    = 0
let dragStartX     = 0
let dragStartY     = 0
let clickDownTs    = 0
let clickDownClientX = 0
let clickDownClientY = 0

// ── Mouse pass-through management ────────────────────────────
// The main process starts with setIgnoreMouseEvents(true, { forward: true })
// so all clicks pass to the game. We capture only while the mouse is over
// the canvas, and release immediately after mouseup or mouseleave.

canvas.addEventListener('mouseenter', () => {
  window.electronAPI.captureMouse()
})

canvas.addEventListener('mouseleave', () => {
  if (!dragging && overlay.pinned) window.electronAPI.releaseMouse()
})

// ── Drag / click ──────────────────────────────────────────────

canvas.addEventListener('mousedown', (e: MouseEvent) => {
  if (e.button !== 0) return
  dragPending      = true
  dragging         = false
  dragStartX       = e.screenX
  dragStartY       = e.screenY
  lastScreenX      = e.screenX
  lastScreenY      = e.screenY
  clickDownTs      = performance.now()
  clickDownClientX = e.clientX
  clickDownClientY = e.clientY
})

// Accumulate move deltas and flush at most once per animation frame instead
// of calling moveWindow() (IPC + synchronous setPosition) on every mousemove.
// A high-poll-rate mouse can fire mousemove hundreds of times/sec; hammering
// setPosition that fast while the OS holds mouse capture on this window is
// what causes the cursor to get visibly stuck/jittery mid-drag on Windows
// (only clearing on alt+tab, which forces the input subsystem to reset).
let pendingDx  = 0
let pendingDy  = 0
let flushQueued = false

function flushMove(): void {
  flushQueued = false
  if (!dragging) { pendingDx = 0; pendingDy = 0; return }
  if (pendingDx !== 0 || pendingDy !== 0) {
    window.electronAPI.moveWindow(pendingDx, pendingDy)
    pendingDx = 0
    pendingDy = 0
  }
  if (dragging) { flushQueued = true; requestAnimationFrame(flushMove) }
}

window.addEventListener('mousemove', (e: MouseEvent) => {
  if (!dragPending && !dragging) return
  if (!(e.buttons & 1)) { dragPending = false; dragging = false; if (overlay.pinned) window.electronAPI.releaseMouse(); return }

  if (!dragging) {
    const dx = e.screenX - dragStartX
    const dy = e.screenY - dragStartY
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
    if (overlay.pinned) { dragPending = false; return }  // position locked
    dragging    = true
    dragPending = false
    if (!flushQueued) { flushQueued = true; requestAnimationFrame(flushMove) }
  }

  pendingDx  += e.screenX - lastScreenX
  pendingDy  += e.screenY - lastScreenY
  lastScreenX = e.screenX
  lastScreenY = e.screenY
})

window.addEventListener('blur', () => {
  dragPending = false
  dragging    = false
  // Only release mouse capture on focus loss while pinned (click-through mode).
  // While unpinned the overlay should stay fully clickable/draggable even after
  // the game window regains focus, otherwise it can get stuck relying on a
  // forwarded mouseenter event to recapture, which isn't always reliable.
  if (overlay.pinned) window.electronAPI.releaseMouse()
})

window.addEventListener('mouseup', (e: MouseEvent) => {
  if (e.button !== 0) { dragPending = false; dragging = false; if (overlay.pinned) window.electronAPI.releaseMouse(); return }
  if (dragPending && !dragging) {
    // Released without moving — weapon-swap click at the original mousedown time.
    ;(overlay as any).handleMouseClick?.(clickDownTs, clickDownClientX, clickDownClientY)
  }
  dragPending = false
  dragging    = false
  if (overlay.pinned) window.electronAPI.releaseMouse()
})

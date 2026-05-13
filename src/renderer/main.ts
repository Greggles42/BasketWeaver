/**
 * Renderer entry point.
 * Wires the Overlay to the canvas, keyboard input, and IPC events from main.
 */

import { Config } from '../shared/config'
import type { GameEvent } from '../shared/events'
import { Overlay } from './overlay'
import { RefinedOverlay } from './overlay-refined'
import { HighContrastOverlay } from './overlay-highcontrast'

declare global {
  interface Window {
    electronAPI: {
      onGameEvent:        (cb: (ev: GameEvent) => void) => void
      onLogSelected:      (cb: (path: string) => void) => void
      onToggleAudio:        (cb: () => void) => void
      onToggleOrientation:  (cb: () => void) => void
      onSetTargetPosition:    (cb: (pct: number) => void) => void
      onResetTrack:           (cb: () => void) => void
      onToggleFistMissSound:    (cb: () => void) => void
      onToggleDynamicWeaving:   (cb: () => void) => void
      onToggleOffhandTimer:     (cb: () => void) => void
      onToggleLaneLines:        (cb: () => void) => void
      onTogglePin:              (cb: () => void) => void
      onClearBuffs:             (cb: () => void) => void
      onToggleBuffSound:        (cb: () => void) => void
      onSetOffhandDelay:      (cb: (delay: number, name: string) => void) => void
      sendFightHistory:       (fights: { label: string, full: string }[]) => void
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
  const [w, h] = Config.ORIENTATION === 'vertical'
    ? [Config.VERT_WINDOW_WIDTH, Config.VERT_WINDOW_HEIGHT]
    : [Config.WINDOW_WIDTH, Config.WINDOW_HEIGHT]
  canvas.width  = w
  canvas.height = h
}

initCanvasSize()

// ── Create overlay ────────────────────────────────────────────

const overlayStyle = new URLSearchParams(location.search).get('overlayStyle') ?? 'refined'

const overlay: {
  start(): void
  handleGameEvent(ev: GameEvent): void
  handleKey(key: string): void
  toggleOrientation(): void
  applyTargetPosition(pct: number): void
  toggleLaneLines(): void
  toggleFistMissSound(): void
  toggleDynamicWeaving(): void
  toggleOffhandTimer(): void
  pinned: boolean
} = overlayStyle === 'highcontrast'
  ? new HighContrastOverlay(canvas)
  : overlayStyle === 'standard'
    ? new Overlay(canvas)
    : new RefinedOverlay(canvas)

overlay.start()

// ── IPC → overlay ─────────────────────────────────────────────

window.electronAPI.onGameEvent(ev => overlay.handleGameEvent(ev))

window.electronAPI.onLogSelected(p => {
  const filename = p.replace(/\\/g, '/').split('/').pop() ?? ''
  const m = filename.match(/^eqlog_([^_]+)_/)
  if (m) (overlay as any).charName = m[1]
  ;(overlay as any).showBanner?.(`Log: ${filename}`, Config.C_GOOD, 3000)
})

window.electronAPI.onToggleAudio(() => {
  // Audio toggle is handled internally by AudioManager; trigger via key handler
  overlay.handleKey('m')
})

window.electronAPI.onToggleOrientation(() => {
  overlay.toggleOrientation()
  initCanvasSize()
})

window.electronAPI.onSetTargetPosition((pct: number) => {
  overlay.applyTargetPosition(pct)
})

window.electronAPI.onResetTrack(() => {
  ;(overlay as any).resetTrack ? (overlay as any).resetTrack() : overlay.handleKey('r')
})

window.electronAPI.onToggleFistMissSound(() => overlay.toggleFistMissSound())
window.electronAPI.onToggleDynamicWeaving(() => overlay.toggleDynamicWeaving())
window.electronAPI.onToggleOffhandTimer(() => overlay.toggleOffhandTimer())
window.electronAPI.onToggleLaneLines(() => overlay.toggleLaneLines())
// ── Buff sounds — preload wav files ──────────────────────────
const audio: import('./audio-manager').AudioManager | undefined = (overlay as any).audio
if (audio) {
  audio.loadFile('avatar',   '/sounds/avatar.wav',   0.8)
  audio.loadFile('savagery', '/sounds/savagery.wav')
}

window.electronAPI.onClearBuffs(() => {
  ;(overlay as any).avatarActive   = false
  ;(overlay as any).savageryActive = false
})

window.electronAPI.onToggleBuffSound(() => {
  if (audio) audio.buffSoundEnabled = !audio.buffSoundEnabled
})

window.electronAPI.onTogglePin(() => {
  overlay.pinned = !overlay.pinned
  if (overlay.pinned) {
    window.electronAPI.releaseMouse()
  } else {
    window.electronAPI.captureMouse()
  }
})
window.electronAPI.onSetOffhandDelay((delay, name) => {
  ;(overlay as any).applyDynamicWeaveWindow?.(delay, name)
})

// ── Status requests from tray ─────────────────────────────────

window.addEventListener('request-status', () => {
  window.electronAPI.replyStatus((overlay as any).rhythm?.inCombat ?? false)
})

// ── Keyboard input ─────────────────────────────────────────────

document.addEventListener('keydown', (e: KeyboardEvent) => {
  // Prevent browser defaults for game keys
  if (['ArrowUp', 'ArrowDown', ' ', 'Tab'].includes(e.key)) e.preventDefault()
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

window.addEventListener('mousemove', (e: MouseEvent) => {
  if (!dragPending && !dragging) return
  if (!(e.buttons & 1)) { dragPending = false; dragging = false; window.electronAPI.releaseMouse(); return }

  if (!dragging) {
    const dx = e.screenX - dragStartX
    const dy = e.screenY - dragStartY
    if (dx * dx + dy * dy < DRAG_THRESHOLD * DRAG_THRESHOLD) return
    if (overlay.pinned) { dragPending = false; return }  // position locked
    dragging    = true
    dragPending = false
  }

  const dx = e.screenX - lastScreenX
  const dy = e.screenY - lastScreenY
  lastScreenX = e.screenX
  lastScreenY = e.screenY
  if (dx !== 0 || dy !== 0) window.electronAPI.moveWindow(dx, dy)
})

window.addEventListener('blur', () => {
  dragPending = false
  dragging    = false
  window.electronAPI.releaseMouse()
})

window.addEventListener('mouseup', (e: MouseEvent) => {
  if (e.button !== 0) { dragPending = false; dragging = false; window.electronAPI.releaseMouse(); return }
  if (dragPending && !dragging) {
    // Released without moving — weapon-swap click at the original mousedown time.
    ;(overlay as any).handleMouseClick?.(clickDownTs, clickDownClientX, clickDownClientY)
  }
  dragPending = false
  dragging    = false
  window.electronAPI.releaseMouse()
})

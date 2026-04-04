/**
 * Event types passed from the main process (log reader) to the renderer.
 * All timestamps are performance.now() values recorded at detection time.
 * These are sent over the IPC channel 'game-event'.
 */

export const enum EvType {
  COMBAT_START    = 'COMBAT_START',
  COMBAT_END      = 'COMBAT_END',   // silent end: you died / zoned / logout
  MOB_DIED        = 'MOB_DIED',     // mob you were fighting died → grade + sound
  MAINHAND_CRUSH  = 'MAINHAND_CRUSH',   // data: { damage, hit, line }
  FIST_ATTACK     = 'FIST_ATTACK',      // data: { damage, hit, line }
  OUT_OF_RANGE    = 'OUT_OF_RANGE',     // data: { line }
  HASTE_DETECTED  = 'HASTE_DETECTED',   // data: { haste_pct, interval, source }
  WEAPON_DETECTED  = 'WEAPON_DETECTED',   // data: { name, delay }
  OFFHAND_DETECTED = 'OFFHAND_DETECTED', // data: { name, delay }
  MOUSE_CLICK     = 'MOUSE_CLICK',      // data: { x, y }
}

export interface GameEvent {
  type: EvType
  ts: number          // performance.now() at detection (ms)
  data?: Record<string, unknown>
}

// ── IPC channel names ────────────────────────────────────────
export const IPC = {
  GAME_EVENT:        'game-event',         // main → renderer: GameEvent
  CONFIG_UPDATE:     'config-update',      // renderer → main: Partial<Config>
  SELECT_LOG:        'select-log',         // renderer/tray → main: open file picker
  LOG_SELECTED:      'log-selected',       // main → renderer: string (path)
  QUIT:              'quit',               // tray → main
  TOGGLE_AUDIO:      'toggle-audio',       // tray → renderer
  TOGGLE_ORIENTATION:'toggle-orientation', // tray → renderer
  SET_SCALE:            'set-scale',             // tray → renderer: number (pct)
  SET_TARGET_POSITION:  'set-target-position',  // tray → renderer: number (pct)
  SET_OPACITY:       'set-opacity',        // tray → main: number (0–1)
  REQUEST_STATUS:    'request-status',     // tray → renderer
  STATUS_REPLY:      'status-reply',       // renderer → main: { inCombat }
  WINDOW_DRAG_START: 'window-drag-start',  // renderer → main
  SAVE_SETTINGS:     'save-settings',      // renderer → main: persist config to disk
  RESET_TRACK:       'reset-track',        // tray → renderer: hard reset engine state
} as const

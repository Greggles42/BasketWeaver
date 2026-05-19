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
  CURSOR_BLOCKED  = 'CURSOR_BLOCKED',  // data: { line }
  HASTE_DETECTED  = 'HASTE_DETECTED',   // data: { haste_pct, interval, source }
  WEAPON_DETECTED  = 'WEAPON_DETECTED',   // data: { name, delay }
  MOUSE_CLICK     = 'MOUSE_CLICK',      // data: { x, y }
  MISC_DAMAGE     = 'MISC_DAMAGE',      // data: { damage } — flying kick, item procs, etc.
  WEAVE_SIGNAL    = 'WEAVE_SIGNAL',     // data: { offhandDelay: number } — Zeal /pipe "weave X" macro
  BUFF_CHANGED    = 'BUFF_CHANGED',     // data: { buff: 'avatar'|'savagery', active: boolean }
  CRIT_HIT        = 'CRIT_HIT',        // data: { damage: number }
}

export interface GameEvent {
  type: EvType
  ts: number          // performance.now() at detection (ms)
  data?: Record<string, unknown>
}

// ── IPC channel names ────────────────────────────────────────
export const IPC = {
  GAME_EVENT:        'game-event',         // main → renderer: GameEvent
  SELECT_LOG:        'select-log',         // renderer/tray → main: open file picker
  LOG_SELECTED:      'log-selected',       // main → renderer: string (path)
  QUIT:              'quit',               // tray → main
  TOGGLE_AUDIO:          'toggle-audio',          // tray → renderer
  TOGGLE_ORIENTATION:    'toggle-orientation',    // tray → renderer
  SET_TARGET_POSITION:  'set-target-position',  // tray → renderer: number (pct)
  SET_OPACITY:       'set-opacity',        // tray → main: number (0–1)
  REQUEST_STATUS:    'request-status',     // tray → renderer
  STATUS_REPLY:      'status-reply',       // renderer → main: { inCombat }
  WINDOW_DRAG_START: 'window-drag-start',  // renderer → main
  SAVE_SETTINGS:     'save-settings',      // renderer → main: persist config to disk
  RESET_TRACK:            'reset-track',             // tray → renderer: hard reset engine state
  TOGGLE_FIST_MISS_SOUND:   'toggle-fist-miss-sound',   // tray → renderer
  TOGGLE_DYNAMIC_WEAVING:   'toggle-dynamic-weaving',   // tray → renderer
  TOGGLE_OFFHAND_TIMER:     'toggle-offhand-timer',      // tray → renderer
  TOGGLE_LANE_LINES:      'toggle-lane-lines',        // tray → renderer
  TOGGLE_PIN:             'toggle-pin',               // tray → renderer
  CLEAR_BUFFS:            'clear-buffs',              // tray → renderer
  TOGGLE_BUFF_SOUND:      'toggle-buff-sound',        // tray → renderer
  FIGHT_HISTORY_UPDATE:   'fight-history-update',    // renderer → main: { label: string, full: string }[]
  SET_OVERLAY_STYLE:      'set-overlay-style',        // tray → main → (reload renderer)
  SET_OFFHAND_DELAY:      'set-offhand-delay',        // tray → renderer: { delay: number, name: string }
  CAPTURE_MOUSE:          'capture-mouse',             // renderer → main: stop ignoring mouse events
  RELEASE_MOUSE:          'release-mouse',             // renderer → main: resume ignoring mouse events (pass-through)
  OPEN_SETTINGS:          'open-settings',
  SETTINGS_GET:           'settings-get',
  SETTINGS_SET:           'settings-set',
  SET_VOLUMES:            'set-volumes',
  SET_THRESHOLDS:         'set-thresholds',
} as const

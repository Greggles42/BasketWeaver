/**
 * Central configuration for Basketweaver.
 * All tunable constants live here; patch at startup via CLI args or IPC.
 * This module is imported by both the main process and the renderer.
 */

export const Config = {
  // ── Window ──────────────────────────────────────────────────
  WINDOW_WIDTH:  376,
  WINDOW_HEIGHT: 100,
  FPS:           60,
  WINDOW_OPACITY: 0.88,
  ALWAYS_ON_TOP:  true,
  VISUAL_MODE:    2,    // 1=circles 2=window bars 3=static timeline 4=swing timer
  WINDOW_SCALE:   50,   // current scale percentage (25/50/75/100)

  // ── Layout ───────────────────────────────────────────────────
  HEADER_H:         10,
  SWING_BAR_H:       5,
  FOOTER_H:         10,
  HIT_ZONE_X:       33,
  NOTE_RADIUS:       5,
  HIGHWAY_DURATION:  3.0,  // seconds of runway visible

  // ── Font sizes (updated by setScale) ─────────────────────────
  FONT_XL: 14,
  FONT_LG: 10,
  FONT_MD: 10,
  FONT_SM: 10,

  // ── Rhythm ───────────────────────────────────────────────────
  PUNCH_INTERVAL:       2.0,
  COMBAT_GRACE:         1.5,
  ROUND_CLUSTER_WINDOW: 0.5,

  // ── Scoring window (seconds, half-width from note target) ────
  GOOD_WINDOW: 0.80,

  // ── Clip detection ───────────────────────────────────────────
  CLIP_DETECTION_WINDOW: 0.80,
  CLIP_AUTO: true,

  // ── Points ───────────────────────────────────────────────────
  HIT_PTS:    100,
  COMBO_STEP:  10,

  // ── Grade thresholds ─────────────────────────────────────────
  GRADE_S: 0.95,
  GRADE_A: 0.85,
  GRADE_B: 0.75,
  GRADE_C: 0.60,
  GRADE_D: 0.45,

  // ── Colors (CSS strings for canvas) ─────────────────────────
  C_BG:          '#0a0c16',
  C_HEADER:      '#0e101e',
  C_FOOTER:      '#0e101e',
  C_HIGHWAY:     '#12142600',  // rendered as filled rect, handled manually
  C_TRACK_LINE:  '#262c50',
  C_NOTE:        '#40a8ff',
  C_NOTE_GLOW:   '#64beff',
  C_NOTE_INNER:  '#c8ebff',
  C_HIT_ZONE:    '#ffc828',
  C_HIT_GLOW:    '#ffe678',
  C_PERFECT:     '#ffd700',
  C_GOOD:        '#50e68c',
  C_MISS:        '#ff3c3c',
  C_TEXT:        '#d2d7f0',
  C_TEXT_DIM:    '#5a6482',
  C_COMBAT:      '#ff6e3c',
  C_IDLE:        '#5a6482',
  C_CLIP:        '#ff7800',

  C_SWING_SAFE:  '#32c864',
  C_SWING_WARN:  '#ffb428',
  C_SWING_CRIT:  '#ff3c3c',

  GRADE_COLORS: {
    'S': '#ffd700',
    'A': '#78ff78',
    'B': '#50b4ff',
    'C': '#ffc850',
    'D': '#c87850',
    'F': '#b43c3c',
    '—': '#969696',
  } as Record<string, string>,

  // ── Audio ────────────────────────────────────────────────────
  SAMPLE_RATE:  44100,
  TICK_VOLUME:  0.38,
  FX_VOLUME:    0.62,
  FIST_SOUND_ON_MISS: true,

  // ── Orientation ──────────────────────────────────────────────
  ORIENTATION: 'horizontal' as 'horizontal' | 'vertical',

  VERT_WINDOW_WIDTH:   43,
  VERT_WINDOW_HEIGHT: 193,

  // ── Timing offsets ────────────────────────────────────────────
  TARGET_OFFSET:         0.000,
  LATENCY_COMPENSATION:  0.000,

  // ── Visual-only hit zone offset (pixels, does not affect timing) ──
  // Positive = shift hit zone right (horizontal) or down (vertical).
  HIT_ZONE_VISUAL_OFFSET: 0,

  // ── Target position (% from approach side, does not affect timing) ──
  // 18 = hit zone sits 18% from the left (H) / 82% from the top (V),
  // leaving ~82% of the highway as runway ahead of it.
  TARGET_POSITION_PCT: 18,

  // ── Scale base dimensions (at 100%) ──────────────────────────
  _BASE_W:   752,
  _BASE_H:   200,
  _BASE_HDR:  40,
  _BASE_SWG:  20,
  _BASE_FTR:  40,
  _BASE_HZX: 132,
  _BASE_RAD:  20,
  _BASE_VW:  172,
  _BASE_VH:  772,
  _BASE_FXL:  54,
  _BASE_FLG:  24,
  _BASE_FMD:  18,
  _BASE_FSM:  13,

  // ── Weapon / haste ────────────────────────────────────────────
  BASE_WEAPON_DELAY:    20,  // EQ tenths-of-seconds
  OFFHAND_WEAPON_DELAY: 16,  // EQ tenths-of-seconds (offhand/fist weapon)
  OFFHAND_WEAPON_NAME:  '',  // display name, auto-detected from /mystats calibration
  HASTE_PCT:             0.0,

  WEAPON_PRESETS: {
    "Bo Staff of Trorsmang":             35,
    "Abashi's Rod of Disillusionment":   30,
    "Caen's Bo Staff of Fury":           30,
    "Tranquil Staff":                    30,
    "Ton Po's Bo Stick of Understanding":40,
    "Imbued Fighter's Staff":            40,
  } as Record<string, number>,

  // ── EQ log regex patterns ─────────────────────────────────────
  // Riposte lines must be checked first — they can match crush/fist patterns
  // but are not normal swing-timer events and would corrupt interval tracking.
  RIPOSTE_PATTERNS:      ['\\bbut you riposte\\b'],
  CRUSH_HIT_PATTERNS:    ['^You crush\\b'],
  CRUSH_MISS_PATTERNS:   ['^You try to crush\\b', '^You attempt to crush\\b'],
  FIST_HIT_PATTERNS:     ['^You (?:punch|strike)\\b'],
  FIST_MISS_PATTERNS:    ['^You try to (?:punch|strike)\\b', '^You attempt to (?:punch|strike)\\b'],
  OUT_OF_RANGE_PATTERNS:    ['Your target is too far away', 'You cannot see your target'],
  CURSOR_BLOCKED_PATTERNS:  ['You cannot swap items when holding something'],
  COMBAT_START_PATTERNS: [
    '^You begin casting\\b',
    '\\bhits? [Yy]ou for \\d+',
    '\\b(kicks?|bites?|claws?|strikes?|slashes?|bashes?|pierces?) [Yy]ou for \\d+',
  ],
  // Mob-death patterns — trigger grade screen + end-combat sound
  MOB_DEATH_PATTERNS: [] as string[],   // handled in code, not regex
  // Silent-end patterns — stop combat tracking, no grade/sound
  COMBAT_END_PATTERNS: [
    '\\bYou have been slain\\b',    // you died
    '\\bYou have left the zone\\b',
    '^Welcome to EverQuest',
  ],
}

export type ConfigType = typeof Config

/** Apply a scale factor (25 / 50 / 75 / 100) to all size-related constants. */
export function setScale(cfg: ConfigType, pct: number): void {
  const s = pct / 100
  cfg.WINDOW_SCALE       = pct
  cfg.WINDOW_WIDTH       = Math.max(188, Math.trunc(cfg._BASE_W   * s))
  cfg.WINDOW_HEIGHT      = Math.max(50,  Math.trunc(cfg._BASE_H   * s))
  cfg.HEADER_H           = Math.max(14,  Math.trunc(cfg._BASE_HDR * s))
  cfg.SWING_BAR_H        = Math.max(5,   Math.trunc(cfg._BASE_SWG * s))
  cfg.FOOTER_H           = Math.max(14,  Math.trunc(cfg._BASE_FTR * s))
  cfg.HIT_ZONE_X         = Math.max(10,  Math.trunc(cfg.WINDOW_WIDTH * cfg.TARGET_POSITION_PCT / 100))
  cfg.NOTE_RADIUS        = Math.max(5,   Math.trunc(cfg._BASE_RAD * s))
  cfg.VERT_WINDOW_WIDTH  = Math.max(43,  Math.trunc(cfg._BASE_VW  * s))
  cfg.VERT_WINDOW_HEIGHT = Math.max(193, Math.trunc(cfg._BASE_VH  * s))
  cfg.FONT_XL            = Math.max(14,  Math.trunc(cfg._BASE_FXL * s))
  cfg.FONT_LG            = Math.max(10,  Math.trunc(cfg._BASE_FLG * s))
  cfg.FONT_MD            = Math.max(10,  Math.trunc(cfg._BASE_FMD * s))
  cfg.FONT_SM            = Math.max(10,  Math.trunc(cfg._BASE_FSM * s))
}

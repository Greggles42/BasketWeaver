/**
 * Central configuration for Basketweaver.
 * All tunable constants live here; patch at startup via CLI args or IPC.
 * This module is imported by both the main process and the renderer.
 */

export const Config = {
  // ── Window ──────────────────────────────────────────────────
  WINDOW_WIDTH:  376,
  WINDOW_HEIGHT: 104,
  FPS:           60,
  WINDOW_OPACITY: 0.88,
  ALWAYS_ON_TOP:  true,
  VISUAL_MODE:    2,    // 1=circles 2=window bars 3=static timeline 4=swing timer

  // ── Layout ───────────────────────────────────────────────────
  HEADER_H:         22,
  SWING_BAR_H:      10,
  FOOTER_H:         22,
  HIT_ZONE_X:       67,
  NOTE_RADIUS:      10,
  HIGHWAY_DURATION:  8.0,  // seconds of runway visible

  // ── Font sizes ───────────────────────────────────────────────
  FONT_XL: 27,
  FONT_LG: 12,
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
  POSITIVE_AUDIO_IN_WINDOW: false,  // punch sound on any in-window attempt; whiff on out-of-window

  // ── Audio volumes (0–1, 1.0 = unity) ─────────────────────────
  VOLUME_MASTER: 1.0,
  VOLUME_PROC:   1.0,
  VOLUME_EPIC:   1.0,

  // ── Sound trigger thresholds ─────────────────────────────────
  CRIT_DAMAGE_THRESHOLD:  400,   // min crit damage for epic.wav
  HUGE_ROUND_THRESHOLD:   600,   // min round damage for oh_snap.wav

  // ── Runtime toggle states (tracked in main process) ──────────
  BUFF_SOUND_ENABLED: true,
  AUDIO_ENABLED:      true,
  WINDOW_PINNED:      true,

  // ── Orientation ──────────────────────────────────────────────
  ORIENTATION: 'horizontal' as 'horizontal' | 'vertical',
  LANE_LINES: false,
  DYNAMIC_WEAVING: true,
  SHOW_OFFHAND_TIMER: true,
  OVERLAY_STYLE: 'refined' as 'refined' | 'standard' | 'highcontrast',
  TRACKING_SOURCE: 'log' as 'log' | 'zeal' | 'hybrid',

  VERT_WINDOW_WIDTH:   86,
  VERT_WINDOW_HEIGHT: 386,

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

  // ── Grading mode ─────────────────────────────────────────────
  // When true, weave attempt grading is based on keystrokes that land in the
  // weave window rather than EQ log fist-attack events. This avoids dual-wield
  // proc failures counting as missed weaves.
  KEYSTROKE_GRADING: false,
  SHOW_ALL_CRITS: true,

  // ── Weapon / haste ────────────────────────────────────────────
  BASE_WEAPON_DELAY:    20,  // EQ tenths-of-seconds
  OFFHAND_WEAPON_DELAY: 16,  // EQ tenths-of-seconds (offhand/fist weapon)
  OFFHAND_WEAPON_NAME:  '',  // display name, set via tray Offhand Delay
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
  RIPOSTE_PATTERNS:      ['\\bbut you riposte\\b', '\\bripostes\\b'],
  CRUSH_HIT_PATTERNS:    ['^You crush\\b'],
  CRUSH_MISS_PATTERNS:   ['^You try to crush\\b', '^You attempt to crush\\b'],
  FIST_HIT_PATTERNS:     ['^You (?:punch|strike)\\b'],
  FIST_MISS_PATTERNS:    ['^You try to (?:punch|strike)\\b', '^You attempt to (?:punch|strike)\\b'],
  // Damage sources counted toward net DPS but not swing-timer events.
  // Kick variants: hits count as MISC_DAMAGE, misses are consumed silently (damage=0 → no emit).
  FLYING_KICK_PATTERNS:  [
    '^You flying kick\\b',
    '^You kick\\b',
    '^You roundkick\\b',
    '^You eagle strike\\b',
    '^You dragon punch\\b',
    '^You tiger claw\\b',
    '^You try to kick\\b',
    '^You attempt to kick\\b',
    '^You try to roundkick\\b',
    '^You attempt to roundkick\\b',
    '^You try to eagle strike\\b',
    '^You attempt to eagle strike\\b',
    '^You try to dragon punch\\b',
    '^You attempt to dragon punch\\b',
    '^You try to tiger claw\\b',
    '^You attempt to tiger claw\\b',
  ],
  PROC_HIT_PATTERNS:     ['^You hit\\b'],
  OUT_OF_RANGE_PATTERNS:    ['Your target is too far away', 'You cannot see your target'],
  CURSOR_BLOCKED_PATTERNS:  ['You cannot swap items when holding something'],
  COMBAT_START_PATTERNS: [
    '^You begin casting\\b',
    '\\bhits? [Yy]ou for \\d+',
    '\\b(kicks?|bites?|claws?|strikes?|slashes?|bashes?|pierces?) [Yy]ou for \\d+',
  ],
  // Mob-death patterns — trigger grade screen + end-combat sound
  MOB_DEATH_PATTERNS: [] as string[],   // handled in code, not regex
  // ── Buff tracking patterns ────────────────────────────────────
  // Avatar (any tier: Avatar / Primal Avatar / Ancient: Ferine Avatar)
  AVATAR_GAINED_PATTERNS: [
    'Your body screams with the power of an [Aa]vatar',
    'Your body screams with the power of a feral [Aa]vatar',
  ],
  AVATAR_LOST_PATTERNS: [
    '^The Avatar departs\\.',
    '^The ferine Avatar departs\\.',
  ],
  // Savagery (Beastlord discipline)
  SAVAGERY_GAINED_PATTERNS: [
    'Your lips curl into a feral snarl as you descend into savagery',
  ],
  SAVAGERY_LOST_PATTERNS: [
    '^The savagery fades\\.',
  ],
  // Innerflame (Monk discipline)
  INNERFLAME_GAINED_PATTERNS: [
    'Your muscles bulge with the force of will\\.',
  ],
  INNERFLAME_LOST_PATTERNS: [
    'Your strength of will fades\\.',
  ],

  // Critical hit notification lines — separate from the damage line
  CRIT_HIT_PATTERNS: [
    'You deliver a Crippling Blow',
    'You deliver a critical hit',
  ],

  // Silent-end patterns — stop combat tracking, no grade/sound
  COMBAT_END_PATTERNS: [
    '\\bYou have been slain\\b',    // you died
    '\\bYou have left the zone\\b',
    '^Welcome to EverQuest',
  ],
}

export type ConfigType = typeof Config

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

  // ── Manual weave window override ─────────────────────────────
  // Full window width in ms (0 = auto: derived from interval − offhand delay).
  // Dynamic weaving can still shrink the window below this value.
  WEAVE_WINDOW_MS: 500,

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

  // ── Audio debounce — minimum ms between repeated crush/punch/whiff sounds ──
  // 0 = disabled. Use ~50–150 ms to prevent double-firing in hybrid mode.
  AUDIO_DEBOUNCE_MS: 150,

  // ── Sound trigger thresholds ─────────────────────────────────
  CRIT_DAMAGE_THRESHOLD:  400,   // min crit damage for epic.wav
  HUGE_ROUND_THRESHOLD:   600,   // min round damage for oh_snap.wav

  // ── Runtime toggle states (tracked in main process) ──────────
  BUFF_SOUND_ENABLED: true,
  AUDIO_ENABLED:      true,
  WINDOW_PINNED:      true,

  // ── Mainhand attack type ──────────────────────────────────────
  // Controls which EQ log verb triggers MAINHAND_CRUSH events.
  // Auto-set when a weapon is selected from the mainhand preset list.
  MAINHAND_ATTACK_TYPE: 'crush' as 'crush' | 'slash' | 'pierce' | 'punch',

  // ── Orientation ──────────────────────────────────────────────
  ORIENTATION: 'horizontal' as 'horizontal',
  LANE_LINES: false,
  DYNAMIC_WEAVING: true,
  SHOW_OFFHAND_TIMER: true,
  OVERLAY_STYLE: 'refined' as 'refined' | 'highcontrast',
  TRACKING_SOURCE: 'log' as 'log' | 'hybrid',

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
  BASE_WEAPON_NAME:     '',  // display name for mainhand preset (avoids alphabetical tie-breaking)
  OFFHAND_WEAPON_NAME:  '',  // display name, set via tray Offhand Delay
  HASTE_PCT:             0.0,
  OFFHAND_CRUSH_ENABLED: false,  // treat 2nd crush in a round as offhand (blunt OH weapons like Ribcracker)
  WEAVE_BANDOLIER_ACTIVE:       false, // runtime: true while a weave bandolier set is loaded (set name contains "weave")
  WEAVE_BANDOLIER_OFF_DELAY_MS: 400,   // ms to keep weave active after swap-back message (Zeal pipe arrives before hit)

  // Mainhand 2H weapons — used for swing interval detection via /mystats
  WEAPON_PRESETS: {
    "Skull Staff of Geoffrey":                 { delay: 20, attackType: 'crush' },
    "Runed Fighters Staff":                    { delay: 20, attackType: 'crush' },
    "Wu's Quivering Staff":                    { delay: 28, attackType: 'crush' },
    "Abashi's Rod of Disempowerment":          { delay: 30, attackType: 'crush' },
    "Caen's Bo Staff of Fury":                 { delay: 30, attackType: 'crush' },
    "Peacebringer":                            { delay: 30, attackType: 'crush' },
    "The Arm of Quellious":                    { delay: 30, attackType: 'crush' },
    "Tranquil Staff":                          { delay: 30, attackType: 'crush' },
    "Bo Staff of Trorsmang":                   { delay: 35, attackType: 'crush' },
    "Efreeti Ice Staff":                       { delay: 35, attackType: 'crush' },
    "Tae Ew Two Hand Hammer":                  { delay: 35, attackType: 'crush' },
    "Amygdalan War Staff":                     { delay: 36, attackType: 'crush' },
    "Exquisite Velium Brawl Stick":            { delay: 36, attackType: 'crush' },
    "Rod of Mourning":                         { delay: 36, attackType: 'crush' },
    "Tae Ew War Maul":                         { delay: 36, attackType: 'crush' },
    "Wrapped Velium Brawl Stick":              { delay: 36, attackType: 'crush' },
    "Carved Velium Brawl Stick":               { delay: 37, attackType: 'crush' },
    "Massive Velium Brawl Stick":              { delay: 37, attackType: 'crush' },
    "Staff of Battle":                         { delay: 37, attackType: 'crush' },
    "Etched Velium Brawl Stick":               { delay: 38, attackType: 'crush' },
    "Gaudralek, Sword of the Sky":             { delay: 38, attackType: 'slash' },
    "Meljeldin, Bane of Giants":               { delay: 38, attackType: 'slash' },
    "Runestone Maul":                          { delay: 38, attackType: 'crush' },
    "Heavy Velium Brawl Stick":                { delay: 39, attackType: 'crush' },
    "Petrified Heartwood Flamberge":           { delay: 39, attackType: 'slash' },
    "Aggression":                              { delay: 40, attackType: 'crush' },
    "Bloodied Berserker's Blade":              { delay: 40, attackType: 'slash' },
    "Bruiser's Beatstick":                     { delay: 40, attackType: 'crush' },
    "Feartouched Greatsword":                  { delay: 40, attackType: 'slash' },
    "Great Maul of Slaughter":                 { delay: 40, attackType: 'crush' },
    "Greatsword of the Disciple":              { delay: 40, attackType: 'slash' },
    "Imbued Fighters Staff":                   { delay: 40, attackType: 'crush' },
    "Scythe of Shadows":                       { delay: 40, attackType: 'slash' },
    "Ton Po's Bo Stick of Understanding":      { delay: 40, attackType: 'crush' },
    "Yttrium War Hammer":                      { delay: 40, attackType: 'crush' },
    "Rocksmasher":                             { delay: 41, attackType: 'crush' },
    "Facesmasher":                             { delay: 42, attackType: 'crush' },
    "Palladius' Axe of Slaughter":             { delay: 42, attackType: 'slash' },
    "The Sword of Ssraeshza":                  { delay: 42, attackType: 'slash' },
    "Frostreaver":                             { delay: 43, attackType: 'slash' },
    "Herbalists Spade":                        { delay: 43, attackType: 'crush' },
    "Scalecracker":                            { delay: 43, attackType: 'crush' },
    "Shovel of the Harvest":                   { delay: 43, attackType: 'crush' },
    "Ancient Prismatic Brawl Stick":           { delay: 44, attackType: 'crush' },
    "Petrified Rod":                           { delay: 44, attackType: 'crush' },
    "Priceless Velium Brawl Stick":            { delay: 44, attackType: 'crush' },
    "Premier Brawl Stick of Secundae":         { delay: 44, attackType: 'crush' },
    "Primal Velium Brawl Stick":               { delay: 44, attackType: 'crush' },
    "Emaciated Maul of the Overseer":          { delay: 45, attackType: 'crush' },
    "Norge`tal":                               { delay: 45, attackType: 'slash' },
    "Twisted Steel Bastard Sword":             { delay: 45, attackType: 'slash' },
    "Blackstone Maul":                         { delay: 53, attackType: 'crush' },
  } as Record<string, { delay: number; attackType: 'crush' | 'slash' | 'pierce' | 'punch' }>,

  // Offhand / fist weapons — used only for BWOH delay lookup, never for swing interval
  OFFHAND_PRESETS: {
    "Fangs of Vyzh`dra":                       19,
    "Fist of Acrylia":                         19,
    "Glowing Mithril Ulak":                    20,
    "Gharn's Rock of Smashing":                19,
    "Fist of Glowing Acrylia":                 19,
    "Horns of Chaos":                          18,
    "Fist of Nature":                          18,
    "Sceptre of Destruction":                  18,
    "Baton of Flame":                          17,
    "Blackout":                                22,
    "Wurmscale Fistwraps":                     18,
    "Essence Mace":                            18,
    "Priceless Velium Fist Wraps":             20,
    "Howling Orb":                             19,
    "Primal Velium Fist Wraps":                20,
    "Dragonrib Club":                          17,
    "Bone Spiked Crusher":                     18,
    "Fist of Mithril":                         22,
    "Ancient Prismatic Fist Wraps":            20,
    "Premier Fist Wraps of Secundae":          20,
    "Sap Encrusted Branch":                    19,
    "Skybreaker":                              19,
    "Fist of Pummeling Prowess":               19,
    "Wu's Fist of Mastery":                    22,
    "Etched Bone Ulak":                        20,
    "Neb's Warbone":                           23,
    "Possessed Sacrificial Club":              19,
    "Ribcracker":                              25,
    "Velium Maul of Superiority":              18,
    "Primal Velium Battlehammer":              20,
    "Ancient Prismatic Staff":                 20,
    "Priceless Velium Battlehammer":           20,
    "Ancient Prismatic Mace":                  20,
    "Vius Handwraps":                          22,
    "Ancient Prismatic Battlehammer":          20,
    "Premier Battlehammer of Secundae":        20,
    "Premier Mace of Secundae":                20,
    "Hammer of the Ironfrost":                 20,
    "Astral Handwraps":                        22,
    "Epic Fists":                              16,
    "White Fire Handwraps":                    22,
    "Acrylia Handled Broadsword":              19,
    "Blade of Carnage":                        20,
    "Grats Bloodfrenzy":                       20,
    "Bloodfrenzy":                             20,
    "Braid of Golden Hair":                    21,
    "Jagged Long Sword":                       30,
    "Vyzh`dra's Render of Souls":              24,
    "Ans Fiel`Tian":                           28,
    "Sarnak Lightning Caller":                 28,
    "Skullcrusher":                            28,
    "Skullcrusher of Kragg":                   28,
    "Longsword of Freedom":                    29,
    "Sabertooth":                              29,
    "Fist of Zek":                             30,
    "Katana of Endurance":                     30,
    "Smolder":                                 30,
    "Katana of Enduring Stone":                31,
    "Katana of Flowing Water":                 33,
    "Green Jade Axe":                          34,
    "Scimitar of the Emerald Dawn":            34,
  } as Record<string, number>,

  // ── EQ log regex patterns ─────────────────────────────────────
  // Riposte lines must be checked first — they can match crush/fist patterns
  // but are not normal swing-timer events and would corrupt interval tracking.
  RIPOSTE_PATTERNS:      ['^You riposte\\b'],
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
  OUT_OF_RANGE_PATTERNS:    ['Your target is too far away', 'You cannot see your target', "You can't hit them from here"],
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

  // Whirlwind (Monk discipline)
  WHIRLWIND_GAINED_PATTERNS: [
    'Your instincts take over as you turn aside every attack\\.',
  ],
  WHIRLWIND_LOST_PATTERNS: [
    'Your fury fades\\.',
  ],

  // ── Auto-detect active log ────────────────────────────────────
  // When enabled, monitors all eqlog_*.txt files in the log directory and
  // automatically switches to whichever file is actively growing.
  AUTO_DETECT_LOG: false,

  // ── Leaderboard ───────────────────────────────────────────────
  LEADERBOARD_CHARACTER_NAME: '',   // auto-populated from log filename or Zeal pipe

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

/**
 * Real-time EverQuest log file tailer — main process, Node.js.
 * Emits GameEvent objects via the provided callback.
 *
 * EQ log line format:
 *   [Day Mon DD HH:MM:SS YYYY] Message text here.
 *
 * We strip the timestamp prefix and match against message content.
 * Timestamps use performance.now() for sub-millisecond precision
 * (mirrors Python's time.perf_counter()).
 */

import * as fs from 'fs'
import { performance } from 'perf_hooks'
import { EvType, type GameEvent } from '../shared/events'
import { type ConfigType } from '../shared/config'
import { parseHaste, calcInterval, parseAtkRating } from './haste-calc'

const PREFIX_RE = /^\[.+?\]\s*/
const DAMAGE_RE = /for\s+(\d+)\s+point/i

// /mystats lines that describe the offhand/secondary weapon slot.
// Matched lines are skipped during weapon and haste detection so only
// the mainhand weapon delay and the character haste value are extracted.
const OFFHAND_LINE_RE = /^(?:secondary|off[\s\-]?(?:hand|weapon)|offhand)[\s:]/i

// Guard for weapon preset detection: only match within a /mystats mainhand line,
// which always starts with "Melee Primary:".  Prevents chat messages (including
// linked items that also show a Delay field) from updating the equipped weapon.
const MYSTATS_WEAPON_LINE_RE = /\bMelee Primary\s*:/i

function stripPrefix(line: string): string {
  const m = PREFIX_RE.exec(line)
  return m ? line.slice(m[0].length) : line
}

function parseDamage(content: string): number {
  const m = DAMAGE_RE.exec(content)
  return m ? parseInt(m[1], 10) : 0
}

export type EventCallback = (ev: GameEvent) => void

export class LogReader {
  private path: string
  private cfg: ConfigType
  private onEvent: EventCallback
  private stopped = false

  private inCombat = false

  private currentTarget   = ''   // most recent mob the player was attacking
  private lastAttackTs    = 0    // performance.now() of last attack on currentTarget
  private lastRiposteTs   = 0    // performance.now() of last "You riposte" line (__DEV__ debug only)
  private lastHastePct    = -1   // dedup: last emitted haste value
  private lastHasteEmitTs = 0    // dedup: when it was emitted
  private lastAtkRating   = 0
  private lastAtkEmitTs   = 0

  // ── Weapon track state ────────────────────────────────────
  private weaponTrackActive = false
  private weaponTrack2H     = ''
  private weaponTrackOH     = ''

  // ── Same-type offhand tracking (OFFHAND_CRUSH_ENABLED) ────
  private offhandCrushPending = false
  private offhandCrushExpiry  = 0   // performance.now() deadline (ms)

  // ── Bandolier weave tracking: state shared via cfg.WEAVE_BANDOLIER_ACTIVE ──

  // ── Technique of Master Wu round clustering ───────────────────
  private wuBuffer: Array<{ skill: string; hit: boolean; damage: number; target?: string }> = []
  private wuTimer: ReturnType<typeof setTimeout> | null = null
  private wuTarget = ''
  private wuRoundStart = 0

  // Extracts target name from "You crush/punch/strike/hit X for N points"
  private static readonly TARGET_RE = /^You (?:crush|slash|pierce|punch|strike|bash|hit) (.+?) for \d+/i

  // ── Technique of Master Wu detection ──────────────────────────
  // Most EQ servers print no skill name at all for these attacks — just a
  // generic verb (kick/strike/claw), the same ambiguity called out in this
  // feature's original spec. "kick" covers Flying Kick, Round Kick, AND the
  // base Kick skill indistinguishably; "strike" and "claw" are Eagle Strike
  // and Tiger Claw but also collide with normal fist/offhand verbs. A few
  // literal multi-word names are kept as a fallback for servers that do
  // print them. Because of this ambiguity, flushWuRound() additionally
  // requires a kick-family hit to "anchor" the round (Wu always fires off a
  // Flying Kick use) before counting it as a proc — see there for why that
  // keeps an incidental "strike" from a normal swing from being misread.
  private static readonly MONK_SPECIAL_HIT_RE =
    /^You (flying kick|roundkick|eagle strike|tiger claw|kick|strike|claw) (.+?) for (\d+)\s+points? of damage/i
  private static readonly MONK_SPECIAL_MISS_RE =
    /^You (?:try to|attempt to) (flying kick|roundkick|eagle strike|tiger claw|kick|strike|claw)\b/i
  private static readonly MONK_SKILL_NAMES: Record<string, string> = {
    'flying kick':   'Flying Kick',
    'roundkick':     'Round Kick',
    'eagle strike':  'Eagle Strike',
    'tiger claw':    'Tiger Claw',
    'kick':          'Kick',
    'strike':        'Strike',
    'claw':          'Claw',
  }
  // Skills whose presence in a round "anchors" it as a genuine Wu proc — Wu
  // always triggers off a Flying Kick use, so require at least one kick-family
  // hit before trusting a strike/claw coincidence as part of the same round.
  private static readonly WU_ANCHOR_SKILLS = new Set(['Flying Kick', 'Round Kick', 'Kick'])
  // Window after a monk special attack line in which any further monk special
  // lines against the same target are considered part of the same Wu round.
  private static readonly WU_ROUND_WINDOW_MS = 300
  // Hard cap on a round's total span from its first hit. A Wu round's attacks
  // all land within ~1s of each other; without this cap, monk specials firing
  // faster than WU_ROUND_WINDOW_MS apart would keep rearming the timer forever
  // and swallow the start of the *next* potential proc into this round.
  private static readonly WU_ROUND_MAX_MS = 1000

  // Matches the EQ system message printed on every zone transition.
  private static readonly ZONE_ENTER_RE = /^You have entered ([^.]+)\.$/i

  // Mob enrage state messages — not player-sourced, so tracked unconditionally
  // (like zone changes) regardless of reader mode.
  private static readonly ENRAGE_START_RE = /^(.+?) has become ENRAGED\.?\s*$/i
  private static readonly ENRAGE_END_RE   = /^(.+?) is no longer enraged\.?\s*$/i

  // Root/immobilize landed-on-target emotes. Not player-sourced, so tracked
  // unconditionally (like zone changes and enrage) regardless of reader mode.
  // Covers every root-family spell's emote text (Ensnaring Roots, Immobilize,
  // Net, Barbed Chains, etc.) — see spell emote table for the full spell list.
  private static readonly ROOT_RE = new RegExp(
    '^(.+?) (?:' + [
      'is entwined by roots',
      'adheres to the ground',
      'turns into a tree',
      'sinks into the ground',
      'becomes entwined in roots',
      "'s image shimmers",
      'is trapped within a whirling wind',
      'stumbles',
      'is stuck to the ground as they begin to regenerate',
      'is encased in meteor dust',
      'is wrapped in chains',
      'is bound, unable to move',
      'is entrapped by roots',
      'is entangled by roots',
      'is entangled by a net',
      'is entombed by elemental ice',
      'is crushed to the ground by a massive boulder',
      'is enveloped in a cloud of noxious spores',
      'is caught in a shackle',
      "'s feet are entangled by worms",
      'is entombed in the earth',
      'becomes entangled by wormspore tentacles',
      'is caught in a web of flame',
      'has been struck by valor',
      'has been struck back',
      'is entrapped by the Rathe',
      'sneezes violently',
      'sinks into dark sand',
      "'s legs collapse",
      "'s body begins to quiver",
      'is covered in dark sand',
    ].join('|') + ')[.!]?\\s*$', 'i')

  // Tash line (resist debuff) landed-on-target emote.
  private static readonly TASH_RE = /^(.+?) glances nervously about\.?\s*$/i

  // Slow-effect landed-on-target emotes. Note "is wrapped in chains" is shared
  // with a root spell (Barbed Chains / Web of Chain) — ROOT_RE is checked first
  // so that ambiguous case is reported as a root, matching real game ambiguity.
  private static readonly SLOW_RE = new RegExp(
    '^(.+?) (?:' + [
      'slows down',
      'yawns',
      'is bound by strands of solid music',
      'is surrounded by chains of music',
      'is bound by chords of music',
      'is encased in water',
      "'s body begins to rot",
      'is slowed by the freezing blast',
      "'s veins have been filled with deadly poison",
      "'s wounds begin to heal",
      'looks dazed',
      'is struck by an enormous comet',
      'has been crippled by a deadly strike',
      "'s skin begins to melt into black decay",
      'is wrapped in chains',
      'has fallen to the will of the crusader',
      'looks lethargic',
      'is wracked by the chill of unlife',
      'falls into a state of torpor',
      'has been deafened',
      'is bound by silver strands of music',
      "'s muscles lock",
      'is slowed by the embracing earth',
      'is crushed by a wall of water',
      'is slowed by the mist of the seas',
      'looks sad',
      'is slowed by the Bane of Thule',
      'is drenched in green slime',
      'is entrapped by living shadows',
      "'s knees buckle",
      'has been numbed with cold',
      'is encased in a static pulse',
      'staggers around shivering',
      'has been struck by a huge frozen arrow',
      "'s motions slow as a plague of insects chews at their skin",
      'is hindered by a shackle of bone',
      'is hindered by a shackle of spirit',
      'feels lethargic',
      'is wracked by the vengeance of Sha',
      'is doused in fungal fluids',
      'chokes on poison gas',
      'is stricken by the curse of Xerkizh the Creator',
      'loses their fighting edge',
      'has been slowed',
      'is slashed by shards of ice',
      'is surrounded by an icy mist',
      "'s rhythm slows",
      'begins to move very slowly',
      'is surrounded by spirits of the air',
      'has been judged by the elements',
      'has been poisoned',
      'feels very sleepy',
      'is pierced by glass',
      'screams in unbearable terror',
      "'s body is covered in a brown mist",
      'falls into a state of stoicism',
      'is surrounded by raging water',
      "'s mind and body slow",
      'trembles in agony',
      'is wrapped in the curse of inevitability',
      'looks panicked and gasps for breath',
      'is covered in thin ice',
      'is covered in thick ice',
    ].join('|') + ')[.!]?\\s*$', 'i')

  // Snare-effect landed-on-target emotes. Several of these emote strings are
  // also used by slow spells (e.g. "'s knees buckle.", "looks lethargic.") —
  // SLOW_RE is checked first, so an ambiguous line reports as SLOWED, matching
  // real game ambiguity (the text alone can't distinguish the two spells).
  private static readonly SNARE_RE = new RegExp(
    '^(.+?) (?:' + [
      'has been ensnared',
      'is surrounded by darkness',
      'is engulfed by darkness',
      'is bound by strands of force',
      'is surrounded by chains of music',
      'has been poisoned',
      'is encased in water',
      "'s body burns as the acid hits them",
      'is engulfed by inescapable darkness',
      'is covered in oil',
      'is covered in putrid webbing',
      'takes a deep slice to the leg',
      'has been covered in duboes',
      'has been plagued',
      'pores are filled with puss',
      'has been overcome by a foul stench',
      'is wrapped in chains',
      'has been cursed by the spirits of the shrine',
      'screams as poison burns their veins',
      "'s knees buckle",
      'looks lethargic',
      'is engulfed in a blinding rage',
      'cries out as they are assaulted by a storm of Locusts',
      'falls into a state of torpor',
      'is engulfed in devouring darkness',
      'is shackled to the ground',
      'is bound by strands of solid music',
      'is bound by silver strands of music',
      'is dragged down by dark vines',
      'is covered in fungus',
      "'s muscles lock",
      'is gripped by shadows of fear and terror',
      'has been snared by vines of kelp',
      'spasms violently',
      'is covered in a poisoned web',
      'is drenched in green slime',
      'is entrapped by living shadows',
      'staggers around shivering',
      'grows pale',
      'appears very pale',
      'has been struck by a huge frozen arrow',
      "'s body is pelted by spores",
      "'s movements slow as their feet are covered in tangling weeds",
      'is engulfed in an embracing darkness',
      'is engulfed by a festering darkness',
      'starts to sink as a pool of quicksand opens beneath them',
      'is entangled in a barbed fishing net',
      "'s legs are slammed by a large rock",
      'is pelted by a cloud of gravel',
      'is blasted by raw energy',
      'is caught in a net of fungus',
      'is pelted by a cloud of pebbles',
      'is engulfed by horrific darkness',
      'is covered in a plagued web',
      'has been hobbled by the spirit of the swamp',
      "'s body is gripped in unlife",
      'falls into a state of stoicism',
      'is surrounded by raging water',
      'has been cursed by the souls of the dead',
      'has been frozen in fear',
      "'s body is assaulted by a black plague",
      'is covered in oozing pus',
    ].join('|') + ')[.!]?\\s*$', 'i')

  private crushHitRe:    RegExp[]
  private crushMissRe:   RegExp[]
  private riposteRe:     RegExp[]
  private fistHitRe:     RegExp[]
  private fistMissRe:    RegExp[]
  // Catch-all for non-mainhand non-punch attack types while weave bandolier is active
  // (e.g. slash/pierce offhand weave weapon when mainhand is crush).
  private weaveHitRe:    RegExp
  private weaveMissRe:   RegExp
  // Rogue Mode — backstab hit/miss (fixed patterns, not weapon-type-dependent)
  private backstabHitRe:  RegExp = /^You backstab (.+?) for (\d+) points? of damage\.?\s*$/i
  private backstabMissRe: RegExp = /^You try to backstab (.+?), but miss!\s*$/i
  private flyingKickRe:  RegExp[]
  private procHitRe:     RegExp[]
  private oorRe:           RegExp[]
  private cursorBlockedRe: RegExp[]
  private startRe:      RegExp[]
  private endRe:        RegExp[]
  private weaponRe:     Array<{ re: RegExp; name: string; delay: number; attackType: string }>
  private avatarGainedRe: RegExp[]
  private avatarLostRe:   RegExp[]
  private savageryGainedRe: RegExp[]
  private savageryLostRe:   RegExp[]
  private innerflamGainedRe:   RegExp[]
  private innerflamLostRe:     RegExp[]
  private whirlwindGainedRe:   RegExp[]
  private whirlwindLostRe:     RegExp[]
  private critHitRe:    RegExp[]
  private missOnly:        boolean
  private weaponTrackOnly: boolean
  private noBandolier:     boolean
  private damageOnly:      boolean

  private static readonly verbPatterns: Record<string, { hit: string[]; miss: string[] }> = {
    crush:  { hit: ['^You crush\\b',  '^You hit\\b'],  miss: ['^You try to crush\\b',  '^You attempt to crush\\b',  '^You try to hit\\b', '^You attempt to hit\\b']  },
    slash:  { hit: ['^You slash\\b',  '^You hit\\b'],  miss: ['^You try to slash\\b',  '^You attempt to slash\\b',  '^You try to hit\\b', '^You attempt to hit\\b']   },
    pierce: { hit: ['^You pierce\\b', '^You hit\\b'],  miss: ['^You try to pierce\\b', '^You attempt to pierce\\b', '^You try to hit\\b', '^You attempt to hit\\b']  },
    punch:  { hit: ['^You punch\\b', '^You strike\\b', '^You hit\\b'],
              miss: ['^You try to punch\\b', '^You attempt to punch\\b',
                     '^You try to strike\\b', '^You attempt to strike\\b',
                     '^You try to hit\\b',    '^You attempt to hit\\b'] },
  }

  constructor(path: string, cfg: ConfigType, onEvent: EventCallback, opts: { missOnly?: boolean; weaponTrackOnly?: boolean; noBandolier?: boolean; damageOnly?: boolean } = {}) {
    this.path            = path
    this.cfg             = cfg
    this.onEvent         = onEvent
    this.missOnly        = opts.missOnly        ?? false
    this.weaponTrackOnly = opts.weaponTrackOnly ?? false
    this.noBandolier     = opts.noBandolier     ?? false
    this.damageOnly      = opts.damageOnly      ?? false

    const compile = (patterns: string[]) =>
      patterns.map(p => new RegExp(p, 'i'))

    this.riposteRe    = compile(cfg.RIPOSTE_PATTERNS)
    const vp = LogReader.verbPatterns[cfg.MAINHAND_ATTACK_TYPE] ?? LogReader.verbPatterns.crush
    this.crushHitRe   = compile(vp.hit)
    this.crushMissRe  = compile(vp.miss)
    this.fistHitRe    = compile(cfg.FIST_HIT_PATTERNS)
    this.fistMissRe   = compile(cfg.FIST_MISS_PATTERNS)
    this.weaveHitRe   = /^You (?:crush|slash|pierce|punch|strike|bash|hit)\b/i
    this.weaveMissRe  = /^You (?:try to|attempt to) (?:crush|slash|pierce|punch|strike|bash|hit)\b/i
    this.flyingKickRe = compile(cfg.FLYING_KICK_PATTERNS)
    this.procHitRe    = compile(cfg.PROC_HIT_PATTERNS)
    this.oorRe            = compile(cfg.OUT_OF_RANGE_PATTERNS)
    this.cursorBlockedRe  = compile(cfg.CURSOR_BLOCKED_PATTERNS)
    this.startRe     = compile(cfg.COMBAT_START_PATTERNS)
    this.endRe       = compile(cfg.COMBAT_END_PATTERNS)

    this.avatarGainedRe   = compile(cfg.AVATAR_GAINED_PATTERNS)
    this.avatarLostRe     = compile(cfg.AVATAR_LOST_PATTERNS)
    this.savageryGainedRe  = compile(cfg.SAVAGERY_GAINED_PATTERNS)
    this.savageryLostRe    = compile(cfg.SAVAGERY_LOST_PATTERNS)
    this.innerflamGainedRe  = compile(cfg.INNERFLAME_GAINED_PATTERNS)
    this.innerflamLostRe    = compile(cfg.INNERFLAME_LOST_PATTERNS)
    this.whirlwindGainedRe  = compile(cfg.WHIRLWIND_GAINED_PATTERNS)
    this.whirlwindLostRe    = compile(cfg.WHIRLWIND_LOST_PATTERNS)
    this.critHitRe          = compile(cfg.CRIT_HIT_PATTERNS)

    this.weaponRe = Object.entries(cfg.WEAPON_PRESETS).map(([name, { delay, attackType }]) => ({
      re: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      name,
      delay,
      attackType,
    }))
  }

  /** Recompile hit/miss regexes after the mainhand attack type changes (e.g. weapon swap). */
  updateAttackType(attackType: string): void {
    const vp = LogReader.verbPatterns[attackType] ?? LogReader.verbPatterns.crush
    const compile = (patterns: string[]) => patterns.map(p => new RegExp(p, 'i'))
    this.crushHitRe  = compile(vp.hit)
    this.crushMissRe = compile(vp.miss)
  }

  /** Start tailing. Returns a cleanup function. */
  start(): () => void {
    let fd: number
    let buffer = ''
    let fileSize = 0

    try {
      fd = fs.openSync(this.path, 'r')
      // Seek to end — only process new lines
      fileSize = fs.fstatSync(fd).size
    } catch (e) {
      console.error(`[LogReader] Cannot open ${this.path}: ${e}`)
      return () => {}
    }

    const readChunk = () => {
      if (this.stopped) return
      try {
        const stat = fs.fstatSync(fd)
        if (stat.size > fileSize) {
          const toRead = stat.size - fileSize
          const buf = Buffer.alloc(toRead)
          const bytesRead = fs.readSync(fd, buf, 0, toRead, fileSize)
          fileSize += bytesRead
          buffer += buf.toString('latin1', 0, bytesRead)

          const lines = buffer.split('\n')
          buffer = lines[lines.length - 1]  // keep incomplete trailing line
          for (let i = 0; i < lines.length - 1; i++) {
            this.processLine(lines[i].trim())
          }
        }
      } catch (e) {
        console.error(`[LogReader] Read error: ${e}`)
      }
    }

    const interval = setInterval(readChunk, 8)

    return () => {
      this.stopped = true
      clearInterval(interval)
      try { fs.closeSync(fd) } catch {}
    }
  }

  stop(): void {
    this.stopped = true
    if (this.wuTimer) clearTimeout(this.wuTimer)
  }

  /** Classifies a line as a monk special attack (hit or miss), or null if it's not one. */
  private classifyMonkSpecial(content: string): { skill: string; hit: boolean; damage: number; target?: string } | null {
    const hm = LogReader.MONK_SPECIAL_HIT_RE.exec(content)
    if (hm) {
      return { skill: LogReader.MONK_SKILL_NAMES[hm[1].toLowerCase()], hit: true, damage: parseInt(hm[3], 10), target: hm[2] }
    }
    const mm = LogReader.MONK_SPECIAL_MISS_RE.exec(content)
    if (mm) {
      return { skill: LogReader.MONK_SKILL_NAMES[mm[1].toLowerCase()], hit: false, damage: 0 }
    }
    return null
  }

  /** Buffers a monk special attack and (re)arms the flush timer for the current Wu round. */
  private trackWuRound(hit: { skill: string; hit: boolean; damage: number; target?: string }, now: number): void {
    if (this.wuBuffer.length === 0) {
      this.wuRoundStart = now
    } else if (now - this.wuRoundStart >= LogReader.WU_ROUND_MAX_MS) {
      // This round already ran its full 1s span — whatever's buffered is done;
      // this hit belongs to a new (potential) round, not a carried-over one.
      this.flushWuRound()
      this.wuRoundStart = now
    }
    if (hit.target) this.wuTarget = hit.target
    this.wuBuffer.push(hit)
    if (this.wuTimer) clearTimeout(this.wuTimer)
    const remaining = Math.max(0, LogReader.WU_ROUND_MAX_MS - (now - this.wuRoundStart))
    this.wuTimer = setTimeout(() => this.flushWuRound(), Math.min(LogReader.WU_ROUND_WINDOW_MS, remaining))
  }

  /** Emits WU_PROC if the buffered round contains more than one monk special
   *  attempt — hit OR miss. The proc is the extra *attempt*, not the damage;
   *  a Wu-triggered swing that whiffs is still a Wu proc, so misses count
   *  toward the attempt total even though they don't add to the damage total. */
  private flushWuRound(): void {
    const buffer = this.wuBuffer
    this.wuBuffer = []
    this.wuTimer = null

    if (buffer.length < 2) return  // a single special attempt is not a proc

    // Wu always triggers off a Flying Kick use — without a kick-family attempt
    // anchoring the round, a "strike"/"claw" coincidence is more likely an
    // ordinary swing landing nearby than a genuine proc (see the ambiguous-verb
    // note on MONK_SPECIAL_HIT_RE above).
    const anchorIdx = buffer.findIndex(h => LogReader.WU_ANCHOR_SKILLS.has(h.skill))
    if (anchorIdx === -1) return

    // Prefer a landed kick-family hit as the "main" attack for display purposes;
    // fall back to the anchor attempt itself if the triggering kick whiffed.
    let mainIdx = buffer.findIndex(h => h.hit && LogReader.WU_ANCHOR_SKILLS.has(h.skill))
    if (mainIdx === -1) mainIdx = anchorIdx
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i].hit && LogReader.WU_ANCHOR_SKILLS.has(buffer[i].skill) && buffer[i].damage > buffer[mainIdx].damage) mainIdx = i
    }
    const mainHit = buffer[mainIdx]
    const extraHits = buffer.filter((_, i) => i !== mainIdx)
    const roundTotalDamage = buffer.reduce((sum, h) => sum + h.damage, 0)

    this.emit({ type: EvType.WU_PROC, ts: performance.now(), data: {
      target: this.wuTarget || this.currentTarget,
      mainHit: { skill: mainHit.skill, damage: mainHit.damage, hit: mainHit.hit },
      extraHits: extraHits.map(h => ({ skill: h.skill, damage: h.damage, hit: h.hit })),
      roundTotalDamage,
    } })
  }

  private processLine(line: string): void {
    if (!line) return
    const content = stripPrefix(line)
    const now = performance.now()

    // ── Zone transitions — tracked in every mode so ambiguous same-name
    // raid bosses can be disambiguated by zone at upload time. ──
    const zoneMatch = LogReader.ZONE_ENTER_RE.exec(content)
    if (zoneMatch) {
      this.emit({ type: EvType.ZONE_CHANGED, ts: now, data: { zone: zoneMatch[1].trim() } })
      return
    }

    // ── Mob enrage state — tracked in every mode, same as zone changes ──
    const enrageStart = LogReader.ENRAGE_START_RE.exec(content)
    if (enrageStart) {
      this.emit({ type: EvType.MOB_ENRAGED, ts: now, data: { mobName: enrageStart[1].trim() } })
      return
    }
    const enrageEnd = LogReader.ENRAGE_END_RE.exec(content)
    if (enrageEnd) {
      this.emit({ type: EvType.MOB_UNENRAGED, ts: now, data: { mobName: enrageEnd[1].trim() } })
      return
    }

    // ── Root/immobilize landed-on-target — tracked in every mode, same as enrage ──
    const rootMatch = LogReader.ROOT_RE.exec(content)
    if (rootMatch) {
      this.emit({ type: EvType.MOB_ROOTED, ts: now, data: { mobName: rootMatch[1].trim() } })
      return
    }

    // ── Tash line landed-on-target — tracked in every mode, same as root ──
    const tashMatch = LogReader.TASH_RE.exec(content)
    if (tashMatch) {
      this.emit({ type: EvType.MOB_TASHED, ts: now, data: { mobName: tashMatch[1].trim() } })
      return
    }

    // ── Slow effect landed-on-target — tracked in every mode, same as root ──
    const slowMatch = LogReader.SLOW_RE.exec(content)
    if (slowMatch) {
      this.emit({ type: EvType.MOB_SLOWED, ts: now, data: { mobName: slowMatch[1].trim() } })
      return
    }

    // ── Snare effect landed-on-target — tracked in every mode, same as slow ──
    const snareMatch = LogReader.SNARE_RE.exec(content)
    if (snareMatch) {
      this.emit({ type: EvType.MOB_SNARED, ts: now, data: { mobName: snareMatch[1].trim() } })
      return
    }

    // ── Weapon track — BW2H / BWOH work standalone in any channel ──
    // Checked before missOnly so it works in hybrid mode too.
    const m2h = /\bBW2H\s+(.+)/i.exec(content)
    if (m2h) {
      this.weaponTrack2H = m2h[1].trim().replace(/['"]\s*$/, '')
      this.emitWeaponTrack(now)
      return
    }
    const moh = /\bBWOH\s+(.+)/i.exec(content)
    if (moh) {
      this.weaponTrackOH = moh[1].trim().replace(/['"]\s*$/, '')
      this.emitWeaponTrack(now)
      return
    }
    if (this.weaponTrackOnly) return

    // ── damageOnly mode: emit LOG_DAMAGE for hit events; skip all state-machine logic ──
    if (this.damageOnly) {
      // Wu round probe — checked first since generic "strike"/"claw" verbs would
      // otherwise be consumed by the fist-hit branch below before ever being seen.
      const monkDO = this.classifyMonkSpecial(content)
      if (monkDO) this.trackWuRound(monkDO, now)

      // Ripostes → misc damage (player-sourced only)
      if (this.riposteRe.some(r => r.test(content)) || /\briposte/i.test(content)) {
        if (content.startsWith('You ')) {
          const damage = parseDamage(content)
          if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'misc' } })
        }
        return
      }
      // Backstab hit (Rogue Mode) — authoritative damage source in hybrid mode
      if (this.backstabHitRe.test(content)) {
        const m = this.backstabHitRe.exec(content)
        const damage = m ? parseInt(m[2], 10) : 0
        if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'backstab' } })
        return
      }
      // Mainhand crush hit (may be DW offhand) — suppressed in Rogue Mode
      if (this.crushHitRe.some(r => r.test(content))) {
        if (this.cfg.ROGUE_MODE_ENABLED) return
        const bandolierWeave = this.cfg.WEAVE_BANDOLIER_ACTIVE
        const damage = parseDamage(content)
        if (bandolierWeave || (this.offhandCrushPending && now < this.offhandCrushExpiry)) {
          this.offhandCrushPending = false
          if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'fist' } })
        } else {
          if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'mainhand' } })
          if (this.cfg.OFFHAND_CRUSH_ENABLED && !bandolierWeave) {
            this.offhandCrushPending = true
            this.offhandCrushExpiry  = now + this.cfg.PUNCH_INTERVAL * 1000 * 0.9
          }
        }
        return
      }
      // Fist hit — suppressed in Rogue Mode
      if (this.fistHitRe.some(r => r.test(content))) {
        if (this.cfg.ROGUE_MODE_ENABLED) return
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'fist' } })
        return
      }
      // Non-punch bandolier weave hit — suppressed in Rogue Mode
      if (this.cfg.WEAVE_BANDOLIER_ACTIVE && this.weaveHitRe.test(content)) {
        if (this.cfg.ROGUE_MODE_ENABLED) return
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'fist' } })
        return
      }
      // Flying kick
      if (this.flyingKickRe.some(r => r.test(content))) {
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'misc' } })
        return
      }
      // Item proc
      if (this.procHitRe.some(r => r.test(content))) {
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'misc' } })
        return
      }
      // Critical hit notification (fallback for ZealReader MeleeCrits misses)
      if (this.critHitRe.some(r => r.test(content))) {
        const m = /\((\d+)\)/.exec(content)
        const damage = m ? parseInt(m[1], 10) : 0
        if (damage > 0) this.emit({ type: EvType.CRIT_HIT, ts: now, data: { damage, target: this.currentTarget } })
        return
      }
      return
    }

    // ── missOnly mode: emit crush/fist misses and buff changes, ignore everything else ──
    if (this.missOnly) {
      // Ripostes must never affect the swing timer — drop them before the miss checks
      // so a riposte miss with a slash/pierce weapon doesn't look like a mainhand miss.
      if (this.riposteRe.some(r => r.test(content)) || /\briposte/i.test(content)) {
        if (__DEV__) {
          console.debug(`[riposte][missOnly] line="${content}" offhandCrushPending=${this.offhandCrushPending}`)
          this.lastRiposteTs = now
        }
        return
      }

      // Track bandolier swaps in missOnly mode only when noBandolier is not set.
      // In hybrid mode the Zeal pipe owns bandolier detection (with off-delay);
      // reading bandolier from the log would immediately clear WEAVE_BANDOLIER_ACTIVE
      // and defeat the off-delay, causing in-flight weave hits to misclassify.
      if (!this.noBandolier) {
        const bm = /^Loading bandolier set (.+?)\.?\s*$/i.exec(content)
        if (bm) {
          const setName = bm[1].trim().replace(/^\[|\]$/g, '')
          const isWeaveSet = setName.toLowerCase().includes('weave')
          const isBackstabSet = setName.toLowerCase().includes(this.cfg.ROGUE_BACKSTAB_SET_NAME.toLowerCase())
          this.cfg.WEAVE_BANDOLIER_ACTIVE = isWeaveSet
          this.cfg.ROGUE_BACKSTAB_SET_ACTIVE = isBackstabSet
          this.emit({ type: EvType.BANDOLIER_CHANGED, ts: now, data: { setName, isWeaveSet, isBackstabSet } })
          return
        }
      }
      // Backstab miss (Rogue Mode)
      if (this.backstabMissRe.test(content)) {
        this.emit({ type: EvType.BACKSTAB_ATTACK, ts: now, data: { damage: 0, hit: false } })
        return
      }
      // Catch both explicit miss patterns ("You try to slash") and zero-damage hit-verb
      // lines ("You slash NAME but miss!" / "You slash NAME." with no damage).  Some EQ
      // clients omit the "try to" prefix for the primary attack; the double-attack attempt
      // uses it, which is why double misses produce audio but single misses previously didn't.
      const isMainhandMiss = !this.cfg.ROGUE_MODE_ENABLED && (this.crushMissRe.some(r => r.test(content)) ||
        (this.crushHitRe.some(r => r.test(content)) && parseDamage(content) === 0))
      if (isMainhandMiss) {
        const bandolierWeave = this.cfg.WEAVE_BANDOLIER_ACTIVE
        const offhandWindowActive = this.cfg.OFFHAND_CRUSH_ENABLED && this.offhandCrushPending && now < this.offhandCrushExpiry
        if (__DEV__) {
          const sinceRiposte = this.lastRiposteTs > 0 ? ((now - this.lastRiposteTs) / 1000).toFixed(3) : 'n/a'
          console.debug(`[mainhand][missOnly] miss line="${content}" bandolierWeave=${bandolierWeave} ` +
            `offhandCrushPending=${this.offhandCrushPending} offhandWindowActive=${offhandWindowActive} sinceLastRiposte=${sinceRiposte}s ` +
            `-> classified as ${bandolierWeave || offhandWindowActive ? 'FIST_ATTACK (offhand)' : 'MAINHAND_CRUSH'}`)
        }
        if (bandolierWeave || offhandWindowActive) {
          this.offhandCrushPending = false
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage: 0, hit: false, line: content } })
        } else {
          this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
            data: { damage: 0, hit: false, line: content } })
          if (this.cfg.OFFHAND_CRUSH_ENABLED) {
            this.offhandCrushPending = true
            this.offhandCrushExpiry  = now + this.cfg.PUNCH_INTERVAL * 1000 * 0.9
          }
        }
      } else if (!this.cfg.ROGUE_MODE_ENABLED && (this.fistMissRe.some(r => r.test(content)) ||
                 (this.fistHitRe.some(r => r.test(content)) && parseDamage(content) === 0))) {
        this.emit({ type: EvType.FIST_ATTACK, ts: now,
          data: { damage: 0, hit: false, line: content } })
      } else if (!this.cfg.ROGUE_MODE_ENABLED && this.cfg.WEAVE_BANDOLIER_ACTIVE && this.weaveMissRe.test(content)) {
        // Non-punch offhand weave miss (different verb from mainhand and fist)
        this.emit({ type: EvType.FIST_ATTACK, ts: now,
          data: { damage: 0, hit: false, line: content } })
      } else if (this.avatarGainedRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'avatar', active: true } })
      } else if (this.avatarLostRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'avatar', active: false } })
      } else if (this.savageryGainedRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: true } })
      } else if (this.savageryLostRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: false } })
      } else if (this.innerflamGainedRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'innerflame', active: true } })
      } else if (this.innerflamLostRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'innerflame', active: false } })
      } else if (this.whirlwindGainedRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'whirlwind', active: true } })
      } else if (this.whirlwindLostRe.some(r => r.test(content))) {
        this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'whirlwind', active: false } })
      }
      return
    }

    // ── Bandolier swap detection ────────────────────────────────
    if (!this.noBandolier) {
      const bm = /^Loading bandolier set (.+?)\.?\s*$/i.exec(content)
      if (bm) {
        const setName = bm[1].trim().replace(/^\[|\]$/g, '')
        const isWeaveSet = setName.toLowerCase().includes('weave')
        const isBackstabSet = setName.toLowerCase().includes(this.cfg.ROGUE_BACKSTAB_SET_NAME.toLowerCase())
        this.cfg.WEAVE_BANDOLIER_ACTIVE = isWeaveSet
        this.cfg.ROGUE_BACKSTAB_SET_ACTIVE = isBackstabSet
        this.emit({ type: EvType.BANDOLIER_CHANGED, ts: now, data: { setName, isWeaveSet, isBackstabSet } })
        return
      }
      if (/^bandolier set swap complete\.?\s*$/i.test(content)) return
    }

    // ── Backstab hit/miss (Rogue Mode) ──────────────────────────
    // Checked ahead of the normal mainhand/fist blocks so backstab events
    // always fire even while those blocks are suppressed below.
    const bsHit = this.backstabHitRe.exec(content)
    if (bsHit) {
      this.ensureCombat(now)
      this.currentTarget = bsHit[1]
      this.lastAttackTs  = now
      this.emit({ type: EvType.BACKSTAB_ATTACK, ts: now,
        data: { damage: parseInt(bsHit[2], 10), hit: true, target: bsHit[1] } })
      return
    }
    if (this.backstabMissRe.test(content)) {
      this.ensureCombat(now)
      this.emit({ type: EvType.BACKSTAB_ATTACK, ts: now, data: { damage: 0, hit: false } })
      return
    }

    // ── Riposte — count damage toward DPS but no track/sound effect ──
    // Ripostes must never affect swing-timer state regardless of weapon type.
    // The fallback uses a prefix-anchored pattern so it catches "ripostes" and
    // "riposted" in addition to "riposte", covering all EQ client variants
    // (e.g. "You slash NAME for X (ripostes)").  MISC_DAMAGE is only emitted
    // for lines starting with "You " to prevent mob-riposte lines
    // ("NAME ripostes your slash!") from being credited as player damage.
    if (this.riposteRe.some(r => r.test(content)) || /\briposte/i.test(content)) {
      if (__DEV__) {
        const sinceLastCrush = this.lastAttackTs > 0 ? ((now - this.lastAttackTs) / 1000).toFixed(3) : 'n/a'
        console.debug(`[riposte] line="${content}" playerSourced=${content.startsWith('You ')} ` +
          `sinceLastMainhandLine=${sinceLastCrush}s offhandCrushPending=${this.offhandCrushPending}`)
        this.lastRiposteTs = now
      }
      // Don't require inCombat already true — a riposte can be the very first
      // player-sourced line of an engagement (mirrors damageOnly mode, which
      // has no such gate) and should still register as combat + count damage.
      if (content.startsWith('You ')) {
        this.ensureCombat(now)
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
      }
      return
    }

    // ── Wu round probe ────────────────────────────────────────────
    // Checked ahead of the mainhand/fist block below since generic "strike"/
    // "claw" verbs would otherwise be consumed by the fist-hit branch before
    // ever being seen here.
    const monk = this.classifyMonkSpecial(content)
    if (monk) this.trackWuRound(monk, now)

    // ── Normal mainhand/offhand swing detection — suppressed entirely in Rogue Mode ──
    if (!this.cfg.ROGUE_MODE_ENABLED) {
      // ── Mainhand crush hit ──────────────────────────────────
      if (this.crushHitRe.some(r => r.test(content))) {
        this.ensureCombat(now)
        const tm = LogReader.TARGET_RE.exec(content)
        const bandolierWeave = this.cfg.WEAVE_BANDOLIER_ACTIVE
        const offhandWindowActive = this.cfg.OFFHAND_CRUSH_ENABLED && this.offhandCrushPending && now < this.offhandCrushExpiry
        if (__DEV__) {
          const sinceRiposte = this.lastRiposteTs > 0 ? ((now - this.lastRiposteTs) / 1000).toFixed(3) : 'n/a'
          console.debug(`[mainhand] hit line="${content}" bandolierWeave=${bandolierWeave} ` +
            `offhandCrushPending=${this.offhandCrushPending} offhandWindowActive=${offhandWindowActive} sinceLastRiposte=${sinceRiposte}s ` +
            `-> classified as ${bandolierWeave || offhandWindowActive ? 'FIST_ATTACK (offhand)' : 'MAINHAND_CRUSH'}`)
        }
        if (bandolierWeave || offhandWindowActive) {
          // Offhand weave — classified by bandolier state or timing window
          this.offhandCrushPending = false
          if (tm) { this.currentTarget = tm[1]; this.lastAttackTs = now }
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage: parseDamage(content), hit: true, line: content } })
        } else {
          if (tm) { this.currentTarget = tm[1]; this.lastAttackTs = now }
          this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
            data: { damage: parseDamage(content), hit: true, line: content, target: this.currentTarget } })
          if (this.cfg.OFFHAND_CRUSH_ENABLED && !bandolierWeave) {
            this.offhandCrushPending = true
            this.offhandCrushExpiry  = now + this.cfg.PUNCH_INTERVAL * 1000 * 0.9
          }
        }
        return
      }

      // ── Mainhand crush miss ─────────────────────────────────
      if (this.crushMissRe.some(r => r.test(content))) {
        this.ensureCombat(now)
        const bandolierWeave = this.cfg.WEAVE_BANDOLIER_ACTIVE
        const offhandWindowActive = this.cfg.OFFHAND_CRUSH_ENABLED && this.offhandCrushPending && now < this.offhandCrushExpiry
        if (__DEV__) {
          const sinceRiposte = this.lastRiposteTs > 0 ? ((now - this.lastRiposteTs) / 1000).toFixed(3) : 'n/a'
          console.debug(`[mainhand] miss line="${content}" bandolierWeave=${bandolierWeave} ` +
            `offhandCrushPending=${this.offhandCrushPending} offhandWindowActive=${offhandWindowActive} sinceLastRiposte=${sinceRiposte}s ` +
            `-> classified as ${bandolierWeave || offhandWindowActive ? 'FIST_ATTACK (offhand)' : 'MAINHAND_CRUSH'}`)
        }
        if (bandolierWeave || offhandWindowActive) {
          this.offhandCrushPending = false
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage: 0, hit: false, line: content } })
        } else {
          this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
            data: { damage: 0, hit: false, line: content } })
          if (this.cfg.OFFHAND_CRUSH_ENABLED && !bandolierWeave) {
            this.offhandCrushPending = true
            this.offhandCrushExpiry  = now + this.cfg.PUNCH_INTERVAL * 1000 * 0.9
          }
        }
        return
      }

      // ── Fist attack hit ─────────────────────────────────────
      if (this.fistHitRe.some(r => r.test(content))) {
        this.ensureCombat(now)
        const tm = LogReader.TARGET_RE.exec(content)
        if (tm) { this.currentTarget = tm[1]; this.lastAttackTs = now }
        this.emit({ type: EvType.FIST_ATTACK, ts: now,
          data: { damage: parseDamage(content), hit: true, line: content } })
        return
      }

      // ── Fist attack miss ────────────────────────────────────
      if (this.fistMissRe.some(r => r.test(content))) {
        this.ensureCombat(now)
        this.emit({ type: EvType.FIST_ATTACK, ts: now,
          data: { damage: 0, hit: false, line: content } })
        return
      }

      // ── Non-punch offhand weave (slash/pierce/crush when WEAVE_BANDOLIER_ACTIVE) ──
      // Catches offhand DW attacks that use a different verb than both the mainhand
      // and fist patterns — e.g. a slash weave weapon when mainhand is crush.
      if (this.cfg.WEAVE_BANDOLIER_ACTIVE) {
        if (this.weaveHitRe.test(content)) {
          this.ensureCombat(now)
          const tm = LogReader.TARGET_RE.exec(content)
          if (tm) { this.currentTarget = tm[1]; this.lastAttackTs = now }
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage: parseDamage(content), hit: true, line: content } })
          return
        }
        if (this.weaveMissRe.test(content)) {
          this.ensureCombat(now)
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage: 0, hit: false, line: content } })
          return
        }
      }
    }

    // ── Flying kick ──────────────────────────────────────────
    if (this.flyingKickRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      const damage = parseDamage(content)
      if (damage > 0)
        this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
      return
    }

    // ── Item proc damage ─────────────────────────────────────
    // No inCombat gate — mirrors damageOnly mode, which counts these
    // unconditionally. A proc landing is itself proof combat is happening.
    if (this.procHitRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      const damage = parseDamage(content)
      if (damage > 0)
        this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
      return
    }

    // ── Critical hit notification ────────────────────────────
    // Format: "You deliver a Crippling Blow! (450)" — damage in parens
    if (this.critHitRe.some(r => r.test(content))) {
      const m = /\((\d+)\)/.exec(content)
      const damage = m ? parseInt(m[1], 10) : 0
      if (damage > 0)
        this.emit({ type: EvType.CRIT_HIT, ts: now, data: { damage, target: this.currentTarget } })
      return
    }

    // ── Out of range ────────────────────────────────────────
    if (this.oorRe.some(r => r.test(content))) {
      this.emit({ type: EvType.OUT_OF_RANGE, ts: now, data: { line: content } })
      return
    }

    // ── Cursor blocking weapon swap ──────────────────────────
    if (this.cursorBlockedRe.some(r => r.test(content))) {
      this.emit({ type: EvType.CURSOR_BLOCKED, ts: now, data: { line: content } })
      return
    }

    // ── Target death detection ───────────────────────────────────
    // Only fires if we have a tracked target attacked within the last 10s.
    // Matches: "You have slain TARGET_NAME" or "TARGET_NAME has been slain by X"
    if (this.inCombat && this.currentTarget && now - this.lastAttackTs <= 10_000) {
      const lower  = content.toLowerCase()
      const target = this.currentTarget.toLowerCase()
      const isMyKill         = lower.startsWith('you have slain ' + target)
      const isThirdPartyKill = lower.startsWith(target + ' has been slain by')
      if (isMyKill || isThirdPartyKill) {
        const mobName       = this.currentTarget
        this.inCombat       = false
        this.currentTarget  = ''
        this.lastAttackTs   = 0
        this.emit({ type: EvType.MOB_DIED, ts: now, data: { line: content, mobName } })
        return
      }
    }

    // ── Silent combat end (zoned / logout) ──────────────────────
    if (this.endRe.some(r => r.test(content))) {
      if (this.inCombat) {
        this.inCombat      = false
        this.currentTarget = ''
        this.lastAttackTs  = 0
        this.emit({ type: EvType.COMBAT_END, ts: now, data: { line: content } })
      }
      return
    }

    // ── Combat start (being attacked, casting) ──────────────
    if (this.startRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      return
    }

    // ── Avatar buff tracking ────────────────────────────────────
    if (this.avatarGainedRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'avatar', active: true } })
      return
    }
    if (this.avatarLostRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'avatar', active: false } })
      return
    }

    // ── Savagery buff tracking ──────────────────────────────────
    if (this.savageryGainedRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: true } })
      return
    }
    if (this.savageryLostRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: false } })
      return
    }

    // ── Innerflame discipline tracking ─────────────────────────
    if (this.innerflamGainedRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'innerflame', active: true } })
      return
    }
    if (this.innerflamLostRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'innerflame', active: false } })
      return
    }
    if (this.whirlwindGainedRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'whirlwind', active: true } })
      return
    }
    if (this.whirlwindLostRe.some(r => r.test(content))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'whirlwind', active: false } })
      return
    }

    // Offhand/secondary slot lines from /mystats — skip weapon and haste detection
    // so only the mainhand weapon delay and the character haste value are extracted.
    if (OFFHAND_LINE_RE.test(content)) return

    // ── Weapon preset detection ─────────────────────────────
    // Only fire on /mystats mainhand lines ("Melee Primary: ...").
    // BW2H / BWOH are handled earlier in processLine and never reach this point.
    if (MYSTATS_WEAPON_LINE_RE.test(content)) {
      for (const { re, name, delay, attackType } of this.weaponRe) {
        if (re.test(content)) {
          this.cfg.BASE_WEAPON_DELAY     = delay
          this.cfg.BASE_WEAPON_NAME      = name
          this.cfg.MAINHAND_ATTACK_TYPE  = attackType as 'crush' | 'slash' | 'pierce' | 'punch'
          this.emit({ type: EvType.WEAPON_DETECTED, ts: now, data: { name, delay } })
          return
        }
      }
    }

    // ── Haste detection (/mystats) ──────────────────────────
    const hastePct = parseHaste(content)
    if (hastePct !== null) {
      // Deduplicate: /mystats outputs multiple lines that can each match a haste pattern.
      // Suppress if same value was emitted within the last 2 seconds.
      const sameValue = Math.abs(hastePct - this.lastHastePct) < 0.5
      const recentEmit = now - this.lastHasteEmitTs < 2000
      if (!sameValue || !recentEmit) {
        this.lastHastePct    = hastePct
        this.lastHasteEmitTs = now
        const interval = calcInterval(hastePct, this.cfg.BASE_WEAPON_DELAY)
        this.emit({ type: EvType.HASTE_DETECTED, ts: now,
          data: { haste_pct: hastePct, interval, source: content } })
      }
      const atkForHaste = this.lastAtkRating > 0 ? this.lastAtkRating : undefined
      this.emit({ type: EvType.STATS_UPDATE, ts: now, data: { hastePct, atkRating: atkForHaste } })
      return
    }

    // ── ATK rating detection (/mystats) ─────────────────────
    const atkRating = parseAtkRating(content)
    if (atkRating !== null) {
      const sameValue  = atkRating === this.lastAtkRating
      const recentEmit = now - this.lastAtkEmitTs < 2000
      if (!sameValue || !recentEmit) {
        this.lastAtkRating  = atkRating
        this.lastAtkEmitTs  = now
        const hastePctNow = this.lastHastePct >= 0 ? this.lastHastePct : undefined
        this.emit({ type: EvType.STATS_UPDATE, ts: now, data: { atkRating, hastePct: hastePctNow } })
      }
    }
  }

  private ensureCombat(now: number): void {
    if (!this.inCombat) {
      this.inCombat = true
      this.offhandCrushPending = false
      this.emit({ type: EvType.COMBAT_START, ts: now })
    }
  }

  private emit(ev: GameEvent): void {
    this.onEvent(ev)
  }

  private emitWeaponTrack(now: number): void {
    const offhandDelay = this.lookupWeaponDelay(this.weaponTrackOH)
    this.emit({ type: EvType.WEAPON_TRACK, ts: now,
      data: { mainhand: this.weaponTrack2H, offhand: this.weaponTrackOH, offhandDelay } })
    this.weaponTrackActive = false
    this.weaponTrack2H = ''
    this.weaponTrackOH = ''
  }

  private lookupWeaponDelay(name: string): number | null {
    const lower = name.toLowerCase()
    for (const [preset, delay] of Object.entries(this.cfg.OFFHAND_PRESETS)) {
      if (preset.toLowerCase() === lower) return delay
    }
    return null
  }
}

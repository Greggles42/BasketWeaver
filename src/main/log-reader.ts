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

  // Extracts target name from "You crush/punch/strike/hit X for N points"
  private static readonly TARGET_RE = /^You (?:crush|slash|pierce|punch|strike|bash|hit) (.+?) for \d+/i

  private crushHitRe:    RegExp[]
  private crushMissRe:   RegExp[]
  private riposteRe:     RegExp[]
  private fistHitRe:     RegExp[]
  private fistMissRe:    RegExp[]
  // Catch-all for non-mainhand non-punch attack types while weave bandolier is active
  // (e.g. slash/pierce offhand weave weapon when mainhand is crush).
  private weaveHitRe:    RegExp
  private weaveMissRe:   RegExp
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
  }

  private processLine(line: string): void {
    if (!line) return
    const content = stripPrefix(line)
    const now = performance.now()

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
      // Ripostes → misc damage (player-sourced only)
      if (this.riposteRe.some(r => r.test(content)) || /\briposte/i.test(content)) {
        if (content.startsWith('You ')) {
          const damage = parseDamage(content)
          if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'misc' } })
        }
        return
      }
      // Mainhand crush hit (may be DW offhand)
      if (this.crushHitRe.some(r => r.test(content))) {
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
      // Fist hit
      if (this.fistHitRe.some(r => r.test(content))) {
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.LOG_DAMAGE, ts: now, data: { damage, source: 'fist' } })
        return
      }
      // Non-punch bandolier weave hit
      if (this.cfg.WEAVE_BANDOLIER_ACTIVE && this.weaveHitRe.test(content)) {
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
      if (this.riposteRe.some(r => r.test(content)) || /\briposte/i.test(content)) return

      // Track bandolier swaps in missOnly mode only when noBandolier is not set.
      // In hybrid mode the Zeal pipe owns bandolier detection (with off-delay);
      // reading bandolier from the log would immediately clear WEAVE_BANDOLIER_ACTIVE
      // and defeat the off-delay, causing in-flight weave hits to misclassify.
      if (!this.noBandolier) {
        const bm = /^Loading bandolier set (.+?)\.?\s*$/i.exec(content)
        if (bm) {
          const setName = bm[1].trim().replace(/^\[|\]$/g, '')
          const isWeaveSet = setName.toLowerCase().includes('weave')
          this.cfg.WEAVE_BANDOLIER_ACTIVE = isWeaveSet
          this.emit({ type: EvType.BANDOLIER_CHANGED, ts: now, data: { setName, isWeaveSet } })
          return
        }
      }
      // Catch both explicit miss patterns ("You try to slash") and zero-damage hit-verb
      // lines ("You slash NAME but miss!" / "You slash NAME." with no damage).  Some EQ
      // clients omit the "try to" prefix for the primary attack; the double-attack attempt
      // uses it, which is why double misses produce audio but single misses previously didn't.
      const isMainhandMiss = this.crushMissRe.some(r => r.test(content)) ||
        (this.crushHitRe.some(r => r.test(content)) && parseDamage(content) === 0)
      if (isMainhandMiss) {
        const bandolierWeave = this.cfg.WEAVE_BANDOLIER_ACTIVE
        if (bandolierWeave || (this.cfg.OFFHAND_CRUSH_ENABLED && this.offhandCrushPending && now < this.offhandCrushExpiry)) {
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
      } else if (this.fistMissRe.some(r => r.test(content)) ||
                 (this.fistHitRe.some(r => r.test(content)) && parseDamage(content) === 0)) {
        this.emit({ type: EvType.FIST_ATTACK, ts: now,
          data: { damage: 0, hit: false, line: content } })
      } else if (this.cfg.WEAVE_BANDOLIER_ACTIVE && this.weaveMissRe.test(content)) {
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
        this.cfg.WEAVE_BANDOLIER_ACTIVE = isWeaveSet
        this.emit({ type: EvType.BANDOLIER_CHANGED, ts: now, data: { setName, isWeaveSet } })
        return
      }
      if (/^bandolier set swap complete\.?\s*$/i.test(content)) return
    }

    // ── Riposte — count damage toward DPS but no track/sound effect ──
    // Ripostes must never affect swing-timer state regardless of weapon type.
    // The fallback uses a prefix-anchored pattern so it catches "ripostes" and
    // "riposted" in addition to "riposte", covering all EQ client variants
    // (e.g. "You slash NAME for X (ripostes)").  MISC_DAMAGE is only emitted
    // for lines starting with "You " to prevent mob-riposte lines
    // ("NAME ripostes your slash!") from being credited as player damage.
    if (this.riposteRe.some(r => r.test(content)) || /\briposte/i.test(content)) {
      if (this.inCombat && content.startsWith('You ')) {
        const damage = parseDamage(content)
        if (damage > 0) this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
      }
      return
    }

    // ── Mainhand crush hit ──────────────────────────────────
    if (this.crushHitRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      const tm = LogReader.TARGET_RE.exec(content)
      const bandolierWeave = this.cfg.WEAVE_BANDOLIER_ACTIVE
      if (bandolierWeave || (this.cfg.OFFHAND_CRUSH_ENABLED && this.offhandCrushPending && now < this.offhandCrushExpiry)) {
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
      if (bandolierWeave || (this.cfg.OFFHAND_CRUSH_ENABLED && this.offhandCrushPending && now < this.offhandCrushExpiry)) {
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

    // ── Flying kick ──────────────────────────────────────────
    if (this.flyingKickRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      const damage = parseDamage(content)
      if (damage > 0)
        this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
      return
    }

    // ── Item proc damage ─────────────────────────────────────
    if (this.procHitRe.some(r => r.test(content))) {
      if (this.inCombat) {
        const damage = parseDamage(content)
        if (damage > 0)
          this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
      }
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

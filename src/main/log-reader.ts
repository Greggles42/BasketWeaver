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
import { parseHaste, calcInterval } from './haste-calc'

const PREFIX_RE = /^\[.+?\]\s*/
const DAMAGE_RE = /for\s+(\d+)\s+point/i

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

  // ── Mystats offhand-detection state machine ───────────────
  // The calibration macro runs /mystats twice with different weapon combinations.
  // We track which block we're in and capture the secondary weapon from the second block.
  private currentTarget = ''   // most recent mob the player was attacking

  private mystatsState: 'idle' | 'await_secondary' | 'reading_secondary' = 'idle'
  private mystatsBlockNum = 0   // increments on each "---- Melee Primary:" line; reset after capture
  private mystatsName   = ''
  private mystatsDmgAve = 0

  // Extracts target name from "You crush/punch/strike X for N points"
  private static readonly TARGET_RE = /^You (?:crush|punch|strike) (.+?) for \d+/i

  private static readonly MELEE_PRIMARY_RE     = /^---- Melee Primary: /i
  private static readonly MELEE_SECONDARY_RE   = /^---- Melee Secondary: (.+?) ----/
  private static readonly MYSTATS_DMG_RE        = /^Dmg = [\d.]+ to [\d.]+, ave = ([\d.]+)/
  private static readonly MYSTATS_DPS_BASE_RE   = /^DPS = [\d.]+ to [\d.]+, ave = ([\d.]+)\s*$/

  private crushHitRe:   RegExp[]
  private crushMissRe:  RegExp[]
  private riposteRe:    RegExp[]
  private fistHitRe:    RegExp[]
  private fistMissRe:   RegExp[]
  private oorRe:           RegExp[]
  private cursorBlockedRe: RegExp[]
  private startRe:      RegExp[]
  private mobDeathRe:   RegExp[]
  private endRe:        RegExp[]
  private weaponRe:     Array<{ re: RegExp; name: string; delay: number }>

  constructor(path: string, cfg: ConfigType, onEvent: EventCallback) {
    this.path    = path
    this.cfg     = cfg
    this.onEvent = onEvent

    const compile = (patterns: string[]) =>
      patterns.map(p => new RegExp(p, 'i'))

    this.riposteRe   = compile(cfg.RIPOSTE_PATTERNS)
    this.crushHitRe  = compile(cfg.CRUSH_HIT_PATTERNS)
    this.crushMissRe = compile(cfg.CRUSH_MISS_PATTERNS)
    this.fistHitRe   = compile(cfg.FIST_HIT_PATTERNS)
    this.fistMissRe  = compile(cfg.FIST_MISS_PATTERNS)
    this.oorRe            = compile(cfg.OUT_OF_RANGE_PATTERNS)
    this.cursorBlockedRe  = compile(cfg.CURSOR_BLOCKED_PATTERNS)
    this.startRe     = compile(cfg.COMBAT_START_PATTERNS)
    this.mobDeathRe  = compile(cfg.MOB_DEATH_PATTERNS)
    this.endRe       = compile(cfg.COMBAT_END_PATTERNS)

    this.weaponRe = Object.entries(cfg.WEAPON_PRESETS).map(([name, delay]) => ({
      re: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      name,
      delay,
    }))
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

    const interval = setInterval(readChunk, 50)

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

    // ── Riposte — ignore, not a swing-timer event ───────────
    if (this.riposteRe.some(r => r.test(content))) return

    // ── Mainhand crush hit ──────────────────────────────────
    if (this.crushHitRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      const tm = LogReader.TARGET_RE.exec(content)
      if (tm) this.currentTarget = tm[1]
      this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
        data: { damage: parseDamage(content), hit: true, line: content } })
      return
    }

    // ── Mainhand crush miss ─────────────────────────────────
    if (this.crushMissRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
        data: { damage: 0, hit: false, line: content } })
      return
    }

    // ── Fist attack hit ─────────────────────────────────────
    if (this.fistHitRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      const tm = LogReader.TARGET_RE.exec(content)
      if (tm) this.currentTarget = tm[1]
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

    // ── Mob death (grade screen + end-combat sound) ─────────────
    if (this.mobDeathRe.some(r => r.test(content))) {
      if (this.inCombat) {
        this.inCombat = false
        this.currentTarget = ''
        this.emit({ type: EvType.MOB_DIED, ts: now, data: { line: content } })
      }
      return
    }

    // ── Third-party kill of the player's current target ──────────
    // "X has been slain" / "X died." — only fire if X matches our tracked target.
    if (this.inCombat && this.currentTarget) {
      const lower = content.toLowerCase()
      const target = this.currentTarget.toLowerCase()
      const isTargetDeath =
        (lower.includes(target) && lower.includes('has been slain')) ||
        (lower.startsWith(target) && /died\.\s*$/.test(lower))
      if (isTargetDeath) {
        this.inCombat = false
        this.currentTarget = ''
        this.emit({ type: EvType.MOB_DIED, ts: now, data: { line: content } })
        return
      }
    }

    // ── Silent combat end (zoned / logout) ──────────────────────
    if (this.endRe.some(r => r.test(content))) {
      if (this.inCombat) {
        this.inCombat = false
        this.currentTarget = ''
        this.emit({ type: EvType.COMBAT_END, ts: now, data: { line: content } })
      }
      return
    }

    // ── Combat start (being attacked, casting) ──────────────
    if (this.startRe.some(r => r.test(content))) {
      this.ensureCombat(now)
      return
    }

    // ── Mystats offhand detection (weave calibration macro) ──────
    // The macro runs /mystats twice. Each "---- Melee Primary:" line starts a new block.
    // We capture the secondary weapon's delay from the second block only.
    if (LogReader.MELEE_PRIMARY_RE.test(content)) {
      this.mystatsBlockNum++
      if (this.mystatsBlockNum === 2) {
        this.mystatsState  = 'await_secondary'
        this.mystatsName   = ''
        this.mystatsDmgAve = 0
      } else {
        this.mystatsState = 'idle'
      }
    } else if (this.mystatsState === 'await_secondary') {
      const m = LogReader.MELEE_SECONDARY_RE.exec(content)
      if (m) {
        this.mystatsName  = m[1].replace(/`/g, "'")
        this.mystatsState = 'reading_secondary'
      }
    } else if (this.mystatsState === 'reading_secondary') {
      const dmgM = LogReader.MYSTATS_DMG_RE.exec(content)
      if (dmgM) {
        this.mystatsDmgAve = parseFloat(dmgM[1])
      } else {
        const dpsM = LogReader.MYSTATS_DPS_BASE_RE.exec(content)
        if (dpsM && this.mystatsDmgAve > 0) {
          const delayTenths = Math.round((this.mystatsDmgAve / parseFloat(dpsM[1])) * 10)
          this.emit({ type: EvType.OFFHAND_DETECTED, ts: now,
            data: { name: this.mystatsName, delay: delayTenths } })
          this.mystatsState  = 'idle'
          this.mystatsName   = ''
          this.mystatsDmgAve = 0
          this.mystatsBlockNum = 0  // reset so next macro run starts fresh
        }
      }
    }

    // ── Weapon preset detection ─────────────────────────────
    for (const { re, name, delay } of this.weaponRe) {
      if (re.test(content)) {
        this.cfg.BASE_WEAPON_DELAY = delay  // keep main-process cfg in sync for haste calc
        this.emit({ type: EvType.WEAPON_DETECTED, ts: now, data: { name, delay } })
        return
      }
    }

    // ── Haste detection (/mystats) ──────────────────────────
    const hastePct = parseHaste(content)
    if (hastePct !== null) {
      const interval = calcInterval(hastePct, this.cfg.BASE_WEAPON_DELAY)
      this.emit({ type: EvType.HASTE_DETECTED, ts: now,
        data: { haste_pct: hastePct, interval, source: content } })
    }
  }

  private ensureCombat(now: number): void {
    if (!this.inCombat) {
      this.inCombat = true
      this.emit({ type: EvType.COMBAT_START, ts: now })
    }
  }

  private emit(ev: GameEvent): void {
    this.onEvent(ev)
  }
}

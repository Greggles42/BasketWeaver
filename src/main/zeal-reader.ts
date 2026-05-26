/**
 * Zeal pipe reader — main process, Node.js.
 * Reads real-time combat events from EverQuest's Zeal plugin named pipes
 * and emits the same GameEvent objects as LogReader.
 *
 * Pipe name format: \\.\pipe\zeal_<PID>
 *
 * Outer pipe message schema:
 *   { type: number, data_len: number, character: string, data: string }
 *
 * For LogText messages (type=0) the `data` field is a nested JSON string:
 *   { type: number (LogType), text: string }
 *
 * IMPORTANT — Zeal sends abbreviated combat text, NOT the verbose log-file
 * format. Examples:
 *   LogType 265 (YouHitOther):  "crush Lalune for 115"
 *   LogType 267 (YouMissOther): "missed Lalune"
 *   LogType 266 (OtherHitsYou): "YOU are pierced by thorns!"
 *
 * We dispatch on LogType first and parse the short text only where needed.
 */

import * as net from 'net'
import { exec } from 'child_process'
import { performance } from 'perf_hooks'
import { EvType, type GameEvent } from '../shared/events'
import { type ConfigType } from '../shared/config'
import { type EventCallback } from './log-reader'
import { parseHaste, calcInterval } from './haste-calc'

// PipeMessageType.LogText = 0
const PIPE_MSG_LOGTEXT = 0

// Zeal LogType constants (from ZealPipes.Common.Enums)
const LOG = {
  YouHitOther:        265,
  OtherHitsYou:       266,
  YouMissOther:       267,
  OtherMissesYou:     268,
  HitForNonMelee:     283,  // proc / spell damage on mob
  YourDeathMessage:   277,
  OtherDeathMessage:  278,
  TooFarAwayMelee:    303,
  Skills:             270,  // /mystats output
  DefaultText:        273,
  Spells:             264,  // buff / debuff messages
  ItemTags:           326,  // item link tags — diagnostic
  MeleeCrits:         301,
  LootMessage:        286,
  MerchantBuySell:    276,
  SpecialAbilities:   271,  // ripostes, backstabs, finishing blows — damage counts, never swing-timer events
}

// "VERB TARGET for DAMAGE" — Zeal's abbreviated hit format for YouHitOther
const ZEAL_HIT_RE = /^(flying kick|crush|punch|strike|kick|bash|slash|pierce|hit)\s+(.+?)\s+for\s+(\d+)/i

// "missed TARGET" — Zeal's miss format for YouMissOther
const ZEAL_MISS_RE = /^missed\s+(.+)/i

// /mystats (LOG.Skills) lines that describe the offhand/secondary weapon slot.
// Matched lines are skipped so only mainhand weapon + haste are extracted.
const OFFHAND_LINE_RE = /^(?:secondary|off[\s\-]?(?:hand|weapon)|offhand)[\s:]/i

function parseDamageShort(text: string): number {
  const m = /for\s+(\d+)/i.exec(text)
  return m ? parseInt(m[1], 10) : 0
}

function findEQProcessIds(): Promise<number[]> {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq eqgame.exe" /FO CSV /NH',
      { encoding: 'utf8', timeout: 3000 },
      (err, stdout) => {
        if (err) { resolve([]); return }
        const pids: number[] = []
        for (const line of stdout.split('\n')) {
          const parts = line.split(',')
          if (parts.length >= 2) {
            const pid = parseInt(parts[1].replace(/"/g, '').trim(), 10)
            if (!isNaN(pid)) pids.push(pid)
          }
        }
        resolve(pids)
      })
  })
}

/** Parse the inner `data` field of a PipeMessage.
 *  Zeal double-encodes it as a JSON string, but handle inline objects too. */
function parseInnerData(raw: unknown): { type?: number; text?: string } | null {
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch { return null }
  }
  if (raw !== null && typeof raw === 'object') {
    return raw as { type?: number; text?: string }
  }
  return null
}

export class ZealReader {
  private cfg: ConfigType
  private onEvent: EventCallback
  private stopped = false
  private sockets: net.Socket[] = []
  private scanTimer: NodeJS.Timeout | null = null
  private connectedPids = new Set<number>()

  // ── Diagnostic ───────────────────────────────────────────────
  private seenLogTypes = new Set<number>()
  private characterName = ''

  // ── Combat state ──────────────────────────────────────────────
  private inCombat = false
  private currentTarget = ''
  private lastAttackTs = 0    // last time player attacked currentTarget

  // ── Swing tracking for miss classification ────────────────────
  // Zeal's YouMissOther sends "missed TARGET" with no verb, making it impossible to
  // distinguish a crush miss from a fist miss. We track the most recent hit timestamps
  // for each weapon slot so we can classify misses by timing.
  private lastCrushHitTs = 0  // last YouHitOther crush hit (ms)
  private lastFistHitTs  = 0  // last YouHitOther punch/strike hit (ms)

  // ── Haste dedup ───────────────────────────────────────────────
  private lastHastePct = -1
  private lastHasteEmitTs = 0

  private weaponRe: Array<{ re: RegExp; name: string; delay: number }>
  private oorRe: RegExp[]
  private cursorBlockedRe: RegExp[]
  private avatarGainedRe: RegExp[]
  private avatarLostRe: RegExp[]
  private savageryGainedRe: RegExp[]
  private savageryLostRe: RegExp[]
  private innerflamGainedRe: RegExp[]
  private innerflamLostRe: RegExp[]

  constructor(cfg: ConfigType, onEvent: EventCallback) {
    this.cfg     = cfg
    this.onEvent = onEvent

    const compile = (patterns: string[]) => patterns.map(p => new RegExp(p, 'i'))
    this.oorRe             = compile(cfg.OUT_OF_RANGE_PATTERNS)
    this.cursorBlockedRe   = compile(cfg.CURSOR_BLOCKED_PATTERNS)
    this.avatarGainedRe    = compile(cfg.AVATAR_GAINED_PATTERNS)
    this.avatarLostRe      = compile(cfg.AVATAR_LOST_PATTERNS)
    this.savageryGainedRe  = compile(cfg.SAVAGERY_GAINED_PATTERNS)
    this.savageryLostRe    = compile(cfg.SAVAGERY_LOST_PATTERNS)
    this.innerflamGainedRe = compile(cfg.INNERFLAME_GAINED_PATTERNS)
    this.innerflamLostRe   = compile(cfg.INNERFLAME_LOST_PATTERNS)
    this.weaponRe       = Object.entries(cfg.WEAPON_PRESETS).map(([name, delay]) => ({
      re: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      name,
      delay,
    }))
  }

  /** Start scanning for EQ processes. Returns a cleanup/stop function. */
  start(): () => void {
    this.stopped = false
    this.scan()
    this.scanTimer = setInterval(() => this.scan(), 2000)
    return () => this.stop()
  }

  private scan(): void {
    if (this.stopped) return
    findEQProcessIds().then(pids => {
      if (this.stopped) return
      for (const pid of pids) {
        if (!this.connectedPids.has(pid)) {
          console.log(`[ZealReader] Found new EQ process PID ${pid}, connecting…`)
          this.connectedPids.add(pid)
          this.connectToPipe(pid)
        }
      }
    })
  }

  private connectToPipe(pid: number): void {
    const pipePath = `\\\\.\\pipe\\zeal_${pid}`
    const socket = net.createConnection({ path: pipePath })
    this.sockets.push(socket)

    let buffer = ''
    let firstChunk = true

    socket.on('connect', () => {
      console.log(`[ZealReader] Connected to Zeal pipe for PID ${pid}`)
    })

    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (firstChunk) {
        firstChunk = false
        console.log(`[ZealReader] PID ${pid} first data (${text.length} bytes): ${text.slice(0, 200).replace(/\n/g, '\\n')}`)
      }

      buffer += text
      const parts = buffer.split(/(?<=\})\s*(?=\{)/)
      buffer = parts[parts.length - 1]
      const isLastComplete = buffer.trimEnd().endsWith('}')
      const limit = isLastComplete ? parts.length : parts.length - 1
      for (let i = 0; i < limit; i++) {
        const s = parts[i].trim()
        if (s) this.parsePipeMessage(s)
      }
      if (isLastComplete) buffer = ''
    })

    socket.on('error', (err) => {
      console.log(`[ZealReader] Pipe error for PID ${pid}: ${err.message}`)
      this.connectedPids.delete(pid)
    })

    socket.on('close', () => {
      console.log(`[ZealReader] Pipe closed for PID ${pid}`)
      this.connectedPids.delete(pid)
      const idx = this.sockets.indexOf(socket)
      if (idx !== -1) this.sockets.splice(idx, 1)
    })
  }

  private parsePipeMessage(json: string): void {
    let outer: { type: number; character?: string; data?: unknown }
    try { outer = JSON.parse(json) } catch { return }
    if (outer.type !== PIPE_MSG_LOGTEXT || !outer.data) return

    const inner = parseInnerData(outer.data)
    if (!inner || !inner.text) return

    if (!this.characterName && outer.character) {
      this.characterName = outer.character
      console.log(`[ZealReader] Character: "${this.characterName}"`)
    }

    const logType = inner.type ?? -1
    const text    = inner.text

    if (!this.seenLogTypes.has(logType)) {
      this.seenLogTypes.add(logType)
      console.log(`[ZealReader] NEW type=${logType} text=${text.slice(0, 120)}`)
    }

    this.processZealMessage(logType, text)
  }

  /** Dispatch on Zeal LogType. Combat events use abbreviated text; calibration
   *  and OOR events fall through to text-pattern matching. */
  private processZealMessage(logType: number, text: string): void {
    const now = performance.now()

    switch (logType) {

      // ── You hit something ──────────────────────────────────────
      case LOG.YouHitOther: {
        const m = ZEAL_HIT_RE.exec(text)
        if (!m) return
        const verb   = m[1].toLowerCase()
        const target = m[2]
        const damage = parseInt(m[3], 10)

        // Ripostes arrive as YouHitOther with verb "strike" and "(riposte)" in the text.
        // They are counter-attacks triggered by mob attacks — not deliberate weave attempts.
        // Count the damage toward net DPS but never treat them as swing-timer events.
        if (/riposte/i.test(text)) {
          if (damage > 0)
            this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
          return
        }

        this.ensureCombat(now)
        this.currentTarget = target
        this.lastAttackTs  = now

        if (verb === 'crush') {
          this.lastCrushHitTs = now
          this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
            data: { damage, hit: true, line: text, target } })
        } else if (verb === 'punch' || verb === 'strike') {
          this.lastFistHitTs = now
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage, hit: true, line: text } })
        } else if (verb === 'flying kick' || verb === 'kick') {
          this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
        } else {
          // hit (proc), slash, pierce, bash → misc damage
          if (damage > 0)
            this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
        }
        return
      }

      // ── Special abilities (ripostes, backstabs, finishing blows) ──
      // These are never swing-timer events. Parse damage for net DPS.
      // When no damage is found (e.g. discipline activation text), fall through
      // to text-pattern matching so buff patterns can fire.
      case LOG.SpecialAbilities: {
        const damage = parseDamageShort(text)
        if (damage > 0) {
          this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
          return
        }
        this.processTextPatterns(text, now)
        return
      }

      // ── You missed something ───────────────────────────────────
      // Zeal sends ALL misses as "missed TARGET" with no verb.  We use timing to
      // Miss events are emitted as MAINHAND_CRUSH in all cases.
      // In hybrid mode the log reader (missOnly) is the authoritative source for miss
      // classification — it uses verified pattern matching to distinguish mainhand miss
      // ("You try to crush") from fist miss ("You try to punch/strike").  Zeal only
      // emits COMBAT_START here so the idle-timeout stays alive during miss streaks.
      // In Zeal-only mode we never emit FIST_ATTACK for misses because the timing
      // heuristic is unreliable and a false FIST_ATTACK sets lastFistAttackTs, which
      // makes the offhand appear to be on cooldown and hides the weave window.
      // Fist hits are still correctly detected via YouHitOther (punch/strike verb).
      case LOG.YouMissOther: {
        this.ensureCombat(now)    // always emits COMBAT_START — see ensureCombat()
        const mre = ZEAL_MISS_RE.exec(text)
        if (mre) { this.currentTarget = mre[1]; this.lastAttackTs = now }

        if (this.cfg.TRACKING_SOURCE === 'hybrid') {
          // Log reader owns miss classification in hybrid mode; just keep combat alive.
          return
        }

        // Zeal-only: treat every miss as a mainhand miss.  The weave window stays
        // visible; fist hits are tracked by YouHitOther so scoring remains accurate.
        this.lastCrushHitTs = now
        this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
          data: { damage: 0, hit: false, line: text } })
        return
      }

      // ── Something hit/missed you — combat start indicator ──────
      case LOG.OtherHitsYou:
      case LOG.OtherMissesYou:
        this.ensureCombat(now)
        return

      // ── You died ───────────────────────────────────────────────
      case LOG.YourDeathMessage:
        if (this.inCombat) {
          this.inCombat      = false
          this.currentTarget = ''
          this.lastAttackTs  = 0
          this.emit({ type: EvType.COMBAT_END, ts: now, data: { line: text } })
        }
        return

      // ── Something died — check if it's our target ──────────────
      case LOG.OtherDeathMessage:
        if (this.inCombat && this.currentTarget && now - this.lastAttackTs <= 10_000) {
          const lower  = text.toLowerCase()
          const target = this.currentTarget.toLowerCase()
          if (lower.includes(target + ' has been slain') ||
              lower.includes('you have slain ' + target)) {
            const mobName = this.currentTarget
            this.inCombat      = false
            this.currentTarget = ''
            this.lastAttackTs  = 0
            this.emit({ type: EvType.MOB_DIED, ts: now, data: { line: text, mobName } })
          }
        }
        return

      // ── Too far away ───────────────────────────────────────────
      case LOG.TooFarAwayMelee:
        this.emit({ type: EvType.OUT_OF_RANGE, ts: now, data: { line: text } })
        return

      // ── /mystats output — extract mainhand weapon + haste only ──
      //    Offhand/secondary slot lines are ignored so they cannot
      //    corrupt BASE_WEAPON_DELAY or trigger false haste events.
      case LOG.Skills:
        if (!OFFHAND_LINE_RE.test(text)) this.processTextPatterns(text, now)
        return

      // ── Melee critical hit ─────────────────────────────────────
      // Format: "Gabbiz Scores a critical hit!(336)"
      // Only emit for the logged-in character (pipe is per-process, but verify name).
      case LOG.MeleeCrits: {
        if (this.characterName) {
          const nameEsc = this.characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const m = new RegExp(`^${nameEsc}\\b.*?\\((\\d+)\\)`, 'i').exec(text)
          if (m) {
            const damage = parseInt(m[1], 10)
            if (damage > 0)
              this.emit({ type: EvType.CRIT_HIT, ts: now, data: { damage, target: this.currentTarget } })
            return
          }
        }
        return
      }

      // ── Diagnostic: log item/loot/merchant events to see if Bandolier
      //    swaps emit anything useful ──────────────────────────────
      case LOG.ItemTags:
      case LOG.LootMessage:
      case LOG.MerchantBuySell:
        console.log(`[ZealReader] DIAG type=${logType} text=${text}`)
        this.processTextPatterns(text, now)
        return

      // ── All other types: text-pattern matching for calibration,
      //    OOR, cursor-blocked, haste, and weapon detection ────────
      default:
        this.processTextPatterns(text, now)
    }
  }

  /** Text-pattern matching for messages that don't have a specific LogType
   *  handler: OOR, cursor blocked, haste, and weapon detection. */
  private processTextPatterns(text: string, now: number): void {

    // Out of range (text-based, catches server-message variants)
    if (this.oorRe.some(r => r.test(text))) {
      this.emit({ type: EvType.OUT_OF_RANGE, ts: now, data: { line: text } })
      return
    }

    // Cursor blocking weapon swap
    if (this.cursorBlockedRe.some(r => r.test(text))) {
      this.emit({ type: EvType.CURSOR_BLOCKED, ts: now, data: { line: text } })
      return
    }

    // Avatar buff tracking
    if (this.avatarGainedRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'avatar', active: true } })
      return
    }
    if (this.avatarLostRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'avatar', active: false } })
      return
    }

    // Savagery buff tracking
    if (this.savageryGainedRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: true } })
      return
    }
    if (this.savageryLostRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: false } })
      return
    }

    // Innerflame discipline tracking
    if (this.innerflamGainedRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'innerflame', active: true } })
      return
    }
    if (this.innerflamLostRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'innerflame', active: false } })
      return
    }

    // Weapon preset detection
    for (const { re, name, delay } of this.weaponRe) {
      if (re.test(text)) {
        this.cfg.BASE_WEAPON_DELAY = delay
        this.emit({ type: EvType.WEAPON_DETECTED, ts: now, data: { name, delay } })
        return
      }
    }

    // Zeal /pipe weave macro — "weave X" where X is offhand delay in EQ tenths (pre-haste)
    const weaveM = /^weave\s+(\d+)/i.exec(text)
    if (weaveM) {
      const offhandDelay = parseInt(weaveM[1], 10)
      this.cfg.OFFHAND_WEAPON_DELAY = offhandDelay
      this.emit({ type: EvType.WEAVE_SIGNAL, ts: now, data: { offhandDelay } })
      return
    }

    // Haste detection
    const hastePct = parseHaste(text)
    if (hastePct !== null) {
      // Always keep cfg in sync so the miss-classification threshold is current.
      this.cfg.HASTE_PCT = hastePct
      const sameValue  = Math.abs(hastePct - this.lastHastePct) < 0.5
      const recentEmit = now - this.lastHasteEmitTs < 2000
      if (!sameValue || !recentEmit) {
        this.lastHastePct    = hastePct
        this.lastHasteEmitTs = now
        const interval = calcInterval(hastePct, this.cfg.BASE_WEAPON_DELAY)
        this.emit({ type: EvType.HASTE_DETECTED, ts: now,
          data: { haste_pct: hastePct, interval, source: text } })
      }
    }
  }

  private ensureCombat(now: number): void {
    if (!this.inCombat) {
      this.inCombat = true
    }
    // Always emit COMBAT_START — the overlay only re-initializes when not already in combat,
    // but always updates lastCombatActivity. This prevents the 10-second idle timeout from
    // firing during periods of sustained missing (crush or fist), which is the primary cause
    // of fights "ending quickly" in Zeal-only mode when the player has a run of misses.
    this.emit({ type: EvType.COMBAT_START, ts: now })
  }

  private emit(ev: GameEvent): void {
    this.onEvent(ev)
  }

  stop(): void {
    this.stopped = true
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null }
    for (const s of this.sockets) { try { s.destroy() } catch {} }
    this.sockets = []
    this.connectedPids.clear()
    this.characterName   = ''
    this.seenLogTypes.clear()
    this.inCombat        = false
    this.currentTarget   = ''
    this.lastAttackTs    = 0
    this.lastCrushHitTs  = 0
    this.lastFistHitTs   = 0
  }
}

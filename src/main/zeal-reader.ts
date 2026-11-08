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
 *
 * PipeCmd messages (type=4) carry whatever text the player sends via Zeal's
 * own `/pipe <text>` command — `{ text: string }`, no LogType. This is a
 * silent, chat-free channel (nothing is printed anywhere), unlike BW2H/BWOH/
 * weave weapon-track macros, which have to rely on the text showing up
 * somewhere in chat for the LogText channel to carry it. We run that text
 * through the same processTextPatterns() matching used for chat text, so a
 * macro built on `/pipe BW2H <name>` / `/pipe BWOH <name>` / `/pipe weave N`
 * works identically but without spamming chat.
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { exec } from 'child_process'
import { performance } from 'perf_hooks'
import { EvType, type GameEvent } from '../shared/events'
import { type ConfigType } from '../shared/config'
import { type EventCallback, savageryVariant, isWeaveSetName } from './log-reader'
import { parseHaste, calcInterval, parseAtkRating } from './haste-calc'
import { debugMonitor } from './debug-monitor'
import { appendCappedLog } from './capped-log'


// PipeMessageType.LogText = 0, PipeMessageType.PipeCmd = 4 (Zeal's "/pipe <text>" command)
const PIPE_MSG_LOGTEXT = 0
const PIPE_MSG_CUSTOM  = 4

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

/** Hybrid-mode diagnostic snapshot — see ZealReader.getStatus(). */
export interface ZealStatus {
  pipeConnected: boolean
  characterName: string
  /** ms since the last own-swing hit/miss was seen, or null if none seen yet this session. */
  msSinceLastSwingData: number | null
  /** true if the most recent process scan found at least one eqgame.exe. */
  eqProcessFound: boolean
  /** message from the most recent pipe socket error, or null if none this session. */
  lastPipeError: string | null
  /** message from the most recent `tasklist` scan failure, or null if none this session. */
  scanError: string | null
  /** Zeal version string parsed from "/zeal version" chat output, or null if not yet seen. */
  zealVersion: string | null
}

// "VERB TARGET for DAMAGE" — Zeal's abbreviated hit format for YouHitOther
const ZEAL_HIT_RE = /^(flying kick|crush|punch|strike|kick|bash|slash|pierce|hit)\s+(.+?)\s+for\s+(\d+)/i

// "missed TARGET" — Zeal's miss format for YouMissOther
const ZEAL_MISS_RE = /^missed\s+(.+)/i

// "backstab TARGET for DAMAGE" — Zeal's abbreviated backstab format, delivered via
// SpecialAbilities (271) rather than YouHitOther (Rogue Mode only)
const ZEAL_BACKSTAB_RE = /^backstab\s+(.+?)\s+for\s+(\d+)/i

// /mystats (LOG.Skills) lines that describe the offhand/secondary weapon slot.
// Matched lines are skipped so only mainhand weapon + haste are extracted.
const OFFHAND_LINE_RE = /^(?:secondary|off[\s\-]?(?:hand|weapon)|offhand)[\s:]/i
// Guard for weapon preset detection: only match /mystats mainhand lines.
// Prevents linked weapons in raid/group/party/whisper/say chat from
// updating the equipped weapon.
const MELEE_PRIMARY_LINE_RE = /\bMelee Primary\s*:/i
// Same guard for the offhand/secondary slot, e.g. "---- Melee Secondary: Ribcracker ----".
const MELEE_SECONDARY_LINE_RE = /\bMelee Secondary\s*:/i

function parseDamageShort(text: string): number {
  const m = /for\s+(\d+)/i.exec(text)
  return m ? parseInt(m[1], 10) : 0
}

function findEQProcessIds(onError: (message: string) => void): Promise<number[]> {
  return new Promise((resolve) => {
    exec('tasklist /FI "IMAGENAME eq eqgame.exe" /FO CSV /NH',
      { encoding: 'utf8', timeout: 3000 },
      (err, stdout) => {
        if (err) { onError(err.message); resolve([]); return }
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
  private onCharacterDetected?: (name: string) => void
  private stopped = false
  private sockets: net.Socket[] = []
  private scanTimer: NodeJS.Timeout | null = null
  private connectedPids = new Set<number>()

  // ── Diagnostic ───────────────────────────────────────────────
  private seenLogTypes = new Set<number>()
  private characterName = ''
  private critRe: RegExp | null = null   // compiled once from characterName
  // Wall-clock (Date.now()) timestamp of the last own-swing event (hit or miss)
  // seen from the pipe. Used to verify Zeal is actually delivering swing data,
  // as opposed to merely being connected — see getStatus().
  private lastSwingDataWallTs = 0
  private eqProcessFound = false
  private lastPipeError: string | null = null
  private scanError: string | null = null
  private readonly logFilePath: string | null
  // Counts consecutive connect failures per PID (reset on a successful 'connect').
  // scan() retries every 2s, so this never fires on an ordinary transient failure
  // (e.g. Zeal's pipe thread not up yet in the first second after character login)
  // — only once a PID has failed to connect several times in a row, meaning the
  // problem is persistent, not a timing fluke.
  private pipeConnectFailures = new Map<number, number>()
  private pipeRetryAfter = new Map<number, number>()   // pid -> Date.now() before which scan() won't retry
  private readonly PIPE_FAILURE_ANNOUNCE_THRESHOLD = 3
  // Announce each distinct failure category once per session (not once per PID —
  // multiboxing could otherwise re-trigger the same banner per character window).
  private announcedPipeFailureKinds = new Set<string>()

  /**
   * Persist a one-line diagnostic to disk. console.log is invisible for a
   * packaged app launched by double-click (no attached console), so this is
   * the only way hybrid-mode failures are ever visible to a user asked to
   * send their log — see zeal-reader.log next to settings.json.
   * ERROR-level lines are prefixed so a user pasting the file can spot the
   * relevant lines at a glance without understanding the rest of the log.
   */
  private log(message: string, level: 'INFO' | 'ERROR' = 'INFO'): void {
    console.log(message)
    if (level === 'ERROR') debugMonitor.logAnomaly('error', 'zeal', message)
    if (!this.logFilePath) return
    try {
      appendCappedLog(this.logFilePath, `[${new Date().toISOString()}] ${level}  ${message}\n`)
    } catch (err) {
      console.error('[ZealReader] Failed to write diagnostic log:', err)
      debugMonitor.logAnomaly('warn', 'zeal', 'Failed to write diagnostic log', { err: String(err) })
    }
  }

  private logError(message: string): void {
    this.log(message, 'ERROR')
  }

  // ── Combat state ──────────────────────────────────────────────
  private inCombat = false
  private currentTarget = ''
  private lastAttackTs = 0    // last time player attacked currentTarget

  // ── Bandolier deactivation buffer ────────────────────────────
  // Zeal pipe delivers the swap-back message before the combat hit arrives.
  // Delay clearing WEAVE_BANDOLIER_ACTIVE so in-flight hits still register as weaves.
  // Duration is cfg.WEAVE_BANDOLIER_OFF_DELAY_MS (user-adjustable).
  private weaveBandolierOffTimer: ReturnType<typeof setTimeout> | null = null

  // ── Swing tracking for miss classification ────────────────────
  // Zeal's YouMissOther sends "missed TARGET" with no verb, making it impossible to
  // distinguish a crush miss from a fist miss. We track the most recent hit timestamps
  // for each weapon slot so we can classify misses by timing.
  private lastCrushHitTs = 0  // last YouHitOther crush hit (ms)
  private lastFistHitTs  = 0  // last YouHitOther punch/strike hit (ms)
  private lastRiposteTs  = 0  // last riposte-classified event (ms, __DEV__ debug only)
  private currentBandolierSetName = ''  // see LogReader's field of the same name

  // ── Haste / ATK dedup ────────────────────────────────────────
  private lastHastePct = -1
  private lastHasteEmitTs = 0
  private lastAtkRating = 0
  private lastAtkEmitTs = 0

  // ── Weapon track state ────────────────────────────────────
  private weaponTrackActive = false
  private weaponTrack2H     = ''
  private weaponTrackOH     = ''

  private zealVersion: string | null = null

  private weaponRe: Array<{ re: RegExp; name: string; delay: number; attackType: string }>
  private offhandWeaponRe: Array<{ re: RegExp; name: string; delay: number }>
  private oorRe: RegExp[]
  private cursorBlockedRe: RegExp[]
  private avatarGainedRe: RegExp[]
  private avatarLostRe: RegExp[]
  private savageryGainedRe: RegExp[]
  private savageryLostRe: RegExp[]
  private innerflamGainedRe:  RegExp[]
  private innerflamLostRe:    RegExp[]
  private whirlwindGainedRe:  RegExp[]
  private whirlwindLostRe:    RegExp[]
  private stonestanceGainedRe: RegExp[]
  private stonestanceLostRe:   RegExp[]
  private discTimerRe:         RegExp[]
  private discReadyRe:         RegExp[]
  private hideSuccessRe:   RegExp[]
  private hideFailRe:      RegExp[]
  private evadeSuccessRe:  RegExp[]
  private evadeFailRe:     RegExp[]

  constructor(cfg: ConfigType, onEvent: EventCallback, onCharacterDetected?: (name: string) => void, logDir?: string) {
    this.cfg     = cfg
    this.onEvent = onEvent
    this.onCharacterDetected = onCharacterDetected
    this.logFilePath = logDir ? path.join(logDir, 'zeal-reader.log') : null

    const compile = (patterns: string[]) => patterns.map(p => new RegExp(p, 'i'))
    this.oorRe             = compile(cfg.OUT_OF_RANGE_PATTERNS)
    this.cursorBlockedRe   = compile(cfg.CURSOR_BLOCKED_PATTERNS)
    this.avatarGainedRe    = compile(cfg.AVATAR_GAINED_PATTERNS)
    this.avatarLostRe      = compile(cfg.AVATAR_LOST_PATTERNS)
    this.savageryGainedRe  = compile(cfg.SAVAGERY_GAINED_PATTERNS)
    this.savageryLostRe    = compile(cfg.SAVAGERY_LOST_PATTERNS)
    this.innerflamGainedRe  = compile(cfg.INNERFLAME_GAINED_PATTERNS)
    this.innerflamLostRe    = compile(cfg.INNERFLAME_LOST_PATTERNS)
    this.whirlwindGainedRe  = compile(cfg.WHIRLWIND_GAINED_PATTERNS)
    this.whirlwindLostRe    = compile(cfg.WHIRLWIND_LOST_PATTERNS)
    this.stonestanceGainedRe = compile(cfg.STONESTANCE_GAINED_PATTERNS)
    this.stonestanceLostRe   = compile(cfg.STONESTANCE_LOST_PATTERNS)
    this.discTimerRe         = compile(cfg.DISC_TIMER_PATTERNS)
    this.discReadyRe         = compile(cfg.DISC_READY_PATTERNS)
    this.hideSuccessRe      = compile(cfg.HIDE_SUCCESS_PATTERNS)
    this.hideFailRe         = compile(cfg.HIDE_FAIL_PATTERNS)
    this.evadeSuccessRe     = compile(cfg.EVADE_SUCCESS_PATTERNS)
    this.evadeFailRe        = compile(cfg.EVADE_FAIL_PATTERNS)
    this.weaponRe       = Object.entries(cfg.WEAPON_PRESETS).map(([name, { delay, attackType }]) => ({
      re: new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
      name,
      delay,
      attackType,
    }))
    this.offhandWeaponRe = Object.entries(cfg.OFFHAND_PRESETS).map(([name, delay]) => ({
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

  /** Surfaces a persistent (non-transient) Zeal pipe connect failure as an on-screen
   *  banner — not just a log line or Settings-window status text, since most users
   *  never open either and will otherwise just report "it doesn't work" with no
   *  detail. Classifies by Win32/libuv error code so the message tells them what to
   *  actually try, instead of a raw errno. Fires once per distinct cause per session
   *  (see announcedPipeFailureKinds) so a persistently-retrying failure doesn't spam
   *  a new banner every 2s. */
  private maybeAnnouncePipeFailure(errCode: string | null): void {
    const kind = errCode ?? 'UNKNOWN'
    if (this.announcedPipeFailureKinds.has(kind)) return
    this.announcedPipeFailureKinds.add(kind)

    let message: string
    if (errCode === 'ENOENT') {
      // CreateNamedPipeA is called with NULL security attributes (see Zeal's
      // named_pipe.cpp), which per MSDN grants Everyone read access — so an elevation mismatch
      // is not the likely cause
      // here. ENOENT means the pipe simply never existed at that path: either this
      // Zeal build predates named-pipe support, or the player hasn't run /zeal yet.
      message = 'Could not find Zeal\'s data pipe — hybrid tracking will use chat-log parsing only. ' +
        'Make sure Zeal is loaded (type /zeal in-game) and that you\'re on a Zeal build that includes named-pipe support.'
    } else if (errCode === 'EACCES') {
      message = 'Access denied connecting to Zeal\'s data pipe. Try closing EverQuest and Basketweaver and ' +
        'relaunching Basketweaver as Administrator, or check if antivirus/firewall software is blocking it.'
    } else {
      message = `Could not connect to Zeal's data pipe (${kind}). Basketweaver will keep retrying automatically — ` +
        'if this never connects, please send zeal-reader.log (Settings > Open Log File) to the developer.'
    }
    this.logError(`[ZealReader] Persistent pipe failure after ${this.PIPE_FAILURE_ANNOUNCE_THRESHOLD}+ attempts: ${message}`)
    this.emit({
      type: EvType.WARNING_BANNER, ts: performance.now(),
      data: { message, code: 'zeal-pipe-failure', level: 'info' },
    })
  }

  private scan(): void {
    if (this.stopped) return
    findEQProcessIds((message) => {
      this.scanError = message
      this.logError(`[ZealReader] tasklist scan failed: ${message}`)
    }).then(pids => {
      if (this.stopped) return
      this.eqProcessFound = pids.length > 0
      // Forget retry state for processes that have exited.
      for (const known of [...this.pipeConnectFailures.keys()]) {
        if (!pids.includes(known)) { this.pipeConnectFailures.delete(known); this.pipeRetryAfter.delete(known) }
      }
      for (const pid of pids) {
        if (!this.connectedPids.has(pid)) {
          if (Date.now() < (this.pipeRetryAfter.get(pid) ?? 0)) continue
          if (this.shouldLogPipeRetry(pid)) this.log(`[ZealReader] Found new EQ process PID ${pid}, connecting…`)
          this.connectedPids.add(pid)
          this.connectToPipe(pid)
        }
      }
    })
  }

  /** A client with no Zeal pipe (login screen, Zeal not loaded) fails every attempt, so
   *  retries back off exponentially (2s, 4s, 8s … capped at 30s) instead of hammering
   *  every scan, and only the first few attempts plus every 10th are logged. */
  private shouldLogPipeRetry(pid: number): boolean {
    const n = this.pipeConnectFailures.get(pid) ?? 0
    return n <= 3 || n % 10 === 0
  }

  private connectToPipe(pid: number): void {
    const pipePath = `\\\\.\\pipe\\zeal_${pid}`
    const socket = net.createConnection({ path: pipePath })
    this.sockets.push(socket)

    let buffer = ''
    let firstChunk = true

    socket.on('connect', () => {
      this.log(`[ZealReader] Connected to Zeal pipe for PID ${pid}`)
      this.pipeConnectFailures.delete(pid)
      this.pipeRetryAfter.delete(pid)
    })

    socket.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (firstChunk) {
        firstChunk = false
        this.log(`[ZealReader] PID ${pid} first data (${text.length} bytes): ${text.slice(0, 200).replace(/\n/g, '\\n')}`)
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
      const errCode = (err as NodeJS.ErrnoException).code ?? null
      const code = errCode ? ` (${errCode})` : ''
      this.lastPipeError = `${err.message}${code}`
      this.connectedPids.delete(pid)
      const idx = this.sockets.indexOf(socket)
      if (idx !== -1) this.sockets.splice(idx, 1)
      socket.destroy()

      const failures = (this.pipeConnectFailures.get(pid) ?? 0) + 1
      this.pipeConnectFailures.set(pid, failures)
      this.pipeRetryAfter.set(pid, Date.now() + Math.min(30_000, 2000 * 2 ** (failures - 1)))
      if (this.shouldLogPipeRetry(pid)) {
        this.logError(`[ZealReader] Pipe error for PID ${pid}: ${err.message}${code}` +
          (failures > 3 ? ` (attempt ${failures}; retries backed off, logging every 10th)` : ''))
      }
      if (failures >= this.PIPE_FAILURE_ANNOUNCE_THRESHOLD) this.maybeAnnouncePipeFailure(errCode)
    })

    socket.on('close', () => {
      if (this.shouldLogPipeRetry(pid)) this.log(`[ZealReader] Pipe closed for PID ${pid}`)
      this.connectedPids.delete(pid)
      const idx = this.sockets.indexOf(socket)
      if (idx !== -1) this.sockets.splice(idx, 1)
    })
  }

  private parsePipeMessage(json: string): void {
    let outer: { type: number; character?: string; data?: unknown }
    try { outer = JSON.parse(json) } catch (err) {
      this.logError(`[ZealReader] Outer JSON parse failed: ${(err as Error).message} — raw: ${json.slice(0, 200)}`)
      return
    }
    if ((outer.type !== PIPE_MSG_LOGTEXT && outer.type !== PIPE_MSG_CUSTOM) || !outer.data) return

    const inner = parseInnerData(outer.data)
    if (!inner || !inner.text) {
      this.logError(`[ZealReader] Inner data parse failed — raw: ${JSON.stringify(outer.data).slice(0, 200)}`)
      return
    }

    if (!this.characterName && outer.character) {
      this.characterName = outer.character
      const nameEsc = this.characterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      this.critRe = new RegExp(`^${nameEsc}\\b.*?\\((\\d+)\\)`, 'i')
      this.log(`[ZealReader] Character: "${this.characterName}"`)
      // Populate leaderboard character name if not already set by user
      if (!this.cfg.LEADERBOARD_CHARACTER_NAME) {
        this.cfg.LEADERBOARD_CHARACTER_NAME = this.characterName
      }
      this.onCharacterDetected?.(this.characterName)
    }

    const text = inner.text

    // PipeCmd (type=4): no LogType — just run the text through the same
    // matching used for chat text (weapon track, weave macro, etc.) directly.
    if (outer.type === PIPE_MSG_CUSTOM) {
      if (!this.seenLogTypes.has(-2)) {
        this.seenLogTypes.add(-2)
        this.log(`[ZealReader] NEW type=custom(/pipe) text=${text.slice(0, 120)}`)
      }
      this.processTextPatterns(text, performance.now())
      return
    }

    const logType = inner.type ?? -1

    if (!this.seenLogTypes.has(logType)) {
      this.seenLogTypes.add(logType)
      this.log(`[ZealReader] NEW type=${logType} text=${text.slice(0, 120)}`)
    }

    this.processZealMessage(logType, text)
  }

  /** Dispatch on Zeal LogType. Combat events use abbreviated text; calibration
   *  and OOR events fall through to text-pattern matching. */
  private processZealMessage(logType: number, text: string): void {
    const now = performance.now()

    // Track receipt of the player's own swing events (hit or miss) — this is
    // the signal the Settings UI uses to confirm swing data is actually
    // flowing over the pipe, not just that a pipe connection exists.
    if (logType === LOG.YouHitOther || logType === LOG.YouMissOther) {
      this.lastSwingDataWallTs = Date.now()
    }

    switch (logType) {

      // ── You hit something ──────────────────────────────────────
      case LOG.YouHitOther: {
        // Riposte check MUST precede verb parsing. Weapon-class ripostes (warrior/ranger)
        // arrive as YouHitOther with the weapon verb ("slash NAME for 250 (riposte)") and
        // no separate riposte verb, so they would otherwise be mis-classified as mainhand
        // swings and corrupt swing-interval calibration.  H2H ripostes come with verb
        // "strike" and "(riposte)" in the text.  Either way, "riposte" always appears in
        // the text — catching it here before verb dispatch is the safe guard.
        if (/riposte/i.test(text)) {
          debugMonitor.logClassify('riposte', `YouHitOther text="${text}" -> riposte`, { text })
          if (__DEV__) {
            const sinceLastCrush = this.lastCrushHitTs > 0 ? ((now - this.lastCrushHitTs) / 1000).toFixed(3) : 'n/a'
            console.debug(`[riposte][zeal] YouHitOther text="${text}" sinceLastMainhandHit=${sinceLastCrush}s`)
            this.lastRiposteTs = now
          }
          const dmg = parseDamageShort(text)
          if (dmg > 0)
            this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage: dmg } })
          return
        }

        const m = ZEAL_HIT_RE.exec(text)
        if (!m) return
        const verb   = m[1].toLowerCase()
        const target = m[2]
        const damage = parseInt(m[3], 10)

        this.ensureCombat(now)
        this.currentTarget = target
        this.lastAttackTs  = now

        // "hit" is the generic verb elemental illusions (fire/water/air) substitute
        // for H2H skill text. When the mainhand is itself H2H (punch build), an
        // illusioned "hit" line is the mainhand swing; otherwise (crush/slash/pierce
        // mainhand) it's the character's own H2H fist/bonus attack, same as punch/strike.
        const mainhandVerb = this.cfg.MAINHAND_ATTACK_TYPE
        const isMainhand = verb === mainhandVerb ||
          (mainhandVerb === 'punch' && (verb === 'punch' || verb === 'strike' || verb === 'hit'))
        const isFist = (verb === 'punch' || verb === 'strike' || verb === 'hit') && !isMainhand

        debugMonitor.logClassify('mainhand', `YouHitOther verb=${verb} -> ${isMainhand ? 'MAINHAND_CRUSH' : isFist ? 'FIST_ATTACK' : 'other'}`,
          { verb, damage, isMainhand, isFist, weaveBandolier: this.cfg.WEAVE_BANDOLIER_ACTIVE })
        if (__DEV__) {
          const sinceRiposte = this.lastRiposteTs > 0 ? ((now - this.lastRiposteTs) / 1000).toFixed(3) : 'n/a'
          console.debug(`[mainhand][zeal] YouHitOther verb=${verb} damage=${damage} isMainhand=${isMainhand} isFist=${isFist} ` +
            `weaveBandolier=${this.cfg.WEAVE_BANDOLIER_ACTIVE} sinceLastRiposte=${sinceRiposte}s`)
        }

        if (isMainhand) {
          if (this.cfg.ROGUE_MODE_ENABLED) {
            // Standard melee swing — counts toward net DPS same as a spell
            // proc; no weave/swing-timer state applies in Rogue Mode. Harmless
            // in hybrid mode, where forwardZealEvent suppresses MISC_DAMAGE
            // from Zeal and the damageOnly log reader is the authoritative source.
            this.lastCrushHitTs = now
            if (damage > 0) this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
            return
          }
          this.lastCrushHitTs = now
          if (this.cfg.WEAVE_BANDOLIER_ACTIVE) {
            this.emit({ type: EvType.FIST_ATTACK, ts: now,
              data: { damage, hit: true, line: text } })
          } else {
            this.emit({ type: EvType.MAINHAND_CRUSH, ts: now,
              data: { damage, hit: true, line: text, target } })
          }
        } else if (isFist) {
          if (this.cfg.ROGUE_MODE_ENABLED) {
            this.lastFistHitTs = now
            if (damage > 0) this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
            return
          }
          this.lastFistHitTs = now
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage, hit: true, line: text } })
        } else if (verb === 'flying kick' || verb === 'kick') {
          this.emit({ type: EvType.MISC_DAMAGE, ts: now, data: { damage } })
        } else if (this.cfg.WEAVE_BANDOLIER_ACTIVE) {
          if (this.cfg.ROGUE_MODE_ENABLED) return
          // Non-mainhand non-punch attack while weave bandolier is active →
          // offhand DW swing with a non-punch weapon type (e.g. slash/pierce offhand)
          this.lastFistHitTs = now
          this.emit({ type: EvType.FIST_ATTACK, ts: now,
            data: { damage, hit: true, line: text } })
        } else {
          // non-mainhand slash/pierce/bash, or an actual item proc → misc damage
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
        if (this.cfg.ROGUE_MODE_ENABLED) {
          const bs = ZEAL_BACKSTAB_RE.exec(text)
          if (bs) {
            const target = bs[1]
            const damage = parseInt(bs[2], 10)
            this.ensureCombat(now)
            this.currentTarget = target
            this.lastAttackTs  = now
            this.emit({ type: EvType.BACKSTAB_ATTACK, ts: now, data: { damage, hit: true, target } })
            return
          }
        }
        const damage = parseDamageShort(text)
        if (/riposte/i.test(text)) {
          debugMonitor.logClassify('riposte', `SpecialAbilities text="${text}" damage=${damage} -> riposte`, { text, damage })
        }
        if (__DEV__ && /riposte/i.test(text)) {
          const sinceLastCrush = this.lastCrushHitTs > 0 ? ((now - this.lastCrushHitTs) / 1000).toFixed(3) : 'n/a'
          console.debug(`[riposte][zeal] SpecialAbilities text="${text}" damage=${damage} sinceLastMainhandHit=${sinceLastCrush}s`)
          this.lastRiposteTs = now
        }
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

        // Log reader owns miss classification in hybrid mode; just keep combat alive.
        return
      }

      // ── Something hit/missed you — idle-timeout keep-alive only ──
      // Fight start must come from the player's own engagement (see ensureCombat()),
      // never from a mob hitting/missing the player first. When combat is already
      // active, re-emit COMBAT_START purely to refresh lastCombatActivity so the
      // 10-second idle timeout doesn't fire while other mobs keep swinging on the
      // player after the tracked target dies. When not in combat, do nothing.
      case LOG.OtherHitsYou:
      case LOG.OtherMissesYou:
        if (this.inCombat) this.emit({ type: EvType.COMBAT_START, ts: now })
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
        if (this.critRe) {
          const m = this.critRe.exec(text)
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

    // ── Zeal version detection (printed by the user running "/zeal version") ──
    const zealVerM = /^Zeal version:\s*([\d.]+)/i.exec(text)
    if (zealVerM) {
      const version = zealVerM[1]
      if (version !== this.zealVersion) {
        this.zealVersion = version
        this.log(`[ZealReader] Detected Zeal version: ${version}`)
      }
      return
    }

    // ── Weapon track (/say command sequence) ──────────────────
    // ── Weapon track — BW2H / BWOH work standalone in any channel ──
    const m2h = /\bBW2H\s+(.+)/i.exec(text)
    if (m2h) {
      this.weaponTrack2H = m2h[1].trim().replace(/['"]\s*$/, '')
      this.emitWeaponTrack(now)
      return
    }
    const moh = /\bBWOH\s+(.+)/i.exec(text)
    if (moh) {
      this.weaponTrackOH = moh[1].trim().replace(/['"]\s*$/, '')
      this.emitWeaponTrack(now)
      return
    }

    // Bandolier swap detection — "Loading bandolier set NAME" / "Bandolier set swap complete"
    {
      const bm = /^Loading bandolier set (.+?)\.?\s*$/i.exec(text)
      if (bm) {
        const setName = bm[1].trim().replace(/^\[|\]$/g, '')
        const isWeaveSet = isWeaveSetName(setName)
        const isBackstabSet = setName.toLowerCase().includes(this.cfg.ROGUE_BACKSTAB_SET_NAME.toLowerCase())
        this.cfg.ROGUE_BACKSTAB_SET_ACTIVE = isBackstabSet
        // Emit BANDOLIER_CHANGED immediately (before any delayed deactivation)
        this.emit({ type: EvType.BANDOLIER_CHANGED, ts: now, data: { setName, isWeaveSet, isBackstabSet } })
        if (isWeaveSet) {
          // Switching TO the weave set — activate immediately, cancel any pending deactivation
          if (this.weaveBandolierOffTimer !== null) {
            clearTimeout(this.weaveBandolierOffTimer)
            this.weaveBandolierOffTimer = null
          }
          this.cfg.WEAVE_BANDOLIER_ACTIVE = true
        } else {
          // Switching AWAY — delay deactivation so in-flight hits still register as weaves
          if (this.weaveBandolierOffTimer !== null) clearTimeout(this.weaveBandolierOffTimer)
          this.weaveBandolierOffTimer = setTimeout(() => {
            this.cfg.WEAVE_BANDOLIER_ACTIVE = false
            this.weaveBandolierOffTimer = null
          }, this.cfg.WEAVE_BANDOLIER_OFF_DELAY_MS)
        }
        return
      }
      if (/^bandolier set swap complete\.?\s*$/i.test(text)) return
    }

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
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'savagery', active: true, variant: savageryVariant(text) } })
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
    if (this.whirlwindGainedRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'whirlwind', active: true } })
      return
    }
    if (this.whirlwindLostRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'whirlwind', active: false } })
      return
    }

    // Stonestance discipline tracking
    if (this.stonestanceGainedRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'stonestance', active: true } })
      return
    }
    if (this.stonestanceLostRe.some(r => r.test(text))) {
      this.emit({ type: EvType.BUFF_CHANGED, ts: now, data: { buff: 'stonestance', active: false } })
      return
    }

    // /disc output — shared discipline reuse timer (never names the discipline)
    for (const re of this.discTimerRe) {
      const m = re.exec(text)
      if (m) {
        this.emit({ type: EvType.DISC_TIMER, ts: now, data: { remainingSec: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) } })
        return
      }
    }
    if (this.discReadyRe.some(r => r.test(text))) {
      this.emit({ type: EvType.DISC_TIMER, ts: now, data: { remainingSec: 0 } })
      return
    }

    // ── Rogue Hide / in-combat Evade reuse tracking ─────────────
    if (this.hideSuccessRe.some(r => r.test(text))) {
      this.emit({ type: EvType.EVADE_USED, ts: now, data: { kind: 'hide', success: true } })
      return
    }
    if (this.hideFailRe.some(r => r.test(text))) {
      this.emit({ type: EvType.EVADE_USED, ts: now, data: { kind: 'hide', success: false } })
      return
    }
    if (this.evadeSuccessRe.some(r => r.test(text))) {
      this.emit({ type: EvType.EVADE_USED, ts: now, data: { kind: 'evade', success: true } })
      return
    }
    if (this.evadeFailRe.some(r => r.test(text))) {
      this.emit({ type: EvType.EVADE_USED, ts: now, data: { kind: 'evade', success: false } })
      return
    }

    // ── Weapon preset detection ─────────────────────────────
    // Only fire on /mystats mainhand lines ("Melee Primary: ...").
    // Prevents weapon names linked in raid, group, party, whisper, or say
    // chat from corrupting BASE_WEAPON_DELAY / MAINHAND_ATTACK_TYPE.
    if (MELEE_PRIMARY_LINE_RE.test(text)) {
      for (const { re, name, delay, attackType } of this.weaponRe) {
        if (re.test(text)) {
          this.cfg.BASE_WEAPON_DELAY    = delay
          this.cfg.BASE_WEAPON_NAME     = name
          this.cfg.MAINHAND_ATTACK_TYPE = attackType as 'crush' | 'slash' | 'pierce' | 'punch'
          this.emit({ type: EvType.WEAPON_DETECTED, ts: now, data: { name, delay } })
          return
        }
      }
    }

    // ── Offhand weapon preset detection ─────────────────────
    // Only fire on /mystats secondary lines ("Melee Secondary: ...").
    if (MELEE_SECONDARY_LINE_RE.test(text)) {
      for (const { re, name, delay } of this.offhandWeaponRe) {
        if (re.test(text)) {
          this.cfg.OFFHAND_WEAPON_DELAY = delay
          this.cfg.OFFHAND_WEAPON_NAME  = name
          this.emit({ type: EvType.OFFHAND_WEAPON_DETECTED, ts: now, data: { name, delay } })
          return
        }
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
      // Always emit STATS_UPDATE with latest known atk + haste when haste changes
      this.emitStatsUpdate(now, { hastePct })
      return
    }

    // ATK rating detection (/mystats)
    const atkRating = parseAtkRating(text)
    if (atkRating !== null) {
      const sameValue  = atkRating === this.lastAtkRating
      const recentEmit = now - this.lastAtkEmitTs < 2000
      if (!sameValue || !recentEmit) {
        this.lastAtkRating  = atkRating
        this.lastAtkEmitTs  = now
        this.emitStatsUpdate(now, { atkRating })
      }
    }
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

  private emitStatsUpdate(now: number, changed: { hastePct?: number; atkRating?: number }): void {
    const data: Record<string, unknown> = {}
    if (changed.hastePct  !== undefined) data.hastePct  = changed.hastePct
    if (changed.atkRating !== undefined) data.atkRating = changed.atkRating
    // Always include the other value so the renderer can update its full snapshot
    if (data.hastePct  === undefined) data.hastePct  = this.lastHastePct  >= 0 ? this.lastHastePct  : undefined
    if (data.atkRating === undefined) data.atkRating = this.lastAtkRating > 0  ? this.lastAtkRating : undefined
    this.emit({ type: EvType.STATS_UPDATE, ts: now, data })
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
    if (ev.type === EvType.BANDOLIER_CHANGED) {
      const { setName, isWeaveSet, isBackstabSet } = ev.data as { setName: string; isWeaveSet: boolean; isBackstabSet: boolean }
      this.currentBandolierSetName = setName
      debugMonitor.logClassify('bandolier', `Loading bandolier set "${setName}" — isWeaveSet=${isWeaveSet} isBackstabSet=${isBackstabSet}`,
        { setName, isWeaveSet, isBackstabSet })
    } else if (ev.type === EvType.FIST_ATTACK) {
      debugMonitor.logClassify('bandolier-weave', `Weave attempt (hit=${ev.data?.hit}) while bandolier set was "${this.currentBandolierSetName}"`,
        { setName: this.currentBandolierSetName, hit: ev.data?.hit })
    }
    this.onEvent(ev)
  }

  /** Snapshot for the Settings UI's hybrid-mode diagnostic indicator. */
  getStatus(): ZealStatus {
    return {
      pipeConnected: this.connectedPids.size > 0,
      characterName: this.characterName,
      msSinceLastSwingData: this.lastSwingDataWallTs > 0 ? Date.now() - this.lastSwingDataWallTs : null,
      eqProcessFound: this.eqProcessFound,
      lastPipeError: this.lastPipeError,
      scanError: this.scanError,
      zealVersion: this.zealVersion,
    }
  }

  stop(): void {
    this.stopped = true
    if (this.scanTimer) { clearInterval(this.scanTimer); this.scanTimer = null }
    for (const s of this.sockets) { try { s.destroy() } catch {} }
    this.sockets = []
    this.connectedPids.clear()
    this.characterName   = ''
    this.critRe          = null
    this.seenLogTypes.clear()
    this.inCombat            = false
    this.currentTarget       = ''
    this.lastAttackTs        = 0
    this.lastCrushHitTs      = 0
    this.lastFistHitTs       = 0
    this.cfg.WEAVE_BANDOLIER_ACTIVE = false
    this.cfg.ROGUE_BACKSTAB_SET_ACTIVE = false
    if (this.weaveBandolierOffTimer !== null) {
      clearTimeout(this.weaveBandolierOffTimer)
      this.weaveBandolierOffTimer = null
    }
    this.lastHastePct    = -1
    this.lastHasteEmitTs = 0
    this.lastAtkRating   = 0
    this.lastAtkEmitTs   = 0
    this.weaponTrackActive = false
    this.weaponTrack2H   = ''
    this.weaponTrackOH   = ''
    this.lastSwingDataWallTs = 0
  }
}

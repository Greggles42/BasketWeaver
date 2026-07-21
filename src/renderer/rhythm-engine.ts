/**
 * Rhythm engine — runs synchronously on the renderer's rAF loop.
 * Direct port of rhythm_engine.py; uses performance.now() (ms) throughout.
 *
 * NOTE: All times are in milliseconds (performance.now()), whereas the Python
 * version uses seconds (time.perf_counter()). Config threshold constants that
 * were seconds are converted on first use via cfgS() helpers below.
 */

import type { ConfigType } from '../shared/config'

export interface Note {
  noteId: number
  targetTime: number    // ms (performance.now())
  swingTime: number     // ms — when the mainhand swing closed this round
  state: 'active' | 'hit' | 'clipped' | 'missed'
  hitTime: number | null
}

export interface GradeResult {
  grade: string
  mobName: string       // name of the target that died (set by caller)
  pctInGreen: number    // 0–1, fraction of mainhand rounds that had a weave attempt
  roundsWeaved: number         // mainhand rounds where a fist attempt occurred (log-based)
  keystrokeRoundsWeaved: number // mainhand rounds where a keystroke landed in the window
  totalRounds: number          // total mainhand rounds completed
  weaveAttempts: number        // total fist punch attempts (log events, hit or miss)
  weaveLanded: number          // fist attacks that dealt damage
  keystrokeGrading: boolean    // which mode produced pctInGreen/grade
  totalFistDamage: number
  fightDuration: number // ms (total wall-clock duration)
  addedDps: number      // damage per second from fist attacks
  totalDps: number      // total melee DPS (mainhand + fist + misc) for the fight
  totalDamage: number   // raw total damage dealt during the fight
  avgReactionMs: number | null  // ms from mainhand crush to first fist attempt, per round
  outOfRangeMs: number  // ms accumulated out-of-range during the fight
  engagedMs: number     // ms actually in melee range (fightDuration - outOfRangeMs)
}

const GRADE_THRESHOLDS: Array<[number, string]> = [
  [0.95, 'S'],
  [0.85, 'A'],
  [0.75, 'B'],
  [0.60, 'C'],
  [0.45, 'D'],
]

/** Config values are stored in seconds; multiply by 1000 for ms comparisons. */
const s = (sec: number) => sec * 1000

export class RhythmEngine {
  cfg: ConfigType
  notes: Note[] = []
  private nextId = 0

  inCombat = false
  private combatStartTime = 0.0

  roundOpen = false
  lastCrushTime = 0.0
  private lastRoundCloseTime = 0.0
  private roundSkipCalibration = false

  nextSwingTime = 0.0
  swingTimerValid = false

  private nextNoteTime = 0.0
  private notesAnchored = false
  private lastKnownInterval = 0.0

  lastRoundFistDamages: number[] = []
  private roundFistDamages: number[] = []

  private roundMainhandDamage = 0
  /** Set in closeRound() to the total mainhand damage dealt that round; cleared by overlay. */
  public roundEndDamage: number | null = null

  score = 0
  combo = 0
  maxCombo = 0
  hitCount = 0
  clippedCount = 0
  missCount = 0

  fistAttemptCount = 0
  fistAttackCount = 0
  totalFistDamage = 0
  totalMeleeDamage = 0   // mainhand + fist combined
  mainhandClips = 0

  // ── Leaderboard tracking ──────────────────────────────────────
  totalOutOfRangeMs = 0
  private outOfRangeStart: number | null = null
  disciplinesUsed: Set<string> = new Set()

  // ── DPS time-series ───────────────────────────────────────────
  /** [ms since combatStart, damage] pairs, appended on every damage event. */
  private damageLog: Array<[number, number]> = []

  get liveDps(): number {
    if (!this.inCombat || this.combatStartTime <= 0) return 0
    const now = performance.now()
    const currentOorMs = this.outOfRangeStart !== null ? Math.max(0, now - this.outOfRangeStart) : 0
    const elapsed = Math.max(0, (now - this.combatStartTime) - this.totalOutOfRangeMs - currentOorMs) / 1000
    return elapsed > 0 ? this.totalFistDamage / elapsed : 0
  }

  get liveTotalDps(): number {
    if (!this.inCombat || this.combatStartTime <= 0) return 0
    const now = performance.now()
    const currentOorMs = this.outOfRangeStart !== null ? Math.max(0, now - this.outOfRangeStart) : 0
    const elapsed = Math.max(0, (now - this.combatStartTime) - this.totalOutOfRangeMs - currentOorMs) / 1000
    return elapsed > 0 ? this.totalMeleeDamage / elapsed : 0
  }

  roundCount = 0
  roundsWithWeave = 0
  keystrokeRoundsWithWeave = 0
  private roundHadKeystroke = false
  private roundHadFistAttempt = false

  private reactionTimeSum = 0
  private reactionTimeCount = 0
  private lastMainhandTs = 0         // timestamp of most recent new mainhand round opening
  private roundReactionCounted = false  // true once we've recorded a reaction time for the current round

  // ── Rolling interval calibration ─────────────────────────────
  private measuredIntervals: number[] = []
  private static readonly CALIB_BUFFER = 4   // fast convergence: 3 samples needed, 4th evicts oldest
  /** Set in closeRound() when the calibrated interval shifts >50ms; cleared by caller. */
  public calibrationEvent: { interval: number } | null = null

  /** Set in closeRound() when keystroke grading detected a weave-key press in the window
   *  but no fist attack arrived in the log (dual-wield roll failed). Cleared by caller. */
  public dwRollFailed = false

  constructor(cfg: ConfigType) {
    this.cfg = cfg
  }

  // ── Public API ───────────────────────────────────────────────

  onCombatStart(ts: number): void {
    if (this.inCombat) return
    this.inCombat = true
    this.combatStartTime = ts
    this.resetScore()

    // Pre-populate the note track immediately using the last known weapon speed.
    // The first real swing will recalibrate via closeRound() as normal.
    const interval    = this.predictedInterval          // seconds
    const halfWindow  = this.computeWindowWidth(interval) / 2
    this.cfg.GOOD_WINDOW    = halfWindow
    this.cfg.PUNCH_INTERVAL = interval
    this.lastKnownInterval  = interval   // seconds, matching PUNCH_INTERVAL units

    // lastRoundCloseTime stays 0 (set by resetScore) so the first closeRound()
    // produces no measurement — combatStart is not a swing boundary.
    this.nextSwingTime      = ts + s(interval)
    this.nextNoteTime       = ts + s(interval) + s(halfWindow)
    this.notesAnchored      = true
    this.swingTimerValid    = true
  }

  /** Resume combat after a spurious end event (false MOB_DIED / COMBAT_END mid-fight).
   *  Restores inCombat and re-arms the swing timer WITHOUT resetting damage stats or
   *  combatStartTime, so the full fight's DPS calculation remains intact. */
  resumeCombat(ts: number): void {
    if (this.inCombat) return
    this.inCombat = true
    // combatStartTime intentionally unchanged — full fight duration preserved.
    // Bootstrap to ts if it was never set (first fight, no prior onCombatStart).
    if (this.combatStartTime <= 0) this.combatStartTime = ts
    // Do NOT call resetScore() — keep accumulated damage stats
    // Clear calibration state so stale measurements from the previous fight don't
    // corrupt the interval estimate for the new/resumed engagement.
    this.measuredIntervals   = []
    this.calibrationEvent    = null
    this.lastRoundCloseTime  = 0
    this.roundHadKeystroke   = false
    this.roundHadFistAttempt = false
    this.dwRollFailed        = false
    const interval   = this.predictedInterval   // derive fresh from weapon delay + haste
    const halfWindow = this.computeWindowWidth(interval) / 2
    this.cfg.PUNCH_INTERVAL  = interval
    this.cfg.GOOD_WINDOW     = halfWindow
    this.nextSwingTime   = ts + s(interval)
    this.nextNoteTime    = ts + s(interval) + s(halfWindow)
    this.notesAnchored   = true
    this.swingTimerValid = true
    this.roundOpen       = false
    this.lastKnownInterval = interval
  }

  onCombatEnd(ts: number): GradeResult {
    if (!this.inCombat) return this.makeGrade()
    // Close any open OOR period before computing engagedMs
    if (this.outOfRangeStart !== null) {
      this.totalOutOfRangeMs += Math.max(0, ts - this.outOfRangeStart)
      this.outOfRangeStart = null
    }
    this.inCombat = false
    this.roundOpen = false
    this.notesAnchored = false
    this.swingTimerValid = false
    for (const note of this.notes) {
      if (note.state === 'active') {
        note.state = 'missed'
        this.missCount++
        this.combo = 0
      }
    }
    return this.makeGrade()
  }

  onMainhandCrush(ts: number, damage: number, _hit: boolean, skipCalibration = false): void {
    if (damage > 0) this.totalMeleeDamage += damage
    if (!this.inCombat) return
    if (damage > 0) this.damageLog.push([ts - this.combatStartTime, damage])

    if (this.roundOpen) {
      if (damage > 0) this.roundMainhandDamage += damage
      this.lastCrushTime = ts
    } else {
      this.roundOpen = true
      this.roundSkipCalibration = skipCalibration
      this.lastCrushTime = ts
      this.lastMainhandTs = ts
      this.roundReactionCounted = false
      this.roundHadFistAttempt = false
      this.roundHadKeystroke   = false
      this.roundFistDamages = []
      this.roundMainhandDamage = damage > 0 ? damage : 0
      // swingTimerValid intentionally kept — the predicted swing just happened as expected.
      // Cleared only by onOutOfRange or combat end.
    }
  }

  /**
   * Returns true if this fist attack was identified as a mainhand clip.
   * reactionTs: renderer performance.now() at IPC receipt — same clock as lastMainhandTs.
   *             Must be passed separately because ts is latency-compensated for scoring.
   */
  onFistAttack(ts: number, damage: number, hit: boolean, reactionTs: number): boolean {
    if (!this.inCombat) return false

    if (this.isClip(ts)) {
      this.mainhandClips++
      for (let i = this.notes.length - 1; i >= 0; i--) {
        const note = this.notes[i]
        if (note.state === 'hit') {
          note.state = 'clipped'
          this.hitCount--
          this.clippedCount++
          this.combo = 0
          break
        }
      }
      return true
    }

    this.fistAttemptCount++
    this.roundHadFistAttempt = true
    // Record reaction time once per round: time from mainhand crush to first fist attempt.
    // Both timestamps use renderer performance.now() so the clocks match.
    if (this.lastMainhandTs > 0 && !this.roundReactionCounted && reactionTs >= this.lastMainhandTs) {
      this.reactionTimeSum += reactionTs - this.lastMainhandTs
      this.reactionTimeCount++
      this.roundReactionCounted = true
    }
    if (hit && damage > 0) {
      this.totalFistDamage += damage
      this.totalMeleeDamage += damage
      this.fistAttackCount++
      this.roundFistDamages.push(damage)
      this.damageLog.push([reactionTs - this.combatStartTime, damage])
    }
    return false
  }

  onMiscDamage(damage: number): void {
    if (!this.inCombat || damage <= 0) return
    this.totalMeleeDamage += damage
    this.damageLog.push([performance.now() - this.combatStartTime, damage])
  }

  /** Accumulate damage sourced from the log file (used in hybrid mode). */
  onLogDamage(damage: number, source: 'mainhand' | 'fist' | 'misc'): void {
    if (damage <= 0) return
    const now = performance.now()
    if (source === 'mainhand') {
      this.totalMeleeDamage += damage
      if (this.inCombat) {
        this.damageLog.push([now - this.combatStartTime, damage])
        // Track per-round mainhand damage so huge-round detection works in hybrid mode
        if (this.roundOpen) this.roundMainhandDamage += damage
      }
    } else if (source === 'fist') {
      if (!this.inCombat) return
      this.totalFistDamage  += damage
      this.totalMeleeDamage += damage
      this.fistAttackCount++
      this.damageLog.push([now - this.combatStartTime, damage])
      // Track per-round fist damage so huge-round detection includes weave hits
      if (this.roundOpen) this.roundFistDamages.push(damage)
    } else {
      if (!this.inCombat) return
      this.totalMeleeDamage += damage
      this.damageLog.push([now - this.combatStartTime, damage])
    }
  }

  onOutOfRange(ts: number): void {
    this.swingTimerValid = false
    this.notesAnchored = false
    this.cancelActiveNotes()
    if (this.inCombat && this.outOfRangeStart === null) {
      this.outOfRangeStart = ts
    }
  }

  onReturnInRange(ts: number): void {
    if (this.outOfRangeStart !== null) {
      this.totalOutOfRangeMs += Math.max(0, ts - this.outOfRangeStart)
      this.outOfRangeStart = null
      // Reset the round-close anchor so the next closeRound() produces no measurement.
      // Without this, the interval measured after returning includes the OOR gap:
      //   measured = lastCrushTime_before_OOR + OOR_duration + swing_tick_after_return
      // At high haste (e.g. 80%, 1.11s interval) a brief OOR of ~0.67s inflates the
      // measured interval to ~1.79s, which the coarse calibration reads as ~12% haste.
      this.lastRoundCloseTime = 0
    }
  }

  /**
   * Return per-second time-averaged DPS samples for the completed fight.
   * Each index i represents second (i+1). DPS is compensated by treating
   * the first `compensationSec` seconds as if `compensationSec` seconds have
   * elapsed — this smooths out the initial spike where small elapsed time
   * inflates the DPS value.
   */
  getDpsSamples(compensationSec = 15): number[] {
    if (this.damageLog.length === 0) return []
    const maxMs  = this.damageLog[this.damageLog.length - 1][0]
    const maxSec = Math.ceil(maxMs / 1000)
    const samples: number[] = []
    let cumDamage = 0
    let logIdx    = 0
    for (let t = 1; t <= maxSec; t++) {
      const tMs = t * 1000
      while (logIdx < this.damageLog.length && this.damageLog[logIdx][0] <= tMs) {
        cumDamage += this.damageLog[logIdx][1]
        logIdx++
      }
      const denom = Math.max(t, compensationSec * (1 - Math.exp(-3 * t / compensationSec)))
      samples.push(cumDamage / denom)
    }
    return samples
  }

  /**
   * Score a weapon-swap attempt (mouse click or SPACE).
   * Returns ['HIT', pts] | [null, 0]
   */
  registerClick(ts: number): [string | null, number] {
    // Score nearest active note within window
    let best: Note | null = null
    let bestDelta = Infinity

    for (const note of this.notes) {
      if (note.state !== 'active') continue
      const delta = Math.abs(ts - note.targetTime)
      if (delta <= s(this.cfg.GOOD_WINDOW) && delta < bestDelta) {
        best = note
        bestDelta = delta
      }
    }

    if (!best) return [null, 0]

    this.roundHadKeystroke = true
    best.state   = 'hit'
    best.hitTime = ts
    this.hitCount++
    this.combo++
    this.maxCombo = Math.max(this.maxCombo, this.combo)
    const multiplier = 1 + Math.floor(this.combo / this.cfg.COMBO_STEP)
    const pts = this.cfg.HIT_PTS * multiplier
    this.score += pts
    return ['HIT', pts]
  }

  get predictedInterval(): number {
    return (this.cfg.BASE_WEAPON_DELAY / 10.0) / (1.0 + this.cfg.HASTE_PCT / 100.0)
  }

  get effectiveOffhandDelay(): number {
    // Derive from current PUNCH_INTERVAL using the weapon delay ratio — this is algebraically
    // equivalent to the haste formula but doesn't depend on HASTE_PCT being accurately known.
    // Both mainhand and offhand share the same haste multiplier, so the ratio is constant.
    return this.cfg.PUNCH_INTERVAL * this.cfg.OFFHAND_WEAPON_DELAY / this.cfg.BASE_WEAPON_DELAY
  }

  /** Full weave window width in seconds for a given swing interval.
   *  When WEAVE_WINDOW_MS is set the manual value is used directly (can exceed the
   *  auto-calculated window).  Dynamic weaving (applyDynamicWeaveWindow) may still
   *  clamp the window down to the real available time when a weapon-swap signal fires. */
  computeWindowWidth(interval: number, effectiveDelay = this.effectiveOffhandDelay): number {
    if (this.cfg.WEAVE_WINDOW_MS > 0) return this.cfg.WEAVE_WINDOW_MS / 1000
    return Math.max(0.2, interval - effectiveDelay)
  }

  adjustInterval(delta: number): void {
    this.cfg.PUNCH_INTERVAL = Math.max(0.5, Math.min(12.0, this.cfg.PUNCH_INTERVAL + delta))
  }

  /** Returns true if ts falls within any note's scoring window.
   *  Includes recently auto-missed notes so a punch that arrives a frame after
   *  the window closes still registers as in-window for positive-audio feedback. */
  isInWeaveWindow(ts: number): boolean {
    return this.notes.some(n =>
      (n.state === 'active' || n.state === 'missed') &&
      Math.abs(ts - n.targetTime) <= s(this.cfg.GOOD_WINDOW))
  }

  /**
   * Record a weave key press for log-grading mode without touching note state or scoring.
   * Sets roundHadKeystroke so dwRollFailed fires at round close if no fist attack follows.
   * Returns true if the keystroke landed in the window (and was newly recorded).
   */
  noteKeystrokeInWindow(ts: number): boolean {
    if (!this.inCombat || this.roundHadKeystroke) return false
    if (this.isInWeaveWindow(ts)) {
      this.roundHadKeystroke = true
      return true
    }
    return false
  }

  /**
   * Record a bandolier-swap weave attempt for inferred DW mode.
   * Caller has already confirmed the swap is inside the weave window.
   * Sets roundHadKeystroke so the attempt is counted at round close, without
   * touching note state or scoring counters.
   */
  noteInferredWeaveAttempt(): void {
    if (!this.inCombat || this.roundHadKeystroke) return
    this.roundHadKeystroke = true
  }

  /**
   * Call every frame. Closes open rounds, pre-generates notes, auto-misses expired notes.
   * Returns newly generated notes (caller may schedule audio ticks).
   */
  update(now: number): Note[] {
    const newNotes: Note[] = []
    if (!this.inCombat) return newNotes

    // Detect interval change — discard stale pre-generated notes
    const currentInterval = this.cfg.PUNCH_INTERVAL
    if (Math.abs(currentInterval - this.lastKnownInterval) > 0.10) {
      this.cancelActiveNotes()
      this.notesAnchored = false
      this.lastKnownInterval = currentInterval
    }

    // Close round once no new crush arrives within cluster window
    if (this.roundOpen && now > this.lastCrushTime + s(this.cfg.ROUND_CLUSTER_WINDOW)) {
      this.closeRound()
    }

    // Pre-generate upcoming notes for highway runway (10 rounds ahead — extras start off-screen and scroll in)
    if (this.notesAnchored) {
      const interval  = s(this.cfg.PUNCH_INTERVAL)
      const lookahead = now + 10.0 * interval
      while (this.nextNoteTime <= lookahead) {
        const note: Note = { noteId: this.nextId++, targetTime: this.nextNoteTime,
          swingTime: this.nextNoteTime - s(this.cfg.GOOD_WINDOW),
          state: 'active', hitTime: null }
        this.notes.push(note)
        newNotes.push(note)
        this.nextNoteTime += interval
      }
    }

    // Auto-miss notes whose window has passed
    for (const note of this.notes) {
      if (note.state === 'active' && now > note.targetTime + s(this.cfg.GOOD_WINDOW)) {
        note.state = 'missed'
        this.missCount++
        this.combo = 0
      }
    }

    // Purge old notes
    const cutoff = s(this.cfg.GOOD_WINDOW + 2.0)
    this.notes = this.notes.filter(n => now - n.targetTime < cutoff)

    return newNotes
  }

  makeGrade(): GradeResult {
    const useKeystroke = this.cfg.KEYSTROKE_GRADING
    const weavedRounds = useKeystroke ? this.keystrokeRoundsWithWeave : this.roundsWithWeave
    const pctInGreen   = this.roundCount > 0 ? weavedRounds / this.roundCount : 0.0

    let grade = 'F'
    for (const [threshold, letter] of GRADE_THRESHOLDS) {
      if (pctInGreen >= threshold) { grade = letter; break }
    }

    const fightDuration = this.combatStartTime > 0
      ? performance.now() - this.combatStartTime : 0.0
    const outOfRangeMs = this.totalOutOfRangeMs
    const engagedMs    = Math.max(0, fightDuration - outOfRangeMs)

    const addedDps = engagedMs > 0
      ? this.totalFistDamage / (engagedMs / 1000) : 0.0
    const totalDps = engagedMs > 0
      ? this.totalMeleeDamage / (engagedMs / 1000) : 0.0

    const avgReactionMs = this.reactionTimeCount > 0
      ? this.reactionTimeSum / this.reactionTimeCount
      : null

    return { grade, mobName: '', pctInGreen,
      roundsWeaved: this.roundsWithWeave,
      keystrokeRoundsWeaved: this.keystrokeRoundsWithWeave,
      totalRounds: this.roundCount,
      weaveAttempts: this.fistAttemptCount, weaveLanded: this.fistAttackCount,
      totalFistDamage: this.totalFistDamage, fightDuration, addedDps, totalDps,
      totalDamage: this.totalMeleeDamage, avgReactionMs,
      keystrokeGrading: useKeystroke, outOfRangeMs, engagedMs }
  }

  // ── Internal ─────────────────────────────────────────────────

  private closeRound(): void {
    this.roundOpen = false
    const roundEnd = this.lastCrushTime

    let interval: number
    if (this.lastRoundCloseTime > 0) {
      const measured = (roundEnd - this.lastRoundCloseTime) / 1000  // seconds
      // Accept plausible single-swing durations only. Cap at 130% of the unhasted
      // weapon delay — a skipped/OOR swing appears as ≥2× the real interval and
      // would otherwise drag the median too low.
      const maxPlausible = (this.cfg.BASE_WEAPON_DELAY / 10) * 1.3
      // Minimum plausible interval = weapon at 125% haste cap (base / 2.25).
      // Any measured gap shorter than this must be a riposte or other non-swing event
      // that slipped through — reject it before it can pollute the rolling median.
      const minPlausible = (this.cfg.BASE_WEAPON_DELAY / 10) / 2.25
      if (!this.roundSkipCalibration && measured >= minPlausible && measured <= maxPlausible) {
        // Change detection: if the new measurement diverges from the running median
        // by more than 8%, a genuine haste or weapon-swap event has occurred.
        // Discard stale samples so calibration converges in ~3 swings instead of
        // slowly drifting over a full buffer rotation.
        if (this.measuredIntervals.length >= 3) {
          const currentMedian = RhythmEngine.median(this.measuredIntervals)
          if (Math.abs(measured - currentMedian) / currentMedian > 0.08) {
            this.measuredIntervals = []
          }
        }
        this.measuredIntervals.push(measured)
        if (this.measuredIntervals.length > RhythmEngine.CALIB_BUFFER)
          this.measuredIntervals.shift()
      }
      // Rolling median: robust to outliers — up to (n/2 - 1) bad values can't corrupt the result.
      // Use 3+ samples for stability; fall back to current PUNCH_INTERVAL while building up.
      const raw = this.measuredIntervals.length >= 3
        ? RhythmEngine.median(this.measuredIntervals)
        : this.cfg.PUNCH_INTERVAL
      if (raw < minPlausible) {
        this.measuredIntervals = []
        interval = this.cfg.PUNCH_INTERVAL
      } else {
        interval = raw
      }
    } else {
      interval = this.predictedInterval
    }

    // Signal a calibration banner when the interval shifts by more than 50 ms.
    if (Math.abs(interval - this.cfg.PUNCH_INTERVAL) > 0.05) {
      this.calibrationEvent = { interval }
    }

    this.lastRoundCloseTime = roundEnd
    this.cfg.PUNCH_INTERVAL = interval

    const windowWidth = this.computeWindowWidth(interval)
    const halfWindow  = windowWidth / 2.0
    this.cfg.GOOD_WINDOW = halfWindow

    const noteTarget = roundEnd + s(halfWindow)
    const note: Note = { noteId: this.nextId++, targetTime: noteTarget,
      swingTime: roundEnd, state: 'active', hitTime: null }
    this.notes.push(note)

    this.nextNoteTime = noteTarget + s(interval)
    this.notesAnchored = true

    this.nextSwingTime   = roundEnd + s(interval)
    this.swingTimerValid = true

    // A confirmed fist attack in the log proves the player pressed the weave key —
    // credit keystroke grading too so log-confirmed weaves are never lost even if
    // the uiohook key detection missed the press.
    if (this.roundHadFistAttempt) this.roundHadKeystroke = true

    this.roundCount++
    if (this.roundHadFistAttempt) this.roundsWithWeave++
    if (this.roundHadKeystroke)   this.keystrokeRoundsWithWeave++
    if (this.roundHadKeystroke && !this.roundHadFistAttempt) this.dwRollFailed = true

    this.lastRoundFistDamages = [...this.roundFistDamages]
    const fistTotal = this.roundFistDamages.reduce((s, d) => s + d, 0)
    this.roundFistDamages = []
    this.roundEndDamage = this.roundMainhandDamage + fistTotal
    this.roundMainhandDamage = 0
  }

  /** Clear the rolling interval buffer — call after a /mystats haste update so
   *  stale measurements from the old haste level don't pollute calibration. */
  resetCalibration(): void {
    this.measuredIntervals = []
    this.calibrationEvent  = null
  }

  private static median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 !== 0
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2
  }

  private cancelActiveNotes(): void {
    this.notes = this.notes.filter(n => n.state !== 'active')
  }

  private isClip(ts: number): boolean {
    const window = this.cfg.CLIP_AUTO
      ? s(this.effectiveOffhandDelay)
      : s(this.cfg.CLIP_DETECTION_WINDOW)
    return (
      this.swingTimerValid &&
      !this.roundOpen &&
      !this.notes.some(n => n.state === 'active') &&
      Math.abs(ts - this.nextSwingTime) < window
    )
  }

  /** Hard reset — wipes all state as if the app just launched. */
  reset(): void {
    this.inCombat = false
    this.combatStartTime = 0.0
    this.resetScore()
  }

  private resetScore(): void {
    this.score = 0; this.combo = 0; this.maxCombo = 0
    this.hitCount = 0; this.clippedCount = 0; this.missCount = 0
    this.fistAttemptCount = 0; this.fistAttackCount = 0; this.totalFistDamage = 0; this.totalMeleeDamage = 0; this.mainhandClips = 0
    this.reactionTimeSum = 0; this.reactionTimeCount = 0; this.lastMainhandTs = 0; this.roundReactionCounted = false
    this.roundCount = 0; this.roundsWithWeave = 0; this.keystrokeRoundsWithWeave = 0
    this.roundHadFistAttempt = false; this.roundHadKeystroke = false; this.dwRollFailed = false
    this.notes = []; this.nextId = 0
    this.roundOpen = false; this.notesAnchored = false
    this.lastRoundCloseTime = 0.0; this.nextSwingTime = 0.0
    this.swingTimerValid = false
    this.lastRoundFistDamages = []; this.roundFistDamages = []
    this.roundMainhandDamage = 0; this.roundEndDamage = null
    this.lastKnownInterval = this.predictedInterval   // seconds, matching PUNCH_INTERVAL units
    this.measuredIntervals = []; this.calibrationEvent = null
    this.totalOutOfRangeMs = 0; this.outOfRangeStart = null
    this.disciplinesUsed = new Set()
    this.damageLog = []
  }
}

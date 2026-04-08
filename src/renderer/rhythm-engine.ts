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
  roundsWeaved: number  // mainhand rounds where a fist attempt occurred
  totalRounds: number   // total mainhand rounds completed
  weaveAttempts: number // total fist punch attempts (log events, hit or miss)
  weaveLanded: number   // fist attacks that dealt damage
  totalFistDamage: number
  fightDuration: number // ms
  addedDps: number      // damage per second from fist attacks
  avgReactionMs: number | null  // ms from mainhand crush to first fist attempt, per round
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

  nextSwingTime = 0.0
  swingTimerValid = false

  private nextNoteTime = 0.0
  private notesAnchored = false
  private lastKnownInterval = 0.0

  lastRoundFistDamages: number[] = []
  private roundFistDamages: number[] = []

  score = 0
  combo = 0
  maxCombo = 0
  hitCount = 0
  clippedCount = 0
  missCount = 0

  fistAttemptCount = 0
  fistAttackCount = 0
  totalFistDamage = 0
  mainhandClips = 0

  private roundCount = 0
  private roundsWithWeave = 0
  private roundHadFistAttempt = false

  private reactionTimeSum = 0
  private reactionTimeCount = 0
  private lastMainhandTs = 0         // timestamp of most recent new mainhand round opening
  private roundReactionCounted = false  // true once we've recorded a reaction time for the current round

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
    const fistDelay   = this.effectiveOffhandDelay
    const halfWindow  = Math.max(0.2, interval - fistDelay) / 2
    this.cfg.GOOD_WINDOW    = halfWindow
    this.cfg.PUNCH_INTERVAL = interval
    this.lastKnownInterval  = s(interval)

    // Seed the swing timer from combat start so closeRound() can measure the
    // first real interval against it.
    this.lastRoundCloseTime = ts
    this.nextSwingTime      = ts + s(interval)
    this.nextNoteTime       = ts + s(interval) + s(halfWindow)
    this.notesAnchored      = true
    this.swingTimerValid    = true
  }

  onCombatEnd(ts: number): GradeResult {
    if (!this.inCombat) return this.makeGrade()
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

  onMainhandCrush(ts: number, _damage: number, _hit: boolean): void {
    if (!this.inCombat) return
    if (this.roundOpen) {
      this.lastCrushTime = ts
    } else {
      this.roundOpen = true
      this.lastCrushTime = ts
      this.lastMainhandTs = ts
      this.roundReactionCounted = false
      this.roundHadFistAttempt = false
      this.roundFistDamages = []
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
      this.fistAttackCount++
      this.roundFistDamages.push(damage)
    }
    return false
  }

  onOutOfRange(_ts: number): void {
    this.swingTimerValid = false
    this.notesAnchored = false
    this.cancelActiveNotes()
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
    return (this.cfg.OFFHAND_WEAPON_DELAY / 10.0) / (1.0 + this.cfg.HASTE_PCT / 100.0)
  }

  adjustInterval(delta: number): void {
    this.cfg.PUNCH_INTERVAL = Math.max(0.5, Math.min(12.0, this.cfg.PUNCH_INTERVAL + delta))
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

    // Pre-generate upcoming notes for highway runway (5 rounds ahead — extras start off-screen and scroll in)
    if (this.notesAnchored) {
      const interval  = s(this.cfg.PUNCH_INTERVAL)
      const lookahead = now + 5.0 * interval
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
    const pctInGreen = this.roundCount > 0 ? this.roundsWithWeave / this.roundCount : 0.0

    let grade = 'F'
    for (const [threshold, letter] of GRADE_THRESHOLDS) {
      if (pctInGreen >= threshold) { grade = letter; break }
    }

    const fightDuration = this.combatStartTime > 0
      ? performance.now() - this.combatStartTime : 0.0
    const addedDps = fightDuration > 0
      ? this.totalFistDamage / (fightDuration / 1000) : 0.0

    const avgReactionMs = this.reactionTimeCount > 0
      ? this.reactionTimeSum / this.reactionTimeCount
      : null

    return { grade, mobName: '', pctInGreen,
      roundsWeaved: this.roundsWithWeave, totalRounds: this.roundCount,
      weaveAttempts: this.fistAttemptCount, weaveLanded: this.fistAttackCount,
      totalFistDamage: this.totalFistDamage, fightDuration, addedDps, avgReactionMs }
  }

  // ── Internal ─────────────────────────────────────────────────

  private closeRound(): void {
    this.roundOpen = false
    const roundEnd = this.lastCrushTime

    let interval: number
    if (this.lastRoundCloseTime > 0) {
      const measured = (roundEnd - this.lastRoundCloseTime) / 1000  // back to seconds
      const known    = this.cfg.PUNCH_INTERVAL
      // Reject the measurement if it looks like a skipped swing (unequip/re-equip gap).
      // A genuine interval change never multiplies the interval by 1.6×+; a missed swing
      // always does. Keep the existing interval so the timer doesn't drift.
      const isSkippedSwing = measured > known * 1.6
      interval = (measured >= 0.5 && measured <= 12.0 && !isSkippedSwing)
        ? measured : known
    } else {
      interval = this.predictedInterval
    }

    this.lastRoundCloseTime = roundEnd
    this.cfg.PUNCH_INTERVAL = interval

    const fistDelay   = this.effectiveOffhandDelay
    const windowWidth = Math.max(0.2, interval - fistDelay)
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

    this.roundCount++
    if (this.roundHadFistAttempt) this.roundsWithWeave++

    this.lastRoundFistDamages = [...this.roundFistDamages]
    this.roundFistDamages = []
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
    this.fistAttemptCount = 0; this.fistAttackCount = 0; this.totalFistDamage = 0; this.mainhandClips = 0
    this.reactionTimeSum = 0; this.reactionTimeCount = 0; this.lastMainhandTs = 0; this.roundReactionCounted = false
    this.roundCount = 0; this.roundsWithWeave = 0; this.roundHadFistAttempt = false
    this.notes = []; this.nextId = 0
    this.roundOpen = false; this.notesAnchored = false
    this.lastRoundCloseTime = 0.0; this.nextSwingTime = 0.0
    this.swingTimerValid = false
    this.lastRoundFistDamages = []; this.roundFistDamages = []
    this.lastKnownInterval = s(this.predictedInterval)
  }
}

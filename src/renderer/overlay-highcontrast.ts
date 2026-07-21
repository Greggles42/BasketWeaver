/**
 * Basketweaver overlay — HIGH CONTRAST style.
 *
 * Drop-in replacement for src/renderer/overlay.ts. Pure black background,
 * vivid saturated colors, chunky shapes, big Archivo type. Designed for
 * streaming / low-vision use and as an alternate user-pickable style.
 *
 * Same public API as the existing Overlay class:
 *   new HighContrastOverlay(canvas).start()
 *   overlay.handleGameEvent(ev)
 *   overlay.handleKey(key)
 *   overlay.toggleOrientation() / etc.
 */

import { Config, type ConfigType } from '../shared/config'
import { EvType, type GameEvent, type HitRecord } from '../shared/events'
import { RhythmEngine, type GradeResult } from './rhythm-engine'
import { AudioManager } from './audio-manager'
import type { EncounterRecord } from '../shared/leaderboard-types'

const COMBAT_IDLE_TIMEOUT_MS = 10_000

// HC palette
const HC = {
  bg:        '#000000',
  accent:    '#ffee00',          // signature yellow
  text:      '#ffffff',
  textDim:   '#888888',
  combat:    '#ff5100',
  result:    '#ffee00',
  idle:      '#333333',
  weaveFill: 'rgba(0,220,255,',  // cyan family
  weaveStrk: 'rgba(150,240,255,',
  swingBar:  'rgba(255,120,0,',
  hitZone:   '#ffee00',
  weaveDps:  '#ff7800',
  missChip:  'rgba(60,60,60,',
  missText:  'rgba(220,220,220,',
  clipWash:  'rgba(255,40,40,',
  clipChip:  'rgba(255,40,40,',
}

const now = () => performance.now()

class Banner {
  static FADE_IN = 300; static FADE_OUT = 500
  text: string; color: string; duration: number; born = now()
  bigNumber?: string
  constructor(text: string, color: string, duration = 4000, bigNumber?: string) {
    this.text = text; this.color = color; this.duration = duration; this.bigNumber = bigNumber
  }
  get alpha() {
    const age = now() - this.born
    if (age < Banner.FADE_IN) return age / Banner.FADE_IN
    const rem = this.duration - age
    if (rem <= 0) return 0
    if (rem < Banner.FADE_OUT) return rem / Banner.FADE_OUT
    return 1
  }
  get expired() { return now() - this.born >= this.duration }
}

class GradeScreen {
  static FADE_IN = 400; static HOLD = 5000; static FADE_OUT = 500
  result: GradeResult; born = now(); dismissed = false
  constructor(result: GradeResult) { this.result = result }
  dismiss() { this.dismissed = true }
  get alpha() {
    if (this.dismissed) return 0
    const age = now() - this.born
    const total = GradeScreen.FADE_IN + GradeScreen.HOLD + GradeScreen.FADE_OUT
    if (age < GradeScreen.FADE_IN) return age / GradeScreen.FADE_IN
    if (age > total) return 0
    const rem = total - age
    if (rem < GradeScreen.FADE_OUT) return rem / GradeScreen.FADE_OUT
    return 1
  }
  get expired() {
    if (this.dismissed) return true
    const age = now() - this.born
    return age > GradeScreen.FADE_IN + GradeScreen.HOLD + GradeScreen.FADE_OUT
  }
}

export class HighContrastOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cfg: ConfigType
  private rhythm: RhythmEngine
  private audio: AudioManager

  private hzX = 80
  private hzY = 0
  private runway = 392
  private highwayY = 30
  private highwayH = 62
  private speed = 0; private targetSpeed = 0

  private hitFlash = 0
  private missFlash = 0
  private clipWarn = 0
  private dwRollFlash = 0     // DW roll failure: keystroke in window, no fist in log
  private dwPendingTs = 0    // timestamp when weave key landed in window; cleared by fist or timer
  private banners: Banner[] = []
  private gradeScreen: GradeScreen | null = null
  private lastGradeResult: import('./rhythm-engine').GradeResult | null = null
  private fightHistory: GradeResult[] = []
  private dpsDisplayTotal   = 0
  private dpsDisplayFist    = 0
  private dpsLastUpdate     = 0
  private lastFrameTime = 0
  private lastCombatActivity = 0
  private combatStartTs = 0
  private swingTimerEverValid = false
  private hasteCalibrated = false  // true when haste% was derived from measured swings, not /mystats
  private weaveBandolierActive = false
  private oorLastSoundTs = 0
  private lastOhSnapTs = 0
  private lastFistAttackTs = 0
  private consecutiveCrushesWithoutFist = 0
  private audioMutedRapidAttack = false
  private rapidAttackMuteUntil = 0
  private static readonly RAPID_CRUSH_THRESHOLD = 4
  private static readonly RAPID_MUTE_MS = 6000
  private avatarActive = false
  private savageryActive = false
  private lastKnownMainhand = ''
  private lastKnownAtkRating = 0
  private lastKnownHastePct = 0
  private avatarFightMs = 0;     private avatarFightStart:      number | null = null
  private savageryFightMs = 0;   private savageryFightStart:    number | null = null
  private innerflameFlightMs = 0; private innerflameFlightStart: number | null = null
  private innerflameUntil  = 0   // performance.now() expiry; 0 = inactive
  private whirlwindUntil   = 0   // performance.now() expiry; 0 = inactive

  pinned = true
  charName = ''
  logSelected = false
  private lastLogActivityTs = 0
  private currentTarget = ''
  private topCrits:      HitRecord[] = []
  private topHugeRounds: HitRecord[] = []
  // Post-combat glide: keep weave windows scrolling for 3 s after mob dies
  private postCombatGlideUntil = 0
  private postCombatNextSwing  = 0
  private postCombatLastCrush  = 0
  private postCombatRoundOpen  = false

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')!
    this.cfg = Config
    this.rhythm = new RhythmEngine(Config)
    this.audio = new AudioManager(Config)
    this.audio.preload()
    this.computeLayout()
  }

  start(): void {
    const TARGET = 1000 / 60
    this.lastFrameTime = now()
    const loop = (ts: number) => {
      requestAnimationFrame(loop)
      const elapsed = ts - this.lastFrameTime
      if (elapsed < TARGET - 0.5) return
      const dt = Math.min(elapsed / 1000, 0.1)
      this.lastFrameTime = ts
      this.update(dt); this.draw()
    }
    requestAnimationFrame(loop)
  }

  // ── Layout ──────────────────────────────────────────────────
  private windowSize(): [number, number] {
    if (this.cfg.ORIENTATION === 'vertical')
      return [this.cfg.VERT_WINDOW_WIDTH, this.cfg.VERT_WINDOW_HEIGHT]
    return [this.cfg.WINDOW_WIDTH, this.cfg.WINDOW_HEIGHT]
  }
  private resizeCanvas(): void {
    const [w, h] = this.windowSize()
    this.canvas.width = w; this.canvas.height = h
  }
  private computeLayout(): void {
    const [w, h] = this.windowSize()
    this.highwayY = 30
    this.highwayH = h - 30 - 30
    if (this.cfg.ORIENTATION === 'horizontal') {
      this.hzX = Math.max(10, Math.trunc(w * this.cfg.TARGET_POSITION_PCT / 100))
      this.hzY = 0
      this.runway = w - this.hzX - 10
    } else {
      this.hzX = Math.trunc(w / 2)
      this.hzY = this.highwayY + Math.trunc(this.highwayH * (1 - this.cfg.TARGET_POSITION_PCT / 100))
      this.runway = this.hzY - this.highwayY
    }
    this.speed = this.runway / (4 * this.cfg.PUNCH_INTERVAL * 1000)
  }
  private hzCenter(): [number, number] {
    const vo = this.cfg.HIT_ZONE_VISUAL_OFFSET
    if (this.cfg.ORIENTATION === 'horizontal')
      return [this.hzX + vo, this.highwayY + this.highwayH / 2]
    return [this.hzX, this.hzY + vo]
  }
  private projectAt(targetTime: number, t: number): [number, number] {
    const vo = this.cfg.HIT_ZONE_VISUAL_OFFSET
    if (this.cfg.ORIENTATION === 'horizontal')
      return [Math.trunc(this.hzX + vo + (targetTime - t) * this.speed),
              this.highwayY + this.highwayH / 2]
    return [this.hzX,
            Math.trunc(this.hzY + vo - (targetTime - t) * this.speed)]
  }

  showBanner(text: string, color: string, duration?: number): void {
    this.banners.push(new Banner(text, color, duration))
  }

  // ── IPC ─────────────────────────────────────────────────────
  handleGameEvent(ev: GameEvent): void {
    this.lastLogActivityTs = now()
    const ts = ev.ts
    switch (ev.type) {
      case EvType.COMBAT_START:
        if (!this.rhythm.inCombat) {
          this.postCombatGlideUntil = 0
          this.rhythm.onCombatStart(now())
          this.audio.play('combat_start')
          this.gradeScreen = null
          this.clearRapidAttackMute()
          this.combatStartTs = now()
          this.dpsDisplayTotal = 0; this.dpsDisplayFist = 0; this.dpsLastUpdate = 0
          this.swingTimerEverValid = false
          const t0 = now()
          this.avatarFightMs = 0;      this.avatarFightStart      = this.avatarActive          ? t0 : null
          this.savageryFightMs = 0;    this.savageryFightStart    = this.savageryActive         ? t0 : null
          this.innerflameFlightMs = 0; this.innerflameFlightStart = this.innerflameUntil > t0  ? t0 : null
        }
        this.lastCombatActivity = ts
        break
      case EvType.MOB_DIED: {
        if (this.rhythm.inCombat) {
          this.postCombatGlideUntil = now() + 3000
          this.postCombatNextSwing  = this.rhythm.nextSwingTime
          this.postCombatLastCrush  = this.rhythm.lastCrushTime
          this.postCombatRoundOpen  = this.rhythm.roundOpen
          const r = this.rhythm.onCombatEnd(ts)
          r.mobName = (ev.data?.mobName as string) ?? ''
          this.audio.play('combat_end')
          this.lastGradeResult = r
          this.pushHistory(r)
          this.sendLeaderboardRecord(r)
          this.gradeScreen = new GradeScreen(r)
        }
        this.clearRapidAttackMute()
        break
      }
      case EvType.COMBAT_END:
        if (this.rhythm.inCombat) {
          this.postCombatGlideUntil = now() + 3000
          this.postCombatNextSwing  = this.rhythm.nextSwingTime
          this.postCombatLastCrush  = this.rhythm.lastCrushTime
          this.postCombatRoundOpen  = this.rhythm.roundOpen
          this.rhythm.onCombatEnd(ts)
        }
        this.clearRapidAttackMute()
        break
      case EvType.MAINHAND_CRUSH: {
        const ct = now()
        const damage = (ev.data?.damage as number) ?? 0
        const hit    = (ev.data?.hit    as boolean) ?? false
        if (ev.data?.target) this.currentTarget = ev.data.target as string
        // Resume if combat ended spuriously mid-fight (preserves damage stats)
        if (!this.rhythm.inCombat) {
          this.postCombatGlideUntil = 0
          this.rhythm.resumeCombat(ct)
        }
        // A mainhand hit means the player is back in range — close any open OOR period
        this.rhythm.onReturnInRange(ct)
        this.rhythm.onMainhandCrush(ct, damage, hit, this.weaveBandolierActive)
        this.lastCombatActivity = ct
        this.consecutiveCrushesWithoutFist++
        if (this.consecutiveCrushesWithoutFist >= HighContrastOverlay.RAPID_CRUSH_THRESHOLD) {
          this.audioMutedRapidAttack = true
          this.rapidAttackMuteUntil = ct + HighContrastOverlay.RAPID_MUTE_MS
          this.audio.setTemporaryMute(true)
        }
        this.audio.playForce('crush')
        this.oorLastSoundTs = 0
        break
      }
      case EvType.FIST_ATTACK: {
        const adjTs   = ts - this.cfg.LATENCY_COMPENSATION * 1000
        const fistNow = now()
        const damage  = (ev.data?.damage as number)  ?? 0
        const hit     = (ev.data?.hit    as boolean) ?? false
        this.rhythm.onReturnInRange(fistNow)
        const isClip  = this.rhythm.onFistAttack(adjTs, damage, hit, fistNow)
        this.dwPendingTs = 0  // offhand swing confirmed — cancel any pending DW no-roll timer
        this.lastCombatActivity = ts
        this.consecutiveCrushesWithoutFist = 0
        this.lastFistAttackTs = fistNow
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else if (this.cfg.POSITIVE_AUDIO_IN_WINDOW && this.rhythm.isInWeaveWindow(adjTs)) {
          this.audio.play('punch')
          if (hit && damage > 0) { this.hitFlash = 1 } else { this.missFlash = 1 }
        } else if (this.cfg.POSITIVE_AUDIO_IN_WINDOW) {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) setTimeout(() => this.audio.play('whiff'), 150)
        } else if (hit) {
          this.audio.play('punch')
          this.hitFlash = 1
        } else {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) setTimeout(() => this.audio.play('whiff'), 150)
        }
        break
      }
      case EvType.MISC_DAMAGE:
        this.rhythm.onMiscDamage((ev.data?.damage as number) ?? 0)
        this.lastCombatActivity = ts
        break
      case EvType.LOG_DAMAGE:
        this.rhythm.onReturnInRange(now())
        this.rhythm.onLogDamage(
          (ev.data?.damage as number) ?? 0,
          (ev.data?.source as 'mainhand' | 'fist' | 'misc') ?? 'misc'
        )
        break
      case EvType.CURSOR_BLOCKED:
        this.audio.play('error')
        this.banners.push(new Banner('CURSOR — SWAP BLOCKED', HC.combat, 3000))
        break
      case EvType.OUT_OF_RANGE: {
        this.rhythm.onOutOfRange(ts)
        this.banners.push(new Banner('OUT OF RANGE', HC.combat, 3000))
        const t = now()
        if (this.rhythm.inCombat && t - this.oorLastSoundTs > 1500) {
          this.oorLastSoundTs = t
          this.audio.play('out_of_range')
        }
        break
      }
      case EvType.WEAPON_DETECTED: {
        const name  = (ev.data?.name  as string) ?? ''
        const delay = (ev.data?.delay as number) ?? 20
        this.lastKnownMainhand = name
        this.cfg.BASE_WEAPON_DELAY = delay
        const newInterval = this.rhythm.predictedInterval
        const fistDelay   = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW    = Math.max(0.2, newInterval - fistDelay) / 2
        this.cfg.PUNCH_INTERVAL = newInterval
        this.rhythm.resetCalibration()
        this.banners.push(new Banner(`WEAPON: ${name.toUpperCase()}`, HC.accent, 4000))
        break
      }
      case EvType.HASTE_DETECTED: {
        const hastePct = (ev.data?.haste_pct as number) ?? 0
        const interval = (ev.data?.interval  as number) ?? this.rhythm.predictedInterval
        this.cfg.HASTE_PCT      = hastePct
        this.cfg.PUNCH_INTERVAL = interval
        const fistDelay   = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW = Math.max(0.2, interval - fistDelay) / 2
        this.rhythm.resetCalibration()
        this.hasteCalibrated = false
        this.audio.play('combat_start')
        this.banners.push(new Banner(`HASTE ${hastePct.toFixed(0)}% · ${interval.toFixed(2)}s`, HC.accent, 4000))
        break
      }
      case EvType.WEAVE_SIGNAL: {
        const offhandDelay = (ev.data?.offhandDelay as number) ?? this.cfg.OFFHAND_WEAPON_DELAY
        this.applyDynamicWeaveWindow(offhandDelay)
        const weaveNow = now()
        const adjTs    = ts - this.cfg.LATENCY_COMPENSATION * 1000
        const isClip   = this.rhythm.onFistAttack(adjTs, 0, false, weaveNow)
        this.lastCombatActivity = ts
        this.consecutiveCrushesWithoutFist = 0
        this.lastFistAttackTs = weaveNow
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) setTimeout(() => this.audio.play('whiff'), 150)
        }
        break
      }
      case EvType.BUFF_CHANGED: {
        const buff   = ev.data?.buff   as string
        const active = ev.data?.active as boolean
        if (buff === 'avatar') {
          this.avatarActive = active
          if (this.rhythm.inCombat) {
            if (active) { this.avatarFightStart = now() }
            else if (this.avatarFightStart !== null) { this.avatarFightMs += now() - this.avatarFightStart; this.avatarFightStart = null }
          }
          if (active) { this.banners.push(new Banner('AVATAR ON', '#a855f7', 4000)); this.audio.playFileSound('avatar') }
        }
        if (buff === 'savagery') {
          this.savageryActive = active
          if (this.rhythm.inCombat) {
            if (active) { this.savageryFightStart = now() }
            else if (this.savageryFightStart !== null) { this.savageryFightMs += now() - this.savageryFightStart; this.savageryFightStart = null }
          }
          if (active) { this.banners.push(new Banner('SAVAGERY ON', '#f97316', 4000)); this.audio.playFileSound('savagery') }
        }
        if (buff === 'innerflame') {
          const t = now()
          this.innerflameUntil = active ? t + 12000 : 0
          if (this.rhythm.inCombat) {
            if (active) { this.innerflameFlightStart = t }
            else if (this.innerflameFlightStart !== null) { this.innerflameFlightMs += t - this.innerflameFlightStart; this.innerflameFlightStart = null }
          }
        }
        if (buff === 'whirlwind') {
          this.whirlwindUntil = active ? now() + 12000 : 0
          if (active) this.banners.push(new Banner('WHIRLWIND', '#c084fc', 3000))
        }
        break
      }
      case EvType.BANDOLIER_CHANGED: {
        const isWeaveSet = (ev.data?.isWeaveSet as boolean) ?? false
        this.weaveBandolierActive = isWeaveSet
        // Inferred DW mode: arm the no-roll timer when the weave bandolier loads and
        // the swap falls inside the current weave window.
        if (isWeaveSet && this.cfg.INFERRED_DW_CHECKS
            && this.rhythm.inCombat && this.rhythm.isInWeaveWindow(ts)) {
          this.dwPendingTs = ts
          this.rhythm.noteInferredWeaveAttempt()
        }
        break
      }
      case EvType.STATS_UPDATE: {
        const atk   = ev.data?.atkRating as number | undefined
        const haste = ev.data?.hastePct  as number | undefined
        if (atk   != null) this.lastKnownAtkRating = atk
        if (haste != null) this.lastKnownHastePct  = haste
        break
      }
      case EvType.CRIT_HIT: {
        const damage = (ev.data?.damage as number) ?? 0
        const target = (ev.data?.target as string) || this.currentTarget
        const big = damage > this.cfg.CRIT_DAMAGE_THRESHOLD
        if (big) {
          this.audio.playFileSound('epic', true)
          this.banners.push(new Banner('MONSTER CRIT', '#ff4444', 3000, damage.toLocaleString()))
          this.recordHit(this.topCrits, damage, target)
        } else if (this.cfg.SHOW_ALL_CRITS) {
          this.audio.playFileSound('hit_tick', true)
          this.banners.push(new Banner('CRIT', '#ffffff', 2000, damage.toLocaleString()))
        }
        break
      }
    }
  }

  handleKey(key: string): void {
    switch (key) {
      case 'Escape': window.electronAPI?.quit(); break
      case ' ': this.gradeScreen?.dismiss(); break
      case 'm': case 'M': this.audio.toggle(); break
      case 'ArrowUp':   this.rhythm.adjustInterval(+0.25); break
      case 'ArrowDown': this.rhythm.adjustInterval(-0.25); break
      case 'r': case 'R': this.resetTrack(); break
      case 'v': case 'V': this.copyToClipboard(); break
    }
  }

  /** Called when the player's configured weave key is pressed (global hook via main process).
   *  Plays an audio confirmation and scores the attempt in the rhythm engine, so a
   *  dual-wield roll failure (nothing in the log) still counts toward keystroke grading. */
  handleWeaveKeyPressed(ts: number): void {
    if (!this.rhythm.inCombat) return
    if (this.cfg.KEYSTROKE_GRADING) {
      const [hit] = this.rhythm.registerClick(ts)
      // Arm DW timer from key press only when not using inferred bandolier detection
      if (hit && !this.cfg.INFERRED_DW_CHECKS) this.dwPendingTs = ts
    } else {
      // Log-grading mode: record keystroke; if it lands in window, arm the DW timer
      if (this.rhythm.noteKeystrokeInWindow(ts) && !this.cfg.INFERRED_DW_CHECKS) this.dwPendingTs = ts
    }
  }

  testDwRollFail(): void {
    this.dwRollFlash = 1
    this.audio.play('dw_ok')
  }

  private resetTrack(): void {
    if (this.rhythm.inCombat) this.rhythm.onCombatEnd(now())
    this.postCombatGlideUntil = 0
    this.gradeScreen = null
    this.lastGradeResult = null
    this.combatStartTs = 0
    this.swingTimerEverValid = false
    this.dwPendingTs = 0
  }

  private recordHit(list: HitRecord[], damage: number, target: string): void {
    const date = new Date().toLocaleString('en-US', {
      month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    list.push({ damage, target: target || 'Unknown', date })
    list.sort((a, b) => b.damage - a.damage)
    if (list.length > 10) list.length = 10
    window.electronAPI?.sendTopRecords(this.topCrits, this.topHugeRounds)
  }

  private pushHistory(result: GradeResult): void {
    this.fightHistory.unshift(result)
    if (this.fightHistory.length > 5) this.fightHistory.length = 5
    const entries = this.fightHistory.map(r => {
      const mob    = r.mobName || 'Unknown'
      const weaved = r.keystrokeGrading ? r.keystrokeRoundsWeaved : r.roundsWeaved
      const reactShort = r.avgReactionMs != null ? `${r.avgReactionMs.toFixed(0)}ms` : '—'
      const reactFull  = r.avgReactionMs != null ? ` | Avg reaction: ${r.avgReactionMs.toFixed(0)}ms` : ''
      const label = `${r.grade}  ${weaved}/${r.totalRounds} rnds  ${r.weaveAttempts}att/${r.weaveLanded}hit  +${r.addedDps.toFixed(0)}dps  ${reactShort}  [${mob}]`
      const full  = `Basketweaver: ${r.grade} ${weaved}/${r.totalRounds} rounds weaved${r.keystrokeGrading ? ' (key)' : ''} | ` +
        `Bonus attacks: ${r.weaveAttempts} attempts ${r.weaveLanded} landed | ` +
        `Added DPS: ${r.addedDps.toFixed(0)}${reactFull}`
      return { label, full }
    })
    window.electronAPI?.sendFightHistory(entries)
  }

  private flushBuffs(fightDuration: number): { avatar: number; savagery: number; innerflame: number } {
    const endNow = now()
    const flush = (start: number | null, accum: number) =>
      start !== null ? accum + (endNow - start) : accum
    const frac = (ms: number) => Math.min(1, ms / Math.max(1, fightDuration))
    return {
      avatar:     frac(flush(this.avatarFightStart,      this.avatarFightMs)),
      savagery:   frac(flush(this.savageryFightStart,    this.savageryFightMs)),
      innerflame: frac(flush(this.innerflameFlightStart, this.innerflameFlightMs)),
    }
  }

  private sendLeaderboardRecord(result: GradeResult): void {
    if (result.fightDuration < 10_000) return
    const record: EncounterRecord = {
      grade:                    result.grade,
      mobName:                  result.mobName,
      pctInGreen:               result.pctInGreen,
      roundsWeaved:             result.roundsWeaved,
      keystrokeRoundsWeaved:    result.keystrokeRoundsWeaved,
      totalRounds:              result.totalRounds,
      weaveAttempts:            result.weaveAttempts,
      weaveLanded:              result.weaveLanded,
      keystrokeGrading:         result.keystrokeGrading,
      totalFistDamage:          result.totalFistDamage,
      fightDuration:            result.fightDuration,
      addedDps:                 result.addedDps,
      totalDps:                 result.totalDps,
      totalDamage:              result.totalDamage,
      avgReactionMs:            result.avgReactionMs,
      id:                       crypto.randomUUID(),
      timestamp:                Date.now(),
      characterName:            this.cfg.LEADERBOARD_CHARACTER_NAME,
      serverName:               'Project Quarm',
      weapons: {
        mainhand: this.lastKnownMainhand || 'Unknown',
        offhand:  this.cfg.OFFHAND_WEAPON_NAME || 'Unknown',
      },
      atkRating:       this.lastKnownAtkRating,
      hastePct:        this.lastKnownHastePct,
      engagedMs:       result.engagedMs,
      outOfRangeMs:    result.outOfRangeMs,
      disciplinesUsed: Array.from(this.rhythm.disciplinesUsed),
      buffsActive: this.flushBuffs(result.fightDuration),
      dpsSamples: this.rhythm.getDpsSamples(),
    }
    window.electronAPI?.sendLeaderboardRecord(record)
  }

  private copyToClipboard(): void {
    const r = this.lastGradeResult ?? this.rhythm.makeGrade()
    const weaved  = r.keystrokeGrading ? r.keystrokeRoundsWeaved : r.roundsWeaved
    const react   = r.avgReactionMs !== null ? ` | Avg reaction: ${r.avgReactionMs.toFixed(0)}ms` : ''
    const text = `Basketweaver: ${r.grade} ${weaved}/${r.totalRounds} rounds weaved${r.keystrokeGrading ? ' (key)' : ''} | ` +
      `Bonus attacks: ${r.weaveAttempts} attempts ${r.weaveLanded} landed | ` +
      `Added DPS: ${r.addedDps.toFixed(0)}` + react
    navigator.clipboard.writeText(text).then(() => {
      this.banners.push(new Banner('Copied to clipboard!', '#5aeb96', 2000))
    }).catch(() => {
      this.banners.push(new Banner('Clipboard error!', '#ff4040', 2000))
    })
  }

  applyTargetPosition(pct: number): void {
    this.cfg.TARGET_POSITION_PCT = pct
    this.cfg.HIT_ZONE_X = Math.max(10, Math.trunc(this.cfg.WINDOW_WIDTH * pct / 100))
    this.computeLayout()
  }
  toggleLaneLines(): void { this.cfg.LANE_LINES = !this.cfg.LANE_LINES }
  toggleFistMissSound(): void { this.cfg.FIST_SOUND_ON_MISS = !this.cfg.FIST_SOUND_ON_MISS }
  toggleDynamicWeaving(): void { this.cfg.DYNAMIC_WEAVING = !this.cfg.DYNAMIC_WEAVING }
  toggleOffhandTimer(): void { this.cfg.SHOW_OFFHAND_TIMER = !this.cfg.SHOW_OFFHAND_TIMER }
  toggleHighContrast(): void { /* this overlay IS the high contrast style */ }

  /** Dynamic Weave Windows — update offhand delay and immediately recalculate
   *  the safe weave window width (visual + scoring) using the post-haste value. */
  applyDynamicWeaveWindow(delayTenths: number, name = ''): void {
    if (!this.cfg.DYNAMIC_WEAVING) return
    this.cfg.OFFHAND_WEAPON_DELAY = delayTenths
    this.cfg.OFFHAND_WEAPON_NAME  = name
    const effectiveDelay = delayTenths / 10 / (1 + this.cfg.HASTE_PCT / 100)
    const autoWidth = Math.max(0.1, this.cfg.PUNCH_INTERVAL - effectiveDelay)
    const baseWidth = this.cfg.WEAVE_WINDOW_MS > 0
      ? Math.min(this.cfg.WEAVE_WINDOW_MS / 1000, autoWidth)
      : autoWidth
    this.cfg.GOOD_WINDOW = baseWidth / 2
  }

  private clearRapidAttackMute(): void {
    this.audioMutedRapidAttack = false
    this.consecutiveCrushesWithoutFist = 0
    this.audio.setTemporaryMute(false)
  }

  // ── Update ──────────────────────────────────────────────────
  private update(dt: number): void {
    const t = now()
    this.targetSpeed = this.runway / (4 * this.cfg.PUNCH_INTERVAL * 1000)
    if (this.speed === 0) this.speed = this.targetSpeed
    else this.speed += (this.targetSpeed - this.speed) * Math.min(1, dt * 12)

    if (this.rhythm.inCombat && this.lastCombatActivity > 0
        && t - this.lastCombatActivity > COMBAT_IDLE_TIMEOUT_MS) {
      this.postCombatGlideUntil = t + 3000
      this.postCombatNextSwing  = this.rhythm.nextSwingTime
      this.postCombatLastCrush  = this.rhythm.lastCrushTime
      this.postCombatRoundOpen  = this.rhythm.roundOpen
      const result = this.rhythm.onCombatEnd(t)
      this.audio.play('combat_end')
      this.gradeScreen = new GradeScreen(result)
      this.lastCombatActivity = 0
    }
    if (this.rhythm.swingTimerValid) this.swingTimerEverValid = true
    if (this.rhythm.inCombat && !this.rhythm.swingTimerValid
        && !this.swingTimerEverValid
        && this.combatStartTs > 0 && t - this.combatStartTs > 5000) this.resetTrack()
    if (this.audioMutedRapidAttack && t > this.rapidAttackMuteUntil) this.clearRapidAttackMute()

    this.rhythm.update(t)
    if (this.rhythm.calibrationEvent) {
      const iv           = this.rhythm.calibrationEvent.interval
      const derivedHaste = Math.max(0, (this.cfg.BASE_WEAPON_DELAY / 10 / iv - 1) * 100)
      this.cfg.HASTE_PCT      = derivedHaste
      this.cfg.PUNCH_INTERVAL = iv
      const fistDelay         = this.rhythm.effectiveOffhandDelay
      this.cfg.GOOD_WINDOW    = Math.max(0.2, iv - fistDelay) / 2
      this.hasteCalibrated = true
      this.banners.push(new Banner(`AUTO-CAL: ${iv.toFixed(2)}s  (${derivedHaste.toFixed(0)}% HASTE)`, '#ff9f44', 3000))
      this.rhythm.calibrationEvent = null
    }
    if (this.rhythm.roundEndDamage !== null) {
      if (this.rhythm.roundEndDamage > this.cfg.HUGE_ROUND_THRESHOLD && t - this.lastOhSnapTs > 1000) {
        const rd = this.rhythm.roundEndDamage
        this.audio.playFileSound('oh_snap', true)
        this.banners.push(new Banner('HUGE ROUND!!!', '#ffd700', 3000, rd.toLocaleString()))
        this.recordHit(this.topHugeRounds, rd, this.currentTarget)
        this.lastOhSnapTs = t
      }
      this.rhythm.roundEndDamage = null
    }
    // Consume the round-close flag (no longer used for display — timer below handles it)
    if (this.rhythm.dwRollFailed) this.rhythm.dwRollFailed = false

    // Timer-based DW no-roll: show indicator only after the offhand weapon had enough
    // time to swing but nothing appeared in the log.
    if (this.dwPendingTs > 0) {
      const offhandMs = this.rhythm.effectiveOffhandDelay * 1000 + this.cfg.DW_ROLL_FAIL_DELAY_MS
      if (t - this.dwPendingTs > offhandMs) {
        this.dwRollFlash = 1
        this.audio.play('dw_ok')
        this.dwPendingTs = 0
      }
    }

    this.hitFlash    = Math.max(0, this.hitFlash    - dt * 3.5)
    this.missFlash   = Math.max(0, this.missFlash   - dt * 2)
    this.clipWarn    = Math.max(0, this.clipWarn    - dt * 2)
    this.dwRollFlash = Math.max(0, this.dwRollFlash - dt * 1.2)
    this.banners = this.banners.filter(b => !b.expired)
    if (this.gradeScreen?.expired) this.gradeScreen = null

    if (t - this.dpsLastUpdate >= 1000) {
      this.dpsDisplayTotal   = Math.trunc(this.rhythm.liveTotalDps)
      this.dpsDisplayFist    = Math.trunc(this.rhythm.liveDps)
      this.dpsLastUpdate = t
    }
  }

  // ── Draw ────────────────────────────────────────────────────
  private draw(): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    ctx.clearRect(0,0,w,h)
    ctx.fillStyle = HC.bg; ctx.fillRect(0,0,w,h)

    // Top accent rule
    ctx.fillStyle = HC.accent; ctx.fillRect(0, 0, w, 2)

    this.drawHeader()
    this.drawHighwayBox()
    this.drawDynamicWeaveWindows()
    this.drawHitZone()
    this.drawMissChip()
    this.drawClipWarn()
    this.drawDwRollFail()
    this.drawOffhandSwingTimer()
    this.drawFooter()
    this.drawNoLogNotice()
    this.drawBanners()
    if (this.gradeScreen) this.drawGradeScreen(this.gradeScreen)

    // Bottom accent rule
    ctx.fillStyle = HC.accent; ctx.fillRect(0, h - 2, w, 2)
  }

  private drawNoLogNotice(): void {
    if (this.rhythm.inCombat || this.gradeScreen) return
    const t = now()
    const stale = this.logSelected && (t - this.lastLogActivityTs) > 60_000
    if (!this.logSelected || stale) {
      const line1 = this.logSelected ? 'Log not updating' : 'No log file selected'
      const line2 = this.logSelected ? 'Is EQ running?' : 'Right-click tray → Select Log'
      const pulse = (1 + Math.sin(t / 2000 * Math.PI)) / 2
      const alpha = 0.20 + pulse * 0.35
      const ctx = this.ctx
      const w = this.canvas.width
      const cy = this.highwayY + this.highwayH / 2
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '700 10px "JetBrains Mono", monospace'
      ctx.fillStyle = `rgba(220,220,220,${alpha.toFixed(3)})`
      ctx.fillText(line1, w / 2, cy - 7)
      ctx.font = '400 9px "JetBrains Mono", monospace'
      ctx.fillStyle = `rgba(180,180,180,${(alpha * 0.75).toFixed(3)})`
      ctx.fillText(line2, w / 2, cy + 7)
      ctx.textAlign = 'left'
    }
  }

  private drawOffhandSwingTimer(): void {
    if (!this.cfg.SHOW_OFFHAND_TIMER) return
    const rhy = this.rhythm
    if (!rhy.inCombat) return
    const t          = now()
    const offhandSec = rhy.effectiveOffhandDelay
    if (offhandSec <= 0) return

    const ctx  = this.ctx
    const w    = this.canvas.width
    const barH = 3
    const barY = this.highwayY + this.highwayH - barH

    ctx.fillStyle = 'rgba(0,0,0,0.6)'
    ctx.fillRect(0, barY, w, barH)

    if (this.lastFistAttackTs <= 0) return

    const elapsed  = (t - this.lastFistAttackTs) / 1000
    const fraction = Math.max(0, 1 - elapsed / offhandSec)
    if (fraction <= 0) return

    const barW = Math.max(1, Math.trunc(w * fraction))
    let color: string
    if (fraction > 0.5) {
      color = 'rgba(0,160,220,0.65)'
    } else if (fraction > 0.15) {
      color = 'rgba(0,210,255,0.80)'
    } else {
      color = 'rgba(150,245,255,0.95)'
    }

    ctx.fillStyle = color
    ctx.fillRect(0, barY, barW, barH)
  }

  private drawInnerflameBar(y: number, h: number): void {
    const frac = this.innerflameUntil > 0 ? Math.max(0, (this.innerflameUntil - now()) / 12000) : 0
    if (frac <= 0) return
    const w = this.canvas.width
    const alpha = 0.65 + frac * 0.30
    this.ctx.fillStyle = `rgba(232,144,32,${alpha.toFixed(2)})`
    this.ctx.fillRect(0, y, Math.trunc(w * frac), h)
  }

  private drawWhirlwindBar(y: number, h: number): void {
    const frac = this.whirlwindUntil > 0 ? Math.max(0, (this.whirlwindUntil - now()) / 12000) : 0
    if (frac <= 0) return
    const w = this.canvas.width
    const alpha = 0.65 + frac * 0.30
    this.ctx.fillStyle = `rgba(192,132,252,${alpha.toFixed(2)})`
    this.ctx.fillRect(0, y, Math.trunc(w * frac), h)
  }

  private drawHeader(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    ctx.textBaseline = 'alphabetic'

    // Character name — bold condensed
    ctx.font = '800 15px "Archivo Narrow", "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    let nx = 10
    for (const ch of (this.charName || '—').toUpperCase()) {
      ctx.fillText(ch, nx, 20)
      nx += ctx.measureText(ch).width + 1.5
    }

    // Phase chip — start after the name, with a minimum gap
    const chipX = Math.max(86, Math.ceil(nx) + 8)
    const phase = this.rhythm.inCombat ? 'COMBAT' : this.gradeScreen ? 'RESULT' : 'IDLE'
    const color = phase === 'COMBAT' ? HC.combat : phase === 'RESULT' ? HC.result : HC.idle
    ctx.fillStyle = color
    ctx.fillRect(chipX, 8, 68, 16)
    ctx.font = '800 10px "Archivo", sans-serif'
    ctx.fillStyle = color === HC.result ? '#000' : '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(phase, chipX + 34, 20)
    ctx.textAlign = 'left'

    // Buff indicators (Avatar, Savagery)
    let buffX = chipX + 68 + 6
    ctx.font = '800 9px "Archivo", sans-serif'
    if (this.avatarActive) {
      ctx.fillStyle = '#a855f7'
      ctx.fillRect(buffX, 8, 32, 16)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.fillText('AVT', buffX + 16, 20)
      ctx.textAlign = 'left'
      buffX += 36
    }
    if (this.savageryActive) {
      ctx.fillStyle = '#f97316'
      ctx.fillRect(buffX, 8, 32, 16)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.fillText('SAV', buffX + 16, 20)
      ctx.textAlign = 'left'
      buffX += 36
    }
    if (this.innerflameUntil > 0 && now() < this.innerflameUntil) {
      const label = 'INNERFLAME'
      ctx.font = '800 9px "Archivo", sans-serif'
      const lw = ctx.measureText(label).width + 10
      ctx.fillStyle = '#e89020'
      ctx.fillRect(buffX, 8, lw, 16)
      ctx.fillStyle = '#000'
      ctx.textAlign = 'center'
      ctx.fillText(label, buffX + lw / 2, 20)
      ctx.textAlign = 'left'
      buffX += lw + 4
    }
    if (this.whirlwindUntil > 0 && now() < this.whirlwindUntil) {
      const label = 'WHIRLWIND'
      ctx.font = '800 9px "Archivo", sans-serif'
      const lw = ctx.measureText(label).width + 10
      ctx.fillStyle = '#c084fc'
      ctx.fillRect(buffX, 8, lw, 16)
      ctx.fillStyle = '#000'
      ctx.textAlign = 'center'
      ctx.fillText(label, buffX + lw / 2, 20)
      ctx.textAlign = 'left'
    }

    // Stats right
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.textAlign = 'right'
    ctx.fillText(`${this.cfg.PUNCH_INTERVAL.toFixed(2)}s`, w - 60, 20)
    ctx.fillStyle = this.hasteCalibrated ? '#ff9f44' : HC.accent
    ctx.fillText(`${this.cfg.HASTE_PCT.toFixed(0)}%`, w - 10, 20)
    ctx.textAlign = 'left'

    this.drawInnerflameBar(27, 3)
    this.drawWhirlwindBar(24, 3)
  }

  private drawHighwayBox(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    ctx.strokeStyle = HC.text; ctx.lineWidth = 2
    ctx.strokeRect(4, this.highwayY, w - 8, this.highwayH)
  }

  private drawDynamicWeaveWindows(): void {
    const t = now()
    const gliding = !this.rhythm.inCombat && t < this.postCombatGlideUntil
    if (!this.rhythm.inCombat && !gliding) return
    const ctx = this.ctx
    const intervalMs = this.cfg.PUNCH_INTERVAL * 1000
    const offhandMs  = this.rhythm.effectiveOffhandDelay * 1000
    const weaveMs    = this.cfg.WEAVE_WINDOW_MS > 0
      ? this.cfg.WEAVE_WINDOW_MS
      : Math.max(50, (this.cfg.PUNCH_INTERVAL - this.rhythm.effectiveOffhandDelay) * 1000)

    const nextSwing = gliding
      ? (this.postCombatRoundOpen ? this.postCombatLastCrush + intervalMs : this.postCombatNextSwing)
      : (this.rhythm.roundOpen    ? this.rhythm.lastCrushTime + intervalMs : this.rhythm.nextSwingTime)
    if (nextSwing <= 0) return

    let firstSwing = nextSwing
    while (firstSwing - intervalMs > t - intervalMs) firstSwing -= intervalMs

    const offhandReadyTs = this.lastFistAttackTs > 0
      ? this.lastFistAttackTs + offhandMs
      : 0
    const nextReady  = offhandReadyTs > 0 ? offhandReadyTs : t - 1
    const orderSet   = this.lastFistAttackTs > 0

    const vert = this.cfg.ORIENTATION === 'vertical'
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH
    ctx.save()
    ctx.beginPath()
    if (!vert) ctx.rect(5, hy, w - 10, hh)
    else        ctx.rect(0, hy + 1, w, hh - 2)
    ctx.clip()

    // Static mode: draw green windows for all visible swings, no red zones
    if (!this.cfg.DYNAMIC_WEAVING) {
      for (let k = 0; k < 30; k++) {
        const swingTime = firstSwing + k * intervalMs
        const safeEnd   = swingTime + weaveMs
        const [sx, sy]  = this.projectAt(swingTime, t)
        if (!vert) {
          if (sx > w) break
          if (sx < -10) continue
          ctx.fillStyle = `${HC.swingBar}0.85)`
          ctx.fillRect(sx - 2, hy + 2, 5, hh - 4)
          const [sfx] = this.projectAt(safeEnd, t)
          if (sfx > sx) {
            const gw = Math.max(3, sfx - sx)
            ctx.fillStyle   = `${HC.weaveFill}0.85)`
            ctx.fillRect(sx, hy + 6, gw, hh - 12)
            ctx.strokeStyle = `${HC.weaveStrk}1.0)`
            ctx.lineWidth = 1.5
            ctx.strokeRect(sx + 0.5, hy + 6.5, gw - 1, hh - 13)
          }
        } else {
          if (sy < hy) break
          if (sy > hy + hh + 10) continue
          ctx.fillStyle = `${HC.swingBar}0.85)`
          ctx.fillRect(6, sy - 2, w - 12, 5)
          const [, sfy] = this.projectAt(safeEnd, t)
          if (sfy < sy) {
            const gh = Math.max(3, sy - sfy)
            ctx.fillStyle   = `${HC.weaveFill}0.85)`
            ctx.fillRect(8, sfy, w - 16, gh)
            ctx.strokeStyle = `${HC.weaveStrk}1.0)`
            ctx.lineWidth = 1.5
            ctx.strokeRect(8 + 0.5, sfy + 0.5, w - 17, gh - 1)
          }
        }
      }
      ctx.restore()
      return
    }

    // Orange markers: draw every visible swing so they fill the track.
    // Weave windows: draw the next eligible window + anticipated 2nd-round window.
    let windowsDrawn = 0
    let projectedNextReady = nextReady  // projected offhand ready time for window lookahead

    for (let k = 0; k < 30; k++) {
      const swingTime = firstSwing + k * intervalMs
      const safeEnd   = swingTime + weaveMs    // deadline to punch and stay ready for next swing
      const windowEnd = swingTime + intervalMs  // full window extent = next mainhand swing
      const winStart  = this.cfg.WEAVE_WINDOW_MS > 0 ? swingTime : Math.max(swingTime, projectedNextReady)

      const [sx, sy] = this.projectAt(swingTime, t)

      if (!vert) {
        if (sx > w) break
        if (sx < -10) continue

        ctx.fillStyle = `${HC.swingBar}0.85)`
        ctx.fillRect(sx - 2, hy + 2, 5, hh - 4)

        if (windowsDrawn < 2 && winStart < windowEnd) {
          const isAnticipated = windowsDrawn === 1
          if (isAnticipated) ctx.globalAlpha = 0.45

          const [wx  ] = this.projectAt(winStart,  t)
          const [sfx ] = this.projectAt(safeEnd,   t)
          const [wndx] = this.projectAt(windowEnd, t)
          const hasWait = projectedNextReady > swingTime

          // Wait zone
          if (hasWait) {
            const waitW = Math.max(0, wx - sx)
            if (waitW > 0) {
              ctx.fillStyle = 'rgba(80,100,180,0.28)'
              ctx.fillRect(sx, hy + 6, waitW, hh - 12)
            }
          }

          // Green safe zone (winStart → safeEnd)
          if (winStart < safeEnd) {
            const greenW = Math.max(3, sfx - wx)
            ctx.fillStyle   = `${HC.weaveFill}0.85)`
            ctx.fillRect(wx, hy + 6, greenW, hh - 12)
            ctx.strokeStyle = `${HC.weaveStrk}1.0)`
            ctx.lineWidth = 1.5
            ctx.strokeRect(wx + 0.5, hy + 6.5, greenW - 1, hh - 13)
          }

          // Discouraged zone (safeEnd → windowEnd)
          if (orderSet) {
            const discW = Math.max(2, wndx - sfx)
            ctx.fillStyle   = 'rgba(200,40,20,0.30)'
            ctx.fillRect(sfx, hy + 6, discW, hh - 12)
            ctx.strokeStyle = 'rgba(255,60,40,0.60)'
            ctx.lineWidth = 1.5
            ctx.strokeRect(sfx + 0.5, hy + 6.5, discW - 1, hh - 13)
          }

          // Cyan ready-line
          if (hasWait && wx > sx && wx < sfx) {
            ctx.strokeStyle = 'rgba(80,220,255,0.95)'
            ctx.lineWidth = 2
            ctx.beginPath(); ctx.moveTo(wx, hy + 2); ctx.lineTo(wx, hy + hh - 2); ctx.stroke()
          }

          if (isAnticipated) ctx.globalAlpha = 1.0
          if (winStart < safeEnd) projectedNextReady = winStart + offhandMs
          windowsDrawn++
        }
      } else {
        if (sy < hy) break
        if (sy > hy + hh + 10) continue

        ctx.fillStyle = `${HC.swingBar}0.85)`
        ctx.fillRect(6, sy - 2, w - 12, 5)

        if (windowsDrawn < 2 && winStart < windowEnd) {
          const isAnticipated = windowsDrawn === 1
          if (isAnticipated) ctx.globalAlpha = 0.45

          const [, wy  ] = this.projectAt(winStart,  t)
          const [, sfy ] = this.projectAt(safeEnd,   t)
          const [, wndy] = this.projectAt(windowEnd, t)
          const hasWait = projectedNextReady > swingTime

          // Wait zone
          if (hasWait) {
            const waitH = Math.max(0, sy - wy)
            if (waitH > 0) {
              ctx.fillStyle = 'rgba(80,100,180,0.28)'
              ctx.fillRect(8, wy, w - 16, waitH)
            }
          }

          // Green safe zone (winStart → safeEnd)
          if (winStart < safeEnd) {
            const greenH = Math.max(3, wy - sfy)
            ctx.fillStyle   = `${HC.weaveFill}0.85)`
            ctx.fillRect(8, sfy, w - 16, greenH)
            ctx.strokeStyle = `${HC.weaveStrk}1.0)`
            ctx.lineWidth = 1.5
            ctx.strokeRect(8 + 0.5, sfy + 0.5, w - 17, greenH - 1)
          }

          // Discouraged zone (safeEnd → windowEnd)
          if (orderSet) {
            const discH = Math.max(2, sfy - wndy)
            ctx.fillStyle   = 'rgba(200,40,20,0.30)'
            ctx.fillRect(8, wndy, w - 16, discH)
            ctx.strokeStyle = 'rgba(255,60,40,0.60)'
            ctx.lineWidth = 1.5
            ctx.strokeRect(8 + 0.5, wndy + 0.5, w - 17, discH - 1)
          }

          // Cyan ready-line
          if (hasWait && wy < sy && wy > sfy) {
            ctx.strokeStyle = 'rgba(80,220,255,0.95)'
            ctx.lineWidth = 2
            ctx.beginPath(); ctx.moveTo(6, wy); ctx.lineTo(w - 6, wy); ctx.stroke()
          }

          if (isAnticipated) ctx.globalAlpha = 1.0
          if (winStart < safeEnd) projectedNextReady = winStart + offhandMs
          windowsDrawn++
        }
      }
    }
    ctx.restore()
  }

  private drawWeaveWindows(): void {
    if (!this.rhythm.inCombat || !this.rhythm.swingTimerValid) return
    const ctx = this.ctx
    const t = now()
    const intervalMs = this.cfg.PUNCH_INTERVAL * 1000
    const offhand    = this.rhythm.effectiveOffhandDelay
    const weaveSec   = Math.max(0.05, this.cfg.PUNCH_INTERVAL - offhand)

    const fillsA = [0.85, 0.45, 0.20]
    const strokesA = [1, 0.55, 0.25]
    const orangeA = [1, 0.6, 0.3]

    const nextSwing = this.rhythm.roundOpen
      ? this.rhythm.lastCrushTime + intervalMs
      : this.rhythm.nextSwingTime
    let firstSwing = nextSwing
    while (firstSwing - intervalMs > t - intervalMs) firstSwing -= intervalMs

    const vert = this.cfg.ORIENTATION === 'vertical'
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH

    // Clip to the highway interior so windows and swing bars vanish cleanly at the left wall
    ctx.save()
    ctx.beginPath()
    if (!vert) {
      ctx.rect(5, hy, w - 10, hh)
    } else {
      ctx.rect(0, hy + 1, w, hh - 2)
    }
    ctx.clip()

    let rank = 0
    for (let k = 0; rank < 3 && k < 12; k++) {
      const swingTime = firstSwing + k * intervalMs
      const weaveEnd  = swingTime + weaveSec * 1000
      const [x1, y1] = this.projectAt(swingTime, t)
      const [x2, y2] = this.projectAt(weaveEnd, t)

      if (!vert) {
        if (x1 > w) break
        if (x2 < 5) continue
        const drawW = Math.max(3, x2 - x1)
        ctx.fillStyle   = `${HC.weaveFill}${fillsA[rank]})`
        ctx.fillRect(x1, hy + 6, drawW, hh - 12)
        ctx.strokeStyle = `${HC.weaveStrk}${strokesA[rank]})`
        ctx.lineWidth = 1.5
        ctx.strokeRect(x1 + 0.5, hy + 6.5, drawW - 1, hh - 13)
        ctx.fillStyle = `${HC.swingBar}${orangeA[rank]})`
        ctx.fillRect(x1 - 2, hy + 2, 5, hh - 4)
      } else {
        if (y1 < hy) break
        if (y2 > hy + hh) continue
        const bh = Math.max(3, y1 - y2)
        ctx.fillStyle   = `${HC.weaveFill}${fillsA[rank]})`
        ctx.fillRect(8, y2, w - 16, bh)
        ctx.strokeStyle = `${HC.weaveStrk}${strokesA[rank]})`
        ctx.lineWidth = 1.5
        ctx.strokeRect(8 + 0.5, y2 + 0.5, w - 17, bh - 1)
        ctx.fillStyle = `${HC.swingBar}${orangeA[rank]})`
        ctx.fillRect(6, y1 - 2, w - 12, 5)
      }
      rank++
    }
    ctx.restore()
  }

  private drawCountdownBar(): void {
    if (!this.rhythm.inCombat) return
    const ctx = this.ctx
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH
    const intervalMs = this.cfg.PUNCH_INTERVAL * 1000
    const nextSwing = this.rhythm.nextSwingTime
    const timeToSwing = Math.max(0, nextSwing - now())
    const frac = 1 - Math.min(1, timeToSwing / intervalMs)
    const barY = hy + hh + 4, barX = 6, barW = w - 12, barH = 4
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(barX, barY, barW, barH)
    ctx.fillStyle = '#00d8ff'; ctx.fillRect(barX, barY, barW * frac, barH)
  }

  private drawHitZone(): void {
    const ctx = this.ctx
    const [hzx, hzy] = this.hzCenter()
    const hy = this.highwayY, hh = this.highwayH
    const w = this.canvas.width

    if (this.cfg.ORIENTATION === 'horizontal') {
      // Thick yellow bar
      ctx.fillStyle = HC.accent
      ctx.fillRect(hzx - 2, hy, 4, hh)
      ctx.fillRect(hzx - 6, hy - 2, 12, 4)
      ctx.fillRect(hzx - 6, hy + hh - 2, 12, 4)

      // Flash burst across highway when a weave lands
      if (this.hitFlash > 0) {
        ctx.fillStyle = `rgba(255,238,0,${this.hitFlash * 0.25})`
        ctx.fillRect(4, hy, w - 8, hh)
        ctx.strokeStyle = `rgba(255,255,255,${this.hitFlash})`
        ctx.lineWidth = 2
        ctx.strokeRect(hzx - 6, hy + 2, 12, hh - 4)
      }
    } else {
      ctx.fillStyle = HC.accent
      ctx.fillRect(4, hzy - 2, w - 8, 4)
      ctx.fillRect(4, hzy - 6, 4, 12)
      ctx.fillRect(w - 8, hzy - 6, 4, 12)
      if (this.hitFlash > 0) {
        ctx.fillStyle = `rgba(255,238,0,${this.hitFlash * 0.25})`
        ctx.fillRect(4, hy, w - 8, hh)
      }
    }
  }

  private drawMissChip(): void {
    if (this.missFlash <= 0) return
    const ctx = this.ctx
    const hy = this.highwayY
    const [hzx, hzy] = this.hzCenter()
    const chipW = 52, chipH = 12
    if (this.cfg.ORIENTATION === 'horizontal') {
      const cx = hzx - chipW / 2
      ctx.fillStyle = `${HC.missChip}${this.missFlash})`
      ctx.fillRect(cx, hy - chipH - 2, chipW, chipH)
      ctx.font = '700 9px "Archivo", sans-serif'
      ctx.fillStyle = `${HC.missText}${this.missFlash})`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('— MISS', hzx, hy - chipH / 2 - 2)
    } else {
      const cy = hzy - chipH / 2
      const w = this.canvas.width
      ctx.fillStyle = `${HC.missChip}${this.missFlash})`
      ctx.fillRect(w - chipW - 4, cy, chipW, chipH)
      ctx.font = '700 9px "Archivo", sans-serif'
      ctx.fillStyle = `${HC.missText}${this.missFlash})`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('— MISS', w - chipW / 2 - 4, hzy)
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  }

  private drawClipWarn(): void {
    if (this.clipWarn <= 0) return
    const ctx = this.ctx
    const w = this.canvas.width
    const [hzx, hzy] = this.hzCenter()
    const hy = this.highwayY, hh = this.highwayH

    ctx.fillStyle = `${HC.clipWash}${this.clipWarn * 0.32})`
    ctx.fillRect(4, hy, w - 8, hh)
    ctx.strokeStyle = `rgba(255,60,60,${this.clipWarn})`
    ctx.lineWidth = 2
    ctx.strokeRect(4, hy, w - 8, hh)

    if (this.cfg.ORIENTATION === 'horizontal') {
      ctx.fillStyle = `${HC.clipChip}${this.clipWarn})`
      ctx.fillRect(hzx - 3, hy, 6, hh)
      ctx.fillRect(hzx - 7, hy - 2, 14, 4)
      ctx.fillRect(hzx - 7, hy + hh - 2, 14, 4)
      ctx.fillRect(w - 80, hy - 11, 70, 12)
    } else {
      ctx.fillStyle = `${HC.clipChip}${this.clipWarn})`
      ctx.fillRect(4, hzy - 3, w - 8, 6)
      ctx.fillRect(w - 80, hy - 11, 70, 12)
    }
    ctx.font = '800 9px "Archivo", sans-serif'
    ctx.fillStyle = '#000'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('CLIPPED', w - 45, hy - 5)
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  }

  private drawDwRollFail(): void {
    if (this.dwRollFlash <= 0) return
    const ctx = this.ctx
    const [hzx, hzy] = this.hzCenter()
    const hy = this.highwayY, hh = this.highwayH
    // Amber expanding ring
    ctx.strokeStyle = `rgba(255,160,0,${this.dwRollFlash * 0.9})`
    ctx.lineWidth = 2
    const rr = 6 + (1 - this.dwRollFlash) * 20
    ctx.beginPath(); ctx.arc(hzx, hzy, rr, 0, Math.PI * 2); ctx.stroke()
    // Solid chip above the highway, same position as miss chip but amber
    const chipW = 64, chipH = 12
    if (this.cfg.ORIENTATION === 'horizontal') {
      ctx.fillStyle = `rgba(255,140,0,${this.dwRollFlash * 0.5})`
      ctx.fillRect(hzx - chipW / 2, hy - chipH - 2, chipW, chipH)
      ctx.font = '700 9px "Archivo", sans-serif'
      ctx.fillStyle = `rgba(255,200,0,${this.dwRollFlash})`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('DW NO ROLL', hzx, hy - chipH / 2 - 2)
    } else {
      const w = this.canvas.width
      ctx.fillStyle = `rgba(255,140,0,${this.dwRollFlash * 0.5})`
      ctx.fillRect(w - chipW - 4, hzy - chipH / 2, chipW, chipH)
      ctx.font = '700 9px "Archivo", sans-serif'
      ctx.fillStyle = `rgba(255,200,0,${this.dwRollFlash})`
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText('DW NO ROLL', w - chipW / 2 - 4, hzy)
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
  }

  private drawFooter(): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    ctx.textBaseline = 'alphabetic'

    this.drawInnerflameBar(h - 30, 3)
    this.drawWhirlwindBar(h - 33, 3)

    // WEAVES
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText('WEAVES', 10, h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.fillText(`${this.rhythm.inCombat ? this.rhythm.roundsWithWeave : 0}`, 10, h - 5)

    // NET DPS
    ctx.textAlign = 'center'
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText('NET DPS', w / 2, h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.fillText(`${this.dpsDisplayTotal}`, w / 2, h - 5)

    // WEAVE DPS — orange
    ctx.textAlign = 'right'
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText('WEAVE', w - 10, h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.weaveDps
    ctx.fillText(`+${this.dpsDisplayFist}`, w - 10, h - 5)
    ctx.textAlign = 'left'
  }

  private drawBanners(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    let y = this.highwayY + 14
    for (const b of this.banners) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = '800 11px "Archivo", sans-serif'
      ctx.fillStyle = this.rgba(b.color, b.alpha)
      ctx.fillText(b.text, w / 2, y)
      y += 14
      if (b.bigNumber) {
        ctx.font = '800 36px "Archivo Narrow", "Archivo", sans-serif'
        ctx.fillStyle = this.rgba(b.color, b.alpha)
        ctx.fillText(b.bigNumber, w / 2, y + 18)
        y += 42
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    }
  }

  private drawGradeScreen(gs: GradeScreen): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    const a = gs.alpha
    if (a <= 0) return
    const g = gs.result
    ctx.fillStyle = `rgba(0,0,0,${0.95 * a})`; ctx.fillRect(0, 0, w, h)

    const colors: Record<string,string> = { S:'#ffd700', A:'#78ff78', B:'#50b4ff', C:'#ffc850', D:'#c87850', F:'#b43c3c' }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = '800 56px "Archivo Narrow", "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(colors[g.grade] || '#fff', a)
    ctx.fillText(g.grade, 48, h / 2)

    ctx.textAlign = 'left'
    ctx.font = '800 14px "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.text, a)
    const weaved = (g as any).keystrokeGrading ? (g as any).keystrokeRoundsWeaved : (g as any).roundsWeaved
    ctx.fillText(`${weaved}/${(g as any).totalRounds} WEAVES LANDED`, 96, h / 2 - 22)
    ctx.font = '600 12px "Archivo", sans-serif'
    ctx.fillText(`NET ${Math.round((g as any).totalDps ?? 0)} DPS`, 96, h / 2 - 4)
    ctx.fillStyle = this.rgba(HC.weaveDps, a)
    ctx.fillText(`+${Math.round(g.addedDps)} FROM WEAVING`, 96, h / 2 + 14)
    ctx.fillStyle = this.rgba(HC.textDim, a)
    ctx.font = '600 10px "Archivo", sans-serif'
    const r = (g as any).avgReactionMs
    ctx.fillText(`${r != null ? Math.round(r) : '—'} MS AVG REACTION`, 96, h / 2 + 30)

    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.accent, a)
    ctx.textAlign = 'right'
    ctx.fillText('[ V ] COPY  ·  [ SPACE ] DISMISS', w - 10, h - 10)
    ctx.textAlign = 'left'
  }

  private rgba(hex: string, a: number): string {
    if (hex.startsWith('rgba')) return hex
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${a.toFixed(3)})`
  }
}

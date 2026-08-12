/**
 * Basketweaver overlay — REFINED ARCADE style.
 *
 * Drop-in replacement for src/renderer/overlay.ts. Renders the dark/rhythm-game
 * look with cleaner type, subtler grid, tighter header, soft-miss feedback,
 * and the existing harsh CLIPPED feedback when the player swings through a
 * weave window.
 *
 * Same public API as the existing Overlay class:
 *   new RefinedOverlay(canvas).start()
 *   overlay.handleGameEvent(ev)
 *   overlay.handleKey(key)
 *   overlay.toggleOrientation() / toggleHighContrast() / etc.
 */

import { Config, type ConfigType } from '../shared/config'
import { EvType, type GameEvent, type HitRecord } from '../shared/events'
import { RhythmEngine, type GradeResult } from './rhythm-engine'
import { AudioManager } from './audio-manager'
import type { EncounterRecord } from '../shared/leaderboard-types'
import { BackstabTimer } from './backstab-timer'

// ── Tuning constants ──────────────────────────────────────────
const COMBAT_IDLE_TIMEOUT_MS = 10_000
const HEADER_H = 24
const FOOTER_H = 24
const HZ_X      = 80          // hit-zone x in horizontal mode
const RUNWAY_PX = 392         // visible runway from hit zone

// Refined Arcade palette
const PAL = {
  bg:           '#0b0d17',
  highway:      '#10132a',
  headerFooter: '#0e1020',
  divider:      '#1a1e38',
  text:         '#d8dbf0',
  textDim:      '#8189a8',
  textVeryDim:  '#596080',
  hitZone:      '#ffc828',
  hitFlash:     '#ffe678',
  weaveFill:    'rgba(90,235,150,',   // append "<a>)"
  weaveStroke:  'rgba(160,255,200,',
  swingBar:     'rgba(255,140,30,',
  combat:       '#ff7d3b',
  result:       '#ffd700',
  idle:         '#596080',
  weaveText:    '#ff9d3b',
  missText:     'rgba(135,143,170,',
  clipText:     'rgba(255,140,140,',
  clipWash:     'rgba(255,60,60,',
  centerLine:   '#232a55',
}

const now = () => performance.now()

// ── Tiny animation objects ───────────────────────────────────
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

interface RogueSummaryResult {
  mobName: string
  fightDuration: number  // ms
  netDps: number
  backstabDps: number
  hits: number
  misses: number
}

class RogueSummaryScreen {
  static FADE_IN = 400; static HOLD = 5000; static FADE_OUT = 500
  result: RogueSummaryResult; born = now()
  constructor(result: RogueSummaryResult) { this.result = result }
  get alpha() {
    const age = now() - this.born
    const total = RogueSummaryScreen.FADE_IN + RogueSummaryScreen.HOLD + RogueSummaryScreen.FADE_OUT
    if (age < RogueSummaryScreen.FADE_IN) return age / RogueSummaryScreen.FADE_IN
    if (age > total) return 0
    const rem = total - age
    if (rem < RogueSummaryScreen.FADE_OUT) return rem / RogueSummaryScreen.FADE_OUT
    return 1
  }
  get expired() {
    const age = now() - this.born
    return age > RogueSummaryScreen.FADE_IN + RogueSummaryScreen.HOLD + RogueSummaryScreen.FADE_OUT
  }
}

interface Particle { x:number; y:number; vx:number; vy:number; life:number; ttl:number; size:number }

// ── Main class ────────────────────────────────────────────────
export class RefinedOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cfg: ConfigType
  private rhythm: RhythmEngine
  readonly audio: AudioManager

  private hzX = HZ_X
  private hzY = 0
  private runway = RUNWAY_PX
  private highwayY = HEADER_H
  private highwayH = 0
  private speed = 0; private targetSpeed = 0

  // Visual state
  private hitFlash = 0
  private missFlash = 0       // soft "—" chip when a weave passes unused
  private clipWarn = 0        // harsh red wash on actual clip
  private dwRollFlash = 0     // DW roll failure: keystroke in window, no fist in log
  private dwPendingTs = 0    // timestamp when weave key landed in window; cleared by fist or timer
  private particles: Particle[] = []
  private banners: Banner[] = []
  private gradeScreen: GradeScreen | null = null
  private lastGradeResult: import('./rhythm-engine').GradeResult | null = null
  private fightHistory: GradeResult[] = []
  // ── Rogue Mode ────────────────────────────────────────────────
  private backstab: BackstabTimer
  private rogueInCombat = false
  private rogueFightStartTs = 0
  private rogueDamageTotal = 0
  private rogueBackstabDamageTotal = 0
  private rogueBackstabHits = 0
  private rogueBackstabMisses = 0
  private rogueSummaryScreen: RogueSummaryScreen | null = null
  private dpsDisplayTotal   = 0
  private dpsDisplayFist    = 0
  private dpsLastUpdate     = 0
  private lastFrameTime = 0
  private lastOhSnapTs = 0
  private lastCombatActivity = 0
  private combatStartTs = 0
  private swingTimerEverValid = false
  private lastFistHitTs = 0
  private lastFistAttackTs = 0
  private hasteCalibrated = false  // true when haste% was derived from measured swings, not /mystats
  private oorLastSoundTs = 0
  private consecutiveCrushesWithoutFist = 0
  private audioMutedRapidAttack = false
  // ── Fist-only / swing-timer mode ─────────────────────────────
  /** True when the player is punching without any detected mainhand weapon swings.
   *  Audio is silenced and fist timing drives the swing timer instead. */
  private fistOnlyMode = false
  private combatFistCount  = 0   // fist attempts since combat start
  private combatCrushCount = 0   // mainhand crush events since combat start
  private static readonly FIST_ONLY_THRESHOLD = 5  // fist attempts before declaring fist-only
  private rapidAttackMuteUntil = 0
  private static readonly RAPID_CRUSH_THRESHOLD = 4
  private static readonly RAPID_MUTE_MS = 6000
  avatarActive = false
  savageryActive = false
  private weaveBandolierActive = false
  private lastKnownMainhand = ''
  private lastKnownAtkRating = 0
  private avatarFightMs = 0;     private avatarFightStart:      number | null = null
  private savageryFightMs = 0;   private savageryFightStart:    number | null = null
  private innerflameFlightMs = 0; private innerflameFlightStart: number | null = null
  private innerflameUntil  = 0   // performance.now() expiry; 0 = inactive
  private whirlwindUntil   = 0   // performance.now() expiry; 0 = inactive
  // ── Time-weighted average haste% across the fight ─────────────
  // Haste can change mid-fight (clicky, disc, or auto-calibration correcting a
  // wrong initial read) — track how long each value held so the displayed and
  // leaderboard-reported haste% reflect the whole fight, not just the latest value.
  private hasteFightWeightedMs = 0
  private hasteSegStart: number | null = null
  private hasteSegValue = 0

  pinned = true
  charName = ''
  logSelected = false
  private lastLogActivityTs = 0  // updated on log-selected or any game event
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
    this.backstab = new BackstabTimer(this.cfg.ROGUE_SWAP_WARN_MS)
    this.computeLayout()
  }

  get inCombat(): boolean { return this.cfg.ROGUE_MODE_ENABLED ? this.rogueInCombat : this.rhythm.inCombat }

  // ── Public lifecycle ────────────────────────────────────────
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
  private resizeCanvas(): void {
    const [w, h] = this.windowSize()
    this.canvas.width = w; this.canvas.height = h
  }
  private windowSize(): [number, number] {
    if (this.cfg.ORIENTATION === 'vertical')
      return [this.cfg.VERT_WINDOW_WIDTH, this.cfg.VERT_WINDOW_HEIGHT]
    return [this.cfg.WINDOW_WIDTH, this.cfg.WINDOW_HEIGHT]
  }
  private computeLayout(): void {
    const [w, h] = this.windowSize()
    this.highwayY = HEADER_H
    this.highwayH = h - HEADER_H - FOOTER_H
    if (this.cfg.ORIENTATION === 'horizontal') {
      this.hzX = Math.max(10, Math.trunc(w * this.cfg.TARGET_POSITION_PCT / 100))
      this.hzY = 0
      this.runway = w - this.hzX - 8
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

  // ── IPC entry ───────────────────────────────────────────────
  handleGameEvent(ev: GameEvent): void {
    this.lastLogActivityTs = now()
    const ts = ev.ts
    switch (ev.type) {
      case EvType.COMBAT_START:
        if (this.cfg.ROGUE_MODE_ENABLED) {
          if (!this.rogueInCombat) {
            this.rogueInCombat = true
            this.rogueFightStartTs = now()
            this.rogueDamageTotal = 0
            this.rogueBackstabDamageTotal = 0
            this.rogueBackstabHits = 0
            this.rogueBackstabMisses = 0
            this.backstab.onCombatStart()
            this.audio.play('combat_start')
            this.rogueSummaryScreen = null
            this.combatStartTs = now()
          }
          this.lastCombatActivity = ts
          break
        }
        if (!this.rhythm.inCombat) {
          this.postCombatGlideUntil = 0
          this.fistOnlyMode = false
          this.combatFistCount = 0
          this.combatCrushCount = 0
          this.rhythm.onCombatStart(now())
          this.audio.play('combat_start')
          this.gradeScreen = null
          this.clearRapidAttackMute()
          this.combatStartTs = now()
          this.swingTimerEverValid = false
          this.dpsDisplayTotal = 0; this.dpsDisplayFist = 0; this.dpsLastUpdate = 0
          const t0 = now()
          this.avatarFightMs = 0;      this.avatarFightStart      = this.avatarActive          ? t0 : null
          this.savageryFightMs = 0;    this.savageryFightStart    = this.savageryActive         ? t0 : null
          this.innerflameFlightMs = 0; this.innerflameFlightStart = this.innerflameUntil > t0  ? t0 : null
          this.hasteFightWeightedMs = 0; this.hasteSegStart = t0; this.hasteSegValue = this.cfg.HASTE_PCT
          // Re-seed disciplinesUsed for any disc already active when combat starts
          // (resetScore cleared the set; BUFF_CHANGED fired before first swing)
          if (this.innerflameUntil > t0) this.rhythm.disciplinesUsed.add('innerflame')
          if (this.whirlwindUntil  > t0) this.rhythm.disciplinesUsed.add('whirlwind')
        }
        this.lastCombatActivity = ts
        break
      case EvType.MOB_DIED: {
        if (this.cfg.ROGUE_MODE_ENABLED) {
          if (this.rogueInCombat) {
            this.finishRogueFight((ev.data?.mobName as string) ?? '')
          }
          break
        }
        if (this.rhythm.inCombat) {
          this.postCombatGlideUntil = now() + 3000
          this.postCombatNextSwing  = this.rhythm.nextSwingTime
          this.postCombatLastCrush  = this.rhythm.lastCrushTime
          this.postCombatRoundOpen  = this.rhythm.roundOpen
          const result = this.rhythm.onCombatEnd(ts)
          result.mobName = (ev.data?.mobName as string) ?? ''
          this.audio.play('combat_end')
          this.lastGradeResult = result
          this.pushHistory(result)
          this.sendLeaderboardRecord(result)
          this.gradeScreen = new GradeScreen(result)
        }
        this.clearRapidAttackMute()
        break
      }
      case EvType.COMBAT_END:
        if (this.cfg.ROGUE_MODE_ENABLED) {
          if (this.rogueInCombat) {
            this.rogueInCombat = false
            this.backstab.onCombatEnd()
          }
          break
        }
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
        const crushTs = now()
        const damage = (ev.data?.damage as number) ?? 0
        const hit    = (ev.data?.hit    as boolean) ?? false
        if (ev.data?.target) this.currentTarget = ev.data.target as string
        this.combatCrushCount++
        if (this.fistOnlyMode) {
          // Weapon detected mid-fight — exit swing-timer mode
          this.fistOnlyMode = false
          this.banners.push(new Banner('Weapon detected — weave mode', PAL.weaveText, 3000))
        }
        // Resume if combat ended spuriously mid-fight (preserves damage stats)
        if (!this.rhythm.inCombat) {
          this.postCombatGlideUntil = 0
          this.rhythm.resumeCombat(crushTs)
        }
        // A mainhand hit means the player is back in range — close any open OOR period
        this.rhythm.onReturnInRange(crushTs)
        this.rhythm.onMainhandCrush(crushTs, damage, hit, this.weaveBandolierActive)
        this.lastCombatActivity = crushTs
        this.consecutiveCrushesWithoutFist++
        if (this.consecutiveCrushesWithoutFist >= RefinedOverlay.RAPID_CRUSH_THRESHOLD) {
          this.audioMutedRapidAttack = true
          this.rapidAttackMuteUntil = crushTs + RefinedOverlay.RAPID_MUTE_MS
          this.audio.setTemporaryMute(true)
        }
        this.audio.playForce('crush')
        this.oorLastSoundTs = 0
        break
      }
      case EvType.FIST_ATTACK: {
        const fistNow = now()
        const damage  = (ev.data?.damage as number)  ?? 0
        const hit     = (ev.data?.hit    as boolean) ?? false
        this.lastCombatActivity = ts
        this.lastFistAttackTs = fistNow

        // ── Fist-only / swing-timer detection ──────────────────
        if (this.combatCrushCount === 0) this.combatFistCount++
        if (!this.fistOnlyMode && this.combatCrushCount === 0
            && this.combatFistCount >= RefinedOverlay.FIST_ONLY_THRESHOLD) {
          this.fistOnlyMode = true
          this.banners.push(new Banner('Swing Timer Mode', PAL.weaveText, 4000))
        }

        if (this.fistOnlyMode) {
          // No mainhand weapon detected — treat fist as the primary attack.
          // Route through onMainhandCrush so the swing timer calibrates from fist timing.
          // Audio and weave visuals are suppressed; the highway acts as a punch-round timer.
          this.rhythm.onReturnInRange(fistNow)
          this.rhythm.onMainhandCrush(fistNow, damage, hit, false)
          break
        }

        // ── Normal weave mode ───────────────────────────────────
        const adjTs  = fistNow - this.cfg.LATENCY_COMPENSATION * 1000
        const isClip = this.rhythm.onFistAttack(adjTs, damage, hit, fistNow)
        this.dwPendingTs = 0  // offhand swing confirmed — cancel any pending DW no-roll timer
        this.consecutiveCrushesWithoutFist = 0
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        const [hzx, hzy] = this.hzCenter()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else if (this.cfg.POSITIVE_AUDIO_IN_WINDOW && this.rhythm.isInWeaveWindow(adjTs)) {
          // Good timing → punch sound regardless of mob hit/miss.
          // Mob hit: full visual (hitFlash + particles).
          // Mob miss: show miss text but still play punch (not whiff) — timing was correct.
          this.audio.play('punch')
          if (hit && damage > 0) {
            this.lastFistHitTs = fistNow
            this.hitFlash = 1
            this.spawnParticles(hzx, hzy)
          } else {
            this.missFlash = 1
          }
        } else if (this.cfg.POSITIVE_AUDIO_IN_WINDOW) {
          // Bad timing → whiff regardless of mob hit/miss
          // Log-confirmed: hit status is known, play immediately (no defer needed)
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) this.audio.play('whiff')
        } else if (hit) {
          this.lastFistHitTs = fistNow
          this.audio.play('punch')
          this.hitFlash = 1
          this.spawnParticles(hzx, hzy)
        } else {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) this.audio.play('whiff')
        }
        break
      }
      case EvType.MISC_DAMAGE: {
        const damage = (ev.data?.damage as number) ?? 0
        if (this.cfg.ROGUE_MODE_ENABLED) {
          this.rogueDamageTotal += damage
        } else {
          this.rhythm.onMiscDamage(damage)
        }
        this.lastCombatActivity = ts
        break
      }
      case EvType.LOG_DAMAGE: {
        const lgNow  = now()
        const damage = (ev.data?.damage as number) ?? 0
        const source = (ev.data?.source as 'mainhand' | 'fist' | 'misc' | 'backstab') ?? 'misc'
        if (this.cfg.ROGUE_MODE_ENABLED) {
          if (!this.rogueInCombat) {
            this.rogueInCombat = true
            this.rogueFightStartTs = lgNow
            this.rogueDamageTotal = 0
            this.rogueBackstabDamageTotal = 0
            this.rogueBackstabHits = 0
            this.rogueBackstabMisses = 0
            this.backstab.onCombatStart()
          }
          this.lastCombatActivity = lgNow
          this.rogueDamageTotal += damage
          if (source === 'backstab') this.rogueBackstabDamageTotal += damage
          break
        }
        this.rhythm.onReturnInRange(lgNow)
        // Ensure combat is tracked even if ZealReader's COMBAT_START arrives late
        if (!this.rhythm.inCombat) this.rhythm.onCombatStart(lgNow)
        this.lastCombatActivity = lgNow
        this.rhythm.onLogDamage(damage, source === 'backstab' ? 'misc' : source)
        break
      }
      case EvType.BACKSTAB_ATTACK: {
        const damage = (ev.data?.damage as number) ?? 0
        const hit    = (ev.data?.hit as boolean) ?? false
        if (!this.cfg.ROGUE_MODE_ENABLED) {
          // Not in Rogue Mode's dedicated backstab UI, but the damage still
          // needs to count toward normal DPS — mirrors how hybrid mode's
          // LOG_DAMAGE(source: 'backstab') is handled just above.
          if (hit && damage > 0) {
            const bsLogNow = now()
            this.rhythm.onReturnInRange(bsLogNow)
            if (!this.rhythm.inCombat) this.rhythm.onCombatStart(bsLogNow)
            this.lastCombatActivity = bsLogNow
            this.rhythm.onLogDamage(damage, 'misc')
          }
          break
        }
        if (ev.data?.target) this.currentTarget = ev.data.target as string
        const bsNow = now()
        if (!this.rogueInCombat) {
          this.rogueInCombat = true
          this.rogueFightStartTs = bsNow
          this.rogueDamageTotal = 0
          this.rogueBackstabDamageTotal = 0
          this.rogueBackstabHits = 0
          this.rogueBackstabMisses = 0
          this.backstab.onCombatStart()
        }
        this.backstab.onBackstabAttack(bsNow)
        this.lastCombatActivity = bsNow
        if (hit) {
          this.rogueBackstabHits++
          if (damage > 0) {
            this.rogueDamageTotal += damage
            this.rogueBackstabDamageTotal += damage
          }
          this.hitFlash = 1
          const [hzx, hzy] = this.hzCenter()
          this.spawnParticles(hzx, hzy)
          this.audio.play('punch')
        } else {
          this.rogueBackstabMisses++
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) this.audio.play('whiff')
        }
        break
      }
      case EvType.CURSOR_BLOCKED:
        this.audio.play('error')
        this.banners.push(new Banner('Item on cursor — weapon swap blocked', PAL.weaveText, 3000))
        break
      case EvType.OUT_OF_RANGE: {
        this.rhythm.onOutOfRange(ts)
        this.banners.push(new Banner('Out of range / no LoS — swing timer desynced', PAL.weaveText, 3000))
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
        this.banners.push(new Banner(`Weapon: ${name}  (delay ${(delay/10).toFixed(1)}s)`, '#5aeb96', 4000))
        break
      }
      case EvType.HASTE_DETECTED: {
        const hastePct = (ev.data?.haste_pct as number) ?? 0
        this.trackHasteChange(hastePct)
        this.cfg.HASTE_PCT = hastePct
        if (this.cfg.ROGUE_MODE_ENABLED) {
          this.backstab.onHasteChanged(hastePct)
          break
        }
        const interval = (ev.data?.interval  as number) ?? this.rhythm.predictedInterval
        this.cfg.PUNCH_INTERVAL = interval
        const fistDelay   = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW = Math.max(0.2, interval - fistDelay) / 2
        this.rhythm.resetCalibration()
        this.hasteCalibrated = false
        this.audio.play('combat_start')
        this.banners.push(new Banner(`Haste sync: ${interval.toFixed(2)}s  (${hastePct.toFixed(0)}% haste)`, '#5aeb96', 4000))
        break
      }
      case EvType.WEAVE_SIGNAL: {
        const offhandDelay = (ev.data?.offhandDelay as number) ?? this.cfg.OFFHAND_WEAPON_DELAY
        this.applyDynamicWeaveWindow(offhandDelay)
        const fistNow = now()
        const adjTs   = fistNow - this.cfg.LATENCY_COMPENSATION * 1000
        const isClip  = this.rhythm.onFistAttack(adjTs, 0, false, fistNow)
        this.lastCombatActivity = ts
        this.consecutiveCrushesWithoutFist = 0
        this.lastFistAttackTs = fistNow
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) {
            setTimeout(() => {
              if (now() - this.lastFistHitTs > 300) this.audio.play('whiff')
            }, 150)
          }
        }
        break
      }
      case EvType.BUFF_CHANGED: {
        const buff   = ev.data?.buff   as string
        const active = ev.data?.active as boolean
        if (buff === 'avatar') {
          this.avatarActive = active
          if (this.rhythm.inCombat) {
            // Only (re)start the timer if it wasn't already running — a duplicate
            // "active" event (buff refreshed/recast before it faded) must not reset
            // the start time, or all time accumulated since the original cast is lost.
            if (active) { if (this.avatarFightStart === null) this.avatarFightStart = now() }
            else if (this.avatarFightStart !== null) { this.avatarFightMs += now() - this.avatarFightStart; this.avatarFightStart = null }
          }
          if (active) { this.banners.push(new Banner('Avatar ON', '#a855f7', 4000)); this.audio.playFileSound('avatar') }
        }
        if (buff === 'savagery') {
          this.savageryActive = active
          if (this.rhythm.inCombat) {
            if (active) { if (this.savageryFightStart === null) this.savageryFightStart = now() }
            else if (this.savageryFightStart !== null) { this.savageryFightMs += now() - this.savageryFightStart; this.savageryFightStart = null }
          }
          if (active) { this.banners.push(new Banner('Savagery ON', '#f97316', 4000)); this.audio.playFileSound('savagery') }
        }
        if (buff === 'innerflame') {
          const t = now()
          this.innerflameUntil = active ? t + 12000 : 0
          if (this.rhythm.inCombat) {
            if (active) {
              if (this.innerflameFlightStart === null) this.innerflameFlightStart = t
              this.rhythm.disciplinesUsed.add('innerflame')
            }
            else if (this.innerflameFlightStart !== null) { this.innerflameFlightMs += t - this.innerflameFlightStart; this.innerflameFlightStart = null }
          }
        }
        if (buff === 'whirlwind') {
          const t = now()
          this.whirlwindUntil = active ? t + 12000 : 0
          if (active) {
            this.banners.push(new Banner('Whirlwind', '#c084fc', 3000))
            if (this.rhythm.inCombat) this.rhythm.disciplinesUsed.add('whirlwind')
          }
        }
        break
      }
      case EvType.BANDOLIER_CHANGED: {
        const isWeaveSet    = (ev.data?.isWeaveSet as boolean) ?? false
        const isBackstabSet = (ev.data?.isBackstabSet as boolean) ?? false
        this.weaveBandolierActive = isWeaveSet
        if (this.cfg.ROGUE_MODE_ENABLED) {
          this.backstab.onBandolierChanged(isBackstabSet)
          break
        }
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
        const atk = ev.data?.atkRating as number | undefined
        if (atk != null) this.lastKnownAtkRating = atk
        break
      }
      case EvType.CRIT_HIT: {
        const damage = (ev.data?.damage as number) ?? 0
        const target = (ev.data?.target as string) || this.currentTarget
        const big = damage > this.cfg.CRIT_DAMAGE_THRESHOLD
        if (big) {
          this.audio.playFileSound('epic', true)
          this.banners.push(new Banner('Monster Crit', '#ff4444', 3000, damage.toLocaleString()))
          this.recordHit(this.topCrits, damage, target)
        } else if (this.cfg.SHOW_ALL_CRITS) {
          this.audio.playFileSound('hit_tick', true)
          this.banners.push(new Banner('Crit', '#ffffff', 2000, damage.toLocaleString()))
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

  resetTrack(): void {
    if (this.rhythm.inCombat) this.rhythm.onCombatEnd(now())
    this.postCombatGlideUntil = 0
    this.gradeScreen = null
    this.lastGradeResult = null
    this.combatStartTs = 0
    this.swingTimerEverValid = false
    this.dwPendingTs = 0
  }

  /** Called when Rogue Mode is toggled on/off mid-session (Settings or tray) so
   *  state starts clean regardless of whether a fight is in progress. */
  resetRogueMode(): void {
    this.rogueInCombat = false
    this.rogueDamageTotal = 0
    this.rogueBackstabDamageTotal = 0
    this.rogueBackstabHits = 0
    this.rogueBackstabMisses = 0
    this.rogueSummaryScreen = null
    this.backstab = new BackstabTimer(this.cfg.ROGUE_SWAP_WARN_MS)
  }

  private finishRogueFight(mobName: string): void {
    this.rogueInCombat = false
    this.backstab.onCombatEnd()
    this.audio.play('combat_end')
    const fightDuration = Math.max(1, now() - this.rogueFightStartTs)
    const seconds = fightDuration / 1000
    this.rogueSummaryScreen = new RogueSummaryScreen({
      mobName,
      fightDuration,
      netDps:      this.rogueDamageTotal / seconds,
      backstabDps: this.rogueBackstabDamageTotal / seconds,
      hits:        this.rogueBackstabHits,
      misses:      this.rogueBackstabMisses,
    })
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
      appVersion:               '',   // stamped authoritatively by the main process
      weapons: {
        mainhand: this.lastKnownMainhand || 'Unknown',
        offhand:  this.cfg.OFFHAND_WEAPON_NAME || 'Unknown',
      },
      atkRating:       this.lastKnownAtkRating,
      hastePct:        this.displayHastePct,
      engagedMs:       result.engagedMs,
      outOfRangeMs:    result.outOfRangeMs,
      disciplinesUsed: Array.from(this.rhythm.disciplinesUsed),
      buffsActive: this.flushBuffs(result.fightDuration),
      dpsSamples: this.rhythm.getDpsSamples(),
    }
    window.electronAPI?.sendLeaderboardRecord(record)
  }

  /** Close the current haste segment and open a new one at `newHaste`.
   *  Called whenever HASTE_PCT is about to change so the weighted-time buffer
   *  captures how long the previous value actually held. */
  private trackHasteChange(newHaste: number): void {
    const t = now()
    if (this.hasteSegStart !== null) {
      this.hasteFightWeightedMs += this.hasteSegValue * (t - this.hasteSegStart)
    }
    this.hasteSegStart = t
    this.hasteSegValue = newHaste
  }

  /** Time-weighted average haste% across the current (or just-ended) fight.
   *  Falls back to the instantaneous HASTE_PCT before the first combat start. */
  private get displayHastePct(): number {
    if (this.combatStartTs <= 0) return this.cfg.HASTE_PCT
    const t = now()
    const elapsed = t - this.combatStartTs
    if (elapsed <= 0) return this.cfg.HASTE_PCT
    const weighted = this.hasteSegStart !== null
      ? this.hasteFightWeightedMs + this.hasteSegValue * (t - this.hasteSegStart)
      : this.hasteFightWeightedMs
    return weighted / elapsed
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
  toggleHighContrast(): void { /* refined style does not use HC mode — see HighContrastOverlay */ }

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

  private spawnParticles(x: number, y: number): void {
    for (let i = 0; i < 10; i++) {
      const ang = Math.random() * Math.PI * 2
      const spd = 50 + Math.random() * 80
      this.particles.push({
        x, y, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd,
        life: 0, ttl: 0.7 + Math.random() * 0.4, size: 1 + Math.random() * 2,
      })
    }
  }

  // ── Update loop ─────────────────────────────────────────────
  private update(dt: number): void {
    const t = now()
    this.targetSpeed = this.runway / (4 * this.cfg.PUNCH_INTERVAL * 1000)
    if (this.speed === 0) this.speed = this.targetSpeed
    else this.speed += (this.targetSpeed - this.speed) * Math.min(1, dt * 12)

    if (this.cfg.ROGUE_MODE_ENABLED) {
      if (this.rogueInCombat && this.lastCombatActivity > 0
          && t - this.lastCombatActivity > COMBAT_IDLE_TIMEOUT_MS) {
        this.finishRogueFight('')
        this.lastCombatActivity = 0
      }
      this.backstab.update(t)
      if (this.backstab.shouldPromptSwapIn && !this.backstab.swapInPromptShown) {
        this.backstab.swapInPromptShown = true
        this.banners.push(new Banner('Swap to BACKSTAB weapon!', PAL.weaveText, 2500))
      }
      if (this.backstab.shouldPromptSwapOut && !this.backstab.swapOutPromptShown) {
        this.backstab.swapOutPromptShown = true
        this.banners.push(new Banner('Swap back to DPS weapon', PAL.weaveText, 2500))
      }
    } else {
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
        this.trackHasteChange(derivedHaste)
        this.cfg.HASTE_PCT      = derivedHaste
        this.cfg.PUNCH_INTERVAL = iv
        const fistDelay         = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW    = Math.max(0.2, iv - fistDelay) / 2
        this.hasteCalibrated = true
        this.banners.push(new Banner(`Auto-calibrated: ${iv.toFixed(2)}s  (${derivedHaste.toFixed(0)}% haste)`, '#ffc844', 3000))
        this.rhythm.calibrationEvent = null
      }
      if (this.rhythm.roundEndDamage !== null) {
        if (this.rhythm.roundEndDamage > this.cfg.HUGE_ROUND_THRESHOLD && t - this.lastOhSnapTs > 1000) {
          const rd = this.rhythm.roundEndDamage
          this.audio.playFileSound('oh_snap', true)
          this.banners.push(new Banner('Huge Round!!!', '#ffd700', 3000, rd.toLocaleString()))
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
    }

    // Decay
    this.hitFlash    = Math.max(0, this.hitFlash    - dt * 3.5)
    this.missFlash   = Math.max(0, this.missFlash   - dt * 2)
    this.clipWarn    = Math.max(0, this.clipWarn    - dt * 2)
    this.dwRollFlash = Math.max(0, this.dwRollFlash - dt * 1.2)

    // Particles
    for (const p of this.particles) {
      p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt
      p.vy += 360 * dt; p.vx *= Math.max(0, 1 - 2 * dt)
    }
    this.particles = this.particles.filter(p => p.life < p.ttl)

    this.banners = this.banners.filter(b => !b.expired)
    if (this.gradeScreen?.expired) this.gradeScreen = null
    if (this.rogueSummaryScreen?.expired) this.rogueSummaryScreen = null

    // DPS
    if (!this.cfg.ROGUE_MODE_ENABLED && t - this.dpsLastUpdate >= 250) {
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

    // Backgrounds
    ctx.fillStyle = PAL.bg; ctx.fillRect(0,0,w,h)
    this.drawHeader()
    this.drawFooter()
    if (this.cfg.ROGUE_MODE_ENABLED) {
      this.drawRogueTrack()
    } else {
      this.drawHighway()
      this.drawDynamicWeaveWindows()
      this.drawHitZone()
      this.drawOffhandSwingTimer()
    }
    this.drawParticles()
    this.drawMissFlash()
    this.drawClipWarn()
    this.drawDwRollFail()
    this.drawNoLogNotice()
    this.drawBanners()
    if (this.gradeScreen) this.drawGradeScreen(this.gradeScreen)
    if (this.rogueSummaryScreen) this.drawRogueSummaryScreen(this.rogueSummaryScreen)
  }

  private drawNoLogNotice(): void {
    if (this.rhythm.inCombat || this.gradeScreen || this.rogueInCombat || this.rogueSummaryScreen) return
    const t = now()
    const stale = this.logSelected && (t - this.lastLogActivityTs) > 60_000
    if (!this.logSelected || stale) {
      const line1 = this.logSelected ? 'Log not updating' : 'No log file selected'
      const line2 = this.logSelected ? 'Is EQ running?' : 'Right-click tray → Select Log'
      // Gentle pulse: 0→1→0 on a ~4s half-cycle
      const pulse = (1 + Math.sin(t / 2000 * Math.PI)) / 2
      const alpha = 0.15 + pulse * 0.30
      const ctx = this.ctx
      const w = this.canvas.width
      const cy = this.highwayY + this.highwayH / 2
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = '600 10px "JetBrains Mono", monospace'
      ctx.fillStyle = `rgba(160,168,210,${alpha.toFixed(3)})`
      ctx.fillText(line1, w / 2, cy - 7)
      ctx.font = '400 9px "JetBrains Mono", monospace'
      ctx.fillStyle = `rgba(130,138,180,${(alpha * 0.75).toFixed(3)})`
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

    ctx.fillStyle = 'rgba(14,16,30,0.55)'
    ctx.fillRect(0, barY, w, barH)

    if (this.lastFistAttackTs <= 0) return

    const elapsed  = (t - this.lastFistAttackTs) / 1000
    const fraction = Math.max(0, 1 - elapsed / offhandSec)
    if (fraction <= 0) return

    const barW = Math.max(1, Math.trunc(w * fraction))
    let color: string
    if (fraction > 0.5) {
      color = 'rgba(40,110,190,0.60)'
    } else if (fraction > 0.15) {
      color = 'rgba(60,175,240,0.75)'
    } else {
      color = 'rgba(100,235,255,0.90)'
    }

    ctx.fillStyle = color
    ctx.fillRect(0, barY, barW, barH)
  }

  private drawHighway(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH
    ctx.fillStyle = PAL.highway; ctx.fillRect(0, hy, w, hh)

    // Subtle vertical scan grid
    ctx.strokeStyle = 'rgba(255,255,255,0.02)'; ctx.lineWidth = 1
    for (let x = 0; x < w; x += 24) {
      ctx.beginPath(); ctx.moveTo(x + 0.5, hy); ctx.lineTo(x + 0.5, hy + hh); ctx.stroke()
    }
    // Center line from hit zone outward
    ctx.strokeStyle = PAL.centerLine
    if (this.cfg.ORIENTATION === 'horizontal') {
      const cy = hy + hh / 2
      ctx.beginPath(); ctx.moveTo(this.hzX, cy); ctx.lineTo(w, cy); ctx.stroke()
    } else {
      ctx.beginPath(); ctx.moveTo(this.hzX, hy); ctx.lineTo(this.hzX, this.hzY); ctx.stroke()
    }
  }

  private drawInnerflameBar(y: number, h: number): void {
    const frac = this.innerflameUntil > 0 ? Math.max(0, (this.innerflameUntil - now()) / 12000) : 0
    if (frac <= 0) return
    const w = this.canvas.width
    const ctx = this.ctx
    const alpha = 0.55 + frac * 0.35
    ctx.fillStyle = `rgba(232,144,32,${alpha.toFixed(2)})`
    ctx.fillRect(0, y, Math.trunc(w * frac), h)
  }

  private drawWhirlwindBar(y: number, h: number): void {
    const frac = this.whirlwindUntil > 0 ? Math.max(0, (this.whirlwindUntil - now()) / 12000) : 0
    if (frac <= 0) return
    const w = this.canvas.width
    const ctx = this.ctx
    const alpha = 0.55 + frac * 0.35
    ctx.fillStyle = `rgba(192,132,252,${alpha.toFixed(2)})`
    ctx.fillRect(0, y, Math.trunc(w * frac), h)
  }

  private drawHeader(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    ctx.fillStyle = PAL.headerFooter; ctx.fillRect(0, 0, w, HEADER_H)
    ctx.fillStyle = PAL.divider;      ctx.fillRect(0, HEADER_H - 1, w, 1)
    this.drawInnerflameBar(HEADER_H - 2, 2)
    this.drawWhirlwindBar(HEADER_H - 4, 2)

    ctx.font = '600 12px "Inter", sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = PAL.text
    ctx.fillText(this.charName || '—', 10, HEADER_H / 2)

    // Phase pill — start after the name, with a minimum gap
    const nameW = ctx.measureText(this.charName || '—').width
    const pillX = Math.max(58, Math.ceil(nameW) + 18)

    const phase = this.rhythm.inCombat
      ? (this.fistOnlyMode ? 'WAITING' : 'COMBAT')
      : this.gradeScreen ? 'RESULT' : 'IDLE'
    const color = phase === 'COMBAT' ? PAL.combat
      : phase === 'WAITING'  ? '#38bdf8'
      : phase === 'RESULT' ? PAL.result : PAL.idle
    ctx.font = '600 9px "JetBrains Mono", monospace'
    const pw = ctx.measureText(phase).width + 12
    ctx.fillStyle = this.rgba(color, 0.15)
    this.roundRect(pillX, 5, pw, 14, 7); ctx.fill()
    ctx.fillStyle = color
    ctx.fillText(phase, pillX + 6, 12)

    // Buff indicators (Avatar, Savagery)
    let buffX = pillX + pw + 5
    ctx.font = '600 9px "JetBrains Mono", monospace'
    if (this.avatarActive) {
      const bw = ctx.measureText('AVT').width + 10
      ctx.fillStyle = this.rgba('#a855f7', 0.18)
      this.roundRect(buffX, 5, bw, 14, 7); ctx.fill()
      ctx.fillStyle = '#a855f7'
      ctx.fillText('AVT', buffX + 5, 12)
      buffX += bw + 4
    }
    if (this.savageryActive) {
      const bw = ctx.measureText('SAV').width + 10
      ctx.fillStyle = this.rgba('#f97316', 0.18)
      this.roundRect(buffX, 5, bw, 14, 7); ctx.fill()
      ctx.fillStyle = '#f97316'
      ctx.fillText('SAV', buffX + 5, 12)
      buffX += bw + 4
    }
    if (this.innerflameUntil > 0 && now() < this.innerflameUntil) {
      const label = 'INNERFLAME'
      const bw = ctx.measureText(label).width + 10
      ctx.fillStyle = this.rgba('#e89020', 0.22)
      this.roundRect(buffX, 5, bw, 14, 7); ctx.fill()
      ctx.fillStyle = '#e89020'
      ctx.fillText(label, buffX + 5, 12)
      buffX += bw + 4
    }
    if (this.whirlwindUntil > 0 && now() < this.whirlwindUntil) {
      const label = 'WHIRLWIND'
      const bw = ctx.measureText(label).width + 10
      ctx.fillStyle = this.rgba('#c084fc', 0.22)
      this.roundRect(buffX, 5, bw, 14, 7); ctx.fill()
      ctx.fillStyle = '#c084fc'
      ctx.fillText(label, buffX + 5, 12)
    }

    // Right-side
    ctx.textAlign = 'right'
    ctx.font = '600 11px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.text
    ctx.fillText(`${this.cfg.PUNCH_INTERVAL.toFixed(2)}s`, w - 70, HEADER_H / 2)
    ctx.font = '500 10px "JetBrains Mono", monospace'
    ctx.fillStyle = this.hasteCalibrated ? '#ffc844' : PAL.textDim
    ctx.fillText(`${this.displayHastePct.toFixed(0)}%`, w - 10, HEADER_H / 2)
    ctx.textAlign = 'left'
  }

  private drawFooter(): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    ctx.fillStyle = PAL.headerFooter; ctx.fillRect(0, h - FOOTER_H, w, FOOTER_H)
    ctx.fillStyle = PAL.divider;      ctx.fillRect(0, h - FOOTER_H, w, 1)
    this.drawInnerflameBar(h - FOOTER_H, 2)
    this.drawWhirlwindBar(h - FOOTER_H + 2, 2)
    ctx.textBaseline = 'middle'

    const fy = h - FOOTER_H / 2
    // WEAVES (left)
    ctx.font = '500 9px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.textDim
    ctx.fillText('WEAVES', 10, fy)
    const lw = ctx.measureText('WEAVES').width
    ctx.font = '600 11px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.text
    ctx.fillText(`${this.rhythm.inCombat ? this.rhythm.roundsWithWeave : 0}`, 10 + lw + 6, fy)

    // NET DPS (center)
    ctx.textAlign = 'center'
    const netVal = `${this.dpsDisplayTotal}`
    ctx.font = '600 11px "JetBrains Mono", monospace'
    const vw = ctx.measureText(netVal).width
    ctx.font = '500 9px "JetBrains Mono", monospace'
    const lblW = ctx.measureText('NET DPS').width
    const startX = w / 2 - (lblW + 6 + vw) / 2
    ctx.textAlign = 'left'
    ctx.fillStyle = PAL.textDim
    ctx.fillText('NET DPS', startX, fy)
    ctx.font = '600 11px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.text
    ctx.fillText(netVal, startX + lblW + 6, fy)

    // WEAVED DPS (right)
    ctx.textAlign = 'right'
    const weaveVal = `+${this.dpsDisplayFist}`
    ctx.font = '600 11px "JetBrains Mono", monospace'
    const wvw = ctx.measureText(weaveVal).width
    ctx.fillStyle = PAL.weaveText
    ctx.fillText(weaveVal, w - 10, fy)
    ctx.font = '500 9px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.textDim
    ctx.fillText('WEAVED DPS', w - 10 - wvw - 6, fy)
    ctx.textAlign = 'left'
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
    if (nextSwing <= 0) return   // no reference yet (very start of combat)

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
          ctx.fillStyle = `${PAL.swingBar}0.75)`
          ctx.fillRect(sx - 1.5, hy - 4, 4, hh + 8)
          const [sfx] = this.projectAt(safeEnd, t)
          if (sfx > sx) {
            const gw = Math.max(3, sfx - sx)
            ctx.fillStyle   = `${PAL.weaveFill}0.85)`
            ctx.fillRect(sx, hy + 10, gw, hh - 20)
            ctx.strokeStyle = `${PAL.weaveStroke}1.0)`
            ctx.lineWidth = 1.25
            ctx.strokeRect(sx + 0.5, hy + 10.5, gw - 1, hh - 21)
          }
        } else {
          if (sy < hy - 30) break
          if (sy > hy + hh + 20) continue
          ctx.fillStyle = `${PAL.swingBar}0.75)`
          ctx.fillRect(6 - 4, sy - 1.5, w - 12 + 8, 4)
          const [, sfy] = this.projectAt(safeEnd, t)
          if (sfy < sy) {
            const gh = Math.max(3, sy - sfy)
            ctx.fillStyle   = `${PAL.weaveFill}0.85)`
            ctx.fillRect(6, sfy, w - 12, gh)
            ctx.strokeStyle = `${PAL.weaveStroke}1.0)`
            ctx.lineWidth = 1.25
            ctx.strokeRect(6.5, sfy + 0.5, w - 13, gh - 1)
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
        if (sx > w + 30) break
        if (sx < this.hzX - w) continue

        ctx.fillStyle = `${PAL.swingBar}0.75)`
        ctx.fillRect(sx - 1.5, hy - 4, 4, hh + 8)

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
              ctx.fillStyle = 'rgba(100,120,180,0.22)'
              ctx.fillRect(sx, hy + 10, waitW, hh - 20)
            }
          }

          // Green safe zone (winStart → safeEnd)
          if (winStart < safeEnd) {
            const greenW = Math.max(3, sfx - wx)
            ctx.fillStyle   = `${PAL.weaveFill}0.85)`
            ctx.fillRect(wx, hy + 10, greenW, hh - 20)
            ctx.strokeStyle = `${PAL.weaveStroke}1.0)`
            ctx.lineWidth = 1.25
            ctx.strokeRect(wx + 0.5, hy + 10.5, greenW - 1, hh - 21)
          }

          // Discouraged zone (safeEnd → windowEnd)
          if (orderSet) {
            const discW = Math.max(2, wndx - sfx)
            ctx.fillStyle   = 'rgba(140,30,20,0.22)'
            ctx.fillRect(sfx, hy + 10, discW, hh - 20)
            ctx.strokeStyle = 'rgba(200,50,30,0.45)'
            ctx.lineWidth = 1.25
            ctx.strokeRect(sfx + 0.5, hy + 10.5, discW - 1, hh - 21)
          }

          // Cyan ready-line
          if (hasWait && wx > sx && wx < sfx) {
            ctx.strokeStyle = 'rgba(80,210,255,0.90)'
            ctx.lineWidth = 1.5
            ctx.beginPath(); ctx.moveTo(wx, hy + 6); ctx.lineTo(wx, hy + hh - 6); ctx.stroke()
          }

          if (isAnticipated) ctx.globalAlpha = 1.0
          if (winStart < safeEnd) projectedNextReady = winStart + offhandMs
          windowsDrawn++
        }
      } else {
        if (sy < hy - 30) break
        if (sy > hy + hh + 20) continue

        ctx.fillStyle = `${PAL.swingBar}0.75)`
        ctx.fillRect(6 - 4, sy - 1.5, w - 12 + 8, 4)

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
              ctx.fillStyle = 'rgba(100,120,180,0.22)'
              ctx.fillRect(6, wy, w - 12, waitH)
            }
          }

          // Green safe zone (winStart → safeEnd)
          if (winStart < safeEnd) {
            const greenH = Math.max(3, wy - sfy)
            ctx.fillStyle   = `${PAL.weaveFill}0.85)`
            ctx.fillRect(6, sfy, w - 12, greenH)
            ctx.strokeStyle = `${PAL.weaveStroke}1.0)`
            ctx.lineWidth = 1.25
            ctx.strokeRect(6.5, sfy + 0.5, w - 13, greenH - 1)
          }

          // Discouraged zone (safeEnd → windowEnd)
          if (orderSet) {
            const discH = Math.max(2, sfy - wndy)
            ctx.fillStyle   = 'rgba(140,30,20,0.22)'
            ctx.fillRect(6, wndy, w - 12, discH)
            ctx.strokeStyle = 'rgba(200,50,30,0.45)'
            ctx.lineWidth = 1.25
            ctx.strokeRect(6.5, wndy + 0.5, w - 13, discH - 1)
          }

          // Cyan ready-line
          if (hasWait && wy < sy && wy > sfy) {
            ctx.strokeStyle = 'rgba(80,210,255,0.90)'
            ctx.lineWidth = 1.5
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
    const ranks = [
      { a: 1.00, sa: 0.85 },
      { a: 0.55, sa: 0.40 },
      { a: 0.25, sa: 0.20 },
    ]

    const nextSwing = this.rhythm.roundOpen
      ? this.rhythm.lastCrushTime + intervalMs
      : this.rhythm.nextSwingTime

    let firstSwing = nextSwing
    while (firstSwing - intervalMs > t - intervalMs) firstSwing -= intervalMs

    const vert = this.cfg.ORIENTATION === 'vertical'
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH

    let rank = 0
    for (let k = 0; rank < 3 && k < 12; k++) {
      const swingTime = firstSwing + k * intervalMs
      const weaveEnd  = swingTime + weaveSec * 1000
      const [x1, y1] = this.projectAt(swingTime, t)
      const [x2, y2] = this.projectAt(weaveEnd, t)
      const r = ranks[rank]

      if (!vert) {
        if (x1 > w + 30) break
        if (x2 < this.hzX - 20) continue
        const boxY = hy + 10, boxH = hh - 20
        const bw = Math.max(3, x2 - x1)
        ctx.fillStyle   = `${PAL.weaveFill}${0.85 * r.a})`
        ctx.fillRect(x1, boxY, bw, boxH)
        ctx.strokeStyle = `${PAL.weaveStroke}${r.sa + 0.25})`
        ctx.lineWidth = 1.25
        ctx.strokeRect(x1 + 0.5, boxY + 0.5, bw - 1, boxH - 1)
        ctx.fillStyle = `${PAL.swingBar}${0.98 * r.a})`
        ctx.fillRect(x1 - 1.5, boxY - 4, 4, boxH + 8)
      } else {
        if (y1 < hy - 30) break
        if (y2 > hy + hh + 20) continue
        const boxX = 6, boxW = w - 12
        const bh = Math.max(3, y1 - y2)   // y1 > y2 because future = up
        ctx.fillStyle   = `${PAL.weaveFill}${0.85 * r.a})`
        ctx.fillRect(boxX, y2, boxW, bh)
        ctx.strokeStyle = `${PAL.weaveStroke}${r.sa + 0.25})`
        ctx.lineWidth = 1.25
        ctx.strokeRect(boxX + 0.5, y2 + 0.5, boxW - 1, bh - 1)
        ctx.fillStyle = `${PAL.swingBar}${0.98 * r.a})`
        ctx.fillRect(boxX - 4, y1 - 1.5, boxW + 8, 4)
      }
      rank++
    }
  }

  private drawHitZone(): void {
    const ctx = this.ctx
    const [hzx, hzy] = this.hzCenter()
    const hy = this.highwayY, hh = this.highwayH
    const flash = this.hitFlash
    const w = this.canvas.width

    if (this.cfg.ORIENTATION === 'horizontal') {
      // Sweep flash across highway
      if (flash > 0) {
        ctx.fillStyle = this.rgba(PAL.hitFlash, flash * 0.18)
        ctx.fillRect(hzx, hy + 6, this.runway, hh - 12)
      }
      // Yellow vertical bar with end caps
      ctx.strokeStyle = flash > 0 ? this.rgba(PAL.hitFlash, 0.85 + flash * 0.15) : PAL.hitZone
      ctx.lineWidth = flash > 0 ? 3 : 2
      ctx.beginPath(); ctx.moveTo(hzx, hy + 4); ctx.lineTo(hzx, hy + hh - 4); ctx.stroke()
      ctx.fillStyle = flash > 0 ? PAL.hitFlash : PAL.hitZone
      ctx.fillRect(hzx - 5, hy + 2, 10, 3)
      ctx.fillRect(hzx - 5, hy + hh - 5, 10, 3)
    } else {
      if (flash > 0) {
        ctx.fillStyle = this.rgba(PAL.hitFlash, flash * 0.18)
        ctx.fillRect(6, hzy - this.runway/2, w - 12, this.runway)
      }
      ctx.strokeStyle = flash > 0 ? this.rgba(PAL.hitFlash, 0.85 + flash * 0.15) : PAL.hitZone
      ctx.lineWidth = flash > 0 ? 3 : 2
      ctx.beginPath(); ctx.moveTo(4, hzy); ctx.lineTo(w - 4, hzy); ctx.stroke()
      ctx.fillStyle = flash > 0 ? PAL.hitFlash : PAL.hitZone
      ctx.fillRect(4, hzy - 5, 3, 10)
      ctx.fillRect(w - 7, hzy - 5, 3, 10)
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx
    for (const p of this.particles) {
      const a = Math.max(0, 1 - p.life / p.ttl)
      ctx.fillStyle = this.rgba('#ffd700', a)
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2); ctx.fill()
    }
  }

  private drawMissFlash(): void {
    if (this.missFlash <= 0) return
    const ctx = this.ctx
    const [hzx] = this.hzCenter()
    const hy = this.highwayY
    ctx.font = '600 9px "JetBrains Mono", monospace'
    ctx.fillStyle = `${PAL.missText}${this.missFlash})`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('— missed', hzx + 32, hy + 12)
    ctx.textAlign = 'left'
  }

  private drawClipWarn(): void {
    if (this.clipWarn <= 0) return
    const ctx = this.ctx
    const [hzx, hzy] = this.hzCenter()
    const hy = this.highwayY, hh = this.highwayH
    const w = this.canvas.width
    // Red wash
    ctx.fillStyle = `${PAL.clipWash}${this.clipWarn * 0.28})`
    ctx.fillRect(0, hy, w, hh)
    // Strobe on hit-zone bar
    ctx.strokeStyle = `rgba(255,80,80,${this.clipWarn})`
    ctx.lineWidth = 3
    if (this.cfg.ORIENTATION === 'horizontal') {
      ctx.beginPath(); ctx.moveTo(hzx, hy + 4); ctx.lineTo(hzx, hy + hh - 4); ctx.stroke()
    } else {
      ctx.beginPath(); ctx.moveTo(4, hzy); ctx.lineTo(w - 4, hzy); ctx.stroke()
    }
    // Expanding ring
    ctx.strokeStyle = `rgba(255,80,80,${this.clipWarn * 0.7})`
    ctx.lineWidth = 1.5
    const rr = 6 + (1 - this.clipWarn) * 26
    ctx.beginPath(); ctx.arc(hzx, hzy, rr, 0, Math.PI * 2); ctx.stroke()
    // Tag
    ctx.font = '700 10px "JetBrains Mono", monospace'
    ctx.fillStyle = `${PAL.clipText}${this.clipWarn})`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('CLIPPED', hzx + 36, hy + 14)
    ctx.textAlign = 'left'
  }

  private drawDwRollFail(): void {
    if (this.dwRollFlash <= 0) return
    const ctx = this.ctx
    const [hzx, hzy] = this.hzCenter()
    const hy = this.highwayY
    // Amber/orange expanding ring at the hit zone — distinct from red clip
    ctx.strokeStyle = `rgba(255,160,0,${this.dwRollFlash * 0.9})`
    ctx.lineWidth = 2
    const rr = 6 + (1 - this.dwRollFlash) * 20
    ctx.beginPath(); ctx.arc(hzx, hzy, rr, 0, Math.PI * 2); ctx.stroke()
    // Label — offset slightly above the miss text position
    ctx.font = '600 9px "JetBrains Mono", monospace'
    ctx.fillStyle = `rgba(255,160,0,${this.dwRollFlash})`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('DW no roll', hzx + 32, hy - 2)
    ctx.textAlign = 'left'
  }

  private drawBanners(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    let y = HEADER_H + 6
    for (const b of this.banners) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = '500 11px "Inter", sans-serif'
      ctx.fillStyle = this.rgba(b.color, b.alpha)
      ctx.fillText(b.text, w / 2, y)
      y += 14
      if (b.bigNumber) {
        ctx.font = '700 34px "Space Grotesk", sans-serif'
        ctx.fillStyle = this.rgba(b.color, b.alpha)
        ctx.fillText(b.bigNumber, w / 2, y + 17)
        y += 40
      }
      ctx.textAlign = 'left'
    }
  }

  private drawGradeScreen(gs: GradeScreen): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    const a = gs.alpha
    if (a <= 0) return
    const g = gs.result
    ctx.fillStyle = this.rgba('#0a0c16', 0.92 * a); ctx.fillRect(0, 0, w, h)
    const colors: Record<string,string> = { S:'#ffd700', A:'#78ff78', B:'#50b4ff', C:'#ffc850', D:'#c87850', F:'#b43c3c' }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.font = '700 48px "Space Grotesk", sans-serif'
    ctx.fillStyle = this.rgba(colors[g.grade] || '#fff', a)
    ctx.fillText(g.grade, 48, h / 2)

    ctx.textAlign = 'left'
    ctx.font = '600 12px "JetBrains Mono", monospace'
    ctx.fillStyle = this.rgba(PAL.text, a)
    const weaved = (g as any).keystrokeGrading ? (g as any).keystrokeRoundsWeaved : (g as any).roundsWeaved
    ctx.fillText(`${weaved}/${(g as any).totalRounds} weaves landed`, 96, h / 2 - 24)
    ctx.font = '500 11px "JetBrains Mono", monospace'
    ctx.fillText(`net ${Math.round((g as any).totalDps ?? 0)} dps`, 96, h / 2 - 6)
    ctx.fillStyle = this.rgba(PAL.weaveText, a)
    ctx.fillText(`+${Math.round(g.addedDps)} from weaving`, 96, h / 2 + 10)
    ctx.fillStyle = this.rgba(PAL.textDim, a)
    ctx.font = '500 10px "JetBrains Mono", monospace'
    const r = (g as any).avgReactionMs
    ctx.fillText(`${r != null ? Math.round(r) : '—'} ms avg reaction`, 96, h / 2 + 26)

    ctx.font = '500 9px "JetBrains Mono", monospace'
    ctx.fillStyle = this.rgba(PAL.textDim, a)
    ctx.textAlign = 'right'
    ctx.fillText('[ V ] copy  ·  [ space ] dismiss', w - 10, h - 10)
    ctx.textAlign = 'left'
  }

  // ── Rogue Mode ─────────────────────────────────────────────
  private drawRogueTrack(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH
    ctx.fillStyle = PAL.highway; ctx.fillRect(0, hy, w, hh)

    const bs = this.backstab
    const pct = bs.progressPct
    const ready = bs.state === 'ready'

    // Progress bar
    const barY = hy + hh * 0.55
    const barH = Math.max(6, hh * 0.22)
    ctx.fillStyle = 'rgba(255,255,255,0.06)'
    ctx.fillRect(8, barY, w - 16, barH)
    const fillW = Math.max(0, (w - 16) * pct)
    ctx.fillStyle = ready ? PAL.hitZone : `${PAL.weaveFill}0.85)`
    ctx.fillRect(8, barY, fillW, barH)
    if (ready) {
      const pulse = (1 + Math.sin(now() / 220)) / 2
      ctx.fillStyle = `rgba(255,200,40,${(0.15 + pulse * 0.25).toFixed(2)})`
      ctx.fillRect(8, barY - 2, w - 16, barH + 4)
    }

    // Countdown / status text
    const seconds = bs.remainingMs / 1000
    const label = ready ? 'BACKSTAB READY' : seconds.toFixed(1) + 's'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = ready ? '700 20px "Space Grotesk", sans-serif' : '700 26px "Space Grotesk", sans-serif'
    ctx.fillStyle = ready ? PAL.hitZone : PAL.text
    ctx.fillText(label, w / 2, hy + hh * 0.28)

    if (bs.isReadyButNotSwapped) {
      ctx.font = '600 10px "JetBrains Mono", monospace'
      ctx.fillStyle = PAL.weaveText
      ctx.fillText('swap to backstab weapon', w / 2, hy + hh * 0.28 + 20)
    }
    ctx.textAlign = 'left'
  }

  private drawRogueSummaryScreen(rs: RogueSummaryScreen): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    const a = rs.alpha
    if (a <= 0) return
    const r = rs.result
    ctx.fillStyle = this.rgba('#0a0c16', 0.92 * a); ctx.fillRect(0, 0, w, h)

    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.font = '600 11px "JetBrains Mono", monospace'
    ctx.fillStyle = this.rgba(PAL.textDim, a)
    ctx.fillText(r.mobName || 'Fight complete', 16, h / 2 - 26)

    ctx.font = '700 20px "Space Grotesk", sans-serif'
    ctx.fillStyle = this.rgba(PAL.text, a)
    ctx.fillText(`NET ${Math.round(r.netDps)} dps`, 16, h / 2 - 4)

    ctx.font = '700 16px "Space Grotesk", sans-serif'
    ctx.fillStyle = this.rgba(PAL.hitZone, a)
    ctx.fillText(`BACKSTAB ${Math.round(r.backstabDps)} dps`, 16, h / 2 + 16)

    ctx.font = '500 10px "JetBrains Mono", monospace'
    ctx.fillStyle = this.rgba(PAL.textDim, a)
    ctx.fillText(`${r.hits}/${r.hits + r.misses} backstabs landed`, 16, h / 2 + 34)
  }

  // ── Tiny utils ──────────────────────────────────────────────
  private rgba(hex: string, a: number): string {
    if (hex.startsWith('rgba')) return hex
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r},${g},${b},${a.toFixed(3)})`
  }
  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y,     x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x,     y + h, r)
    ctx.arcTo(x,     y + h, x,     y,     r)
    ctx.arcTo(x,     y,     x + w, y,     r)
    ctx.closePath()
  }
}

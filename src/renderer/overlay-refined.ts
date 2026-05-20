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

interface Particle { x:number; y:number; vx:number; vy:number; life:number; ttl:number; size:number }

// ── Main class ────────────────────────────────────────────────
export class RefinedOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cfg: ConfigType
  private rhythm: RhythmEngine
  private audio: AudioManager

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
  private particles: Particle[] = []
  private banners: Banner[] = []
  private gradeScreen: GradeScreen | null = null
  private lastGradeResult: import('./rhythm-engine').GradeResult | null = null
  private fightHistory: GradeResult[] = []
  private dpsDisplayTotal = 0
  private dpsDisplayFist = 0
  private dpsLastUpdate = 0
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
  private rapidAttackMuteUntil = 0
  private static readonly RAPID_CRUSH_THRESHOLD = 4
  private static readonly RAPID_MUTE_MS = 6000
  private avatarActive = false
  private savageryActive = false

  pinned = true
  charName = ''
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

  // ── IPC entry ───────────────────────────────────────────────
  handleGameEvent(ev: GameEvent): void {
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
          this.swingTimerEverValid = false
          this.dpsDisplayTotal = 0; this.dpsDisplayFist = 0; this.dpsLastUpdate = 0
        }
        this.lastCombatActivity = ts
        break
      case EvType.MOB_DIED: {
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
          this.gradeScreen = new GradeScreen(result)
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
        const crushTs = now()
        const damage = (ev.data?.damage as number) ?? 0
        const hit    = (ev.data?.hit    as boolean) ?? false
        if (ev.data?.target) this.currentTarget = ev.data.target as string
        // Auto-restart if combat ended spuriously mid-fight
        if (!this.rhythm.inCombat) {
          this.postCombatGlideUntil = 0
          this.rhythm.onCombatStart(crushTs)
          this.combatStartTs = crushTs
          this.swingTimerEverValid = false
        }
        this.rhythm.onMainhandCrush(crushTs, damage, hit)
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
        const adjTs   = ts - this.cfg.LATENCY_COMPENSATION * 1000
        const damage  = (ev.data?.damage as number)  ?? 0
        const hit     = (ev.data?.hit    as boolean) ?? false
        const isClip  = this.rhythm.onFistAttack(adjTs, damage, hit, fistNow)
        this.lastCombatActivity = ts
        this.consecutiveCrushesWithoutFist = 0
        this.lastFistAttackTs = fistNow
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        const [hzx, hzy] = this.hzCenter()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else if (hit && damage > 0) {
          this.lastFistHitTs = now()
          this.audio.play('punch')
          this.hitFlash = 1
          this.spawnParticles(hzx, hzy)
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
      case EvType.MISC_DAMAGE:
        this.rhythm.onMiscDamage((ev.data?.damage as number) ?? 0)
        this.lastCombatActivity = ts
        break
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
        const interval = (ev.data?.interval  as number) ?? this.rhythm.predictedInterval
        this.cfg.HASTE_PCT      = hastePct
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
        const adjTs   = ts - this.cfg.LATENCY_COMPENSATION * 1000
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
          if (active) {
            this.banners.push(new Banner('Avatar ON', '#a855f7', 4000))
            this.audio.playFileSound('avatar')
          }
        }
        if (buff === 'savagery') {
          this.savageryActive = active
          if (active) {
            this.banners.push(new Banner('Savagery ON', '#f97316', 4000))
            this.audio.playFileSound('savagery')
          }
        }
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
      case 'h': case 'H': this.toggleOrientation(); break
      case 'ArrowUp':   this.rhythm.adjustInterval(+0.25); break
      case 'ArrowDown': this.rhythm.adjustInterval(-0.25); break
      case 'r': case 'R': this.resetTrack(); break
      case 'v': case 'V': this.copyToClipboard(); break
    }
  }

  private resetTrack(): void {
    if (this.rhythm.inCombat) this.rhythm.onCombatEnd(now())
    this.postCombatGlideUntil = 0
    this.gradeScreen = null
    this.lastGradeResult = null
    this.combatStartTs = 0
    this.swingTimerEverValid = false
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

  toggleOrientation(): void {
    this.cfg.ORIENTATION = this.cfg.ORIENTATION === 'horizontal' ? 'vertical' : 'horizontal'
    this.resizeCanvas(); this.computeLayout()
    window.electronAPI?.resizeWindow(
      this.cfg.ORIENTATION === 'vertical' ? this.cfg.VERT_WINDOW_WIDTH  : this.cfg.WINDOW_WIDTH,
      this.cfg.ORIENTATION === 'vertical' ? this.cfg.VERT_WINDOW_HEIGHT : this.cfg.WINDOW_HEIGHT,
    )
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
    this.cfg.GOOD_WINDOW = Math.max(0.1, this.cfg.PUNCH_INTERVAL - effectiveDelay) / 2
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

    // Decay
    this.hitFlash  = Math.max(0, this.hitFlash  - dt * 3.5)
    this.missFlash = Math.max(0, this.missFlash - dt * 2)
    this.clipWarn  = Math.max(0, this.clipWarn  - dt * 2)

    // Particles
    for (const p of this.particles) {
      p.life += dt; p.x += p.vx * dt; p.y += p.vy * dt
      p.vy += 360 * dt; p.vx *= Math.max(0, 1 - 2 * dt)
    }
    this.particles = this.particles.filter(p => p.life < p.ttl)

    this.banners = this.banners.filter(b => !b.expired)
    if (this.gradeScreen?.expired) this.gradeScreen = null

    // DPS
    if (t - this.dpsLastUpdate >= 1000) {
      this.dpsDisplayTotal = Math.trunc(this.rhythm.liveTotalDps)
      this.dpsDisplayFist  = Math.trunc(this.rhythm.liveDps)
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
    this.drawHighway()
    this.drawHeader()
    this.drawFooter()
    this.drawDynamicWeaveWindows()
    this.drawHitZone()
    this.drawParticles()
    this.drawMissFlash()
    this.drawClipWarn()
    this.drawOffhandSwingTimer()
    this.drawBanners()
    if (this.gradeScreen) this.drawGradeScreen(this.gradeScreen)
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

  private drawHeader(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    ctx.fillStyle = PAL.headerFooter; ctx.fillRect(0, 0, w, HEADER_H)
    ctx.fillStyle = PAL.divider;      ctx.fillRect(0, HEADER_H - 1, w, 1)

    ctx.font = '600 12px "Inter", sans-serif'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = PAL.text
    ctx.fillText(this.charName || '—', 10, HEADER_H / 2)

    // Phase pill
    const phase = this.rhythm.inCombat ? 'COMBAT' : this.gradeScreen ? 'RESULT' : 'IDLE'
    const color = phase === 'COMBAT' ? PAL.combat : phase === 'RESULT' ? PAL.result : PAL.idle
    ctx.font = '600 9px "JetBrains Mono", monospace'
    const pw = ctx.measureText(phase).width + 12
    ctx.fillStyle = this.rgba(color, 0.15)
    this.roundRect(58, 5, pw, 14, 7); ctx.fill()
    ctx.fillStyle = color
    ctx.fillText(phase, 64, 12)

    // Buff indicators (Avatar, Savagery)
    let buffX = 58 + pw + 5
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
    }

    // Right-side
    ctx.textAlign = 'right'
    ctx.font = '600 11px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.text
    ctx.fillText(`${this.cfg.PUNCH_INTERVAL.toFixed(2)}s`, w - 70, HEADER_H / 2)
    ctx.font = '500 10px "JetBrains Mono", monospace'
    ctx.fillStyle = this.hasteCalibrated ? '#ffc844' : PAL.textDim
    ctx.fillText(`${this.cfg.HASTE_PCT.toFixed(0)}%`, w - 10, HEADER_H / 2)
    ctx.textAlign = 'left'
  }

  private drawFooter(): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    ctx.fillStyle = PAL.headerFooter; ctx.fillRect(0, h - FOOTER_H, w, FOOTER_H)
    ctx.fillStyle = PAL.divider;      ctx.fillRect(0, h - FOOTER_H, w, 1)
    ctx.textBaseline = 'middle'

    const fy = h - FOOTER_H / 2
    // WEAVES (left)
    ctx.font = '500 9px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.textDim
    ctx.fillText('WEAVES', 10, fy)
    const lw = ctx.measureText('WEAVES').width
    ctx.font = '600 11px "JetBrains Mono", monospace'
    ctx.fillStyle = PAL.text
    ctx.fillText(`${this.rhythm.roundsWithWeave}`, 10 + lw + 6, fy)

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
    const weaveMs    = Math.max(50, (this.cfg.PUNCH_INTERVAL - this.rhythm.effectiveOffhandDelay) * 1000)

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
      const winStart  = Math.max(swingTime, projectedNextReady)

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

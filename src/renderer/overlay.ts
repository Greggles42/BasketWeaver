/**
 * Basketweaver overlay renderer.
 * Runs in the Electron renderer process on a <canvas> via requestAnimationFrame.
 * Direct port of overlay.py + all draw helpers.
 */

import { Config, type ConfigType } from '../shared/config'
import { EvType, IPC, type GameEvent } from '../shared/events'
import { RhythmEngine, type Note, type GradeResult } from './rhythm-engine'
import { AudioManager } from './audio-manager'

// ── Timing helpers ────────────────────────────────────────────
const now = () => performance.now()

const COMBAT_IDLE_TIMEOUT_MS = 10_000

// ── Small animation objects ───────────────────────────────────

class Judgment {
  static DURATION_MS = 750
  text: string; color: string; x: number; y: number; born: number
  constructor(text: string, color: string, x: number, y: number) {
    this.text = text; this.color = color; this.x = x; this.y = y
    this.born = now()
  }
  get alpha() { return Math.max(0, 1 - (now() - this.born) / Judgment.DURATION_MS) }
  get offsetY() { return Math.trunc((1 - this.alpha) * -20) }
  get expired() { return this.alpha <= 0 }
}

class Banner {
  static FADE_IN  = 300
  static FADE_OUT = 500
  text: string; color: string; duration: number; born: number
  constructor(text: string, color: string, duration = 4000) {
    this.text = text; this.color = color; this.duration = duration
    this.born = now()
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
  static FADE_IN  = 400
  static HOLD     = 5000
  static FADE_OUT = 500
  result: GradeResult; born: number; dismissed = false
  constructor(result: GradeResult) { this.result = result; this.born = now() }
  dismiss() { this.dismissed = true }
  get alpha() {
    if (this.dismissed) return 0
    const age   = now() - this.born
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

interface Particle {
  x: number; y: number; vx: number; vy: number
  color: string; size: number; lifetime: number; born: number
}

interface Ring {
  x: number; y: number; color: string; maxR: number; lifetime: number; born: number
}

interface MissDrop {
  x: number; y: number; vy: number; radius: number; born: number
}

interface ClickMark { ts: number }

// ── Seeded pseudo-random (LCG, for deterministic particle generation) ──
function lcgRand(seed: { v: number }): number {
  seed.v = ((1664525 * seed.v + 1013904223) & 0x7fffffff)
  return seed.v / 0x7fffffff
}

// ── Canvas helpers ────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return [r, g, b]
}

function rgbaStr(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alpha.toFixed(3)})`
}

function lerpColor(hex1: string, hex2: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(hex1)
  const [r2, g2, b2] = hexToRgb(hex2)
  return `rgb(${Math.trunc(r1 + (r2 - r1) * t)},${Math.trunc(g1 + (g2 - g1) * t)},${Math.trunc(b1 + (b2 - b1) * t)})`
}

// ── Main Overlay class ────────────────────────────────────────

export class Overlay {
  private canvas: HTMLCanvasElement
  private ctx2d: CanvasRenderingContext2D
  private cfg: ConfigType
  private rhythm: RhythmEngine
  private audio: AudioManager

  // Layout
  private highwayY   = 0
  private highwayH   = 0
  private highwayCY  = 0   // horizontal center-y
  private highwayCX  = 0   // vertical center-x
  private swingBarY  = 0
  private footerY    = 0
  private hzX        = 0   // hit zone x (horizontal)
  private hzY        = 0   // hit zone y (vertical)
  private runway      = 0
  private speed       = 0   // smoothed display speed (px/ms)
  private targetSpeed = 0   // instantaneous speed from current interval

  // Instrumentation
  private swingLog: number[] = []          // perf timestamps of mainhand crush events
  private showInstrumentation = false

  // Rapid non-fistweaving detection — mute audio when crush spam without fist attacks
  private consecutiveCrushesWithoutFist = 0
  private audioMutedRapidAttack = false
  private rapidAttackMuteUntil = 0
  private static readonly RAPID_CRUSH_THRESHOLD = 4
  private static readonly RAPID_MUTE_MS         = 6000

  // Effects
  private judgments:  Judgment[]  = []
  private banners:    Banner[]    = []
  private gradeScreen: GradeScreen | null = null
  private lastGradeResult: GradeResult | null = null
  private fightHistory: GradeResult[] = []
  private hitFlash    = 0
  private flashColor  = Config.C_PERFECT
  private scoreDisplay = 0
  private particles:  Particle[] = []
  private rings:      Ring[]     = []
  private missDrops:  MissDrop[] = []
  private clickMarks: ClickMark[] = []

  private lastFrameTime = 0
  private lastCombatActivity = 0

  private highContrast = false
  private defaultColors: Partial<ConfigType> = {}

  pinned = true
  private oorLastSoundTs = 0
  private lastFistHitTs  = 0
  private static readonly HC_COLORS = {
    C_BG:     '#000000',
    C_HEADER: '#000000',
    C_FOOTER: '#000000',
  }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.ctx2d  = canvas.getContext('2d')!
    this.cfg    = Config
    this.rhythm = new RhythmEngine(Config)
    this.audio  = new AudioManager(Config)
    this.audio.preload()
    this.computeLayout()
  }

  // ── Entry point ───────────────────────────────────────────────

  start(): void {
    const TARGET_FRAME_MS = 1000 / 60
    this.lastFrameTime = now()
    const loop = (ts: number) => {
      requestAnimationFrame(loop)
      const elapsed = ts - this.lastFrameTime
      if (elapsed < TARGET_FRAME_MS - 0.5) return
      const dt = Math.min(elapsed / 1000, 0.1)
      this.lastFrameTime = ts
      this.update(dt)
      this.draw()
    }
    requestAnimationFrame(loop)
  }

  // ── IPC event from main process ───────────────────────────────

  handleGameEvent(ev: GameEvent): void {
    const ts = ev.ts

    switch (ev.type) {
      case EvType.COMBAT_START:
        if (!this.rhythm.inCombat) {
          this.rhythm.onCombatStart(performance.now())
          this.audio.play('combat_start')
          this.gradeScreen = null
          this.swingLog = []
          this.clearRapidAttackMute()
          this.oorLastSoundTs = 0
        }
        this.lastCombatActivity = ts
        break

      case EvType.MOB_DIED:
        if (this.rhythm.inCombat) {
          const result = this.rhythm.onCombatEnd(ts)
          result.mobName = (ev.data?.mobName as string) ?? ''
          this.lastGradeResult = result
          this.pushHistory(result)
          this.audio.play('combat_end')
          this.gradeScreen = new GradeScreen(result)
        }
        this.clearRapidAttackMute()
        break

      case EvType.COMBAT_END:
        // Silent end (zoned / logout) — stop tracking, no grade or sound
        if (this.rhythm.inCombat) {
          this.rhythm.onCombatEnd(ts)
        }
        this.clearRapidAttackMute()
        break

      case EvType.MAINHAND_CRUSH: {
        // Use renderer-side performance.now() so the orange bar position and
        // audio are anchored to the same clock, eliminating IPC timing drift.
        const crushTs = performance.now()
        const damage = ev.data?.damage as number ?? 0
        const hit    = ev.data?.hit    as boolean ?? false
        this.rhythm.onMainhandCrush(crushTs, damage, hit)
        this.lastCombatActivity = crushTs
        this.swingLog.push(crushTs)
        if (this.swingLog.length > 9) this.swingLog.shift()
        this.consecutiveCrushesWithoutFist++
        if (this.consecutiveCrushesWithoutFist >= Overlay.RAPID_CRUSH_THRESHOLD) {
          this.audioMutedRapidAttack = true
          this.rapidAttackMuteUntil = crushTs + Overlay.RAPID_MUTE_MS
          this.audio.setTemporaryMute(true)
        }
        if (!this.audioMutedRapidAttack) this.audio.play('crush')
        this.oorLastSoundTs = 0   // back in range — next OOR episode gets its own sound
        break
      }

      case EvType.FIST_ATTACK: {
        const fistNow = performance.now()   // renderer clock — matches crushTs for reaction time
        const adjTs   = ts - this.cfg.LATENCY_COMPENSATION * 1000
        const damage  = ev.data?.damage as number  ?? 0
        const hit     = ev.data?.hit    as boolean ?? false
        const isClip  = this.rhythm.onFistAttack(adjTs, damage, hit, fistNow)
        this.lastCombatActivity = ts
        this.consecutiveCrushesWithoutFist = 0
        if (this.audioMutedRapidAttack) {
          this.clearRapidAttackMute()
        }
        if (isClip) {
          this.showClipIndicator()
        } else {
          const [hzx, hzy] = this.hitZoneCenter()
          if (hit && damage > 0) {
            this.lastFistHitTs = now()
            this.audio.play('punch')
            this.spawnExplosion(hzx, hzy, this.cfg.C_PERFECT, true)
          } else {
            if (this.cfg.FIST_SOUND_ON_MISS) {
              // Delay slightly so a near-simultaneous hit from the other
              // dual-wield swing has time to update lastFistHitTs first.
              setTimeout(() => {
                if (now() - this.lastFistHitTs > 300) this.audio.play('whiff')
              }, 150)
            }
            this.spawnMissDrop(hzx, hzy)
          }
        }
        break
      }

      case EvType.CURSOR_BLOCKED: {
        this.audio.play('error')
        const [hzx, hzy] = this.hitZoneCenter()
        const [jx, jy] = this.cfg.ORIENTATION === 'horizontal'
          ? [hzx + 18, this.highwayY + 6]
          : [hzx + this.cfg.NOTE_RADIUS + 4, hzy - 12]
        this.judgments.push(new Judgment('CURSOR!', this.cfg.C_CLIP, jx, jy))
        this.showBanner('Item on cursor — weapon swap blocked', this.cfg.C_CLIP, 3000)
        break
      }

      case EvType.OUT_OF_RANGE: {
        this.rhythm.onOutOfRange(ts)
        this.showBanner('Out of range / no LoS — swing timer desynced', this.cfg.C_CLIP, 3000)
        const oorNow = now()
        if (this.rhythm.inCombat && oorNow - this.oorLastSoundTs > 1500) {
          this.oorLastSoundTs = oorNow
          this.audio.play('out_of_range')
        }
        break
      }

      case EvType.MOUSE_CLICK: {
        const adjTs = ts - this.cfg.LATENCY_COMPENSATION * 1000
        this.clickMarks.push({ ts: adjTs })
        this.doClickHit(adjTs)
        break
      }

      case EvType.WEAPON_DETECTED: {
        const name  = ev.data?.name  as string ?? ''
        const delay = ev.data?.delay as number ?? 20
        this.cfg.BASE_WEAPON_DELAY = delay
        const newInterval = this.rhythm.predictedInterval
        const fistDelay   = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW    = Math.max(0.2, newInterval - fistDelay) / 2
        this.cfg.PUNCH_INTERVAL = newInterval
        const msg = `Weapon: ${name}  (delay ${(delay / 10).toFixed(1)}s)`
        this.showBanner(msg, this.cfg.C_GOOD, 4000)
        break
      }

      case EvType.OFFHAND_DETECTED: {
        const name  = ev.data?.name  as string ?? ''
        const delay = ev.data?.delay as number ?? 16
        this.cfg.OFFHAND_WEAPON_DELAY = delay
        this.cfg.OFFHAND_WEAPON_NAME  = name
        ;(window as any).electronAPI?.saveSettings()
        const msg = `Offhand: ${name}  (${(delay / 10).toFixed(1)}s)`
        this.showBanner(msg, this.cfg.C_CLIP, 5000)
        break
      }

      case EvType.HASTE_DETECTED: {
        const hastePct = ev.data?.haste_pct as number ?? 0
        const interval = ev.data?.interval  as number ?? this.rhythm.predictedInterval
        this.cfg.HASTE_PCT      = hastePct
        this.cfg.PUNCH_INTERVAL = interval
        const fistDelay   = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW = Math.max(0.2, interval - fistDelay) / 2
        this.audio.play('combat_start')
        const msg = `Haste sync: ${interval.toFixed(2)}s  (${hastePct.toFixed(0)}% haste)`
        this.showBanner(msg, this.cfg.C_GOOD, 4000)
        break
      }
    }
  }

  handleKey(key: string): void {
    switch (key) {
      case 'Escape': window.electronAPI?.quit(); break
      case ' ':
        this.doHit(now())
        this.gradeScreen?.dismiss()
        break
      case 'm': case 'M': {
        const on = this.audio.toggle()
        console.log(`[Basketweaver] Audio ${on ? 'ON' : 'OFF'}`)
        break
      }
      case 'h': case 'H': this.toggleOrientation(); break
      case 'ArrowUp':   this.rhythm.adjustInterval(+0.25); break
      case 'ArrowDown': this.rhythm.adjustInterval(-0.25); break
      case ']': this.cfg.TARGET_OFFSET = Math.round(Math.min(1000, this.cfg.TARGET_OFFSET * 1000 + 25)) / 1000; break
      case '[': this.cfg.TARGET_OFFSET = Math.round(Math.max(0,    this.cfg.TARGET_OFFSET * 1000 - 25)) / 1000; break
      case "'": this.cfg.LATENCY_COMPENSATION = Math.round(Math.min(500, this.cfg.LATENCY_COMPENSATION * 1000 + 25)) / 1000; break
      case ';': this.cfg.LATENCY_COMPENSATION = Math.round(Math.max(0,   this.cfg.LATENCY_COMPENSATION * 1000 - 25)) / 1000; break
      case '.': this.cfg.HIT_ZONE_VISUAL_OFFSET += 5; break
      case ',': this.cfg.HIT_ZONE_VISUAL_OFFSET -= 5; break
      case 'r': case 'R':
        this.resetTrack()
        break
      case 'c': case 'C':
        this.rhythm.onCombatStart(now())
        this.rhythm.onMainhandCrush(now(), 100, true)
        this.audio.play('combat_start')
        this.gradeScreen = null
        break
      case 'e': case 'E':
        if (this.rhythm.inCombat) {
          const result = this.rhythm.onCombatEnd(now())
          this.lastGradeResult = result
          this.audio.play('combat_end')
          this.gradeScreen = new GradeScreen(result)
        }
        break
      case 'v': case 'V': this.copyToClipboard(); break
      case 'i': case 'I': this.showInstrumentation = !this.showInstrumentation; break
    }
  }

  // ── IPC commands from tray/main ───────────────────────────────

  toggleOrientation(): void {
    this.cfg.ORIENTATION = this.cfg.ORIENTATION === 'horizontal' ? 'vertical' : 'horizontal'
    this.resizeCanvas()
    this.computeLayout()
    window.electronAPI?.resizeWindow(
      this.cfg.ORIENTATION === 'vertical' ? this.cfg.VERT_WINDOW_WIDTH  : this.cfg.WINDOW_WIDTH,
      this.cfg.ORIENTATION === 'vertical' ? this.cfg.VERT_WINDOW_HEIGHT : this.cfg.WINDOW_HEIGHT,
    )
  }

  applyScale(pct: number): void {
    const { setScale } = require('../shared/config') as typeof import('../shared/config')
    setScale(this.cfg, pct)
    this.resizeCanvas()
    this.computeLayout()
    window.electronAPI?.resizeWindow(
      this.cfg.ORIENTATION === 'vertical' ? this.cfg.VERT_WINDOW_WIDTH  : this.cfg.WINDOW_WIDTH,
      this.cfg.ORIENTATION === 'vertical' ? this.cfg.VERT_WINDOW_HEIGHT : this.cfg.WINDOW_HEIGHT,
    )
  }

  applyTargetPosition(pct: number): void {
    this.cfg.TARGET_POSITION_PCT = pct
    // Keep HIT_ZONE_X in sync for any code that still reads it directly
    this.cfg.HIT_ZONE_X = Math.max(10,
      Math.trunc(this.cfg.WINDOW_WIDTH * pct / 100))
    this.computeLayout()
  }

  toggleFistMissSound(): void {
    this.cfg.FIST_SOUND_ON_MISS = !this.cfg.FIST_SOUND_ON_MISS
  }

  private pushHistory(result: GradeResult): void {
    this.fightHistory.unshift(result)   // newest first
    if (this.fightHistory.length > 5) this.fightHistory.length = 5
    // Send formatted history to main process for the tray submenu.
    const lines = this.fightHistory.map(r => {
      const mob   = r.mobName || 'Unknown'
      const react = r.avgReactionMs !== null ? `${r.avgReactionMs.toFixed(0)}ms` : '—'
      return `${r.grade}  ${r.roundsWeaved}/${r.totalRounds} rnds  +${r.addedDps.toFixed(0)}dps  ${react}  [${mob}]`
    })
    window.electronAPI?.sendFightHistory(lines)
  }

  toggleHighContrast(): void {
    const hc = Overlay.HC_COLORS
    if (!this.highContrast) {
      // Save originals and apply HC colors
      for (const key of Object.keys(hc) as Array<keyof typeof hc>) {
        (this.defaultColors as any)[key] = (this.cfg as any)[key];
        (this.cfg as any)[key] = hc[key]
      }
    } else {
      // Restore originals
      for (const key of Object.keys(hc) as Array<keyof typeof hc>) {
        (this.cfg as any)[key] = (this.defaultColors as any)[key]
      }
    }
    this.highContrast = !this.highContrast
  }

  // ── Layout ────────────────────────────────────────────────────

  private resizeCanvas(): void {
    const [w, h] = this.currentWindowSize()
    this.canvas.width  = w
    this.canvas.height = h
  }

  private currentWindowSize(): [number, number] {
    if (this.cfg.ORIENTATION === 'vertical') {
      return [this.cfg.VERT_WINDOW_WIDTH, this.cfg.VERT_WINDOW_HEIGHT]
    }
    return [this.cfg.WINDOW_WIDTH, this.cfg.WINDOW_HEIGHT]
  }

  private computeLayout(): void {
    const [w, h] = this.currentWindowSize()
    this.highwayY  = this.cfg.HEADER_H
    this.highwayH  = h - this.cfg.HEADER_H - this.cfg.SWING_BAR_H - this.cfg.FOOTER_H
    this.highwayCY = this.highwayY + Math.trunc(this.highwayH / 2)
    this.highwayCX = Math.trunc(w / 2)
    this.swingBarY = h - this.cfg.FOOTER_H - this.cfg.SWING_BAR_H
    this.footerY   = h - this.cfg.FOOTER_H

    if (this.cfg.ORIENTATION === 'horizontal') {
      this.hzX    = Math.max(10, Math.trunc(w * this.cfg.TARGET_POSITION_PCT / 100))
      this.hzY    = 0
      this.runway = w - this.hzX
    } else {
      this.hzX    = 0
      this.hzY    = this.highwayY + Math.trunc(this.highwayH * (1 - this.cfg.TARGET_POSITION_PCT / 100))
      this.runway = this.hzY - this.highwayY
    }
    this.speed = this.runway / (this.cfg.HIGHWAY_DURATION * 1000)
  }

  private hitZoneCenter(): [number, number] {
    const vo = this.cfg.HIT_ZONE_VISUAL_OFFSET
    if (this.cfg.ORIENTATION === 'horizontal') return [this.hzX + vo, this.highwayCY]
    return [this.highwayCX, this.hzY + vo]
  }

  // ── Note position ─────────────────────────────────────────────

  private noteScreenPos(targetTime: number, nowMs: number): [number, number] {
    const vo = this.cfg.HIT_ZONE_VISUAL_OFFSET
    if (this.cfg.ORIENTATION === 'horizontal') {
      return [Math.trunc(this.hzX + vo + (targetTime - nowMs) * this.speed), this.highwayCY]
    }
    return [this.highwayCX, Math.trunc(this.hzY + vo - (targetTime - nowMs) * this.speed)]
  }

  // ── Update ────────────────────────────────────────────────────

  private update(dt: number): void {
    const t = now()

    // Smoothly lerp display speed toward the target so interval changes
    // don't cause notes to jump position (stutter) on the highway.
    this.targetSpeed = this.runway / (4.0 * this.cfg.PUNCH_INTERVAL * 1000)
    if (this.speed === 0) {
      this.speed = this.targetSpeed   // snap on first frame — no lerp from zero
    } else {
      this.speed += (this.targetSpeed - this.speed) * Math.min(1, dt * 12)
    }

    // Auto combat-end idle timeout
    if (this.rhythm.inCombat && this.lastCombatActivity > 0
        && t - this.lastCombatActivity > COMBAT_IDLE_TIMEOUT_MS) {
      const result = this.rhythm.onCombatEnd(t)
      this.lastGradeResult = result
      this.audio.play('combat_end')
      this.gradeScreen = new GradeScreen(result)
      this.lastCombatActivity = 0
    }

    if (this.audioMutedRapidAttack && t > this.rapidAttackMuteUntil) {
      this.clearRapidAttackMute()
    }

    const prevMisses = this.rhythm.missCount
    this.rhythm.update(t)
    const newMisses = this.rhythm.missCount - prevMisses

    const [hzx, hzy] = this.hitZoneCenter()
    const [mjx, mjy] = this.cfg.ORIENTATION === 'horizontal'
      ? [hzx + 18, this.highwayY + 6]
      : [hzx + this.cfg.NOTE_RADIUS + 4, hzy - 12]

    // Tick particles and drops
    for (const p of this.particles) {
      p.x  += p.vx * dt
      p.y  += p.vy * dt
      p.vy += 360 * dt
      p.vx *= Math.max(0, 1 - 2 * dt)
    }
    for (const d of this.missDrops) {
      d.vy += 480 * dt
      d.y  += d.vy * dt
    }

    const pAge = (p: Particle) => Math.min(1, (t - p.born) / (p.lifetime * 1000))
    const rAge = (r: Ring)     => Math.min(1, (t - r.born) / (r.lifetime * 1000))
    const dAge = (d: MissDrop) => Math.min(1, (t - d.born) / 600)
    this.particles  = this.particles.filter(p => pAge(p) < 1)
    this.rings      = this.rings.filter(r => rAge(r) < 1)
    this.missDrops  = this.missDrops.filter(d => dAge(d) < 1)

    this.hitFlash = Math.max(0, this.hitFlash - dt * 3.5)
    this.judgments   = this.judgments.filter(j => !j.expired)
    this.banners     = this.banners.filter(b => !b.expired)
    this.clickMarks  = this.clickMarks.filter(cm =>
      t - cm.ts < (this.cfg.HIGHWAY_DURATION + 1) * 1000)

    const target = this.rhythm.score
    const gap = target - this.scoreDisplay
    if (gap > 0) this.scoreDisplay += Math.min(gap, gap * dt * 8 + 1)

    if (this.gradeScreen?.expired) this.gradeScreen = null
  }

  // ── Draw ──────────────────────────────────────────────────────

  private draw(): void {
    const ctx = this.ctx2d
    const w   = this.canvas.width
    const h   = this.canvas.height

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = this.cfg.C_BG
    ctx.fillRect(0, 0, w, h)

    this.drawHighway()
    this.drawResyncingNotice()

    this.drawWindowBar()
    this.drawNotes()
    this.drawHitZone()
    this.drawEffects()

    this.drawHeader()
    this.drawSwingBar()
    this.drawFooter()
    this.drawJudgments()
    this.drawBanners()
    if (this.gradeScreen) this.drawGradeScreen(this.gradeScreen)
    if (this.showInstrumentation) this.drawInstrumentation()
  }

  // ── Highway ───────────────────────────────────────────────────

  private drawHighway(): void {
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const w    = this.canvas.width
    const hy   = this.highwayY
    const hh   = this.highwayH

    ctx.fillStyle = '#12141e'
    ctx.fillRect(0, hy, w, hh)

    if (cfg.ORIENTATION === 'horizontal') {
      const cy       = this.highwayCY
      const lanePad  = Math.trunc(hh / 4)
      const glowH    = Math.trunc(hh / 2)

      // Center-lane glow
      const grad = ctx.createLinearGradient(0, hy + hh / 4, 0, hy + hh * 3 / 4)
      grad.addColorStop(0, 'rgba(28,34,62,0.08)')
      grad.addColorStop(0.5, 'rgba(28,34,62,0.14)')
      grad.addColorStop(1, 'rgba(28,34,62,0.08)')
      ctx.fillStyle = grad
      ctx.fillRect(0, hy + lanePad, w, glowH)

      // Scanlines (every 4px)
      ctx.strokeStyle = 'rgba(0,0,0,0.18)'
      ctx.lineWidth = 1
      for (let ly = hy; ly < hy + hh; ly += 4) {
        ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke()
      }

      ctx.strokeStyle = cfg.C_TRACK_LINE; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(0, hy + lanePad); ctx.lineTo(w, hy + lanePad); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(0, hy + hh - lanePad); ctx.lineTo(w, hy + hh - lanePad); ctx.stroke()
      ctx.strokeStyle = '#323864'
      ctx.beginPath(); ctx.moveTo(this.hzX + this.cfg.HIT_ZONE_VISUAL_OFFSET, cy); ctx.lineTo(w, cy); ctx.stroke()
    } else {
      const cx      = this.highwayCX
      const lanePad = Math.trunc(w / 4)

      const grad = ctx.createLinearGradient(w / 4, 0, w * 3 / 4, 0)
      grad.addColorStop(0, 'rgba(28,34,62,0.08)')
      grad.addColorStop(0.5, 'rgba(28,34,62,0.14)')
      grad.addColorStop(1, 'rgba(28,34,62,0.08)')
      ctx.fillStyle = grad
      ctx.fillRect(lanePad, hy, Math.trunc(w / 2), hh)

      ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 1
      for (let ly = hy; ly < hy + hh; ly += 4) {
        ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(w, ly); ctx.stroke()
      }

      ctx.strokeStyle = cfg.C_TRACK_LINE
      ctx.beginPath(); ctx.moveTo(lanePad, hy); ctx.lineTo(lanePad, hy + hh); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(w - lanePad, hy); ctx.lineTo(w - lanePad, hy + hh); ctx.stroke()
      ctx.strokeStyle = '#323864'
      ctx.beginPath(); ctx.moveTo(cx, hy); ctx.lineTo(cx, this.hzY + this.cfg.HIT_ZONE_VISUAL_OFFSET); ctx.stroke()
    }
  }

  // ── Hit zone ──────────────────────────────────────────────────

  private drawHitZone(): void {
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const [hzx, hzy] = this.hitZoneCenter()
    const hy   = this.highwayY
    const hh   = this.highwayH
    const flash = this.hitFlash

    if (cfg.ORIENTATION === 'horizontal') {
      // Glow strip
      if (flash > 0) {
        const grad = ctx.createLinearGradient(hzx - 24, 0, hzx + 24, 0)
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(0.5, rgbaStr(this.flashColor, flash * 0.4))
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.fillRect(hzx - 24, hy, 48, hh)
      }
      // Gold line
      ctx.strokeStyle = flash > 0 ? rgbaStr(cfg.C_HIT_GLOW, 0.7 + flash * 0.3) : cfg.C_HIT_ZONE
      ctx.lineWidth = flash > 0 ? 3 : 2
      ctx.beginPath(); ctx.moveTo(hzx, hy); ctx.lineTo(hzx, hy + hh); ctx.stroke()

      // Gold dot on center
      ctx.beginPath()
      ctx.arc(hzx, hzy, 5, 0, Math.PI * 2)
      ctx.fillStyle = flash > 0 ? rgbaStr(cfg.C_HIT_GLOW, 1) : cfg.C_HIT_ZONE
      ctx.fill()
    } else {
      if (flash > 0) {
        const w = this.canvas.width
        const grad = ctx.createLinearGradient(0, hzy - 24, 0, hzy + 24)
        grad.addColorStop(0, 'rgba(0,0,0,0)')
        grad.addColorStop(0.5, rgbaStr(this.flashColor, flash * 0.4))
        grad.addColorStop(1, 'rgba(0,0,0,0)')
        ctx.fillStyle = grad
        ctx.fillRect(0, hzy - 24, w, 48)
      }
      const w = this.canvas.width
      ctx.strokeStyle = flash > 0 ? rgbaStr(cfg.C_HIT_GLOW, 0.7 + flash * 0.3) : cfg.C_HIT_ZONE
      ctx.lineWidth = flash > 0 ? 3 : 2
      ctx.beginPath(); ctx.moveTo(0, hzy); ctx.lineTo(w, hzy); ctx.stroke()

      // Ring
      ctx.beginPath()
      ctx.arc(hzx, hzy, 7, 0, Math.PI * 2)
      ctx.strokeStyle = flash > 0 ? rgbaStr(cfg.C_HIT_GLOW, 1) : cfg.C_HIT_ZONE
      ctx.lineWidth = 2
      ctx.stroke()
    }
  }

  // ── Notes ─────────────────────────────────────────────────────

  private drawNotes(): void {
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const t    = now()
    const w    = this.canvas.width
    const h    = this.canvas.height
    const r    = cfg.NOTE_RADIUS
    const vert = cfg.ORIENTATION === 'vertical'
    const [hzx, hzy] = this.hitZoneCenter()
    const rhy  = this.rhythm

    // Sort upcoming active notes by target time so we can assign opacity by rank.
    // Index 0 = nearest (full), 1 = next (50%), 2 = next+1 (25%), rest hidden.
    const upcomingActive = rhy.swingTimerValid
      ? rhy.notes
          .filter(n => n.state === 'active')
          .sort((a, b) => a.targetTime - b.targetTime)
      : []
    const UPCOMING_ALPHAS = [1.0, 0.55, 0.28, 0.12, 0.06]
    // Notes beyond the canvas edge fade in over this distance (px) as they scroll into view.
    const entryFade = Math.trunc(this.runway / 4)

    for (const note of rhy.notes) {
      const [nx, ny] = this.noteScreenPos(note.targetTime, t)

      // Extend the clip zone so off-screen notes can fade in before entering.
      if (vert) { if (ny < this.highwayY - entryFade - r || ny > h + r * 2) continue }
      else { if (nx > w + entryFade + r || nx < -r * 4) continue }

      if (note.state === 'active') {
        const rank = upcomingActive.indexOf(note)
        if (rank < 0 || rank >= UPCOMING_ALPHAS.length) continue
        let opacity = UPCOMING_ALPHAS[rank]
        // Smooth fade-in as the note crosses the canvas edge.
        if (!vert && nx > w) opacity *= Math.max(0, 1 - (nx - w) / entryFade)
        if (vert  && ny < this.highwayY) opacity *= Math.max(0, 1 - (this.highwayY - ny) / entryFade)
        if (opacity < 0.01) continue
        if (cfg.VISUAL_MODE !== 2) {
          if (rank === 0) this.drawSwingMarker(nx, ny)
          this.drawActiveNote(nx, ny, r, opacity)
        }
      } else if (note.state === 'hit' || note.state === 'clipped') {
        const age = (t - (note.hitTime ?? note.targetTime)) / 1000
        if (age < 0.40) this.drawHitNote(hzx, hzy, r, note.state, age)
      }
    }

    // Click marks — small triangles
    const C_CLICK = '#ffa028'
    for (const cm of this.clickMarks) {
      const [cx, cy] = this.noteScreenPos(cm.ts, t)
      const age   = t - cm.ts
      const alpha = Math.max(0, 1 - age / ((cfg.HIGHWAY_DURATION + 0.5) * 1000))
      if (alpha <= 0) continue
      if (vert) {
        if (cy < this.highwayY - 8 || cy > h + 8) continue
        ctx.strokeStyle = rgbaStr(C_CLICK, alpha)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx - 5, cy); ctx.lineTo(cx + 5, cy); ctx.lineTo(cx, cy - 7)
        ctx.closePath(); ctx.stroke()
      } else {
        if (cx < -8 || cx > w + 8) continue
        ctx.strokeStyle = rgbaStr(C_CLICK, alpha)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(cx - 4, cy + 6); ctx.lineTo(cx + 4, cy + 6); ctx.lineTo(cx, cy - 2)
        ctx.closePath(); ctx.stroke()
      }
    }
  }

  private drawActiveNote(x: number, y: number, r: number, opacity = 1.0): void {
    const ctx = this.ctx2d
    const cfg = this.cfg

    // Outer glow (skip for ghost notes — keeps them clean and distinct)
    if (opacity > 0.6) {
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r * 3.5)
      grad.addColorStop(0, rgbaStr(cfg.C_NOTE_GLOW, 0.25 * opacity))
      grad.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = grad
      ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8)
    }

    // Outer circle — ghost notes render as outline only
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
    if (opacity > 0.6) {
      ctx.fillStyle = rgbaStr(cfg.C_NOTE, opacity); ctx.fill()
      ctx.strokeStyle = rgbaStr(cfg.C_NOTE_GLOW, opacity); ctx.lineWidth = 2; ctx.stroke()
      // Inner bright dot
      ctx.beginPath(); ctx.arc(x, y, Math.max(1, r * 0.5), 0, Math.PI * 2)
      ctx.fillStyle = rgbaStr(cfg.C_NOTE_INNER, opacity); ctx.fill()
    } else {
      ctx.strokeStyle = rgbaStr(cfg.C_NOTE, opacity); ctx.lineWidth = 1.5; ctx.stroke()
    }
  }

  private drawHitNote(x: number, y: number, r: number, state: string, age: number): void {
    const ctx   = this.ctx2d
    const cfg   = this.cfg
    const alpha = Math.max(0, 1 - age / 0.40)
    const color = state === 'clipped' ? cfg.C_CLIP : cfg.C_GOOD
    const gr    = r * (1 + age * 3)

    ctx.beginPath(); ctx.arc(x, y, gr, 0, Math.PI * 2)
    ctx.strokeStyle = rgbaStr(color, alpha * 0.5)
    ctx.lineWidth = 2; ctx.stroke()

    ctx.beginPath(); ctx.arc(x, y, Math.max(1, r * 0.5 * alpha), 0, Math.PI * 2)
    ctx.fillStyle = rgbaStr(color, alpha); ctx.fill()
  }

  private drawMissedNote(x: number, y: number, r: number, age: number): void {
    const ctx   = this.ctx2d
    const cfg   = this.cfg
    const alpha = Math.max(0, 1 - age / 0.45)
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.strokeStyle = rgbaStr(cfg.C_MISS, alpha * 0.7)
    ctx.lineWidth = 2; ctx.stroke()
  }

  private drawSwingMarker(noteX: number, noteY: number): void {
    const ctx    = this.ctx2d
    const cfg    = this.cfg
    const vert   = cfg.ORIENTATION === 'vertical'
    const offset = cfg.TARGET_OFFSET * this.speed * 1000
    let mx: number, my: number

    if (vert) { mx = noteX; my = noteY + offset }
    else       { mx = noteX - offset; my = noteY }

    const vo   = this.cfg.HIT_ZONE_VISUAL_OFFSET
    const past = vert ? (my > this.hzY + vo) : (mx < this.hzX + vo)
    const dist = past ? (vert ? my - (this.hzY + vo) : (this.hzX + vo) - mx) : 0
    const alpha = Math.max(0, 1 - dist / 35) * (210 / 255)
    if (alpha <= 0) return

    const w = this.canvas.width; const h = this.canvas.height
    if (vert) { if (my < this.highwayY - 12 || my > h + 12) return }
    else      { if (mx < -12 || mx > w + 12) return }

    // Connecting line
    ctx.strokeStyle = rgbaStr(cfg.C_HIT_ZONE, alpha * 0.45)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(mx, my); ctx.lineTo(noteX, noteY); ctx.stroke()

    // Diamond
    const s = 5
    ctx.save()
    ctx.translate(mx, my)
    ctx.rotate(Math.PI / 4)
    ctx.fillStyle = rgbaStr(cfg.C_HIT_ZONE, alpha)
    ctx.fillRect(-s, -s, s * 2, s * 2)
    ctx.restore()

    // Bright centre dot
    ctx.beginPath(); ctx.arc(mx, my, 2, 0, Math.PI * 2)
    ctx.fillStyle = rgbaStr('#fffdc8', alpha * 0.8); ctx.fill()
  }

  // ── Window bar (mode 2) ───────────────────────────────────────

  private drawWindowBar(): void {
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const rhy  = this.rhythm
    const t    = now()
    const vert = cfg.ORIENTATION === 'vertical'
    const w    = this.canvas.width
    const h    = this.canvas.height
    const hy   = this.highwayY
    const hh   = this.highwayH

    if (!rhy.inCombat || !rhy.swingTimerValid) return

    const interval_ms  = cfg.PUNCH_INTERVAL * 1000
    const offhandDelay = rhy.effectiveOffhandDelay                          // seconds
    const windowSec    = Math.max(0.05, cfg.PUNCH_INTERVAL - offhandDelay) // weave window
    const windowPx     = windowSec * this.speed * 1000                     // pixels

    // During an open round nextSwingTime is stale. Recompute from lastCrushTime.
    const nextSwing = rhy.roundOpen
      ? rhy.lastCrushTime + interval_ms
      : rhy.nextSwingTime

    // Swing times: k=0 → last swing (may still be on screen), k=1 → next, k=2 → one beyond
    //   swingTime_k = nextSwing + (k - 1) * interval
    const hc = this.highContrast
    const GREEN_FILL  = hc
      ? ['rgba(0,210,0,0.88)', 'rgba(0,210,0,0.55)', 'rgba(0,210,0,0.28)']
      : ['rgba(25,90,50,0.50)', 'rgba(25,90,50,0.25)', 'rgba(25,90,50,0.12)']
    const GREEN_STRK  = hc
      ? ['rgba(0,255,0,1.0)',   'rgba(0,255,0,0.75)',  'rgba(0,255,0,0.45)']
      : ['rgba(60,200,90,0.70)','rgba(60,200,90,0.38)','rgba(60,200,90,0.18)']
    const ORANGE_A    = [0.95, 0.55, 0.28]
    const strokeW     = hc ? 2 : 1

    let rank = 0
    for (let k = 0; rank < 3 && k < 10; k++) {
      const swingTime      = nextSwing + (k - 1) * interval_ms
      const [swingX, swingY] = this.noteScreenPos(swingTime, t)

      if (vert) {
        // In vertical mode: future = UP (smaller y). Weave window spans from
        // swingTime upward (into the future runway) by windowPx.
        const barH = Math.max(4, windowPx)
        const barY = swingY - barH   // top of green box (end of weave window, future)
        const barW = Math.max(6, w - 8)
        const barX = (w - barW) / 2

        if (swingY < hy) break       // swing is above highway top — further future also above
        if (barY > h) continue       // entire box is below canvas — try next k

        // Green weave window box
        ctx.fillStyle = GREEN_FILL[rank]
        ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.fill()
        ctx.strokeStyle = GREEN_STRK[rank]; ctx.lineWidth = strokeW
        ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.stroke()

        // Orange mainhand swing marker at bottom of green box (the swing time itself)
        ctx.fillStyle = `rgba(255,140,20,${ORANGE_A[rank]})`
        ctx.fillRect(barX - 2, swingY - 1, barW + 4, 3)
      } else {
        // In horizontal mode: future = RIGHT (larger x). Weave window spans from
        // swingTime rightward (into the approaching runway) by windowPx.
        const barW = Math.max(4, windowPx)
        const barX = swingX          // left edge = mainhand swing time
        const barH = Math.max(6, hh - 8)
        const barY = hy + (hh - barH) / 2

        if (barX + barW < 0) continue  // scrolled off left — skip
        if (barX > w) break             // beyond right edge — nothing further visible

        // Green weave window box
        ctx.fillStyle = GREEN_FILL[rank]
        ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.fill()
        ctx.strokeStyle = GREEN_STRK[rank]; ctx.lineWidth = strokeW
        ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 3); ctx.stroke()

        // Orange mainhand swing marker at left edge of green box (the swing time itself)
        ctx.fillStyle = `rgba(255,140,20,${ORANGE_A[rank]})`
        ctx.fillRect(swingX - 1, barY - 2, 3, barH + 4)
      }

      rank++
    }
  }

  // ── Effects ───────────────────────────────────────────────────

  private drawEffects(): void {
    const ctx = this.ctx2d
    const t   = now()

    // Rings
    for (const ring of this.rings) {
      const tr = Math.min(1, (t - ring.born) / (ring.lifetime * 1000))
      const radius = Math.trunc(ring.maxR * (1 - (1 - tr) ** 2.2))
      const alpha  = 230 / 255 * (1 - tr) ** 2
      if (alpha <= 0 || radius <= 0) continue
      ctx.beginPath(); ctx.arc(ring.x, ring.y, radius, 0, Math.PI * 2)
      ctx.strokeStyle = rgbaStr(ring.color, alpha); ctx.lineWidth = 3; ctx.stroke()
    }

    // Fist-miss drops — grey circles falling from hit zone
    for (const drop of this.missDrops) {
      const tr    = Math.min(1, (t - drop.born) / 600)
      const alpha = 0.55 * (1 - tr) ** 1.4
      if (alpha <= 0) continue
      ctx.beginPath(); ctx.arc(drop.x, drop.y, drop.radius, 0, Math.PI * 2)
      ctx.fillStyle = `rgba(130,130,140,${alpha})`; ctx.fill()
    }

    // Spark particles
    for (const p of this.particles) {
      const tr    = Math.min(1, (t - p.born) / (p.lifetime * 1000))
      const alpha = 255 / 255 * (1 - tr) ** 1.6
      if (alpha <= 0) continue
      const r = Math.max(1, Math.trunc(p.size))
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2)
      ctx.fillStyle = rgbaStr(p.color, alpha); ctx.fill()
    }
  }

  // ── Resyncing notice ──────────────────────────────────────────

  private drawResyncingNotice(): void {
    const rhy = this.rhythm
    if (!rhy.inCombat || rhy.swingTimerValid || !(rhy as any).notesAnchored) return
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const vert = cfg.ORIENTATION === 'vertical'
    const w    = this.canvas.width

    ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
    const text = '⟳ SWING TIMER RESYNCING'
    const tm   = ctx.measureText(text)
    const tw   = tm.width
    const th   = cfg.FONT_SM + 4

    let bx: number, by: number
    if (vert) {
      bx = this.highwayCX - tw / 2 - 4
      by = this.highwayY + Math.trunc(this.highwayH / 4) - th / 2 - 2
    } else {
      bx = w / 2 - tw / 2 - 4
      by = this.highwayY + 2
    }

    ctx.fillStyle = 'rgba(10,10,20,0.7)'
    ctx.beginPath(); ctx.roundRect(bx, by, tw + 8, th + 4, 3); ctx.fill()
    ctx.fillStyle = '#ffa028'
    ctx.fillText(text, bx + 4, by + th)
  }

  // ── Timeline (mode 3) ─────────────────────────────────────────

  private drawTimeline(): void {
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const rhy  = this.rhythm
    const t    = now()
    const vert = cfg.ORIENTATION === 'vertical'
    const w    = this.canvas.width
    const cy   = this.highwayY + Math.trunc(this.highwayH / 2)

    let trackX: number, trackY: number, trackW: number, trackH: number
    if (vert) {
      trackW = 80; trackH = this.highwayH - 40
      trackX = this.highwayCX - trackW / 2
      trackY = this.highwayY + 20
    } else {
      trackH = 80; trackW = w - 60
      trackX = 30; trackY = cy - trackH / 2
    }

    const zoneRect = (f0: number, f1: number) =>
      vert
        ? { x: trackX, y: trackY + f0 * trackH, w: trackW, h: Math.max(1, (f1 - f0) * trackH) }
        : { x: trackX + f0 * trackW, y: trackY, w: Math.max(1, (f1 - f0) * trackW), h: trackH }

    const fillZone = (f0: number, f1: number, color: string, alpha: number, radius = 4) => {
      const z = zoneRect(f0, f1)
      ctx.fillStyle = color.startsWith('#') ? rgbaStr(color, alpha) : color
      ctx.beginPath(); ctx.roundRect(z.x, z.y, z.w, z.h, radius); ctx.fill()
    }

    const fullZ = zoneRect(0, 1)

    if (!rhy.inCombat || !(rhy as any).notesAnchored) {
      ctx.fillStyle = '#16182a'; ctx.beginPath()
      ctx.roundRect(fullZ.x, fullZ.y, fullZ.w, fullZ.h, 6); ctx.fill()
      ctx.strokeStyle = cfg.C_TRACK_LINE; ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(fullZ.x, fullZ.y, fullZ.w, fullZ.h, 6); ctx.stroke()
      ctx.fillStyle = cfg.C_TEXT_DIM; ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      const msg = rhy.inCombat ? 'Waiting for mainhand swing…' : 'Not in combat'
      const mw  = ctx.measureText(msg).width
      ctx.fillText(msg, fullZ.x + (fullZ.w - mw) / 2, fullZ.y + fullZ.h / 2 + cfg.FONT_SM / 2)
      return
    }

    if (!rhy.swingTimerValid) {
      ctx.fillStyle = '#1e1606'; ctx.beginPath()
      ctx.roundRect(fullZ.x, fullZ.y, fullZ.w, fullZ.h, 6); ctx.fill()
      ctx.strokeStyle = cfg.C_CLIP; ctx.lineWidth = 1
      ctx.beginPath(); ctx.roundRect(fullZ.x, fullZ.y, fullZ.w, fullZ.h, 6); ctx.stroke()
      ctx.fillStyle = cfg.C_CLIP; ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      const msg = '⟳ SWING TIMER RESYNCING…'
      const mw  = ctx.measureText(msg).width
      ctx.fillText(msg, fullZ.x + (fullZ.w - mw) / 2, fullZ.y + fullZ.h / 2 + cfg.FONT_SM / 2)
      return
    }

    const interval   = cfg.PUNCH_INTERVAL
    const elapsed    = (t - (rhy as any).lastRoundCloseTime) / 1000
    const posFrac    = Math.min(1.02, elapsed / interval)
    const winS       = Math.max(0, (cfg.TARGET_OFFSET - cfg.GOOD_WINDOW) / interval)
    const winE       = Math.min(1, (cfg.TARGET_OFFSET + cfg.GOOD_WINDOW) / interval)
    const dngS       = Math.min(1, Math.max(winE + 0.01, 1 - rhy.effectiveOffhandDelay / interval))

    ctx.fillStyle = '#12141e'; ctx.beginPath()
    ctx.roundRect(fullZ.x, fullZ.y, fullZ.w, fullZ.h, 6); ctx.fill()

    if (winS > 0.001)  fillZone(0, winS,     'rgba(25,35,70,0.63)',     1, 4)
    fillZone(winS, winE,   'rgba(25,120,55,0.82)',    1, 4)
    ctx.strokeStyle = 'rgba(60,200,90,0.6)'; ctx.lineWidth = 1
    const gZ = zoneRect(winS, winE)
    ctx.beginPath(); ctx.roundRect(gZ.x, gZ.y, gZ.w, gZ.h, 4); ctx.stroke()

    if (winE < dngS - 0.01) fillZone(winE, dngS, 'rgba(110,88,12,0.59)', 1, 4)
    if (dngS < 1.0)        fillZone(dngS, 1,    'rgba(130,28,28,0.75)', 1, 4)

    // Reequip deadline line
    ctx.strokeStyle = cfg.C_HIT_ZONE; ctx.lineWidth = 2
    if (vert) {
      const ry = trackY + winE * trackH
      ctx.beginPath(); ctx.moveTo(trackX - 3, ry); ctx.lineTo(trackX + trackW + 3, ry); ctx.stroke()
    } else {
      const rx = trackX + winE * trackW
      ctx.beginPath(); ctx.moveTo(rx, trackY - 3); ctx.lineTo(rx, trackY + trackH + 3); ctx.stroke()
    }

    ctx.strokeStyle = cfg.C_TRACK_LINE; ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(fullZ.x, fullZ.y, fullZ.w, fullZ.h, 6); ctx.stroke()

    // Position colour
    let posCol: string
    if (posFrac >= dngS)       posCol = cfg.C_SWING_CRIT
    else if (posFrac > winE)   posCol = cfg.C_SWING_WARN
    else if (posFrac >= winS)  posCol = cfg.C_SWING_SAFE
    else                       posCol = cfg.C_TEXT_DIM

    const posClamped = Math.min(1, posFrac)
    const ts = 7

    if (vert) {
      const py = trackY + posClamped * trackH
      ctx.strokeStyle = posCol; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(trackX - 8, py); ctx.lineTo(trackX + trackW + 8, py); ctx.stroke()
      ctx.fillStyle = posCol
      ctx.beginPath()
      ctx.moveTo(trackX - 16 - ts, py - ts)
      ctx.lineTo(trackX - 16 + ts, py - ts)
      ctx.lineTo(trackX - 16, py + ts)
      ctx.closePath(); ctx.fill()

      const rem = Math.max(0, interval - elapsed)
      ctx.fillStyle = posCol; ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      ctx.fillText(`${rem.toFixed(1)}s`, trackX + trackW + 6, py + cfg.FONT_SM / 2)
    } else {
      const px = trackX + posClamped * trackW
      ctx.strokeStyle = posCol; ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(px, trackY - 8); ctx.lineTo(px, trackY + trackH + 8); ctx.stroke()
      ctx.fillStyle = posCol
      ctx.beginPath()
      ctx.moveTo(px - ts, trackY - 12 - ts)
      ctx.lineTo(px - ts, trackY - 12 + ts)
      ctx.lineTo(px + ts, trackY - 12)
      ctx.closePath(); ctx.fill()

      const rem = Math.max(0, interval - elapsed)
      ctx.fillStyle = posCol; ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      const remW = ctx.measureText(`${rem.toFixed(1)}s`).width
      ctx.fillText(`${rem.toFixed(1)}s`, px - remW / 2, trackY + trackH + cfg.FONT_SM + 2)
    }

    // Zone labels
    ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
    if (vert) {
      const unY = trackY + winS * trackH
      ctx.fillStyle = 'rgba(100,240,120,0.8)'
      ctx.fillText('UNEQUIP', trackX + trackW + 6, unY + cfg.FONT_SM / 2)
      const reY = trackY + winE * trackH
      ctx.fillStyle = 'rgba(255,200,40,0.8)'
      ctx.fillText('REEQUIP', trackX + trackW + 6, reY + cfg.FONT_SM / 2)
    } else {
      const unX = trackX + winS * trackW
      ctx.fillStyle = 'rgba(100,240,120,0.8)'
      ctx.fillText('UNEQUIP', unX, trackY + trackH + cfg.FONT_SM + 2)
      const reX = trackX + winE * trackW
      ctx.fillStyle = 'rgba(255,200,40,0.8)'
      const reW = ctx.measureText('REEQUIP').width
      ctx.fillText('REEQUIP', reX - reW / 2, trackY + trackH + cfg.FONT_SM + 2)
    }
  }

  // ── Swing timer mode (mode 4) ─────────────────────────────────

  private drawSwingTimerMode(): void {
    const ctx  = this.ctx2d
    const cfg  = this.cfg
    const rhy  = this.rhythm
    const t    = now()
    const vert = cfg.ORIENTATION === 'vertical'
    const w    = this.canvas.width
    const hy   = this.highwayY
    const hh   = this.highwayH

    const interval = rhy.predictedInterval
    if (interval <= 0) return

    const lastClose = (rhy as any).lastRoundCloseTime as number
    let progress = 0, elapsed = 0
    if (lastClose > 0 && rhy.swingTimerValid) {
      elapsed  = (t - lastClose) / 1000
      progress = Math.min(1, Math.max(0, elapsed / interval))
    }

    const valid = rhy.swingTimerValid && rhy.inCombat
    let barColor: string
    if (!valid) {
      barColor = cfg.C_IDLE
    } else if (progress < 0.6) {
      barColor = cfg.C_SWING_SAFE
    } else if (progress < 0.85) {
      barColor = lerpColor(cfg.C_SWING_SAFE, cfg.C_SWING_WARN, (progress - 0.6) / 0.25)
    } else {
      barColor = lerpColor(cfg.C_SWING_WARN, cfg.C_SWING_CRIT, (progress - 0.85) / 0.15)
    }

    const pad = Math.max(2, Math.trunc(hh / 6))

    if (!vert) {
      const barW = Math.trunc(w * progress)
      ctx.fillStyle = 'rgba(18,20,38,0.47)'
      ctx.beginPath(); ctx.roundRect(0, hy + pad, w, hh - pad * 2, 4); ctx.fill()
      if (barW > 0) {
        ctx.fillStyle = rgbaStr(barColor, 0.71)
        ctx.beginPath(); ctx.roundRect(0, hy + pad, barW, hh - pad * 2, 4); ctx.fill()
        ctx.strokeStyle = barColor; ctx.lineWidth = 1
        ctx.beginPath(); ctx.roundRect(0, hy + pad, barW, hh - pad * 2, 4); ctx.stroke()
        if (valid) {
          ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(barW, hy + pad); ctx.lineTo(barW, hy + hh - pad); ctx.stroke()
        }
      }
      const rem = Math.max(0, interval - elapsed)
      ctx.fillStyle = cfg.C_TEXT; ctx.font = `${cfg.FONT_LG}px Consolas, monospace`
      const label = `${rem.toFixed(2)}s`
      const lw    = ctx.measureText(label).width
      ctx.fillText(label, (w - lw) / 2, hy + hh / 2 + cfg.FONT_LG / 2)
    } else {
      const barH = Math.trunc(hh * progress)
      ctx.fillStyle = 'rgba(18,20,38,0.47)'
      ctx.beginPath(); ctx.roundRect(pad, hy, w - pad * 2, hh, 4); ctx.fill()
      if (barH > 0) {
        ctx.fillStyle = rgbaStr(barColor, 0.71)
        ctx.beginPath(); ctx.roundRect(pad, hy, w - pad * 2, barH, 4); ctx.fill()
        ctx.strokeStyle = barColor; ctx.lineWidth = 1
        ctx.beginPath(); ctx.roundRect(pad, hy, w - pad * 2, barH, 4); ctx.stroke()
        if (valid) {
          const ly = hy + barH
          ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 2
          ctx.beginPath(); ctx.moveTo(pad, ly); ctx.lineTo(w - pad, ly); ctx.stroke()
        }
      }
      const rem = Math.max(0, interval - elapsed)
      ctx.fillStyle = cfg.C_TEXT; ctx.font = `${cfg.FONT_LG}px Consolas, monospace`
      const label = `${rem.toFixed(2)}s`
      const lw    = ctx.measureText(label).width
      ctx.fillText(label, (w - lw) / 2, hy + hh / 2 + cfg.FONT_LG / 2)
    }
  }

  // ── Swing bar (reequip countdown strip) ───────────────────────

  private drawSwingBar(): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    const rhy = this.rhythm
    const t   = now()
    const w   = this.canvas.width
    const y   = this.swingBarY
    const h   = cfg.SWING_BAR_H

    ctx.fillStyle = cfg.C_HEADER
    ctx.fillRect(0, y, w, h)
    ctx.strokeStyle = cfg.C_TRACK_LINE; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()

    const barH = Math.max(2, h - 4)
    const barY = y + Math.trunc((h - barH) / 2)

    const showLabel = h >= 12
    let barX = 4
    if (showLabel) {
      ctx.fillStyle = cfg.C_TEXT_DIM
      ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      ctx.fillText('REEQUIP', 6, y + h / 2 + cfg.FONT_SM / 2)
      barX = ctx.measureText('REEQUIP').width + 12
    }
    const barW = Math.max(4, w - barX - 4)

    if (!rhy.inCombat || !(rhy as any).notesAnchored) {
      ctx.fillStyle = '#16182c'
      ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 2); ctx.fill()
      return
    }
    if (!rhy.swingTimerValid) {
      ctx.fillStyle = '#281e0a'
      ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 2); ctx.fill()
      if (showLabel) {
        ctx.fillStyle = 'rgba(180,140,40,0.8)'; ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
        const dw = ctx.measureText('DESYNCED').width
        ctx.fillText('DESYNCED', barX + (barW - dw) / 2, barY + barH / 2 + cfg.FONT_SM / 2)
      }
      return
    }

    const lastClose = (rhy as any).lastRoundCloseTime as number
    const elapsed = (t - lastClose) / 1000
    const fill    = Math.min(1, elapsed / cfg.PUNCH_INTERVAL)

    let barColor: string
    if (fill < 0.70)      barColor = cfg.C_SWING_SAFE
    else if (fill < 0.90) barColor = cfg.C_SWING_WARN
    else                  barColor = cfg.C_SWING_CRIT

    ctx.fillStyle = '#16182c'
    ctx.beginPath(); ctx.roundRect(barX, barY, barW, barH, 2); ctx.fill()
    const fillW = Math.max(2, Math.trunc(barW * fill))
    ctx.fillStyle = barColor
    ctx.beginPath(); ctx.roundRect(barX, barY, fillW, barH, 2); ctx.fill()

    if (showLabel) {
      const rem = Math.max(0, cfg.PUNCH_INTERVAL - elapsed)
      ctx.fillStyle = cfg.C_TEXT_DIM; ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      const tw = ctx.measureText(`${rem.toFixed(1)}s`).width
      ctx.fillText(`${rem.toFixed(1)}s`, barX + barW - tw - 2, barY + barH / 2 + cfg.FONT_SM / 2)
    }
  }

  // ── Header ────────────────────────────────────────────────────

  private drawHeader(): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    const rhy = this.rhythm
    const w   = this.canvas.width
    const h   = cfg.HEADER_H

    ctx.fillStyle = cfg.C_HEADER
    ctx.fillRect(0, 0, w, h)
    ctx.strokeStyle = cfg.C_TRACK_LINE; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, h); ctx.lineTo(w, h); ctx.stroke()

    const scoreText = rhy.inCombat
      ? `${Math.trunc(this.scoreDisplay).toLocaleString()} pts  x${rhy.combo}`
      : '—'
    const statusColor = rhy.inCombat ? cfg.C_COMBAT : cfg.C_IDLE
    ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
    ctx.fillStyle = statusColor
    ctx.fillText(rhy.inCombat ? '⚔ COMBAT' : '○ IDLE', 4, h / 2 + cfg.FONT_SM / 2)

    // Pin icon at far right
    this.drawPinIcon(w - h, 0, h)

    ctx.fillStyle = cfg.C_TEXT
    const sw = ctx.measureText(scoreText).width
    ctx.fillText(scoreText, w - h - sw - 4, h / 2 + cfg.FONT_SM / 2)
  }

  private drawPinIcon(x: number, y: number, size: number): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    const cx  = x + size / 2
    const cy  = y + size / 2
    const r   = Math.max(2, size * 0.24)
    const color = this.pinned ? cfg.C_COMBAT : cfg.C_TEXT_DIM

    // Pin head
    ctx.beginPath()
    ctx.arc(cx, cy - r * 0.5, r, 0, Math.PI * 2)
    if (this.pinned) {
      ctx.fillStyle = color
      ctx.fill()
    } else {
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.stroke()
    }

    // Needle
    ctx.strokeStyle = color
    ctx.lineWidth   = 1
    ctx.beginPath()
    ctx.moveTo(cx, cy - r * 0.5 + r)
    ctx.lineTo(cx + r * 0.5, cy + r * 1.0)
    ctx.stroke()
  }

  // ── Footer ────────────────────────────────────────────────────

  private drawFooter(): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    const rhy = this.rhythm
    const w   = this.canvas.width
    const y   = this.footerY
    const h   = cfg.FOOTER_H

    ctx.fillStyle = cfg.C_FOOTER
    ctx.fillRect(0, y, w, h)
    ctx.strokeStyle = cfg.C_TRACK_LINE; ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke()

    ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
    ctx.fillStyle = cfg.C_TEXT_DIM
    const hasteTxt  = cfg.HASTE_PCT > 0 ? `  h:${cfg.HASTE_PCT.toFixed(0)}%` : ''
    const windowTxt = `  win:${(cfg.GOOD_WINDOW * 2).toFixed(2)}s`
    const visualTxt = cfg.HIT_ZONE_VISUAL_OFFSET !== 0 ? `  vis:${cfg.HIT_ZONE_VISUAL_OFFSET > 0 ? '+' : ''}${cfg.HIT_ZONE_VISUAL_OFFSET}px` : ''
    const line = `int:${cfg.PUNCH_INTERVAL.toFixed(2)}s  off:${(cfg.TARGET_OFFSET * 1000).toFixed(0)}ms${hasteTxt}${windowTxt}${visualTxt}`
    ctx.fillText(line, 4, y + h / 2 + cfg.FONT_SM / 2)
  }

  // ── Judgments (HIT/MISS/CLIP floating text) ────────────────────

  private drawJudgments(): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    for (const j of this.judgments) {
      const a = j.alpha
      if (a <= 0) continue
      ctx.globalAlpha = a
      ctx.font = `bold ${cfg.FONT_MD}px Consolas, monospace`
      ctx.fillStyle = j.color
      ctx.fillText(j.text, j.x, j.y + j.offsetY)
      ctx.globalAlpha = 1
    }
  }

  // ── Banners ───────────────────────────────────────────────────

  private drawBanners(): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    const w   = this.canvas.width
    const hy  = this.highwayY

    let offsetY = 0
    for (const b of this.banners) {
      const a = b.alpha
      if (a <= 0) continue
      ctx.font = `${cfg.FONT_SM}px Consolas, monospace`
      const tw = ctx.measureText(b.text).width
      const bx = (w - tw - 8) / 2
      const by = hy + 4 + offsetY
      ctx.globalAlpha = a
      ctx.fillStyle = 'rgba(10,10,20,0.7)'
      ctx.beginPath(); ctx.roundRect(bx, by, tw + 8, cfg.FONT_SM + 6, 3); ctx.fill()
      ctx.fillStyle = b.color
      ctx.fillText(b.text, bx + 4, by + cfg.FONT_SM + 2)
      ctx.globalAlpha = 1
      offsetY += cfg.FONT_SM + 10
    }
  }

  // ── Grade screen ──────────────────────────────────────────────

  // ── Instrumentation panel ─────────────────────────────────────

  private drawInstrumentation(): void {
    const ctx      = this.ctx2d
    const cfg      = this.cfg
    const w        = this.canvas.width
    const log      = this.swingLog

    // Need at least 2 entries to compute a delta
    if (log.length < 2) {
      // Show waiting message
      const font = `${cfg.FONT_SM}px Consolas, monospace`
      ctx.font = font
      const msg = 'SWING LOG: waiting…'
      const tw  = ctx.measureText(msg).width
      const panW = tw + 12
      const panH = cfg.FONT_SM + 10
      const px   = w - panW - 4
      const py   = this.highwayY + 4

      ctx.fillStyle = 'rgba(8,10,20,0.82)'
      ctx.beginPath(); ctx.roundRect(px, py, panW, panH, 3); ctx.fill()
      ctx.fillStyle = cfg.C_TEXT_DIM
      ctx.fillText(msg, px + 6, py + panH - 4)
      return
    }

    // Compute deltas between consecutive swings (newest last)
    const deltas: number[] = []
    for (let i = 1; i < log.length; i++) {
      deltas.push(log[i] - log[i - 1])
    }
    // Show up to the last 6 deltas, newest on the right
    const shown = deltas.slice(-6)

    const expectedMs = cfg.PUNCH_INTERVAL * 1000
    const lineH      = cfg.FONT_SM + 4
    const font       = `${cfg.FONT_SM}px Consolas, monospace`
    ctx.font = font

    // Measure widths to size the panel
    const title    = 'SWING LOG (ms)'
    const titleW   = ctx.measureText(title).width
    const colW     = ctx.measureText('9999  ').width
    const panW     = Math.max(titleW + 12, colW * shown.length + 12)
    const panH     = lineH * 2 + 10   // title row + deltas row
    const px       = w - panW - 4
    const py       = this.highwayY + 4

    // Panel background
    ctx.fillStyle = 'rgba(8,10,20,0.82)'
    ctx.beginPath(); ctx.roundRect(px, py, panW, panH, 3); ctx.fill()
    ctx.strokeStyle = 'rgba(60,70,120,0.6)'; ctx.lineWidth = 1
    ctx.beginPath(); ctx.roundRect(px, py, panW, panH, 3); ctx.stroke()

    // Title
    ctx.fillStyle = cfg.C_TEXT_DIM
    ctx.fillText(title, px + 6, py + lineH)

    // Delta values, color-coded by closeness to expected interval
    let dx = px + 6
    const vy = py + lineH * 2 + 2
    for (const delta of shown) {
      const diff = Math.abs(delta - expectedMs)
      let color: string
      if (diff < 80)        color = cfg.C_SWING_SAFE   // ±80ms — on time
      else if (diff < 200)  color = cfg.C_SWING_WARN   // ±200ms — drifting
      else                  color = cfg.C_TEXT_DIM      // outlier/skipped swing

      const label = `${Math.round(delta)}`
      ctx.fillStyle = color
      ctx.fillText(label, dx, vy)
      dx += ctx.measureText(label + '  ').width
    }
  }

  private drawGradeScreen(gs: GradeScreen): void {
    const ctx = this.ctx2d
    const cfg = this.cfg
    const a   = gs.alpha
    if (a <= 0) return
    const w = this.canvas.width
    const h = this.canvas.height
    const r = gs.result

    ctx.globalAlpha = a
    ctx.fillStyle = 'rgba(0,0,0,0.82)'
    ctx.fillRect(0, 0, w, h)

    ctx.textAlign    = 'center'
    ctx.textBaseline = 'middle'

    const gradeColor = cfg.GRADE_COLORS[r.grade] ?? cfg.C_TEXT
    const cx = w / 2

    // Build the row list dynamically so row height always fits the canvas.
    const rows: Array<{ text: string; color: string; bold?: boolean; size: number }> = [
      { text: `${r.grade}  ${r.roundsWeaved}/${r.totalRounds} rounds weaved`,
        color: gradeColor, bold: true, size: cfg.FONT_LG },
      { text: `Bonus attacks: ${r.weaveAttempts} attempts  ${r.weaveLanded} landed  +${r.addedDps.toFixed(0)} dps`,
        color: cfg.C_TEXT_DIM, size: cfg.FONT_SM },
    ]
    if (r.avgReactionMs !== null)
      rows.push({ text: `${r.avgReactionMs.toFixed(0)} ms avg reaction`,
        color: cfg.C_TEXT_DIM, size: cfg.FONT_SM })
    rows.push({ text: 'SPACE / click to dismiss   V copy to chat',
      color: 'rgba(90,100,130,0.7)', size: cfg.FONT_SM })

    const pad  = 4
    const rowH = (h - pad * 2) / rows.length

    rows.forEach((row, i) => {
      const y = pad + rowH * i + rowH / 2
      ctx.font      = `${row.bold ? 'bold ' : ''}${row.size}px Consolas, monospace`
      ctx.fillStyle = row.color
      ctx.fillText(row.text, cx, y)
    })

    ctx.textAlign    = 'left'
    ctx.textBaseline = 'alphabetic'
    ctx.globalAlpha  = 1
  }

  // ── Hit / click helpers ───────────────────────────────────────

  /** Called from the renderer when a canvas click is confirmed (not a drag). */
  handleMouseClick(ts: number, x = -1, y = -1): void {
    // Check if the click landed on the pin icon (top-right header area)
    const pinSize = this.cfg.HEADER_H
    const pinX    = this.canvas.width - pinSize
    if (x >= pinX && y >= 0 && y < pinSize) {
      this.pinned = !this.pinned
      return
    }
    this.doClickHit(ts)
    this.gradeScreen?.dismiss()
  }

  private doHit(ts: number): void {
    this.doClickHit(ts)
  }

  private doClickHit(ts: number): void {
    const [judgment, _pts] = this.rhythm.registerClick(ts)
    const [hzx, hzy] = this.hitZoneCenter()
    const [jx, jy] = this.cfg.ORIENTATION === 'horizontal'
      ? [hzx + 18, this.highwayY + 6]
      : [hzx + this.cfg.NOTE_RADIUS + 4, hzy - 12]

    if (judgment === 'HIT') {
      this.hitFlash   = 0.85
      this.flashColor = this.cfg.C_GOOD
      this.spawnExplosion(hzx, hzy, this.cfg.C_GOOD, false)
      this.judgments.push(new Judgment('HIT', this.cfg.C_GOOD, jx, jy))
    } else {
      this.hitFlash   = 0.5
      this.flashColor = this.cfg.C_CLIP
    }
  }

  private clearRapidAttackMute(): void {
    this.consecutiveCrushesWithoutFist = 0
    this.audioMutedRapidAttack = false
    this.rapidAttackMuteUntil = 0
    this.audio.setTemporaryMute(false)
  }

  private showClipIndicator(): void {
    const [hzx, hzy] = this.hitZoneCenter()
    const [jx, jy] = this.cfg.ORIENTATION === 'horizontal'
      ? [hzx + 18, this.highwayY + 6]
      : [hzx + this.cfg.NOTE_RADIUS + 4, hzy - 12]
    this.judgments.push(new Judgment('CLIP!', this.cfg.C_CLIP, jx, jy))
    this.audio.play('miss')
  }

  showBanner(text: string, color: string, durationMs = 4000): void {
    this.banners.push(new Banner(text, color, durationMs))
  }

  // ── Particle effects ──────────────────────────────────────────

  private spawnExplosion(x: number, y: number, color: string, perfect: boolean): void {
    this.rings.push({ x, y, color, maxR: 50, lifetime: 0.45, born: now() })
    if (perfect) this.rings.push({ x, y, color: '#ffffff', maxR: 28, lifetime: 0.28, born: now() })

    const seed = { v: Math.trunc(Math.random() * 0x7fffffff) }
    const count = perfect ? 18 : 13
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2 + (lcgRand(seed) - 0.5) * 0.6
      const speed = 70 + lcgRand(seed) * 130
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 30,
        color,
        size: 1.8 + lcgRand(seed) * (perfect ? 3.0 : 2.0),
        lifetime: 0.30 + lcgRand(seed) * 0.28,
        born: now(),
      })
    }
  }

  private spawnMissDrop(x: number, y: number): void {
    const r = Math.max(3, Math.trunc(this.cfg.NOTE_RADIUS * 0.55))
    const t = now()
    this.missDrops.push({ x: x - 5, y, vy: 15, radius: r, born: t })
    this.missDrops.push({ x: x + 5, y, vy: 25, radius: r, born: t })
  }

  // ── Clipboard ─────────────────────────────────────────────────

  resetTrack(): void {
    this.rhythm.reset()
    this.gradeScreen        = null
    this.lastGradeResult    = null
    this.rings              = []
    this.explosions         = []
    this.missDrops          = []
    this.judgments          = []
    this.clickMarks         = []
    this.banners            = []
    this.hitFlash           = 0
    this.lastCombatActivity = 0
    this.showBanner('Track reset', this.cfg.C_TEXT_DIM, 2000)
  }

  private copyToClipboard(): void {
    const r = this.lastGradeResult ?? this.rhythm.makeGrade()
    const reactionPart = r.avgReactionMs !== null ? ` | Avg reaction: ${r.avgReactionMs.toFixed(0)}ms` : ''
    const text = `Basketweaver: ${r.grade} ${r.roundsWeaved}/${r.totalRounds} rounds weaved | ` +
      `Bonus attacks: ${r.weaveAttempts} attempts ${r.weaveLanded} landed | ` +
      `Added DPS: ${r.addedDps.toFixed(0)}` + reactionPart
    navigator.clipboard.writeText(text).then(() => {
      this.showBanner('Copied to clipboard!', this.cfg.C_GOOD, 2000)
    }).catch(() => {
      this.showBanner('Clipboard error!', this.cfg.C_MISS, 2000)
    })
  }
}

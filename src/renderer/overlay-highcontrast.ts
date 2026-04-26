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
import { EvType, type GameEvent } from '../shared/events'
import { RhythmEngine, type GradeResult } from './rhythm-engine'
import { AudioManager } from './audio-manager'

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
  constructor(text: string, color: string, duration = 4000) {
    this.text = text; this.color = color; this.duration = duration
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
  private banners: Banner[] = []
  private gradeScreen: GradeScreen | null = null
  private lastGradeResult: import('./rhythm-engine').GradeResult | null = null
  private fightHistory: GradeResult[] = []
  private dpsDisplayTotal = 0
  private dpsDisplayFist = 0
  private dpsLastUpdate = 0
  private lastFrameTime = 0
  private lastCombatActivity = 0
  private combatStartTs = 0
  private swingTimerEverValid = false
  private hasteCalibrated = false  // true when haste% was derived from measured swings, not /mystats
  private oorLastSoundTs = 0
  private consecutiveCrushesWithoutFist = 0
  private audioMutedRapidAttack = false
  private rapidAttackMuteUntil = 0
  private static readonly RAPID_CRUSH_THRESHOLD = 4
  private static readonly RAPID_MUTE_MS = 6000

  pinned = true
  charName = ''

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

  // ── IPC ─────────────────────────────────────────────────────
  handleGameEvent(ev: GameEvent): void {
    const ts = ev.ts
    switch (ev.type) {
      case EvType.COMBAT_START:
        if (!this.rhythm.inCombat) {
          this.rhythm.onCombatStart(now())
          this.audio.play('combat_start')
          this.gradeScreen = null
          this.clearRapidAttackMute()
          this.combatStartTs = now()
          this.dpsDisplayTotal = 0; this.dpsDisplayFist = 0; this.dpsLastUpdate = 0
          this.swingTimerEverValid = false
        }
        this.lastCombatActivity = ts
        break
      case EvType.MOB_DIED: {
        if (this.rhythm.inCombat) {
          const r = this.rhythm.onCombatEnd(ts)
          r.mobName = (ev.data?.mobName as string) ?? ''
          this.audio.play('combat_end')
          this.lastGradeResult = r
          this.pushHistory(r)
          this.gradeScreen = new GradeScreen(r)
        }
        this.clearRapidAttackMute()
        break
      }
      case EvType.COMBAT_END:
        if (this.rhythm.inCombat) this.rhythm.onCombatEnd(ts)
        this.clearRapidAttackMute()
        break
      case EvType.MAINHAND_CRUSH: {
        const ct = now()
        const damage = (ev.data?.damage as number) ?? 0
        const hit    = (ev.data?.hit    as boolean) ?? false
        this.rhythm.onMainhandCrush(ct, damage, hit)
        this.lastCombatActivity = ct
        this.consecutiveCrushesWithoutFist++
        if (this.consecutiveCrushesWithoutFist >= HighContrastOverlay.RAPID_CRUSH_THRESHOLD) {
          this.audioMutedRapidAttack = true
          this.rapidAttackMuteUntil = ct + HighContrastOverlay.RAPID_MUTE_MS
          this.audio.setTemporaryMute(true)
        }
        if (!this.audioMutedRapidAttack) this.audio.play('crush')
        this.oorLastSoundTs = 0
        break
      }
      case EvType.FIST_ATTACK: {
        const adjTs = ts - this.cfg.LATENCY_COMPENSATION * 1000
        const damage = (ev.data?.damage as number)  ?? 0
        const hit    = (ev.data?.hit    as boolean) ?? false
        const isClip = this.rhythm.onFistAttack(adjTs, damage, hit, now())
        this.lastCombatActivity = ts
        this.consecutiveCrushesWithoutFist = 0
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else if (hit && damage > 0) {
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
        this.cfg.BASE_WEAPON_DELAY = delay
        const newInterval = this.rhythm.predictedInterval
        const fistDelay   = this.rhythm.effectiveOffhandDelay
        this.cfg.GOOD_WINDOW    = Math.max(0.2, newInterval - fistDelay) / 2
        this.cfg.PUNCH_INTERVAL = newInterval
        this.banners.push(new Banner(`WEAPON: ${name.toUpperCase()}`, HC.accent, 4000))
        break
      }
      case EvType.OFFHAND_DETECTED: {
        const name  = (ev.data?.name  as string) ?? ''
        const delay = (ev.data?.delay as number) ?? 16
        this.applyDynamicWeaveWindow(delay, name)
        ;(window as any).electronAPI?.saveSettings()
        this.banners.push(new Banner(`OFFHAND: ${name.toUpperCase()}`, HC.combat, 5000))
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
    this.gradeScreen = null
    this.lastGradeResult = null
    this.combatStartTs = 0
    this.swingTimerEverValid = false
  }

  private pushHistory(result: GradeResult): void {
    this.fightHistory.unshift(result)
    if (this.fightHistory.length > 5) this.fightHistory.length = 5
    const lines = this.fightHistory.map(r => {
      const mob    = r.mobName || 'Unknown'
      const weaved = r.keystrokeGrading ? r.keystrokeRoundsWeaved : r.roundsWeaved
      const react  = r.avgReactionMs !== null ? `${r.avgReactionMs.toFixed(0)}ms` : '—'
      return `${r.grade}  ${weaved}/${r.totalRounds} rnds  ${r.weaveAttempts}att/${r.weaveLanded}hit  +${r.addedDps.toFixed(0)}dps  ${react}  [${mob}]`
    })
    window.electronAPI?.sendFightHistory(lines)
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
  toggleHighContrast(): void { /* this overlay IS the high contrast style */ }

  /** Dynamic Weave Windows — update offhand delay and immediately recalculate
   *  the safe weave window width (visual + scoring) using the post-haste value. */
  applyDynamicWeaveWindow(delayTenths: number, name = ''): void {
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

  // ── Update ──────────────────────────────────────────────────
  private update(dt: number): void {
    const t = now()
    this.targetSpeed = this.runway / (4 * this.cfg.PUNCH_INTERVAL * 1000)
    if (this.speed === 0) this.speed = this.targetSpeed
    else this.speed += (this.targetSpeed - this.speed) * Math.min(1, dt * 12)

    if (this.rhythm.inCombat && this.lastCombatActivity > 0
        && t - this.lastCombatActivity > COMBAT_IDLE_TIMEOUT_MS) {
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
      const iv = this.rhythm.calibrationEvent.interval
      const derivedHaste = Math.max(0, (this.cfg.BASE_WEAPON_DELAY / 10 / iv - 1) * 100)
      this.cfg.HASTE_PCT = derivedHaste
      this.hasteCalibrated = true
      this.banners.push(new Banner(`AUTO-CAL: ${iv.toFixed(2)}s  (${derivedHaste.toFixed(0)}% HASTE)`, '#ff9f44', 3000))
      this.rhythm.calibrationEvent = null
    }

    this.hitFlash  = Math.max(0, this.hitFlash  - dt * 3.5)
    this.missFlash = Math.max(0, this.missFlash - dt * 2)
    this.clipWarn  = Math.max(0, this.clipWarn  - dt * 2)
    this.banners = this.banners.filter(b => !b.expired)
    if (this.gradeScreen?.expired) this.gradeScreen = null

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
    ctx.fillStyle = HC.bg; ctx.fillRect(0,0,w,h)

    // Top accent rule
    ctx.fillStyle = HC.accent; ctx.fillRect(0, 0, w, 2)

    this.drawHeader()
    this.drawHighwayBox()
    this.drawWeaveWindows()
    this.drawHitZone()
    this.drawMissChip()
    this.drawClipWarn()
    this.drawFooter()
    this.drawBanners()
    if (this.gradeScreen) this.drawGradeScreen(this.gradeScreen)

    // Bottom accent rule
    ctx.fillStyle = HC.accent; ctx.fillRect(0, h - 2, w, 2)
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

    // Phase chip
    const phase = this.rhythm.inCombat ? 'COMBAT' : this.gradeScreen ? 'RESULT' : 'IDLE'
    const color = phase === 'COMBAT' ? HC.combat : phase === 'RESULT' ? HC.result : HC.idle
    ctx.fillStyle = color
    ctx.fillRect(86, 8, 68, 16)
    ctx.font = '800 10px "Archivo", sans-serif'
    ctx.fillStyle = color === HC.result ? '#000' : '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(phase, 86 + 34, 20)
    ctx.textAlign = 'left'

    // Stats right
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.textAlign = 'right'
    ctx.fillText(`${this.cfg.PUNCH_INTERVAL.toFixed(2)}s`, w - 60, 20)
    ctx.fillStyle = this.hasteCalibrated ? '#ff9f44' : HC.accent
    ctx.fillText(`${this.cfg.HASTE_PCT.toFixed(0)}%`, w - 10, 20)
    ctx.textAlign = 'left'
  }

  private drawHighwayBox(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    ctx.strokeStyle = HC.text; ctx.lineWidth = 2
    ctx.strokeRect(4, this.highwayY, w - 8, this.highwayH)
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

    let rank = 0
    for (let k = 0; rank < 3 && k < 12; k++) {
      const swingTime = firstSwing + k * intervalMs
      const weaveEnd  = swingTime + weaveSec * 1000
      const [x1, y1] = this.projectAt(swingTime, t)
      const [x2, y2] = this.projectAt(weaveEnd, t)

      if (!vert) {
        if (x1 > w) break
        if (x2 < 4) continue
        ctx.fillStyle   = `${HC.weaveFill}${fillsA[rank]})`
        ctx.fillRect(Math.max(6, x1), hy + 6, Math.max(3, x2 - x1), hh - 12)
        ctx.strokeStyle = `${HC.weaveStrk}${strokesA[rank]})`
        ctx.lineWidth = 1.5
        ctx.strokeRect(Math.max(6, x1) + 0.5, hy + 6.5, Math.max(3, x2 - x1) - 1, hh - 13)
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
    const w = this.canvas.width
    const hy = this.highwayY
    ctx.fillStyle = `${HC.missChip}${this.missFlash})`
    ctx.fillRect(w - 70, hy - 11, 60, 12)
    ctx.font = '700 9px "Archivo", sans-serif'
    ctx.fillStyle = `${HC.missText}${this.missFlash})`
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('— MISS', w - 40, hy - 5)
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

  private drawFooter(): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    ctx.textBaseline = 'alphabetic'

    // WEAVES
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText('WEAVES', 10, h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.fillText(`${this.rhythm.roundsWithWeave}`, 10, h - 5)

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
      ctx.font = '800 11px "Archivo", sans-serif'
      ctx.fillStyle = this.rgba(b.color, b.alpha)
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.fillText(b.text, w / 2, y)
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
      y += 18
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

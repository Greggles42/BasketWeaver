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
import { BackstabTimer } from './backstab-timer'
import { lookupMobAc } from '../shared/mob-ac'

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
  backstabFill:   'rgba(255,30,30,',   // rogue-mode backstab weave window
  backstabStroke: 'rgba(255,120,100,',
  swingBar:  'rgba(255,120,0,',
  hitZone:   '#ffee00',
  weaveDps:  '#ff7800',
  missChip:  'rgba(60,60,60,',
  missText:  'rgba(220,220,220,',
  clipWash:  'rgba(255,40,40,',
  clipChip:  'rgba(255,40,40,',
}

const now = () => performance.now()

/** Highest total damage within any rolling `windowMs` window of a
 *  [elapsedMs, damage] log — used for the Rogue Mode "best burst" stat
 *  (mirrors RhythmEngine.getBestWindowDamage for the monk-mode equivalent). */
function bestWindowDamage(log: Array<[number, number]>, windowMs = 1000): number {
  if (log.length === 0) return 0
  const sorted = [...log].sort((a, b) => a[0] - b[0])
  let best = 0, sum = 0, left = 0
  for (let right = 0; right < sorted.length; right++) {
    sum += sorted[right][1]
    while (sorted[left][0] < sorted[right][0] - windowMs) { sum -= sorted[left][1]; left++ }
    if (sum > best) best = sum
  }
  return best
}

// Audio debounce keys for the debuff alert sounds — cleared on mob death /
// combat end so the next encounter's first alert always plays.
const DEBUFF_ALERT_SOUND_NAMES = ['rooted', 'tashed', 'slowed', 'snared', 'enrage', 'enraged']

// A tumbling rectangular fragment used by the weave-window "explode" animation.
// `kind` picks the fill/stroke color at draw time (weave cyan vs rogue-mode backstab red).
interface Shard { x:number; y:number; vx:number; vy:number; life:number; ttl:number; size:number; rot:number; vr:number; kind: 'weave' | 'backstab' }

class Banner {
  static FADE_IN = 300; static FADE_OUT = 500
  text: string; color: string; duration: number; born = now()
  bigNumber?: string
  large: boolean
  constructor(text: string, color: string, duration = 4000, bigNumber?: string, large = false) {
    this.text = text; this.color = color; this.duration = duration; this.bigNumber = bigNumber; this.large = large
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
  get remainingMs() {
    if (this.dismissed) return 0
    const total = GradeScreen.FADE_IN + GradeScreen.HOLD + GradeScreen.FADE_OUT
    return Math.max(0, total - (now() - this.born))
  }
}

interface RogueSummaryResult {
  mobName: string
  fightDuration: number  // ms
  netDps: number
  backstabDps: number
  hits: number
  misses: number
  bestOneSecondDamage: number
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
  get remainingMs() {
    const total = RogueSummaryScreen.FADE_IN + RogueSummaryScreen.HOLD + RogueSummaryScreen.FADE_OUT
    return Math.max(0, total - (now() - this.born))
  }
}

export class HighContrastOverlay {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cfg: ConfigType
  private rhythm: RhythmEngine
  readonly audio: AudioManager

  private hzX = 80
  private hzY = 0
  private runway = 392
  private highwayY = 30
  private highwayH = 62
  private speed = 0; private targetSpeed = 0

  private hitFlash = 0
  private missFlash = 0
  private weaveShards: Shard[] = []
  // Which round's swingTime the fade/explode state below belongs to — lets a new
  // round's box start fresh (fully visible) without an explicit round-change hook.
  private weaveFadeAnchorSwingTime = -1
  private weaveBoxExplodeTs = 0   // performance.now() of explosion; 0 = this round's box hasn't exploded
  private static readonly WEAVE_FADE_MS = 150   // how fast the exploded box's fill disappears
  private clipWarn = 0
  private dwRollFlash = 0     // DW roll failure: keystroke in window, no fist in log
  private wuProcFlash = 0     // Technique of Master Wu proc indicator, by the target icon
  private wuProcLabel = ''
  private wuProcSub   = ''
  private tripleAttackFlash = 0    // small top-right icon, independent of banners/wuProc
  private quadAttackFlash   = 0    // same, for a 4-in-a-row cluster
  private multiAttackHits: number[] = []  // mainhand-crush timestamps in the current round
  private multiAttackRoundStart = 0       // ts of the round's first hit — round is capped to 100ms from here
  private multiAttackFlushTimer: ReturnType<typeof setTimeout> | null = null
  private dwPendingTs = 0    // timestamp when weave key landed in window; cleared by fist or timer
  private banners: Banner[] = []
  private bigBannerQueue: Banner[] = []
  private gradeScreen: GradeScreen | null = null
  private copyFlash: { text: string; color: string; born: number } | null = null
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
  /** [elapsedMs since rogueFightStartTs, damage] pairs, for the best-1s-burst stat. */
  private rogueDamageLog: Array<[number, number]> = []
  /** Timestamp (performance.now()) of the last landed backstab — used to detect
   *  a double backstab (two landed hits in quick succession) and to attribute a
   *  CRIT_HIT to a backstab rather than a standard swing. */
  private lastBackstabHitTs = 0
  /** Highest single backstab hit recorded this session, per weapon name.
   *  Session-scoped (not persisted) — resets on app restart, not per-fight. */
  private rogueBackstabMaxByWeapon: Map<string, number> = new Map()
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
  // ── Fist-only / swing-timer mode ─────────────────────────────
  private fistOnlyMode = false
  private combatFistCount  = 0
  private combatCrushCount = 0
  private static readonly FIST_ONLY_THRESHOLD = 5
  avatarActive = false
  savageryActive = false
  savageryVariant: 'savagery' | 'ferocity' = 'savagery'
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
  private lastLogActivityTs = 0
  private currentTarget = ''
  private lastEnrageAlertMob = ''
  private lastEnrageAlertTs  = 0
  private lastRootAlertMob = ''
  private lastRootAlertTs  = 0
  private lastTashAlertMob = ''
  private lastTashAlertTs  = 0
  private lastSlowAlertMob = ''
  private lastSlowAlertTs  = 0
  private lastSnareAlertMob = ''
  private lastSnareAlertTs  = 0
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

  /** Weave-window "explode" animation — the cyan weave box's border breaks apart
   *  into tumbling fragments that fly out onto the runway track, while the box's
   *  fill fades out over WEAVE_FADE_MS. Triggered when a weave lands while the
   *  window is on target. Shares the same trigger point for both standard and
   *  dynamic weaving since both route through FIST_ATTACK + isInWeaveWindow(). */
  private spawnWeaveExplosion(): void {
    const r = this.computeActiveWeaveBoxRect(now())
    if (!r) return
    this.weaveFadeAnchorSwingTime = r.swingTime
    this.weaveBoxExplodeTs = now()
    this.spawnBoxShards(r, 'weave')
  }

  /** Rogue Mode equivalent of spawnWeaveExplosion() — pops the backstab-ready
   *  window box when a backstab lands while the ability was actually ready
   *  (not during its cooldown window, which the caller must have already ruled out). */
  private spawnBackstabExplosion(): void {
    const r = this.computeActiveBackstabBoxRect(now())
    if (!r) return
    this.weaveFadeAnchorSwingTime = r.readyAt
    this.weaveBoxExplodeTs = now()
    this.spawnBoxShards(r, 'backstab')
  }

  /** Sample fragments from all 4 edges of a box so it reads as the border
   *  breaking apart, not a burst from the center. Shared by both the weave
   *  window and Rogue Mode's backstab window explosions. */
  private spawnBoxShards(r: { x: number; y: number; w: number; h: number }, kind: 'weave' | 'backstab'): void {
    const edges: Array<() => { x: number; y: number; nx: number; ny: number }> = [
      () => ({ x: r.x + Math.random() * r.w, y: r.y,         nx: 0,  ny: -1 }),  // top
      () => ({ x: r.x + Math.random() * r.w, y: r.y + r.h,   nx: 0,  ny: 1  }),  // bottom
      () => ({ x: r.x,         y: r.y + Math.random() * r.h, nx: -1, ny: 0  }),  // left
      () => ({ x: r.x + r.w,   y: r.y + Math.random() * r.h, nx: 1,  ny: 0  }),  // right
    ]
    for (let i = 0; i < 18; i++) {
      const { x, y, nx, ny } = edges[i % 4]()
      const spd     = 60 + Math.random() * 110
      const tangent = (Math.random() - 0.5) * 50   // drift along the edge, not just straight out
      this.weaveShards.push({
        x, y,
        vx: nx * spd + -ny * tangent,
        vy: ny * spd +  nx * tangent,
        life: 0, ttl: 0.4 + Math.random() * 0.3,
        size: 3 + Math.random() * 5,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 16,
        kind,
      })
    }
  }
  private projectAt(targetTime: number, t: number): [number, number] {
    const vo = this.cfg.HIT_ZONE_VISUAL_OFFSET
    if (this.cfg.ORIENTATION === 'horizontal')
      return [Math.trunc(this.hzX + vo + (targetTime - t) * this.speed),
              this.highwayY + this.highwayH / 2]
    return [this.hzX,
            Math.trunc(this.hzY + vo - (targetTime - t) * this.speed)]
  }

  showBanner(text: string, color: string, duration?: number, large = false): void {
    this.banners.push(new Banner(text, color, duration, undefined, large))
  }

  // Delays the banner until any active post-fight summary screen has finished
  // (grade screen / rogue summary), so the rank alert doesn't compete with it.
  showRankBanner(text: string, color: string, duration = 6000, onShow?: () => void): void {
    const remaining = Math.max(this.gradeScreen?.remainingMs ?? 0, this.rogueSummaryScreen?.remainingMs ?? 0)
    const fire = () => { this.showBanner(text, color, duration, true); onShow?.() }
    if (remaining > 0) setTimeout(fire, remaining)
    else fire()
  }

  // ── IPC ─────────────────────────────────────────────────────
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
            this.rogueDamageLog = []
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
          this.dpsDisplayTotal = 0; this.dpsDisplayFist = 0; this.dpsLastUpdate = 0
          this.swingTimerEverValid = false
          const t0 = now()
          this.avatarFightMs = 0;      this.avatarFightStart      = this.avatarActive          ? t0 : null
          this.savageryFightMs = 0;    this.savageryFightStart    = this.savageryActive         ? t0 : null
          this.innerflameFlightMs = 0; this.innerflameFlightStart = this.innerflameUntil > t0  ? t0 : null
          this.hasteFightWeightedMs = 0; this.hasteSegStart = t0; this.hasteSegValue = this.cfg.HASTE_PCT
        }
        this.lastCombatActivity = ts
        break
      case EvType.MOB_DIED: {
        this.audio.resetDebounce(DEBUFF_ALERT_SOUND_NAMES)
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
        this.audio.resetDebounce(DEBUFF_ALERT_SOUND_NAMES)
        if (/\bYou have been slain\b/i.test((ev.data?.line as string) ?? '')) this.clearDisciplineBuffs()
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
        const ct = now()
        const damage = (ev.data?.damage as number) ?? 0
        const hit    = (ev.data?.hit    as boolean) ?? false
        if (ev.data?.target) this.currentTarget = ev.data.target as string
        this.combatCrushCount++
        if (hit) this.checkTripleAttack(ct)
        if (this.fistOnlyMode) {
          this.fistOnlyMode = false
          this.banners.push(new Banner('WEAPON — WEAVE MODE', HC.combat, 3000))
        }
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
        this.lastCombatActivity = ts
        this.lastFistAttackTs = fistNow

        // ── Fist-only / swing-timer detection ──────────────────
        if (this.combatCrushCount === 0) this.combatFistCount++
        if (!this.fistOnlyMode && this.combatCrushCount === 0
            && this.combatFistCount >= HighContrastOverlay.FIST_ONLY_THRESHOLD) {
          this.fistOnlyMode = true
          this.banners.push(new Banner('SWING TIMER MODE', HC.accent, 4000))
        }

        if (this.fistOnlyMode) {
          this.rhythm.onReturnInRange(fistNow)
          this.rhythm.onMainhandCrush(fistNow, damage, hit, false)
          break
        }

        // ── Normal weave mode ───────────────────────────────────
        this.rhythm.onReturnInRange(fistNow)
        const isClip  = this.rhythm.onFistAttack(adjTs, damage, hit, fistNow)
        this.dwPendingTs = 0  // offhand swing confirmed — cancel any pending DW no-roll timer
        this.consecutiveCrushesWithoutFist = 0
        if (this.audioMutedRapidAttack) this.clearRapidAttackMute()
        if (isClip) {
          this.clipWarn = 1
          this.audio.play('error')
        } else if (this.cfg.POSITIVE_AUDIO_IN_WINDOW && this.rhythm.isInWeaveWindow(adjTs)) {
          this.audio.play('punch')
          if (hit && damage > 0) {
            this.hitFlash = 1
            // Weave landed while the window was on target — break the cyan box apart.
            if (this.cfg.WEAVE_EXPLODE_ENABLED) this.spawnWeaveExplosion()
          } else { this.missFlash = 1 }
        } else if (this.cfg.POSITIVE_AUDIO_IN_WINDOW) {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) setTimeout(() => this.audio.play('whiff'), 150)
        } else if (hit) {
          this.audio.play('punch')
          this.hitFlash = 1
          // Weave landed while the window was on target — break the cyan box apart.
          if (this.cfg.WEAVE_EXPLODE_ENABLED && this.rhythm.isInWeaveWindow(adjTs)) this.spawnWeaveExplosion()
        } else {
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) setTimeout(() => this.audio.play('whiff'), 150)
        }
        break
      }
      case EvType.MISC_DAMAGE: {
        const damage = (ev.data?.damage as number) ?? 0
        if (this.cfg.ROGUE_MODE_ENABLED) {
          this.rogueDamageTotal += damage
          if (damage > 0) this.rogueDamageLog.push([now() - this.rogueFightStartTs, damage])
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
            this.rogueDamageLog = []
            this.backstab.onCombatStart()
          }
          this.lastCombatActivity = lgNow
          this.rogueDamageTotal += damage
          if (source === 'backstab') {
            this.rogueBackstabDamageTotal += damage
            // Hybrid mode's authoritative backstab-landed signal — BACKSTAB_ATTACK(hit:true)
            // never fires here, so the hit count and cooldown reset happen off this event too.
            this.rogueBackstabHits++
            // Capture readiness before onBackstabAttack() unconditionally flips the
            // state to 'cooldown' — the explosion only fires for a backstab that
            // landed while actually ready, not a clipped/early attempt.
            const wasBackstabReady = this.backstab.state === 'ready'
            this.backstab.onBackstabAttack(lgNow)
            if (damage > 0 && this.cfg.ROGUE_MAX_HIT_TRACKING_ENABLED) {
              const weaponKey = this.lastKnownMainhand || 'Unknown'
              const prevMax = this.rogueBackstabMaxByWeapon.get(weaponKey) ?? 0
              if (damage >= prevMax) {
                this.rogueBackstabMaxByWeapon.set(weaponKey, damage)
                this.banners.push(new Banner('MAX HIT', '#ffee00', 2500, damage.toLocaleString()))
              }
            }
            if (this.lastBackstabHitTs > 0 && lgNow - this.lastBackstabHitTs < 200) {
              this.wuProcFlash = 1
              this.wuProcLabel = 'Double Backstab'
              this.wuProcSub   = damage.toLocaleString()
            }
            this.lastBackstabHitTs = lgNow
            this.hitFlash = 1
            this.audio.play('punch')
            if (this.cfg.WEAVE_EXPLODE_ENABLED && wasBackstabReady) this.spawnBackstabExplosion()
          }
          if (damage > 0) this.rogueDamageLog.push([lgNow - this.rogueFightStartTs, damage])
          break
        }
        this.rhythm.onReturnInRange(lgNow)
        if (!this.rhythm.inCombat) this.rhythm.onCombatStart(lgNow)
        this.lastCombatActivity = lgNow
        // In hybrid/damageOnly tracking mode, mainhand crush hits arrive here as
        // LOG_DAMAGE(source:'mainhand') instead of a separate MAINHAND_CRUSH event —
        // Triple/Quadruple Attack detection needs this hook too, or it never fires
        // for anyone using hybrid tracking.
        if (source === 'mainhand') this.checkTripleAttack(lgNow)
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
          this.rogueDamageLog = []
          this.backstab.onCombatStart()
        }
        // Capture readiness before onBackstabAttack() unconditionally flips the
        // state to 'cooldown' — the explosion only fires for a backstab that
        // landed while actually ready, not a clipped/early attempt.
        const wasBackstabReady = this.backstab.state === 'ready'
        this.backstab.onBackstabAttack(bsNow)
        this.lastCombatActivity = bsNow
        if (hit) {
          this.rogueBackstabHits++
          if (damage > 0) {
            this.rogueDamageTotal += damage
            this.rogueBackstabDamageTotal += damage
            this.rogueDamageLog.push([bsNow - this.rogueFightStartTs, damage])

            // Max-hit tracking: was this the hardest backstab landed this
            // session with the currently-equipped weapon? User-togglable in Settings.
            if (this.cfg.ROGUE_MAX_HIT_TRACKING_ENABLED) {
              const weaponKey = this.lastKnownMainhand || 'Unknown'
              const prevMax = this.rogueBackstabMaxByWeapon.get(weaponKey) ?? 0
              if (damage >= prevMax) {
                this.rogueBackstabMaxByWeapon.set(weaponKey, damage)
                this.banners.push(new Banner('MAX HIT', '#ffee00', 2500, damage.toLocaleString()))
              }
            }
          }
          // Double backstab: two landed hits close enough together that they can
          // only be the same instantaneous proc, not two separate cooldown cycles.
          // Reuses the Technique of Master Wu proc indicator by the target icon
          // (visual only — no audio cue for this one).
          if (this.lastBackstabHitTs > 0 && bsNow - this.lastBackstabHitTs < 200) {
            this.wuProcFlash = 1
            this.wuProcLabel = 'Double Backstab'
            this.wuProcSub   = damage.toLocaleString()
          }
          this.lastBackstabHitTs = bsNow
          this.hitFlash = 1
          this.audio.play('punch')
          if (this.cfg.WEAVE_EXPLODE_ENABLED && wasBackstabReady) this.spawnBackstabExplosion()
        } else {
          this.rogueBackstabMisses++
          this.missFlash = 1
          if (this.cfg.FIST_SOUND_ON_MISS) setTimeout(() => this.audio.play('whiff'), 150)
        }
        break
      }
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
            // Only (re)start the timer if it wasn't already running — a duplicate
            // "active" event (buff refreshed/recast before it faded) must not reset
            // the start time, or all time accumulated since the original cast is lost.
            if (active) { if (this.avatarFightStart === null) this.avatarFightStart = now() }
            else if (this.avatarFightStart !== null) { this.avatarFightMs += now() - this.avatarFightStart; this.avatarFightStart = null }
          }
          if (active) { this.banners.push(new Banner('AVATAR ON', '#a855f7', 4000)); this.audio.playFileSound('avatar') }
        }
        if (buff === 'savagery') {
          this.savageryActive = active
          const variant = (ev.data?.variant as 'savagery' | 'ferocity') ?? this.savageryVariant
          this.savageryVariant = variant
          if (this.rhythm.inCombat) {
            if (active) { if (this.savageryFightStart === null) this.savageryFightStart = now() }
            else if (this.savageryFightStart !== null) { this.savageryFightMs += now() - this.savageryFightStart; this.savageryFightStart = null }
          }
          if (active) {
            const label = variant === 'ferocity' ? 'FEROCITY ON' : 'SAVAGERY ON'
            this.banners.push(new Banner(label, '#f97316', 4000)); this.audio.playFileSound('savagery')
          }
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
            this.banners.push(new Banner('WHIRLWIND', '#c084fc', 3000))
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
        // A crit notification line immediately follows the backstab damage
        // line in the log, so a crit arriving right after a landed backstab
        // is that backstab critting — distinguish it from a standard-swing crit.
        const isBackstabCrit = this.cfg.ROGUE_MODE_ENABLED &&
          this.lastBackstabHitTs > 0 && now() - this.lastBackstabHitTs < 400
        if (big) {
          this.audio.playFileSound('epic', true)
          this.queueBigBanner(new Banner('MONSTER CRIT', '#ff4444', 3000, damage.toLocaleString()))
          this.recordHit(this.topCrits, damage, target)
        } else if (this.cfg.SHOW_ALL_CRITS) {
          this.audio.playFileSound('hit_tick', true)
          this.queueBigBanner(new Banner('CRIT', isBackstabCrit ? '#ff4444' : '#ffffff', 2000, damage.toLocaleString()))
        }
        break
      }
      case EvType.WU_PROC: {
        const roundTotalDamage = (ev.data?.roundTotalDamage as number) ?? 0
        const extraHits = (ev.data?.extraHits as { skill: string; damage: number }[]) ?? []
        this.wuProcFlash = 1
        this.wuProcLabel = `Wu +${extraHits.length}`
        this.wuProcSub   = roundTotalDamage.toLocaleString()
        // Notification always shows (even an all-miss round), but the sound
        // cue only fires once the round clears the configured damage floor.
        if (roundTotalDamage >= this.cfg.WU_DAMAGE_THRESHOLD && Math.random() * 100 < this.cfg.WU_PROC_CHANCE) {
          this.audio.playRandomKungfu()
        }
        break
      }
      case EvType.MOB_ENRAGED: {
        if (this.cfg.ENRAGE_ALERT_MODE === 'off') break
        const mobName = (ev.data?.mobName as string) ?? ''
        const key = mobName.toLowerCase()
        const isCurrentTarget = key === this.currentTarget.toLowerCase()
        // Hybrid mode runs two log readers over the same file, which can emit
        // this event twice for the same line — suppress an immediate repeat
        // for the same mob so the warning doesn't double-fire.
        const duplicate = key === this.lastEnrageAlertMob && now() - this.lastEnrageAlertTs < 1000
        if (isCurrentTarget && !duplicate) {
          this.lastEnrageAlertMob = key
          this.lastEnrageAlertTs  = now()
          this.banners.push(new Banner('⚠ ENRAGED', '#ff4444', 4000))
          if (this.cfg.ENRAGE_ALERT_MODE === 'voice') this.audio.playFileSoundDebounced('enraged', this.cfg.ENRAGE_AUDIO_DEBOUNCE_MS, true)
          else if (this.cfg.ENRAGE_ALERT_MODE === 'beep') this.audio.playForceDebounced('enrage', this.cfg.ENRAGE_AUDIO_DEBOUNCE_MS)
        }
        break
      }
      case EvType.MOB_ROOTED: {
        if (this.cfg.ROOT_ALERT_MODE === 'off') break
        const mobName = (ev.data?.mobName as string) ?? ''
        const key = mobName.toLowerCase()
        const isCurrentTarget = key === this.currentTarget.toLowerCase()
        // Hybrid mode runs two log readers over the same file, which can emit
        // this event twice for the same line — suppress an immediate repeat
        // for the same mob so the banner doesn't double-fire.
        const duplicate = key === this.lastRootAlertMob && now() - this.lastRootAlertTs < 1000
        if (isCurrentTarget && !duplicate) {
          this.lastRootAlertMob = key
          this.lastRootAlertTs  = now()
          this.banners.push(new Banner('🌿 ROOTED', '#8bc34a', 4000))
          this.audio.playFileSoundDebounced('rooted', this.cfg.ROOT_AUDIO_DEBOUNCE_MS, true)
        }
        break
      }
      case EvType.MOB_TASHED: {
        if (this.cfg.TASH_ALERT_MODE === 'off') break
        const mobName = (ev.data?.mobName as string) ?? ''
        const key = mobName.toLowerCase()
        const isCurrentTarget = key === this.currentTarget.toLowerCase()
        // Hybrid mode runs two log readers over the same file, which can emit
        // this event twice for the same line — suppress an immediate repeat
        // for the same mob so the banner doesn't double-fire.
        const duplicate = key === this.lastTashAlertMob && now() - this.lastTashAlertTs < 1000
        if (isCurrentTarget && !duplicate) {
          this.lastTashAlertMob = key
          this.lastTashAlertTs  = now()
          this.banners.push(new Banner('🔮 TASHED', '#b388ff', 4000))
          this.audio.playFileSoundDebounced('tashed', this.cfg.TASH_AUDIO_DEBOUNCE_MS, true)
        }
        break
      }
      case EvType.MOB_SLOWED: {
        if (this.cfg.SLOW_ALERT_MODE === 'off') break
        const mobName = (ev.data?.mobName as string) ?? ''
        const key = mobName.toLowerCase()
        const isCurrentTarget = key === this.currentTarget.toLowerCase()
        // Hybrid mode runs two log readers over the same file, which can emit
        // this event twice for the same line — suppress an immediate repeat
        // for the same mob so the banner doesn't double-fire.
        const duplicate = key === this.lastSlowAlertMob && now() - this.lastSlowAlertTs < 1000
        if (isCurrentTarget && !duplicate) {
          this.lastSlowAlertMob = key
          this.lastSlowAlertTs  = now()
          this.banners.push(new Banner('🐌 SLOWED', '#42a5f5', 4000))
          this.audio.playFileSoundDebounced('slowed', this.cfg.SLOW_AUDIO_DEBOUNCE_MS, true)
        }
        break
      }
      case EvType.MOB_SNARED: {
        if (this.cfg.SNARE_ALERT_MODE === 'off') break
        const mobName = (ev.data?.mobName as string) ?? ''
        const key = mobName.toLowerCase()
        const isCurrentTarget = key === this.currentTarget.toLowerCase()
        // Hybrid mode runs two log readers over the same file, which can emit
        // this event twice for the same line — suppress an immediate repeat
        // for the same mob so the banner doesn't double-fire.
        const duplicate = key === this.lastSnareAlertMob && now() - this.lastSnareAlertTs < 1000
        if (isCurrentTarget && !duplicate) {
          this.lastSnareAlertMob = key
          this.lastSnareAlertTs  = now()
          this.banners.push(new Banner('🕸 SNARED', '#26a69a', 4000))
          this.audio.playFileSoundDebounced('snared', this.cfg.SNARE_AUDIO_DEBOUNCE_MS, true)
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
    this.rogueDamageLog = []
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
      bestOneSecondDamage: bestWindowDamage(this.rogueDamageLog, 1000),
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

  /** EQ clears nearly all buffs on death — the game doesn't always print a
   *  "fades" line for each one, so without this the overlay's own tracked
   *  state (and its header pills/banners) would keep showing Avatar/Savagery
   *  active after a death that actually stripped them. Flushes any in-progress
   *  fight-time accumulation first, same as a normal active:false would. */
  private clearDisciplineBuffs(): void {
    const t = now()
    if (this.avatarActive) {
      this.avatarActive = false
      if (this.avatarFightStart !== null) { this.avatarFightMs += t - this.avatarFightStart; this.avatarFightStart = null }
    }
    if (this.savageryActive) {
      this.savageryActive = false
      if (this.savageryFightStart !== null) { this.savageryFightMs += t - this.savageryFightStart; this.savageryFightStart = null }
    }
    if (this.innerflameUntil > 0) {
      this.innerflameUntil = 0
      if (this.innerflameFlightStart !== null) { this.innerflameFlightMs += t - this.innerflameFlightStart; this.innerflameFlightStart = null }
    }
    this.whirlwindUntil = 0
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
      characterClass:           this.cfg.ROGUE_MODE_ENABLED ? 'Rogue' : 'Monk',
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

  /** Monk Triple/Quadruple Attack detection: flags when 3 (or 4) mainhand-crush
   *  hits land within a single 100ms round. Offhand/dual-wield swings never
   *  reach this — they arrive as separate FIST_ATTACK events — and ripostes
   *  never reach this either, since log-reader excludes them before a
   *  MAINHAND_CRUSH event is ever emitted. On the 3rd hit we wait one more
   *  window before declaring Triple, so a 4th hit arriving just after can still
   *  escalate the flash to Quadruple instead of firing both.
   *
   *  The round is a hard 100ms cap from its *first* hit, not a sliding gap
   *  filter — a chain of hits each <100ms apart but spanning well past 100ms
   *  total is not one round, it's several, so it must never roll an old hit
   *  forward into the window used to judge a newer one. */
  private checkTripleAttack(hitTs: number): void {
    if (!this.cfg.TRIPLE_ATTACK_DETECTION_ENABLED) return
    const WINDOW_MS = 100
    if (this.multiAttackHits.length === 0 || hitTs - this.multiAttackRoundStart > WINDOW_MS) {
      this.multiAttackHits = []
      this.multiAttackRoundStart = hitTs
    }
    this.multiAttackHits.push(hitTs)
    if (this.multiAttackHits.length >= 4) {
      if (this.multiAttackFlushTimer !== null) { clearTimeout(this.multiAttackFlushTimer); this.multiAttackFlushTimer = null }
      this.quadAttackFlash = 1
      this.multiAttackHits = []
      return
    }
    if (this.multiAttackHits.length === 3 && this.multiAttackFlushTimer === null) {
      this.multiAttackFlushTimer = setTimeout(() => {
        this.multiAttackFlushTimer = null
        if (this.multiAttackHits.length === 3) {
          this.tripleAttackFlash = 1
          this.multiAttackHits = []
        }
      }, WINDOW_MS)
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
      this.copyFlash = { text: 'COPIED!', color: '#5aeb96', born: now() }
    }).catch(() => {
      this.copyFlash = { text: 'CLIPBOARD ERROR!', color: '#ff4040', born: now() }
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

    if (this.cfg.ROGUE_MODE_ENABLED) {
      if (this.rogueInCombat && this.lastCombatActivity > 0
          && t - this.lastCombatActivity > COMBAT_IDLE_TIMEOUT_MS) {
        this.finishRogueFight('')
        this.lastCombatActivity = 0
      }
      this.backstab.update(t)
      if (this.backstab.shouldPromptSwapIn && !this.backstab.swapInPromptShown) {
        this.backstab.swapInPromptShown = true
        this.banners.push(new Banner('SWAP TO BACKSTAB WEAPON!', HC.accent, 2500))
      }
      if (this.backstab.shouldPromptSwapOut && !this.backstab.swapOutPromptShown) {
        this.backstab.swapOutPromptShown = true
        this.banners.push(new Banner('SWAP BACK TO DPS WEAPON', HC.accent, 2500))
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
        this.banners.push(new Banner(`AUTO-CAL: ${iv.toFixed(2)}s  (${derivedHaste.toFixed(0)}% HASTE)`, '#ff9f44', 3000))
        this.rhythm.calibrationEvent = null
      }
      if (this.rhythm.roundEndDamage !== null) {
        if (this.rhythm.roundEndDamage > this.cfg.HUGE_ROUND_THRESHOLD && t - this.lastOhSnapTs > 1000) {
          const rd = this.rhythm.roundEndDamage
          this.audio.playFileSound('oh_snap', true)
          this.queueBigBanner(new Banner('HUGE ROUND!!!', '#ffd700', 3000, rd.toLocaleString()))
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

    this.hitFlash    = Math.max(0, this.hitFlash    - dt * 3.5)
    this.missFlash   = Math.max(0, this.missFlash   - dt * 2)
    this.clipWarn    = Math.max(0, this.clipWarn    - dt * 2)
    this.dwRollFlash = Math.max(0, this.dwRollFlash - dt * 1.2)
    this.wuProcFlash = Math.max(0, this.wuProcFlash - dt * 0.3)
    this.tripleAttackFlash = Math.max(0, this.tripleAttackFlash - dt * 0.5)
    this.quadAttackFlash   = Math.max(0, this.quadAttackFlash   - dt * 0.5)
    // Weave-explosion shards
    for (const s of this.weaveShards) {
      s.life += dt; s.x += s.vx * dt; s.y += s.vy * dt
      s.vy += 280 * dt; s.vx *= Math.max(0, 1 - 1.6 * dt)
      s.rot += s.vr * dt
    }
    this.weaveShards = this.weaveShards.filter(s => s.life < s.ttl)

    this.banners = this.banners.filter(b => !b.expired)
    if (this.bigBannerQueue.length && !this.banners.some(b => b.bigNumber !== undefined)) {
      const next = this.bigBannerQueue.shift()!
      next.born = now()
      this.banners.push(next)
    }
    if (this.gradeScreen?.expired) this.gradeScreen = null
    if (this.rogueSummaryScreen?.expired) this.rogueSummaryScreen = null

    if (t - this.dpsLastUpdate >= 250) {
      if (this.cfg.ROGUE_MODE_ENABLED) {
        const elapsed = this.rogueInCombat ? Math.max(0.001, (t - this.rogueFightStartTs) / 1000) : 0
        this.dpsDisplayTotal = elapsed > 0 ? Math.trunc(this.rogueDamageTotal / elapsed) : 0
        this.dpsDisplayFist  = elapsed > 0 ? Math.trunc(this.rogueBackstabDamageTotal / elapsed) : 0
      } else {
        this.dpsDisplayTotal = Math.trunc(this.rhythm.liveTotalDps)
        this.dpsDisplayFist  = Math.trunc(this.rhythm.liveDps)
      }
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
    if (this.cfg.ROGUE_MODE_ENABLED) {
      this.drawRogueTrack()
    } else {
      this.drawHighwayBox()
      this.drawDynamicWeaveWindows()
      this.drawHitZone()
      this.drawOffhandSwingTimer()
    }
    this.drawWeaveExplosion()
    this.drawMissChip()
    this.drawClipWarn()
    this.drawDwRollFail()
    this.drawWuProc()
    this.drawMultiAttackIcon()
    this.drawFooter()
    this.drawNoLogNotice()
    this.drawBanners()
    if (this.gradeScreen) this.drawGradeScreen(this.gradeScreen)
    if (this.rogueSummaryScreen) this.drawRogueSummaryScreen(this.rogueSummaryScreen)

    // Bottom accent rule
    ctx.fillStyle = HC.accent; ctx.fillRect(0, h - 2, w, 2)
  }

  private drawNoLogNotice(): void {
    if (this.rhythm.inCombat || this.gradeScreen || this.rogueInCombat || this.rogueSummaryScreen) return
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
    const phase = this.inCombat ? 'COMBAT' : (this.gradeScreen || this.rogueSummaryScreen) ? 'RESULT' : 'IDLE'
    const color = phase === 'COMBAT' ? HC.combat : phase === 'RESULT' ? HC.result : HC.idle
    ctx.fillStyle = color
    ctx.fillRect(chipX, 8, 68, 16)
    ctx.font = '800 10px "Archivo", sans-serif'
    ctx.fillStyle = color === HC.result ? '#000' : '#fff'
    ctx.textAlign = 'center'
    ctx.fillText(phase, chipX + 34, 20)
    ctx.textAlign = 'left'

    // Rogue Mode indicator — sits right after the phase chip, before buff icons
    let afterPhaseX = chipX + 68 + 6
    if (this.cfg.ROGUE_MODE_ENABLED) {
      ctx.font = '800 9px "Archivo", sans-serif'
      const rw = ctx.measureText('ROG').width + 10
      ctx.fillStyle = '#ff4d4d'
      ctx.fillRect(afterPhaseX, 8, rw, 16)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.fillText('ROG', afterPhaseX + rw / 2, 20)
      ctx.textAlign = 'left'
      afterPhaseX += rw + 4
    }

    // Buff indicators (Avatar, Savagery)
    let buffX = afterPhaseX
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
      const label = this.savageryVariant === 'ferocity' ? 'FERO' : 'SAV'
      ctx.fillStyle = '#f97316'
      ctx.fillRect(buffX, 8, 32, 16)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.fillText(label, buffX + 16, 20)
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
    ctx.fillText(`${this.displayHastePct.toFixed(0)}%`, w - 10, 20)
    ctx.textAlign = 'left'

    this.drawInnerflameBar(27, 3)
    this.drawWhirlwindBar(24, 3)
  }

  /** Small, independent top-right icon for Triple/Quadruple Attack procs — drawn
   *  under the haste% readout, deliberately outside the banners/wuProc stack so
   *  a Huge Round or Crit banner never overrides it. */
  private drawMultiAttackIcon(): void {
    const quad   = this.quadAttackFlash > 0
    const triple = !quad && this.tripleAttackFlash > 0
    if (!quad && !triple) return
    const ctx = this.ctx
    const w = this.canvas.width
    const a = Math.min(1, quad ? this.quadAttackFlash : this.tripleAttackFlash)
    const label = quad ? 'QUAD ATK' : 'TRIPLE ATK'
    const color = quad ? '#ff5050' : '#ff9f44'
    const y = 38
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.font = '800 9px "Archivo", sans-serif'
    const tw = ctx.measureText(label).width
    const padX = 6, boxW = tw + padX * 2, boxH = 14
    ctx.fillStyle = this.rgba(color, 0.9 * a)
    ctx.fillRect(w - 10 - boxW, y - boxH / 2, boxW, boxH)
    ctx.fillStyle = this.rgba('#000', a)
    ctx.fillText(label, w - 10 - padX, y)
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
  }

  private drawHighwayBox(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    ctx.strokeStyle = HC.text; ctx.lineWidth = 2
    ctx.strokeRect(4, this.highwayY, w - 8, this.highwayH)
  }

  /** Computes the currently-active weave window box's geometry fresh, independent
   *  of whatever drawDynamicWeaveWindows() last rendered. Used by spawnWeaveExplosion()
   *  so the explosion can't go stale or silently no-op if the box wasn't (re)drawn
   *  on the exact frame before the hit arrived — it mirrors the same math the
   *  renderer uses for the k=0 / "current round" box, computed on demand. */
  private computeActiveWeaveBoxRect(t: number): { x: number; y: number; w: number; h: number; swingTime: number } | null {
    const gliding = !this.rhythm.inCombat && t < this.postCombatGlideUntil
    if (!this.rhythm.inCombat && !gliding) return null
    const intervalMs = this.cfg.PUNCH_INTERVAL * 1000
    const offhandMs  = this.rhythm.effectiveOffhandDelay * 1000
    const weaveMs    = this.cfg.WEAVE_WINDOW_MS > 0
      ? this.cfg.WEAVE_WINDOW_MS
      : Math.max(50, (this.cfg.PUNCH_INTERVAL - this.rhythm.effectiveOffhandDelay) * 1000)

    const nextSwing = gliding
      ? (this.postCombatRoundOpen ? this.postCombatLastCrush + intervalMs : this.postCombatNextSwing)
      : (this.rhythm.roundOpen    ? this.rhythm.lastCrushTime + intervalMs : this.rhythm.nextSwingTime)
    if (nextSwing <= 0) return null

    let swingTime = nextSwing
    while (swingTime - intervalMs > t - intervalMs) swingTime -= intervalMs

    const safeEnd   = swingTime + weaveMs
    const windowEnd = swingTime + intervalMs

    let winStart = swingTime
    if (this.cfg.DYNAMIC_WEAVING && this.cfg.WEAVE_WINDOW_MS <= 0) {
      const offhandReadyTs = this.lastFistAttackTs > 0 ? this.lastFistAttackTs + offhandMs : 0
      const nextReady = offhandReadyTs > 0 ? offhandReadyTs : t - 1
      winStart = Math.max(swingTime, nextReady)
    }
    if (winStart >= windowEnd || winStart >= safeEnd) return null

    const vert = this.cfg.ORIENTATION === 'vertical'
    const hy = this.highwayY, hh = this.highwayH
    const w = this.canvas.width

    if (!vert) {
      const [wx]  = this.projectAt(winStart, t)
      const [sfx] = this.projectAt(safeEnd,  t)
      return { x: wx, y: hy + 6, w: Math.max(3, sfx - wx), h: hh - 12, swingTime }
    }
    const [, wy ] = this.projectAt(winStart, t)
    const [, sfy] = this.projectAt(safeEnd,  t)
    return { x: 8, y: sfy, w: w - 16, h: Math.max(3, wy - sfy), swingTime }
  }

  /** Rogue Mode equivalent of computeActiveWeaveBoxRect() — the backstab-ready
   *  window box, computed fresh (same math as drawRogueTrack()) rather than cached,
   *  for the same stale-frame reason computeActiveWeaveBoxRect avoids a cache. */
  private computeActiveBackstabBoxRect(t: number): { x: number; y: number; w: number; h: number; readyAt: number } | null {
    const bs = this.backstab
    if (bs.state !== 'ready' && bs.state !== 'cooldown') return null
    const windowMs = this.cfg.ROGUE_BACKSTAB_WINDOW_MS
    const speed    = this.runway / Math.max(1, bs.cooldownMsValue)
    const readyAt  = bs.readyAtMs
    const boxEnd   = readyAt + windowMs

    const vert = this.cfg.ORIENTATION === 'vertical'
    const hy = this.highwayY, hh = this.highwayH
    const w = this.canvas.width

    if (!vert) {
      const [sx] = this.rogueProjectAt(readyAt, t, speed)
      const [ex] = this.rogueProjectAt(boxEnd,  t, speed)
      return { x: sx, y: hy + 16, w: Math.max(3, ex - sx), h: hh - 32, readyAt }
    }
    const [, sy] = this.rogueProjectAt(readyAt, t, speed)
    const [, ey] = this.rogueProjectAt(boxEnd,  t, speed)
    return { x: 8, y: ey, w: w - 16, h: Math.max(3, sy - ey), readyAt }
  }

  /** Fade multiplier (1 = fully visible, 0 = gone) for the currently-active weave
   *  box's fill/stroke. Resets to fully visible whenever `swingTime` changes (a new
   *  round's box), so an exploded box stays hidden only for the remainder of its own
   *  round rather than forever. */
  private weaveBoxFade(swingTime: number, t: number): number {
    if (this.weaveFadeAnchorSwingTime !== swingTime) {
      this.weaveFadeAnchorSwingTime = swingTime
      this.weaveBoxExplodeTs = 0
    }
    if (this.weaveBoxExplodeTs <= 0) return 1
    return Math.max(0, 1 - (t - this.weaveBoxExplodeTs) / HighContrastOverlay.WEAVE_FADE_MS)
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
            let fade = 1
            if (k === 0) fade = this.weaveBoxFade(swingTime, t)
            ctx.fillStyle   = `${HC.weaveFill}${0.85 * fade})`
            ctx.fillRect(sx, hy + 6, gw, hh - 12)
            ctx.strokeStyle = `${HC.weaveStrk}${1.0 * fade})`
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
            let fade = 1
            if (k === 0) fade = this.weaveBoxFade(swingTime, t)
            ctx.fillStyle   = `${HC.weaveFill}${0.85 * fade})`
            ctx.fillRect(8, sfy, w - 16, gh)
            ctx.strokeStyle = `${HC.weaveStrk}${1.0 * fade})`
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
    const [tzx, tzy] = this.hzCenter()   // swing target line — the discouraged (red) zone must not scroll past it
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
            let fade = 1
            if (!isAnticipated) fade = this.weaveBoxFade(swingTime, t)
            ctx.fillStyle   = `${HC.weaveFill}${0.85 * fade})`
            ctx.fillRect(wx, hy + 6, greenW, hh - 12)
            ctx.strokeStyle = `${HC.weaveStrk}${1.0 * fade})`
            ctx.lineWidth = 1.5
            ctx.strokeRect(wx + 0.5, hy + 6.5, greenW - 1, hh - 13)
          }

          // Discouraged zone (safeEnd → windowEnd) — clamped so it never scrolls
          // past the swing target once safeEnd itself has already passed it.
          if (orderSet && wndx > tzx) {
            const clampedSfx = Math.max(sfx, tzx)
            const discW = Math.max(2, wndx - clampedSfx)
            ctx.fillStyle   = 'rgba(200,40,20,0.30)'
            ctx.fillRect(clampedSfx, hy + 6, discW, hh - 12)
            ctx.strokeStyle = 'rgba(255,60,40,0.60)'
            ctx.lineWidth = 1.5
            ctx.strokeRect(clampedSfx + 0.5, hy + 6.5, discW - 1, hh - 13)
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
            let fade = 1
            if (!isAnticipated) fade = this.weaveBoxFade(swingTime, t)
            ctx.fillStyle   = `${HC.weaveFill}${0.85 * fade})`
            ctx.fillRect(8, sfy, w - 16, greenH)
            ctx.strokeStyle = `${HC.weaveStrk}${1.0 * fade})`
            ctx.lineWidth = 1.5
            ctx.strokeRect(8 + 0.5, sfy + 0.5, w - 17, greenH - 1)
          }

          // Discouraged zone (safeEnd → windowEnd) — clamped so it never scrolls
          // past the swing target once safeEnd itself has already passed it.
          if (orderSet && wndy < tzy) {
            const clampedSfy = Math.min(sfy, tzy)
            const discH = Math.max(2, clampedSfy - wndy)
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

  /** Tumbling border fragments from spawnWeaveExplosion(), clipped to the runway
   *  track so they visually break apart on the highway rather than flying over
   *  the header/footer chrome. */
  private drawWeaveExplosion(): void {
    if (this.weaveShards.length === 0) return
    const ctx = this.ctx
    const vert = this.cfg.ORIENTATION === 'vertical'
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH
    ctx.save()
    ctx.beginPath()
    if (!vert) ctx.rect(5, hy, w - 10, hh)
    else        ctx.rect(0, hy + 1, w, hh - 2)
    ctx.clip()
    for (const s of this.weaveShards) {
      const a = Math.max(0, 1 - s.life / s.ttl)
      const fill   = s.kind === 'backstab' ? HC.backstabFill   : HC.weaveFill
      const stroke = s.kind === 'backstab' ? HC.backstabStroke : HC.weaveStrk
      ctx.save()
      ctx.translate(s.x, s.y)
      ctx.rotate(s.rot)
      ctx.fillStyle = `${fill}${a})`
      ctx.strokeStyle = `${stroke}${a})`
      ctx.lineWidth = 1
      ctx.fillRect(-s.size / 2, -s.size / 2, s.size, s.size)
      ctx.strokeRect(-s.size / 2, -s.size / 2, s.size, s.size)
      ctx.restore()
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

  private drawWuProc(): void {
    if (this.wuProcFlash <= 0) return
    const ctx = this.ctx
    const [hzx, hzy] = this.hzCenter()
    // Fade in fast, hold, then fade out — avoids an abrupt linear-decay pop-in.
    const a = Math.min(1, this.wuProcFlash * 2.5)
    const chipW = 92, chipH = 32
    const chipX = hzx - 16 - chipW
    const chipY = hzy - chipH / 2
    ctx.fillStyle = `rgba(40,30,0,${(a * 0.6).toFixed(2)})`
    ctx.fillRect(chipX, chipY, chipW, chipH)
    ctx.strokeStyle = `rgba(255,215,0,${(a * 0.8).toFixed(2)})`
    ctx.lineWidth = 1.5
    ctx.strokeRect(chipX, chipY, chipW, chipH)
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'
    ctx.font = '700 13px "Archivo", sans-serif'
    ctx.fillStyle = `rgba(255,215,0,${a.toFixed(2)})`
    ctx.fillText(this.wuProcLabel, hzx - 24, hzy - 8)
    ctx.font = '700 12px "JetBrains Mono", monospace'
    ctx.fillStyle = `rgba(255,235,120,${a.toFixed(2)})`
    ctx.fillText(this.wuProcSub, hzx - 24, hzy + 8)
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

    // Left/center-aligned trio across the footer; 4th stat anchored right.
    ctx.textAlign = 'left'

    const rogue = this.cfg.ROGUE_MODE_ENABLED

    // Left stat — WEAVES, or BACKSTABS in Rogue Mode
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText(rogue ? 'BACKSTABS' : 'WEAVES', 10, h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    const leftVal = rogue
      ? `${this.rogueBackstabHits}`
      : `${this.rhythm.inCombat ? this.rhythm.roundsWithWeave : 0}`
    ctx.fillText(leftVal, 10, h - 5)

    ctx.textAlign = 'center'

    // AC
    const targetAc = lookupMobAc(this.currentTarget)
    const acVal = targetAc === 'ambiguous' ? '--*' : targetAc !== undefined ? `${targetAc}` : '--'
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText('AC', w * (5 / 16), h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.fillText(acVal, w * (5 / 16), h - 5)

    // NET DPS
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText('NET DPS', w * (9 / 16), h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = HC.text
    ctx.fillText(`${this.dpsDisplayTotal}`, w * (9 / 16), h - 5)

    // Right stat — WEAVE DPS, or BACKSTAB DPS in Rogue Mode
    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = HC.textDim
    ctx.fillText(rogue ? 'BACKSTAB' : 'WEAVE', w * (7 / 8), h - 18)
    ctx.font = '800 15px "Archivo", sans-serif'
    ctx.fillStyle = rogue ? HC.hitZone : HC.weaveDps
    ctx.fillText(rogue ? `${this.dpsDisplayFist}` : `+${this.dpsDisplayFist}`, w * (7 / 8), h - 5)
    ctx.textAlign = 'left'
  }

  private queueBigBanner(banner: Banner): void {
    if (this.banners.some(b => b.bigNumber !== undefined)) {
      this.bigBannerQueue.push(banner)
    } else {
      this.banners.push(banner)
    }
  }

  private drawBanners(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    let y = this.highwayY + 14
    for (const b of this.banners) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      ctx.font = b.large ? '800 22px "Archivo", sans-serif' : '800 11px "Archivo", sans-serif'
      ctx.fillStyle = this.rgba(b.color, b.alpha)
      const lineH = b.large ? 26 : 14
      for (const line of b.text.split('\n')) {
        ctx.fillText(line, w / 2, y)
        y += lineH
      }
      if (b.bigNumber) {
        ctx.font = '800 36px "Archivo Narrow", "Archivo", sans-serif'
        ctx.fillStyle = this.rgba(b.color, b.alpha)
        ctx.fillText(b.bigNumber, w / 2, y + 18)
        y += 42
      }
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'
    }
  }

  // ── Rogue Mode ─────────────────────────────────────────────
  /** Projects a timestamp onto the highway scaled to the full (haste-adjusted)
   *  backstab cooldown, so the whole cooldown is visible crossing the track —
   *  independent of mainhand's PUNCH_INTERVAL-based speed/projectAt. */
  private rogueProjectAt(targetTime: number, t: number, speed: number): [number, number] {
    const vo = this.cfg.HIT_ZONE_VISUAL_OFFSET
    if (this.cfg.ORIENTATION === 'horizontal')
      return [Math.trunc(this.hzX + vo + (targetTime - t) * speed), this.highwayY + this.highwayH / 2]
    return [this.hzX, Math.trunc(this.hzY + vo - (targetTime - t) * speed)]
  }

  private drawRogueTrack(): void {
    const ctx = this.ctx
    const w = this.canvas.width
    const hy = this.highwayY, hh = this.highwayH
    ctx.strokeStyle = HC.text; ctx.lineWidth = 2
    ctx.strokeRect(4, hy, w - 8, hh)

    const bs = this.backstab
    const ready = bs.state === 'ready'
    const t = now()
    const windowMs = this.cfg.ROGUE_BACKSTAB_WINDOW_MS
    const vert = this.cfg.ORIENTATION === 'vertical'
    // Scale the whole highway to the current (haste-adjusted) cooldown length,
    // so the next backstab's timing is visible across the full track, not just
    // a short lookahead — the window then keeps scrolling past the marker at
    // this same speed once it opens.
    const speed = this.runway / Math.max(1, bs.cooldownMsValue)

    ctx.save()
    ctx.beginPath()
    ctx.rect(6, hy + 2, w - 12, hh - 4)
    ctx.clip()

    if (bs.state === 'cooldown' || bs.state === 'ready') {
      const readyAt = bs.readyAtMs
      const boxEnd  = readyAt + windowMs
      const fade = this.weaveBoxFade(readyAt, t)
      const [sx, sy] = this.rogueProjectAt(readyAt, t, speed)
      const [ex, ey] = this.rogueProjectAt(boxEnd, t, speed)
      if (!vert) {
        const bw = Math.max(3, ex - sx)
        ctx.fillStyle   = `${HC.backstabFill}${0.9 * fade})`
        ctx.fillRect(sx, hy + 16, bw, hh - 32)
        ctx.strokeStyle = `${HC.backstabStroke}${1.0 * fade})`
        ctx.lineWidth = 1.5
        ctx.strokeRect(sx + 0.5, hy + 16.5, bw - 1, hh - 33)
        ctx.fillStyle = `${HC.swingBar}1.0)`
        ctx.fillRect(sx - 1.5, hy - 2, 4, hh + 4)
      } else {
        const bh = Math.max(3, sy - ey)
        ctx.fillStyle   = `${HC.backstabFill}${0.9 * fade})`
        ctx.fillRect(8, ey, w - 16, bh)
        ctx.strokeStyle = `${HC.backstabStroke}${1.0 * fade})`
        ctx.lineWidth = 1.5
        ctx.strokeRect(8.5, ey + 0.5, w - 17, bh - 1)
        ctx.fillStyle = `${HC.swingBar}1.0)`
        ctx.fillRect(8 - 2, sy - 1.5, w - 16 + 4, 4)
      }
    }
    ctx.restore()

    // Stationary yellow target marker, same look as mainhand swing tracking
    this.drawHitZone()

    const seconds = bs.remainingMs / 1000
    const label = ready ? 'BACKSTAB READY' : seconds.toFixed(1) + 'S'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = ready ? '800 14px "Archivo Narrow", "Archivo", sans-serif' : '800 16px "Archivo Narrow", "Archivo", sans-serif'
    ctx.fillStyle = ready ? HC.hitZone : HC.text
    ctx.fillText(label, w / 2, hy + 12)

    if (bs.isReadyButNotSwapped) {
      ctx.font = '700 9px "Archivo", sans-serif'
      ctx.fillStyle = HC.accent
      ctx.fillText('SWAP TO BACKSTAB WEAPON', w / 2, hy + hh - 10)
    }
    ctx.textAlign = 'left'
  }

  private drawRogueSummaryScreen(rs: RogueSummaryScreen): void {
    const ctx = this.ctx
    const w = this.canvas.width, h = this.canvas.height
    const a = rs.alpha
    if (a <= 0) return
    const r = rs.result
    ctx.fillStyle = `rgba(0,0,0,${0.95 * a})`; ctx.fillRect(0, 0, w, h)

    ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
    ctx.font = '700 10px "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.textDim, a)
    ctx.fillText((r.mobName || 'FIGHT COMPLETE').toUpperCase(), 16, h / 2 - 26)

    ctx.font = '800 18px "Archivo Narrow", "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.text, a)
    ctx.fillText(`NET ${Math.round(r.netDps)} DPS`, 16, h / 2 - 4)

    ctx.font = '800 15px "Archivo Narrow", "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.hitZone, a)
    ctx.fillText(`BACKSTAB ${Math.round(r.backstabDps)} DPS`, 16, h / 2 + 16)

    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.textDim, a)
    ctx.fillText(`${r.hits} BACKSTABS LANDED`, 16, h / 2 + 34)
    ctx.fillText(`BEST 1S BURST: ${Math.round(r.bestOneSecondDamage).toLocaleString()} DMG`, 16, h / 2 + 48)
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
    const rowH = 18
    ctx.font = '800 14px "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.text, a)
    const weaved = (g as any).keystrokeGrading ? (g as any).keystrokeRoundsWeaved : (g as any).roundsWeaved
    ctx.fillText(`${weaved}/${(g as any).totalRounds} WEAVES LANDED`, 96, h / 2 - rowH)
    ctx.font = '600 12px "Archivo", sans-serif'
    ctx.fillText(`NET ${Math.round((g as any).totalDps ?? 0)} DPS`, 96, h / 2)
    ctx.fillStyle = this.rgba(HC.weaveDps, a)
    ctx.fillText(`+${Math.round(g.addedDps)} FROM WEAVING`, 96, h / 2 + rowH)

    const col2 = 270
    ctx.fillStyle = this.rgba(HC.textDim, a)
    ctx.font = '600 10px "Archivo", sans-serif'
    const r = (g as any).avgReactionMs
    ctx.fillText(`${r != null ? Math.round(r) : '—'}MS REACT`, col2, h / 2 - rowH / 2)
    ctx.fillText(`1S BURST: ${Math.round((g as any).bestOneSecondDamage ?? 0).toLocaleString()}`, col2, h / 2 + rowH / 2)

    ctx.font = '600 9px "Archivo", sans-serif'
    ctx.fillStyle = this.rgba(HC.accent, a)
    ctx.textAlign = 'right'
    ctx.fillText('[ V ] COPY  ·  [ SPACE ] DISMISS', w - 10, h - 10)

    if (this.copyFlash) {
      const age = now() - this.copyFlash.born
      const flashAlpha = age < 1400 ? 1 - Math.max(0, (age - 900) / 500) : 0
      if (flashAlpha > 0) {
        ctx.font = '700 10px "Archivo", sans-serif'
        ctx.fillStyle = this.rgba(this.copyFlash.color, a * flashAlpha)
        ctx.fillText(this.copyFlash.text, w - 10, h - 26)
      } else {
        this.copyFlash = null
      }
    }
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

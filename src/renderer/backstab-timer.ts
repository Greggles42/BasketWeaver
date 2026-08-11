/**
 * Rogue Mode — backstab cooldown timer + weapon-swap prompt state machine.
 * Deliberately separate from RhythmEngine: that engine is built around
 * continuous mainhand/offhand swing prediction (rounds, pre-generated notes,
 * median calibration), none of which fits a single 10s-cooldown ability.
 */

// EQ base backstab cooldown, in tenths-of-seconds (matches BASE_WEAPON_DELAY's units),
// fed into the same haste-scaling formula used for weapon swing intervals.
export const ROGUE_BACKSTAB_BASE_TENTHS = 100 // 10.0s base, before haste

/** Same formula as src/main/haste-calc.ts calcInterval — duplicated here rather than
 *  imported across the main/renderer boundary, matching how RhythmEngine.predictedInterval
 *  already reimplements it locally instead of importing from main/haste-calc. */
function calcIntervalSec(hastePct: number, baseDelayTenths: number): number {
  const effectiveDelay = Math.max(4, baseDelayTenths / (1.0 + hastePct / 100.0))
  return Math.max(0.5, Math.min(12.0, effectiveDelay / 10.0))
}

export type RogueState = 'idle' | 'cooldown' | 'ready'

export class BackstabTimer {
  state: RogueState = 'idle'

  private readyAt = 0          // performance.now() timestamp when backstab is next available
  private cooldownMs = ROGUE_BACKSTAB_BASE_TENTHS * 100 // ms, rescaled by onHasteChanged
  private backstabSetActive = false

  // One-shot banner guards — set by the overlay once it has pushed the banner
  // for the current cycle, cleared here when the underlying condition resets.
  swapInPromptShown = false
  swapOutPromptShown = false

  constructor(private swapWarnMs = 1500) {}

  onCombatStart(): void {
    this.state = 'idle'
    this.readyAt = 0
    this.swapInPromptShown = false
    this.swapOutPromptShown = false
  }

  onCombatEnd(): void {
    this.state = 'idle'
    this.readyAt = 0
    this.swapInPromptShown = false
    this.swapOutPromptShown = false
  }

  /** Recompute the hasted cooldown duration. Rescales any in-flight cooldown
   *  proportionally so a haste buff landing mid-cooldown adjusts the countdown live. */
  onHasteChanged(hastePct: number): void {
    const newCooldownMs = calcIntervalSec(hastePct, ROGUE_BACKSTAB_BASE_TENTHS) * 1000
    if (this.state === 'cooldown' && this.cooldownMs > 0) {
      const now = performance.now()
      const remaining = Math.max(0, this.readyAt - now)
      const fraction = remaining / this.cooldownMs
      this.readyAt = now + newCooldownMs * fraction
    }
    this.cooldownMs = newCooldownMs
  }

  /** Fired when a "Loading bandolier set <name>." line matches/doesn't match
   *  the configured backstab set name. */
  onBandolierChanged(isBackstabSet: boolean): void {
    this.backstabSetActive = isBackstabSet
    if (isBackstabSet) this.swapInPromptShown = false
    else this.swapOutPromptShown = false
  }

  /** A backstab landed (hit or miss) — either way, the ability goes on cooldown. */
  onBackstabAttack(ts: number): void {
    this.state = 'cooldown'
    this.readyAt = ts + this.cooldownMs
    this.swapInPromptShown = false
    this.swapOutPromptShown = false
  }

  /** Called once per frame from the overlay's draw loop (mirrors RhythmEngine.update(now)).
   *  Promotes 'cooldown' -> 'ready' once time is up AND the backstab set is confirmed equipped;
   *  otherwise stays in 'cooldown' so isReadyButNotSwapped keeps nagging. */
  update(now: number): void {
    if (this.state === 'cooldown' && now >= this.readyAt && this.backstabSetActive) {
      this.state = 'ready'
    }
  }

  get remainingMs(): number {
    if (this.state === 'ready') return 0
    if (this.state !== 'cooldown') return 0
    return Math.max(0, this.readyAt - performance.now())
  }

  get progressPct(): number {
    if (this.state === 'ready') return 1
    if (this.state !== 'cooldown' || this.cooldownMs <= 0) return 0
    return Math.min(1, Math.max(0, 1 - this.remainingMs / this.cooldownMs))
  }

  /** Time-driven: fire the "swap to backstab weapon" prompt in the closing window
   *  of the cooldown (or any time we're ready-but-unswapped), unless the backstab
   *  set is already equipped. */
  get shouldPromptSwapIn(): boolean {
    if (this.backstabSetActive) return false
    if (this.state === 'ready') return true
    if (this.state !== 'cooldown') return false
    return this.remainingMs <= this.swapWarnMs
  }

  /** Cooldown finished but the player never confirmed the swap — the correct
   *  degraded behavior is to keep nagging rather than silently going quiet. */
  get isReadyButNotSwapped(): boolean {
    return this.state === 'cooldown' && this.remainingMs <= 0 && !this.backstabSetActive
  }

  /** A backstab just landed and the player is still on the backstab set —
   *  remind them to swap back to their DPS weapons. */
  get shouldPromptSwapOut(): boolean {
    return this.state === 'cooldown' && this.backstabSetActive
  }
}

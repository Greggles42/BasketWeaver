/**
 * Rogue Mode — Hide/Evade reuse timer. Fixed-duration cooldown (unlike
 * BackstabTimer, not haste-scaled): tracks when the Hide or in-combat
 * Evade AA is next usable so the player knows when to click the macro again.
 * Deliberately simple compared to BackstabTimer — no "landing window" concept,
 * since Hide/Evade has no timing-precision requirement, just ready-or-not.
 */

export type EvadeState = 'idle' | 'cooldown' | 'ready'

export class EvadeTimer {
  state: EvadeState = 'idle'

  private readyAt = 0          // performance.now() timestamp when usable again
  private cooldownMs = 7000    // last cooldown duration used, for progressPct/remainingMs
  // Dedupes near-simultaneous duplicate EVADE_USED events from the log reader
  // and the Zeal pipe reader both matching the same line in hybrid mode.
  private lastTriggerTs = 0

  /** The Hide or Evade ability was just triggered (success or fail — EQ starts
   *  the reuse timer either way), putting it on cooldown. `cooldownMs` is
   *  passed in fresh each time since it depends on the user-configurable AA
   *  reduction setting, which can change live. */
  onAbilityUsed(ts: number, cooldownMs: number): void {
    if (this.lastTriggerTs > 0 && ts - this.lastTriggerTs < 300) return
    this.lastTriggerTs = ts
    this.cooldownMs = cooldownMs
    this.state = 'cooldown'
    this.readyAt = ts + cooldownMs
  }

  update(now: number): void {
    if (this.state === 'cooldown' && now >= this.readyAt) this.state = 'ready'
  }

  get readyAtMs(): number { return this.readyAt }
  get cooldownMsValue(): number { return this.cooldownMs }

  get remainingMs(): number {
    if (this.state !== 'cooldown') return 0
    return Math.max(0, this.readyAt - performance.now())
  }

  get progressPct(): number {
    if (this.state === 'ready') return 1
    if (this.state !== 'cooldown' || this.cooldownMs <= 0) return 0
    return Math.min(1, Math.max(0, 1 - this.remainingMs / this.cooldownMs))
  }
}

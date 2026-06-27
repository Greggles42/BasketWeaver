/**
 * EncounterRecord — a fully annotated fight record suitable for local
 * storage and community leaderboard upload.
 *
 * All GradeResult fields are inlined (not extended) so the type survives
 * JSON serialization across IPC and the Vercel API boundary.
 */

export interface EncounterRecord {
  // ── GradeResult fields ───────────────────────────────────────
  grade: string
  mobName: string
  pctInGreen: number           // 0–1, fraction of mainhand rounds with weave attempt
  roundsWeaved: number
  keystrokeRoundsWeaved: number
  totalRounds: number
  weaveAttempts: number
  weaveLanded: number
  keystrokeGrading: boolean
  totalFistDamage: number
  fightDuration: number        // ms, wall-clock total (including out-of-range time)
  addedDps: number             // fist-only DPS
  totalDps: number             // mainhand + fist + misc DPS
  avgReactionMs: number | null

  // ── Leaderboard fields ───────────────────────────────────────
  id: string                   // crypto.randomUUID() — dedup key
  timestamp: number            // Date.now() when fight ended
  characterName: string        // from Zeal pipe or config
  serverName: string           // user-configured EQ server name

  weapons: {
    mainhand: string           // detected weapon name or 'Unknown'
    offhand: string            // offhand name from config or 'Unknown'
  }

  atkRating: number            // last known ATK at or before fight end (0 = unknown)
  hastePct: number             // last known haste % (0 = none/unknown)

  engagedMs: number            // ms actually in melee range during fight
  outOfRangeMs: number         // ms accumulated in OUT_OF_RANGE state during fight

  disciplinesUsed: string[]    // e.g. ['innerflame', 'savagery']
  /** Fraction (0–1) of fightDuration each buff was active. 0 = not active during fight. */
  buffsActive: {
    avatar:     number
    savagery:   number
    innerflame: number
  }

  /** Per-second compensated DPS values (index 0 = second 1). The denominator
   *  is max(15, t) so the first 15 s are normalised to a 15-second window,
   *  removing the initial spike. Empty array if no damage was logged. */
  dpsSamples: number[]
}

/**
 * Discipline reuse/recast cooldown data and math.
 *
 * The server uses ONE shared reuse timer for all disciplines (confirmed by the
 * user), so callers track a single ready-at timestamp, not one per discipline.
 *
 * Base reuse seconds and minimum-use level are the Monk values (this app is a
 * fistweaving tool) read from the eqmacemu server source (C:\Projects\eqmacemu-src,
 * zone/effects.cpp, Client::CastDiscipline): the per-discipline reuse timer is a
 * hardcoded value in that switch statement, NOT the `recast_time` column in the
 * spells_new SQL table (that column is vestigial/unused by the actual reuse logic).
 * Gained/lost chat text was cross-checked against
 * utils/sql/git/required/2015_08_26_disc_spells.sql's cast_on_you/spell_fades columns.
 */

export type DisciplineKey = 'stonestance' | 'whirlwind' | 'innerflame'

export const DISCIPLINE_REUSE_DATA: Record<DisciplineKey, { baseReuseSec: number; minLevel: number }> = {
  stonestance: { baseReuseSec: 720,  minLevel: 51 },
  whirlwind:   { baseReuseSec: 3600, minLevel: 53 },
  innerflame:  { baseReuseSec: 1800, minLevel: 56 },
}

/**
 * Mirrors effects.cpp's level-scaling: reuse shrinks 54s for every level above
 * the discipline's minimum-use level, clamped to [234s, 4320s] (3:54-72:00).
 */
export function computeDiscReuseSeconds(key: DisciplineKey, characterLevel: number): number {
  const { baseReuseSec, minLevel } = DISCIPLINE_REUSE_DATA[key]
  let level = characterLevel
  if (baseReuseSec < 1620 && level > 60) level = 60
  const reuse = baseReuseSec - (level - minLevel) * 54
  return Math.min(4320, Math.max(234, reuse))
}

export const DISCIPLINE_COLORS: Record<DisciplineKey, string> = {
  stonestance: '#9ca3af',
  whirlwind:   '#c084fc',
  innerflame:  '#e89020',
}

/** Formats a remaining-ms duration as "M:SS" for the cooldown chip. */
export function formatCooldown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Fistweave interval calculation from EQ haste stats.
 * Direct port of haste_calc.py.
 */

interface HastePattern {
  re: RegExp
  mode: 'pct' | 'attack_speed'
}

const PATTERNS: HastePattern[] = [
  { re: /^haste[:\s]+(\d+)\s*%/i,                  mode: 'pct' },
  { re: /^melee haste[:\s]+(\d+)\s*%/i,             mode: 'pct' },
  { re: /your (?:melee )?haste (?:is|:)\s+(\d+)/i,  mode: 'pct' },
  { re: /^attack speed[:\s]+(\d+)/i,                mode: 'attack_speed' },
  { re: /your attack speed is\s+(\d+)/i,            mode: 'attack_speed' },
  { re: /haste:\s*(\d+)%/i,                         mode: 'pct' },
  { re: /\((\d+)%\s+haste\)/i,                      mode: 'pct' },
]

/** Returns haste as a percentage (e.g. 40.0) or null if not found. */
export function parseHaste(line: string): number | null {
  for (const { re, mode } of PATTERNS) {
    const m = re.exec(line)
    if (m) {
      const val = parseInt(m[1], 10)
      if (mode === 'attack_speed') {
        return Math.max(0, val - 100)
      }
      return Math.max(0, val)
    }
  }
  return null
}

/** Calculate the optimal fistweave punch interval in seconds. */
export function calcInterval(hastePct: number, baseDelayTenths = 20): number {
  const effectiveDelay = Math.max(4, baseDelayTenths / (1.0 + hastePct / 100.0))
  return Math.max(0.5, Math.min(12.0, effectiveDelay / 10.0))
}

const ATK_PATTERNS: RegExp[] = [
  /^attack[:\s]+(\d+)/i,
  /^atk[:\s]+(\d+)/i,
  /your attack(?: rating)? is[:\s]+(\d+)/i,
  /attack rating[:\s]+(\d+)/i,
  /\battack\s*:\s*(\d+)/i,
]

/** Returns attack rating as an integer (e.g. 850) or null if not found. */
export function parseAtkRating(line: string): number | null {
  for (const re of ATK_PATTERNS) {
    const m = re.exec(line)
    if (m) {
      const val = parseInt(m[1], 10)
      if (val > 0) return val
    }
  }
  return null
}

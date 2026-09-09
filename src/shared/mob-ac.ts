import highHpMobs from './high_hp_mobs.json'

interface HighHpMob { id: number; name: string; hp: number; ac: number }

const acsByName = new Map<string, Set<number>>()
for (const m of highHpMobs as HighHpMob[]) {
  const key = m.name.toLowerCase().replace(/_/g, ' ').trim()
  if (!acsByName.has(key)) acsByName.set(key, new Set())
  acsByName.get(key)!.add(m.ac)
}

/** Looks up a known target's AC from the high-HP mob dataset, by name.
 *  Returns 'ambiguous' when multiple instances of the mob have differing AC values. */
export function lookupMobAc(mobName: string): number | 'ambiguous' | undefined {
  if (!mobName) return undefined
  const acs = acsByName.get(mobName.toLowerCase().trim())
  if (!acs) return undefined
  return acs.size > 1 ? 'ambiguous' : [...acs][0]
}

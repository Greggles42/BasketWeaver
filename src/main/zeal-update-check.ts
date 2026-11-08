/**
 * Checks GitHub for the latest Zeal release and compares it against the Zeal
 * version Basketweaver has detected in-game (via "/zeal version" chat text —
 * see zeal-reader.ts). Pure network + comparison helpers; orchestration
 * (timers, notification) lives in main/index.ts.
 */

const ZEAL_RELEASES_LATEST_URL = 'https://api.github.com/repos/CoastalRedwood/Zeal/releases/latest'

/** Returns the latest Zeal version tag (e.g. "1.4.8", leading "v" stripped),
 *  or null on any network/parse failure — callers should treat null as
 *  "unknown, try again later," never as "no update available." */
export async function fetchLatestZealVersion(): Promise<string | null> {
  try {
    const res = await fetch(ZEAL_RELEASES_LATEST_URL, {
      headers: { 'User-Agent': 'Basketweaver', Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return null
    const data = await res.json() as { tag_name?: string }
    if (!data.tag_name) return null
    return data.tag_name.replace(/^v/i, '').trim()
  } catch {
    return null
  }
}

/** Dotted-numeric version comparison (e.g. "1.4.8" vs "1.4.10") — not full
 *  semver (no pre-release/build metadata handling), which is all Zeal's plain
 *  "X.Y.Z" tags need. Returns true if `latest` is strictly newer than `installed`. */
export function isZealOutdated(installed: string, latest: string): boolean {
  const a = installed.split('.').map(n => parseInt(n, 10) || 0)
  const b = latest.split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0
    const bi = b[i] ?? 0
    if (bi > ai) return true
    if (bi < ai) return false
  }
  return false
}

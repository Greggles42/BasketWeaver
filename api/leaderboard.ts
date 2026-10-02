import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from '@vercel/postgres'
import { ALLOWED_MOBS } from './_allowed-mobs'

// See records.ts — strips a zone-disambiguation suffix (e.g. "(Plane of
// Disease)") before checking mob_name against ALLOWED_MOBS.
const BASE_MOB_NAME_SQL = "regexp_replace(LOWER(mob_name), '\\s*\\([^)]*\\)\\s*$', '')"

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const mob    = String(req.query.mob    ?? '')
  const server = String(req.query.server ?? '')
  const limit  = Math.min(200, parseInt(String(req.query.limit  ?? '50')))
  const offset = Math.max(0,   parseInt(String(req.query.offset ?? '0')))

  const conditions: string[] = []
  const params: (string | number)[] = []
  if (mob)    { params.push(mob);    conditions.push(`LOWER(mob_name) = LOWER($${params.length})`) }
  if (server) { params.push(server); conditions.push(`LOWER(server_name) = LOWER($${params.length})`) }

  const mobPlaceholders = ALLOWED_MOBS.map((_, i) => `$${params.length + i + 1}`).join(', ')
  params.push(...ALLOWED_MOBS)
  conditions.push(`${BASE_MOB_NAME_SQL} IN (${mobPlaceholders})`)

  params.push(limit, offset)

  const where = 'WHERE ' + conditions.join(' AND ')
  const limitIdx  = params.length - 1
  const offsetIdx = params.length

  const client = await db.connect()
  try {
    // COUNT(*) OVER() reports the total matching rows (pre-LIMIT) alongside each
    // returned row, so pagination can report a real total instead of the page size.
    const result = await client.query(
      `SELECT *, COUNT(*) OVER() AS full_count FROM records ${where} ORDER BY total_dps DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    )
    const total = result.rows.length > 0 ? Number(result.rows[0].full_count) : 0
    const records = result.rows.map((row: Record<string, unknown>) => {
      const { full_count, ...rest } = row
      return rest
    })
    return res.status(200).json({ records, total })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return res.status(500).json({ error: `DB error: ${msg}` })
  } finally {
    client.release()
  }
}

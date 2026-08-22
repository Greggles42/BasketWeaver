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

  const server = String(req.query.server ?? '')

  const params: (string | number)[] = []
  const conditions: string[] = []

  if (server) {
    params.push(server)
    conditions.push(`LOWER(server_name) = LOWER($${params.length})`)
  }

  const mobPlaceholders = ALLOWED_MOBS.map((_, i) => `$${params.length + i + 1}`).join(', ')
  params.push(...ALLOWED_MOBS)
  conditions.push(`${BASE_MOB_NAME_SQL} IN (${mobPlaceholders})`)

  const where = 'WHERE ' + conditions.join(' AND ')

  const client = await db.connect()
  try {
    const result = await client.query(
      `SELECT mob_name, COUNT(*) AS count, MAX(total_dps) AS best_dps, MAX(timestamp) AS last_upload
       FROM records ${where}
       GROUP BY mob_name ORDER BY last_upload DESC`,
      params
    )
    return res.status(200).json({ mobs: result.rows })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return res.status(500).json({ error: `DB error: ${msg}` })
  } finally {
    client.release()
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from '@vercel/postgres'

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

  const params: string[] = []
  const where = server ? (params.push(server), 'WHERE LOWER(server_name) = LOWER($1)') : ''

  const client = await db.connect()
  try {
    const result = await client.query(
      `SELECT mob_name, COUNT(*) AS count, MAX(total_dps) AS best_dps
       FROM records ${where}
       GROUP BY mob_name ORDER BY count DESC`,
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

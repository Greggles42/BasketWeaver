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

  const mob    = String(req.query.mob    ?? '')
  const server = String(req.query.server ?? '')
  const limit  = Math.min(200, parseInt(String(req.query.limit  ?? '50')))
  const offset = Math.max(0,   parseInt(String(req.query.offset ?? '0')))

  const conditions: string[] = []
  const params: (string | number)[] = []
  if (mob)    { params.push(mob);    conditions.push(`LOWER(mob_name) = LOWER($${params.length})`) }
  if (server) { params.push(server); conditions.push(`LOWER(server_name) = LOWER($${params.length})`) }
  params.push(limit, offset)

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
  const limitIdx  = params.length - 1
  const offsetIdx = params.length

  const client = await db.connect()
  try {
    const result = await client.query(
      `SELECT * FROM records ${where} ORDER BY total_dps DESC LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    )
    return res.status(200).json({ records: result.rows, total: result.rows.length })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return res.status(500).json({ error: `DB error: ${msg}` })
  } finally {
    client.release()
  }
}

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { db } from '@vercel/postgres'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v))
  if (req.method === 'OPTIONS') return res.status(200).end()

  const client = await db.connect()
  try {
    // ── POST /api/records — submit a record ──────────────────────────────────
    if (req.method === 'POST') {
      const key = String(req.headers['x-api-key'] ?? '')
      if (!process.env.API_KEY || key !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' })
      }

      const rec = req.body
      if (!rec?.id || !rec?.mob_name || !rec?.character_name) {
        return res.status(400).json({ error: 'Missing required fields: id, mob_name, character_name' })
      }

      await client.query(
        `INSERT INTO records (
          id, character_name, server_name, mob_name, grade,
          total_dps, fist_dps, fight_duration, engaged_ms, out_of_range_ms,
          mainhand, offhand, atk_rating, haste_pct,
          disciplines_used, buffs_at_start,
          pct_in_green, total_rounds, weave_attempts, weave_landed,
          avg_reaction_ms, timestamp
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
        ) ON CONFLICT (id) DO NOTHING`,
        [
          rec.id,
          rec.character_name,
          rec.server_name      ?? '',
          rec.mob_name,
          rec.grade            ?? 'F',
          rec.totalDps         ?? 0,
          rec.addedDps         ?? 0,
          rec.fightDuration    ?? 0,
          rec.engagedMs        ?? 0,
          rec.outOfRangeMs     ?? 0,
          rec.weapons?.mainhand ?? '',
          rec.weapons?.offhand  ?? '',
          rec.atkRating        ?? 0,
          rec.hastePct         ?? 0,
          JSON.stringify(rec.disciplinesUsed ?? []),
          JSON.stringify(rec.buffsAtStart    ?? {}),
          rec.pctInGreen       ?? 0,
          rec.totalRounds      ?? 0,
          rec.weaveAttempts    ?? 0,
          rec.weaveLanded      ?? 0,
          rec.avgReactionMs    ?? null,
          rec.timestamp        ?? Date.now(),
        ]
      )
      return res.status(201).json({ ok: true })
    }

    // ── GET /api/records — character history ─────────────────────────────────
    if (req.method === 'GET') {
      const char   = String(req.query.char   ?? '')
      const server = String(req.query.server ?? '')
      const limit  = Math.min(200, parseInt(String(req.query.limit ?? '100')))

      const conditions: string[] = []
      const params: (string | number)[] = []
      if (char)   { params.push(char);   conditions.push(`LOWER(character_name) = LOWER($${params.length})`) }
      if (server) { params.push(server); conditions.push(`LOWER(server_name) = LOWER($${params.length})`) }
      params.push(limit)

      const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
      const result = await client.query(
        `SELECT * FROM records ${where} ORDER BY timestamp DESC LIMIT $${params.length}`,
        params
      )
      return res.status(200).json({ records: result.rows })
    }

    return res.status(405).json({ error: 'Method not allowed' })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return res.status(500).json({ error: `DB error: ${msg}` })
  } finally {
    client.release()
  }
}

/**
 * LeaderboardManager — persists EncounterRecord objects to
 * %APPDATA%/Basketweaver/leaderboard.json.
 *
 * Retention policy: top 100 records per mob name, ranked by totalDps.
 * Deduplication: by record id (uuid).
 */

import * as fs   from 'fs'
import * as path from 'path'
import * as https from 'https'
import type { EncounterRecord } from '../shared/leaderboard-types'

const MAX_PER_MOB = 100

export class LeaderboardManager {
  private filePath: string
  private records: EncounterRecord[] = []

  constructor(configDir: string) {
    this.filePath = path.join(configDir, 'leaderboard.json')
    this.load()
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) this.records = parsed
      }
    } catch {
      this.records = []
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.records), 'utf8')
    } catch (err) {
      console.error('[Leaderboard] Failed to save:', err)
    }
  }

  addRecord(record: EncounterRecord): void {
    // Dedup by id
    if (this.records.some(r => r.id === record.id)) return

    this.records.push(record)

    // Prune: keep top MAX_PER_MOB per mob by totalDps
    const mob = record.mobName
    const mobRecords = this.records
      .filter(r => r.mobName === mob)
      .sort((a, b) => b.totalDps - a.totalDps)
    if (mobRecords.length > MAX_PER_MOB) {
      const toRemove = new Set(mobRecords.slice(MAX_PER_MOB).map(r => r.id))
      this.records = this.records.filter(r => !toRemove.has(r.id))
    }

    this.save()
  }

  getAll(): EncounterRecord[] {
    return [...this.records].sort((a, b) => b.timestamp - a.timestamp)
  }

  getByMob(mobName: string): EncounterRecord[] {
    return this.records
      .filter(r => r.mobName.toLowerCase() === mobName.toLowerCase())
      .sort((a, b) => b.totalDps - a.totalDps)
  }

  personalBest(mobName: string, characterName: string): EncounterRecord | null {
    const matches = this.records.filter(
      r => r.mobName.toLowerCase() === mobName.toLowerCase() &&
           r.characterName.toLowerCase() === characterName.toLowerCase()
    )
    if (matches.length === 0) return null
    return matches.reduce((best, r) => r.totalDps > best.totalDps ? r : best)
  }

  getMobNames(): string[] {
    return [...new Set(this.records.map(r => r.mobName))].sort()
  }

  /** Upload a single record to the configured Cloudflare Worker.
   *  Returns true on success, false on error. */
  async upload(record: EncounterRecord, workerUrl: string, apiKey: string): Promise<boolean> {
    return new Promise((resolve) => {
      const body = JSON.stringify(record)
      const url  = new URL('/api/records', workerUrl)
      const options = {
        hostname: url.hostname,
        port:     url.port || 443,
        path:     url.pathname,
        method:   'POST',
        headers: {
          'Content-Type':  'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-API-Key':     apiKey,
        },
      }
      const req = https.request(options, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 201)
      })
      req.on('error', (err) => {
        console.error('[Leaderboard] Upload error:', err.message)
        resolve(false)
      })
      req.setTimeout(8000, () => { req.destroy(); resolve(false) })
      req.write(body)
      req.end()
    })
  }
}

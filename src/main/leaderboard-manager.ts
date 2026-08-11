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
const MAX_LOG_BYTES = 512 * 1024   // truncate upload log once it exceeds this size

/**
 * Mobs whose kills may be uploaded to the online leaderboard.
 * All comparisons are case-insensitive (names stored as lowercase).
 * Local leaderboard is unrestricted — this list only gates uploads.
 */
const ONLINE_ELIGIBLE_MOBS = new Set<string>([
  // ── Classic ──────────────────────────────────────────────────
  // Nagafen's Lair
  'lord nagafen',
  // Permafrost Keep
  'lady vox',
  // Plane of Fear
  'cazic thule', 'dread', 'fright', 'terror',
  // Plane of Hate
  'innoruuk',
  // Plane of Sky
  'thunder spirit princess', 'noble dojorn', 'protector of sky', 'gorgalosk',
  'keeper of souls', 'overseer of air',
  'spiroc guardian', 'the spiroc lord',
  'bazzt zzzt',
  'sister of the spire',
  'hand of veeshan', 'eye of veeshan',

  // ── Ruins of Kunark ──────────────────────────────────────────
  'severilous', 'talendor', 'faydedar', 'gorenaire', 'trakanon',
  'venril sathir',
  'king tearis thex', 'queen velazul di\'zok',
  // Veeshan's Peak
  'silverwing', 'hoshkar', 'phara dar', 'nexona', 'druushk', 'xygoz',

  // ── Scars of Velious ─────────────────────────────────────────
  'dain frostreaver iv',
  'klandicar', 'sontalak',
  'zlandicar',
  // Kael Drakkal
  'derakor the vindicator', 'statue of rallos zek', 'king tormax',
  // Skyshrine
  'lord yelinak',
  // Velketor's Labyrinth
  'velketor the sorcerer',
  // Plane of Growth
  'tunare',
  // Wakening Land
  'wuoshi', 'lord doljonijiarnimorinar',
  // Sleeper's Tomb
  'hraashna', 'nanzata', 'tukaarak', 'ventani',
  'the progenitor', 'master of the guard', 'the final arbiter', 'kerafyrm',
  // Temple of Veeshan (entrance / Halls of Testing)
  'zeixshi-kar', 'tjudawos', 'vyskudra', 'kildrukaun the ancients',
  'casalem', 'essedera', 'grozzmel', 'krigara', 'lepethida',
  'midayor', 'tavekalem', 'ymmeln', 'zemm',
  // North Temple of Veeshan
  'aaryonar', 'dozekar the cursed', 'cekenar', 'lord feshlak', 'jorlleag',
  'lord koi\'doken', 'lord kreizenn', 'lendiniara the keeper',
  'lady mirenilla', 'lady nevederia', 'sevalak', 'lord vyemm',
  'dagarn the destroyer', 'zlexak', 'eashen of the sky',
  'ikatiar the venom', 'gozzrem', 'telkorenar', 'vulak`aerr',

  // ── Shadows of Luclin ─────────────────────────────────────────
  // Ssraeshza Temple
  'xerikizh the creator', 'the high priest of ssraeshza', 'emperor ssraeshza',
  'a glyph covered serpent', 'vyzh`dra the exiled', 'vyzh`dra the cursed',
  // Sanctus Seru
  'lord inquisitor seru',
  // Acrylia Caverns
  'khati sha the twisted',
  // Akheva Ruins
  'the itraer vius', 'shei vinitras', 'the insanity crawler',
  // Grieg's End
  'grieg veneficus',
  // Vex Thal
  'kaas thox xi ans dyek', 'thall va xakra', 'thall xundraux diabo',
  'diabo xi xin', 'diabo xi va', 'diabo xi xin thall', 'thall va kelun',
  'diabo xi va terminiel', 'thunderos xi diabo',
  'kaas thox xi aten ha ra', 'va xi aten ha ra', 'aten ha ra',
])

export class LeaderboardManager {
  private filePath: string
  private logFilePath: string
  private records: EncounterRecord[] = []

  constructor(configDir: string) {
    this.filePath = path.join(configDir, 'leaderboard.json')
    this.logFilePath = path.join(configDir, 'leaderboard-upload.log')
    this.load()
  }

  /**
   * Persist a one-line diagnostic to disk. console.log is invisible for a
   * packaged app launched by double-click (no attached console), so this is
   * the only way upload failures are ever visible to a user asked to send
   * their log — see leaderboard-upload.log next to leaderboard.json.
   */
  log(message: string): void {
    const line = `[${new Date().toISOString()}] ${message}\n`
    console.log(message)
    try {
      if (fs.existsSync(this.logFilePath) && fs.statSync(this.logFilePath).size > MAX_LOG_BYTES) {
        fs.writeFileSync(this.logFilePath, '', 'utf8')
      }
      fs.appendFileSync(this.logFilePath, line, 'utf8')
    } catch (err) {
      console.error('[Leaderboard] Failed to write upload log:', err)
    }
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
    // Filter out implausible or trivial fights
    if (record.fightDuration < 10_000) return          // shorter than 10 seconds
    if (record.totalDps > 2_000) return                // unrealistically high DPS

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

  /** Returns true if this mob's kills are permitted on the online leaderboard. */
  static isOnlineEligible(mobName: string): boolean {
    return ONLINE_ELIGIBLE_MOBS.has(mobName.toLowerCase())
  }

  /** Upload a single record to the Vercel API (basketweaver.vercel.app).
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
        const ok = res.statusCode === 200 || res.statusCode === 201
        if (!ok) {
          let body = ''
          res.on('data', (c) => { body += c })
          res.on('end', () => {
            this.log(`[Leaderboard] Upload rejected for "${record.mobName}": HTTP ${res.statusCode} ${body.slice(0, 300)}`)
            resolve(false)
          })
        } else {
          resolve(true)
        }
      })
      req.on('error', (err) => {
        this.log(`[Leaderboard] Upload error for "${record.mobName}": ${err.message}`)
        resolve(false)
      })
      req.setTimeout(8000, () => {
        this.log(`[Leaderboard] Upload timed out for "${record.mobName}" after 8s`)
        req.destroy()
        resolve(false)
      })
      req.write(body)
      req.end()
    })
  }
}

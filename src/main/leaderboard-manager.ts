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

  // ── Planes of Power ─────────────────────────────────────────────
  'a deadly warboar', 'a ferocious warboar', 'a monstrous mudwalker',
  'a mystical arbitor of earth', 'a perfected warder of earth', 'a rathe councilman',
  'advocent joran', "aerin'dar", 'agnarr the storm lord', 'anar of water',
  'arch mage alchtonion', 'arch mage yozanni', 'arlyxir', 'auliffe chaoswind',
  'avatar of dust', 'avatar of earth', 'avatar of mist', 'avatar of smoke',
  'avatar of the elements', 'avatar of wind', 'azobian the darklord',
  'babnoxis the spider queen', 'baltaldor the cursed',
  'bertoxxulous',   // two versions — disambiguated by zone, see AMBIGUOUS_MOBS
  'blazzax the omnifiend', 'brynju thunderclap',
  'chamberlain escalardian', 'champion of torment', 'chancellor kirta', 'chancellor traxom',
  'coirnav the avatar of water', 'criare sunmane',
  'deathbringer blackheart', 'deathbringer skullsmash',
  'decorin berik', 'decorin grunhork', 'derugoak bloodwalker',
  "dersool fal'giersnaol", 'deyid the twisted', 'dreamwarp',
  "drornok tok vo'lok", 'earthen overseer', 'eindride icestorm',
  'emmerik skyfury', 'evynd firestorm', 'falto, lord of thunder',
  'fennin ro, the tyrant of fire', 'freegan haun', 'gaukr sandstorm',
  'general druav flamesinger', 'general reparm', 'glykus helmir',
  'grioihin the wise', 'grummus', 'guardian of coirnav', 'guardian of doomfire',
  'gurebk, lord of krendic', 'gutripping war beast', 'halgoz rellinic',
  'hebabbilys the ragelord', 'high priest ultor szanvon', 'hobgoblin anguish lord',
  'hreidar lynhillig', 'hydrotha',
  'javonn the overlord', 'jaxoliz dawneyes', 'jeplak, lord of srerendi', 'jiva',
  'kazrok of fire', 'krziik the mighty', 'kuanbyr hailstorm', 'laef windfall',
  'lord mithaniel marr', 'maareq the prophet', 'magmaton', 'manaetic behemoth',
  'mujaki the devourer', "neffiken, lord of kelek'vor", 'neimon of air',
  'ofossaa the enlightened', 'omni magus crato', 'oreen wavecrasher',
  'overlord banord paffa', 'peregrin rockskull', 'pyronis', 'quarm',
  'quavonis firetail', 'queen silandria', 'ralthazor, champion of marr', 'ralthos enrok',
  'rallos zek',   // two versions — disambiguated by zone, see AMBIGUOUS_MOBS
  'rallos zek the warlord', 'reaxnous the chaoslord', 'rinturion windblade',
  'rizlona', 'rythor of the undead', 'salczek the fleshgrinder',
  'saryrn',   // two versions — disambiguated by zone, see AMBIGUOUS_MOBS
  'solusek ro', 'sorrowsong', "ston'ruak, ancient of the trees", 'supernatural guardian',
  "ta'grusch the abomination",
  'tallon zek',   // two versions — disambiguated by zone, see AMBIGUOUS_MOBS
  'terris-thule',   // two versions — disambiguated by zone, see AMBIGUOUS_MOBS
  'the keeper of sorrow', 'the protector of desolik',
  'vallon zek',   // two versions — disambiguated by zone, see AMBIGUOUS_MOBS
  'warlord prollaz', 'xanamech nezmirthafen', 'xegony', 'xuzl',
])

/**
 * Mobs whose NPC name is reused for two distinct raid encounters.
 * When one of these is uploaded, its mob name is suffixed with the player's
 * current zone (e.g. "Bertoxxulous (Plane of Disease)") so the two versions
 * land in separate leaderboard buckets instead of colliding.
 */
const AMBIGUOUS_MOBS = new Set<string>([
  'bertoxxulous', 'rallos zek', 'saryrn', 'terris-thule', 'tallon zek', 'vallon zek',
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

  /** Returns true if this mob's kills are permitted on the online leaderboard.
   *  Strips a trailing zone qualifier (e.g. "(Plane of Disease)") added by
   *  qualifyMobName() so ambiguous-mob uploads still pass the allowlist. */
  static isOnlineEligible(mobName: string): boolean {
    const base = mobName.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()
    return ONLINE_ELIGIBLE_MOBS.has(base)
  }

  /** For mobs whose NPC name is reused by two distinct raid encounters (see
   *  AMBIGUOUS_MOBS), appends the current zone name so the two versions are
   *  tracked as separate leaderboard entries. No-op for every other mob, or
   *  when the current zone is unknown. */
  static qualifyMobName(mobName: string, zoneName: string): string {
    if (!zoneName) return mobName
    if (!AMBIGUOUS_MOBS.has(mobName.trim().toLowerCase())) return mobName
    return `${mobName} (${zoneName})`
  }

  /** Upload a single record to the Vercel API (basketweaver.vercel.app).
   *  Returns { ok: true, rank } on success — rank is this fight's placement
   *  among all records for the same mob, sorted by total DPS (1 = best). */
  async upload(record: EncounterRecord, workerUrl: string, apiKey: string): Promise<{ ok: boolean; rank?: number }> {
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
        let body = ''
        res.on('data', (c) => { body += c })
        res.on('end', () => {
          if (!ok) {
            this.log(`[Leaderboard] Upload rejected for "${record.mobName}": HTTP ${res.statusCode} ${body.slice(0, 300)}`)
            resolve({ ok: false })
            return
          }
          try {
            const parsed = JSON.parse(body) as { rank?: number }
            resolve({ ok: true, rank: parsed.rank })
          } catch {
            resolve({ ok: true })
          }
        })
      })
      req.on('error', (err) => {
        this.log(`[Leaderboard] Upload error for "${record.mobName}": ${err.message}`)
        resolve({ ok: false })
      })
      req.setTimeout(8000, () => {
        this.log(`[Leaderboard] Upload timed out for "${record.mobName}" after 8s`)
        req.destroy()
        resolve({ ok: false })
      })
      req.write(body)
      req.end()
    })
  }
}

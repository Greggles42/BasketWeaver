/**
 * Leaderboard window renderer.
 * Displays local fight records and allows uploading to the community board.
 */

import type { EncounterRecord } from '../shared/leaderboard-types'

type R = EncounterRecord

declare global {
  interface Window {
    leaderboardAPI: {
      onData:       (cb: (records: unknown[]) => void) => void
      onConfig:     (cb: (cfg: { workerUrl: string; characterName: string; uploadEnabled: boolean }) => void) => void
      uploadRecord: (record: unknown) => void
      getAll:       () => Promise<unknown[]>
      openSettings: () => void
    }
  }
}

// ── State ─────────────────────────────────────────────────────

let allRecords: R[] = []
let sortCol   = 'timestamp'
let sortAsc   = false
let workerUrl = ''
const uploadedIds = new Set<string>()

// ── DOM refs ──────────────────────────────────────────────────

const filterMob    = document.getElementById('filterMob')    as HTMLInputElement
const filterChar   = document.getElementById('filterChar')   as HTMLInputElement
const tbody        = document.getElementById('lbBody')!
const statusText   = document.getElementById('statusText')!
const communityLink = document.getElementById('communityLink')!
const btnUploadAll  = document.getElementById('btnUploadAll')  as HTMLButtonElement
const btnSettings   = document.getElementById('btnSettings')   as HTMLButtonElement
const chartPanel    = document.getElementById('chartPanel')!
const chartTitle    = document.getElementById('chartTitle')!
const btnCloseChart = document.getElementById('btnCloseChart') as HTMLButtonElement
const dpsCanvas     = document.getElementById('dpsChart')      as HTMLCanvasElement

// ── Helpers ───────────────────────────────────────────────────

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function getNestedVal(rec: EncounterRecord, col: string): unknown {
  const parts = col.split('.')
  let v: unknown = rec
  for (const p of parts) v = (v as Record<string, unknown>)?.[p]
  return v
}

function gradeClass(grade: string): string {
  return `grade-${grade}` in document.documentElement.style ? '' : `grade-${grade}`
}

// ── Render ────────────────────────────────────────────────────

function filtered(): R[] {
  const mob = filterMob.value.toLowerCase()
  const chr = filterChar.value.toLowerCase()
  return allRecords.filter(r =>
    (!mob || r.mobName.toLowerCase().includes(mob)) &&
    (!chr || r.characterName.toLowerCase().includes(chr))
  )
}

function sorted(records: R[]): R[] {
  return [...records].sort((a, b) => {
    let av = getNestedVal(a, sortCol)
    let bv = getNestedVal(b, sortCol)
    if (av == null) av = ''
    if (bv == null) bv = ''
    const cmp = typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv))
    return sortAsc ? cmp : -cmp
  })
}

function render(): void {
  const rows = sorted(filtered())
  statusText.textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''} (${allRecords.length} total)`

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="18" class="empty">No records match the current filters.</td></tr>'
    return
  }

  tbody.innerHTML = rows.map(r => {
    const discs = r.disciplinesUsed.join(', ') || '—'
    const buffs  = [
      r.buffsAtStart.avatar   ? 'Avatar'   : '',
      r.buffsAtStart.savagery ? 'Savagery' : '',
    ].filter(Boolean).join(', ') || '—'

    const uploaded = uploadedIds.has(r.id)
    const uploadLabel = uploaded ? '✓ Sent' : 'Upload'
    const uploadClass = uploaded ? 'uploaded' : ''

    return `<tr data-id="${escHtml(r.id)}">
      <td>${escHtml(r.mobName || 'Unknown')}</td>
      <td class="grade-${escHtml(r.grade)}">${escHtml(r.grade)}</td>
      <td>${r.totalDps.toFixed(1)}</td>
      <td>${r.addedDps.toFixed(1)}</td>
      <td>${escHtml(r.weapons.mainhand)}</td>
      <td>${escHtml(r.weapons.offhand)}</td>
      <td>${r.atkRating || '—'}</td>
      <td>${r.hastePct ? r.hastePct.toFixed(0) + '%' : '—'}</td>
      <td>${escHtml(discs)}</td>
      <td>${escHtml(buffs)}</td>
      <td>${fmtDuration(r.engagedMs)}</td>
      <td>${fmtDuration(r.fightDuration)}</td>
      <td>${r.totalRounds}</td>
      <td>${(r.pctInGreen * 100).toFixed(0)}%</td>
      <td>${escHtml(r.characterName || '—')}</td>
      <td>${fmtDate(r.timestamp)}</td>
      <td><button class="upload-btn ${uploadClass}" data-upload="${escHtml(r.id)}">${uploadLabel}</button></td>
    </tr>`
  }).join('')
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Upload ────────────────────────────────────────────────────

async function uploadRecord(id: string): Promise<void> {
  const rec = allRecords.find(r => r.id === id)
  if (!rec) return
  const btn = tbody.querySelector(`[data-upload="${id}"]`) as HTMLButtonElement | null
  if (btn) { btn.textContent = '…'; btn.disabled = true }
  window.leaderboardAPI.uploadRecord(rec)
  // Optimistically mark as uploaded (main process logs result)
  uploadedIds.add(id)
  if (btn) { btn.textContent = '✓ Sent'; btn.classList.add('uploaded'); btn.disabled = false }
}

// ── DPS Chart ─────────────────────────────────────────────────

function showChart(rec: R): void {
  const samples = rec.dpsSamples
  if (!samples || samples.length === 0) return

  chartTitle.textContent = `${rec.mobName || 'Unknown'} — time-averaged DPS`
  chartPanel.style.display = 'block'
  drawChart(samples)
}

function drawChart(samples: number[]): void {
  const dpr    = window.devicePixelRatio || 1
  const width  = dpsCanvas.offsetWidth
  const height = dpsCanvas.height          // CSS px height from HTML attribute

  dpsCanvas.width  = width  * dpr
  dpsCanvas.height = height * dpr

  const ctx = dpsCanvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, height)

  // Layout constants
  const padL = 52, padR = 16, padT = 10, padB = 26
  const plotW = width  - padL - padR
  const plotH = height - padT - padB

  const rawMax   = Math.max(...samples, 1)
  const totalSec = samples.length

  // Round up to a nice axis ceiling
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMax)))
  const niceStep  = [1, 2, 2.5, 5, 10].map(f => f * magnitude).find(s => s * 4 >= rawMax) ?? magnitude * 10
  const axisMax   = Math.ceil(rawMax / niceStep) * niceStep
  const TICKS     = 4

  // Helpers: value → pixel
  const xOf = (sec: number) => padL + (sec / totalSec) * plotW
  const yOf = (dps: number) => padT + plotH - (dps / axisMax) * plotH

  // ── Background grid ───────────────────────────────────────────
  ctx.strokeStyle = '#1e2240'
  ctx.lineWidth   = 1

  // Horizontal grid lines
  for (let i = 0; i <= TICKS; i++) {
    const y     = padT + (i / TICKS) * plotH
    const value = axisMax * (1 - i / TICKS)
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke()
    ctx.fillStyle = '#5a6482'
    ctx.font = '10px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'right'
    ctx.fillText(value.toFixed(0), padL - 6, y + 3.5)
  }

  // Vertical grid lines every 15 seconds
  ctx.textAlign = 'center'
  for (let t = 0; t <= totalSec; t += 15) {
    const x = xOf(t)
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke()
    ctx.fillStyle = '#5a6482'
    ctx.fillText(`${t}s`, x, padT + plotH + 16)
  }
  // Always label the last second if it wasn't already covered
  if (totalSec % 15 !== 0) {
    ctx.fillStyle = '#5a6482'
    ctx.fillText(`${totalSec}s`, xOf(totalSec), padT + plotH + 16)
  }

  // ── Peak DPS marker ───────────────────────────────────────────
  const peakIdx = samples.reduce((best, v, i) => v > samples[best] ? i : best, 0)
  const peakSec = peakIdx + 1
  const peakDps = samples[peakIdx]
  const px = xOf(peakSec)
  const py = yOf(peakDps)
  ctx.save()
  ctx.setLineDash([4, 3])
  ctx.strokeStyle = '#ffd700'
  ctx.lineWidth   = 1
  ctx.globalAlpha = 0.5
  ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + plotH); ctx.stroke()
  ctx.restore()
  ctx.fillStyle  = '#ffd700'
  ctx.globalAlpha = 0.85
  ctx.textAlign  = 'left'
  ctx.font       = '9px "Segoe UI", system-ui, sans-serif'
  const peakLabel = `peak ${peakDps.toFixed(0)} @ ${peakSec}s`
  const labelX = px + 3 + (px + ctx.measureText(peakLabel).width + 6 > padL + plotW ? -(ctx.measureText(peakLabel).width + 8) : 0)
  ctx.fillText(peakLabel, labelX, py > padT + 14 ? py - 4 : padT + 10)
  ctx.globalAlpha = 1

  // ── DPS line ──────────────────────────────────────────────────
  ctx.beginPath()
  ctx.strokeStyle = '#40a8ff'
  ctx.lineWidth   = 1.5
  ctx.lineJoin    = 'round'

  for (let i = 0; i < samples.length; i++) {
    const x = xOf(i + 1)
    const y = yOf(samples[i])
    if (i === 0) ctx.moveTo(x, y)
    else         ctx.lineTo(x, y)
  }
  ctx.stroke()

  // Area fill under the line
  ctx.lineTo(xOf(samples.length), padT + plotH)
  ctx.lineTo(xOf(1), padT + plotH)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH)
  grad.addColorStop(0,   'rgba(64,168,255,0.25)')
  grad.addColorStop(1,   'rgba(64,168,255,0)')
  ctx.fillStyle = grad
  ctx.fill()

  // ── Axes ──────────────────────────────────────────────────────
  ctx.strokeStyle = '#2a2f50'
  ctx.lineWidth   = 1
  ctx.beginPath()
  ctx.moveTo(padL, padT)
  ctx.lineTo(padL, padT + plotH)
  ctx.lineTo(padL + plotW, padT + plotH)
  ctx.stroke()
}

// ── Event wiring ──────────────────────────────────────────────

tbody.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const uploadBtn = target.closest('[data-upload]') as HTMLElement | null
  if (uploadBtn) {
    uploadRecord(uploadBtn.dataset.upload!)
    return
  }
  // Click anywhere else on a row → show DPS chart
  const row = target.closest('tr[data-id]') as HTMLElement | null
  if (row) {
    const rec = allRecords.find(r => r.id === row.dataset.id)
    if (rec?.dpsSamples?.length) showChart(rec)
  }
})

btnUploadAll.addEventListener('click', async () => {
  const rows = filtered()
  for (const r of rows) {
    if (!uploadedIds.has(r.id)) await uploadRecord(r.id)
  }
})

btnSettings.addEventListener('click', () => window.leaderboardAPI.openSettings())
btnCloseChart.addEventListener('click', () => { chartPanel.style.display = 'none' })

;[filterMob, filterChar].forEach(el => el.addEventListener('input', render))

// ── Column sort ───────────────────────────────────────────────

document.querySelectorAll('thead th[data-col]').forEach(th => {
  th.addEventListener('click', () => {
    const col = (th as HTMLElement).dataset.col!
    if (sortCol === col) {
      sortAsc = !sortAsc
    } else {
      sortCol = col
      sortAsc = false
    }
    document.querySelectorAll('thead th').forEach(t => t.classList.remove('sorted'))
    th.classList.add('sorted')
    render()
  })
})

// ── IPC listeners ──────────────────────────────────────────────

window.leaderboardAPI.onData((records) => {
  allRecords = records as R[]
  render()
})

window.leaderboardAPI.onConfig((cfg) => {
  workerUrl = cfg.workerUrl
  if (workerUrl) {
    communityLink.innerHTML = `<a href="${escHtml(workerUrl)}" target="_blank">View Community Board ↗</a>`
  }
})

// ── Init ──────────────────────────────────────────────────────

window.leaderboardAPI.getAll().then(records => {
  allRecords = records as R[]
  render()
})

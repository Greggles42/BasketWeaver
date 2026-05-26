/**
 * Settings window renderer logic.
 */

declare global {
  interface Window {
    settingsAPI: {
      getSettings(): Promise<Record<string, unknown>>
      setSetting(key: string, value: unknown): void
      close(): void
    }
  }
}

// ── Constants (mirror tray.ts) ────────────────────────────────

const WEAPON_PRESETS: Record<string, number> = {
  "Bo Staff of Trorsmang":                35,
  "Abashi's Rod of Disillusionment":      30,
  "Caen's Bo Staff of Fury":              30,
  "Tranquil Staff":                       30,
  "Ton Po's Bo Stick of Understanding":   40,
  "Imbued Fighter's Staff":               40,
}

const INTERVALS      = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0]
const TARGET_OFFSETS = [0, 25, 50, 75, 100, 125, 150, 200, 250]     // ms
const LATENCY_VALUES = [0, 25, 50, 75, 100, 125, 150, 200]           // ms
const CLIP_WINDOWS   = [250, 500, 750, 1000, 1250, 1500, 2000]       // ms
const TARGET_POSITIONS = [10, 14, 18, 22, 26, 30, 35, 40]
const OFFHAND_DELAYS   = Array.from({ length: 13 }, (_, i) => 16 + i)

// ── Helpers ───────────────────────────────────────────────────

/**
 * Populate a <select> element with [label, value] pairs and select the
 * matching option (within tolerance for floating-point comparisons).
 */
function populateSelect(
  id: string,
  options: [string, number][],
  currentVal: number,
  tolerance = 0.001,
): void {
  const sel = document.getElementById(id) as HTMLSelectElement | null
  if (!sel) return
  sel.innerHTML = ''
  for (const [label, val] of options) {
    const opt = document.createElement('option')
    opt.value = String(val)
    opt.textContent = label
    if (Math.abs(val - currentVal) < tolerance) opt.selected = true
    sel.appendChild(opt)
  }
}

/**
 * Wire a range slider to display its value and fire onChange.
 * fmt: function that converts the raw number to a display string.
 */
function setupSlider(
  id: string,
  valId: string,
  initial: number,
  fmt: (v: number) => string,
  onChange: (v: number) => void,
): void {
  const slider = document.getElementById(id) as HTMLInputElement | null
  const valEl  = document.getElementById(valId) as HTMLElement | null
  if (!slider) return
  slider.value = String(Math.round(initial))
  if (valEl) valEl.textContent = fmt(initial)
  slider.addEventListener('input', () => {
    const v = Number(slider.value)
    if (valEl) valEl.textContent = fmt(v)
    onChange(v)
  })
}

/** Wire a checkbox to send key/value over settingsAPI. */
function setupToggle(id: string, key: string, currentVal: boolean): void {
  const cb = document.getElementById(id) as HTMLInputElement | null
  if (!cb) return
  cb.checked = currentVal
  cb.addEventListener('change', () => {
    window.settingsAPI.setSetting(key, cb.checked)
  })
}

// ── Init ──────────────────────────────────────────────────────

async function init(): Promise<void> {
  const s = await window.settingsAPI.getSettings()

  // Version
  const verEl = document.getElementById('appVersion')
  if (verEl) verEl.textContent = 'v' + s.APP_VERSION

  // ── Volume sliders ──────────────────────────────────────────
  setupSlider('volumeMaster', 'volumeMasterVal',
    (s.VOLUME_MASTER as number) * 100,
    v => v + '%',
    v => window.settingsAPI.setSetting('VOLUME_MASTER', v / 100),
  )

  setupSlider('volumeProc', 'volumeProcVal',
    (s.VOLUME_PROC as number) * 100,
    v => v + '%',
    v => window.settingsAPI.setSetting('VOLUME_PROC', v / 100),
  )

  setupSlider('volumeEpic', 'volumeEpicVal',
    (s.VOLUME_EPIC as number) * 100,
    v => v + '%',
    v => window.settingsAPI.setSetting('VOLUME_EPIC', v / 100),
  )

  // ── Threshold inputs ────────────────────────────────────────
  const critEl = document.getElementById('critThreshold') as HTMLInputElement | null
  if (critEl) {
    critEl.value = String(s.CRIT_DAMAGE_THRESHOLD)
    critEl.addEventListener('change', () => {
      const v = parseInt(critEl.value, 10)
      if (!isNaN(v) && v >= 0) window.settingsAPI.setSetting('CRIT_DAMAGE_THRESHOLD', v)
    })
  }

  const hugeEl = document.getElementById('hugeRoundThreshold') as HTMLInputElement | null
  if (hugeEl) {
    hugeEl.value = String(s.HUGE_ROUND_THRESHOLD)
    hugeEl.addEventListener('change', () => {
      const v = parseInt(hugeEl.value, 10)
      if (!isNaN(v) && v >= 0) window.settingsAPI.setSetting('HUGE_ROUND_THRESHOLD', v)
    })
  }

  // ── Tracking source radio ────────────────────────────────────
  const trackingGroup = document.getElementById('trackingSource')
  if (trackingGroup) {
    const radios = trackingGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    for (const r of radios) {
      if (r.value === s.TRACKING_SOURCE) r.checked = true
      r.addEventListener('change', () => {
        if (r.checked) window.settingsAPI.setSetting('TRACKING_SOURCE', r.value)
      })
    }
  }

  // ── Overlay style radio ──────────────────────────────────────
  const styleGroup = document.getElementById('overlayStyle')
  if (styleGroup) {
    const radios = styleGroup.querySelectorAll<HTMLInputElement>('input[type="radio"]')
    for (const r of radios) {
      if (r.value === s.OVERLAY_STYLE) r.checked = true
      r.addEventListener('change', () => {
        if (r.checked) window.settingsAPI.setSetting('OVERLAY_STYLE', r.value)
      })
    }
  }

  // ── Mainhand delay select + custom override ──────────────────
  // Sentinel 0 = "Custom" (no real EQ weapon has delay 0)
  const CUSTOM = 0
  const currentMainhand = s.BASE_WEAPON_DELAY as number
  const mainhandInPresets = Object.values(WEAPON_PRESETS).includes(currentMainhand)
  const mainhandOpts: [string, number][] = [
    ...Object.entries(WEAPON_PRESETS).map(
      ([name, delay]): [string, number] => [`${name}  (${(delay / 10).toFixed(1)}s)`, delay],
    ),
    ['── Custom ──', CUSTOM],
  ]
  populateSelect('mainhandDelay', mainhandOpts, mainhandInPresets ? currentMainhand : CUSTOM)

  const mainhandSel        = document.getElementById('mainhandDelay')    as HTMLSelectElement
  const mainhandCustomRow  = document.getElementById('mainhandCustomRow') as HTMLElement
  const mainhandCustom     = document.getElementById('mainhandCustom')    as HTMLInputElement
  const mainhandCustomSec  = document.getElementById('mainhandCustomSec') as HTMLElement

  const showMainhandSec = (v: number) => { mainhandCustomSec.textContent = `= ${(v / 10).toFixed(1)}s` }

  if (!mainhandInPresets) {
    mainhandCustomRow.style.display = ''
    mainhandCustom.value = String(currentMainhand)
    showMainhandSec(currentMainhand)
  }

  mainhandSel.addEventListener('change', () => {
    const v = Number(mainhandSel.value)
    if (v === CUSTOM) {
      mainhandCustomRow.style.display = ''
      mainhandCustom.focus()
    } else {
      mainhandCustomRow.style.display = 'none'
      window.settingsAPI.setSetting('BASE_WEAPON_DELAY', v)
    }
  })
  mainhandCustom.addEventListener('input', () => {
    const v = parseInt(mainhandCustom.value, 10)
    if (!isNaN(v) && v > 0) showMainhandSec(v)
  })
  mainhandCustom.addEventListener('change', () => {
    const v = parseInt(mainhandCustom.value, 10)
    if (!isNaN(v) && v > 0) {
      showMainhandSec(v)
      window.settingsAPI.setSetting('BASE_WEAPON_DELAY', v)
    }
  })

  // ── Offhand delay select + custom override ───────────────────
  const currentOffhand = s.OFFHAND_WEAPON_DELAY as number
  const offhandInList  = OFFHAND_DELAYS.includes(currentOffhand)
  const offhandOpts: [string, number][] = [
    ...OFFHAND_DELAYS.map((d): [string, number] => [`${(d / 10).toFixed(1)}s  (delay ${d})`, d]),
    ['── Custom ──', CUSTOM],
  ]
  populateSelect('offhandDelay', offhandOpts, offhandInList ? currentOffhand : CUSTOM)

  const offhandSel       = document.getElementById('offhandDelay')    as HTMLSelectElement
  const offhandCustomRow = document.getElementById('offhandCustomRow') as HTMLElement
  const offhandCustom    = document.getElementById('offhandCustom')    as HTMLInputElement
  const offhandCustomSec = document.getElementById('offhandCustomSec') as HTMLElement

  const showOffhandSec = (v: number) => { offhandCustomSec.textContent = `= ${(v / 10).toFixed(1)}s` }

  if (!offhandInList) {
    offhandCustomRow.style.display = ''
    offhandCustom.value = String(currentOffhand)
    showOffhandSec(currentOffhand)
  }

  offhandSel.addEventListener('change', () => {
    const v = Number(offhandSel.value)
    if (v === CUSTOM) {
      offhandCustomRow.style.display = ''
      offhandCustom.focus()
    } else {
      offhandCustomRow.style.display = 'none'
      window.settingsAPI.setSetting('OFFHAND_WEAPON_DELAY', v)
    }
  })
  offhandCustom.addEventListener('input', () => {
    const v = parseInt(offhandCustom.value, 10)
    if (!isNaN(v) && v > 0) showOffhandSec(v)
  })
  offhandCustom.addEventListener('change', () => {
    const v = parseInt(offhandCustom.value, 10)
    if (!isNaN(v) && v > 0) {
      showOffhandSec(v)
      window.settingsAPI.setSetting('OFFHAND_WEAPON_DELAY', v)
    }
  })

  // ── Punch interval select ────────────────────────────────────
  const intervalOpts: [string, number][] = INTERVALS.map(v => [`${v.toFixed(1)}s`, v])
  populateSelect('punchInterval', intervalOpts, s.PUNCH_INTERVAL as number)
  const intervalSel = document.getElementById('punchInterval') as HTMLSelectElement | null
  if (intervalSel) {
    intervalSel.addEventListener('change', () => {
      window.settingsAPI.setSetting('PUNCH_INTERVAL', Number(intervalSel.value))
    })
  }

  // ── Target offset select (stored in seconds, displayed in ms) ──
  const offsetOpts: [string, number][] = TARGET_OFFSETS.map(ms => [`${ms} ms`, ms / 1000])
  populateSelect('targetOffset', offsetOpts, s.TARGET_OFFSET as number)
  const offsetSel = document.getElementById('targetOffset') as HTMLSelectElement | null
  if (offsetSel) {
    offsetSel.addEventListener('change', () => {
      // value is in seconds (e.g. "0.025")
      window.settingsAPI.setSetting('TARGET_OFFSET', Number(offsetSel.value))
    })
  }

  // ── Latency comp select (stored in seconds, displayed in ms) ──
  const latencyOpts: [string, number][] = LATENCY_VALUES.map(ms => [`${ms} ms`, ms / 1000])
  populateSelect('latencyComp', latencyOpts, s.LATENCY_COMPENSATION as number)
  const latencySel = document.getElementById('latencyComp') as HTMLSelectElement | null
  if (latencySel) {
    latencySel.addEventListener('change', () => {
      window.settingsAPI.setSetting('LATENCY_COMPENSATION', Number(latencySel.value))
    })
  }

  // ── Clip window select ───────────────────────────────────────
  // -1 sentinel = Auto
  const clipCurrent = (s.CLIP_AUTO as boolean)
    ? -1
    : (s.CLIP_DETECTION_WINDOW as number) * 1000
  const clipOpts: [string, number][] = [
    ['Auto (offhand delay)', -1],
    ...CLIP_WINDOWS.map((ms): [string, number] => [`${ms} ms`, ms]),
  ]
  populateSelect('clipWindow', clipOpts, clipCurrent, 1)
  const clipSel = document.getElementById('clipWindow') as HTMLSelectElement | null
  if (clipSel) {
    clipSel.addEventListener('change', () => {
      const v = Number(clipSel.value)
      if (v === -1) {
        window.settingsAPI.setSetting('CLIP_AUTO', true)
      } else {
        window.settingsAPI.setSetting('CLIP_AUTO', false)
        window.settingsAPI.setSetting('CLIP_DETECTION_WINDOW', v / 1000)
      }
    })
  }

  // ── Target position select ───────────────────────────────────
  const tgtPosOpts: [string, number][] = TARGET_POSITIONS.map(p => [`${p}%`, p])
  populateSelect('targetPosition', tgtPosOpts, s.TARGET_POSITION_PCT as number)
  const tgtPosSel = document.getElementById('targetPosition') as HTMLSelectElement | null
  if (tgtPosSel) {
    tgtPosSel.addEventListener('change', () => {
      window.settingsAPI.setSetting('TARGET_POSITION_PCT', Number(tgtPosSel.value))
    })
  }

  // ── Opacity slider ───────────────────────────────────────────
  setupSlider('opacity', 'opacityVal',
    Math.round((s.WINDOW_OPACITY as number) * 100),
    v => v + '%',
    v => window.settingsAPI.setSetting('WINDOW_OPACITY', v / 100),
  )

  // ── Boolean toggles ──────────────────────────────────────────
  setupToggle('audioEnabled',       'AUDIO_ENABLED',       s.AUDIO_ENABLED      as boolean)
  setupToggle('buffSoundEnabled',   'BUFF_SOUND_ENABLED',  s.BUFF_SOUND_ENABLED as boolean)
  setupToggle('fistMissSound',      'FIST_SOUND_ON_MISS',  s.FIST_SOUND_ON_MISS as boolean)
  setupToggle('dynamicWeaving',     'DYNAMIC_WEAVING',     s.DYNAMIC_WEAVING    as boolean)
  setupToggle('offhandTimer',       'SHOW_OFFHAND_TIMER',  s.SHOW_OFFHAND_TIMER as boolean)
  setupToggle('keystrokeGrading',   'KEYSTROKE_GRADING',   s.KEYSTROKE_GRADING  as boolean)
  setupToggle('orientationVertical','ORIENTATION_VERTICAL', s.ORIENTATION === 'vertical')
  setupToggle('windowPinned',       'WINDOW_PINNED',       s.WINDOW_PINNED      as boolean)
  setupToggle('showAllCrits',          'SHOW_ALL_CRITS',             s.SHOW_ALL_CRITS             as boolean)
  setupToggle('positiveAudioInWindow', 'POSITIVE_AUDIO_IN_WINDOW',   s.POSITIVE_AUDIO_IN_WINDOW   as boolean)

  // ── Close button ─────────────────────────────────────────────
  document.getElementById('btnClose')?.addEventListener('click', () => {
    window.settingsAPI.close()
  })
}

init()

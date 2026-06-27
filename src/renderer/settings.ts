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

type AttackType = 'crush' | 'slash' | 'pierce' | 'punch'
const WEAPON_PRESETS: Record<string, { delay: number; attackType: AttackType }> = {
  "Skull Staff of Geoffrey":                 { delay: 20, attackType: 'crush' },
  "Runed Fighters Staff":                    { delay: 20, attackType: 'crush' },
  "Wu's Quivering Staff":                    { delay: 28, attackType: 'crush' },
  "Abashi's Rod of Disempowerment":          { delay: 30, attackType: 'crush' },
  "Caen's Bo Staff of Fury":                 { delay: 30, attackType: 'crush' },
  "Peacebringer":                            { delay: 30, attackType: 'crush' },
  "The Arm of Quellious":                    { delay: 30, attackType: 'crush' },
  "Tranquil Staff":                          { delay: 30, attackType: 'crush' },
  "Bo Staff of Trorsmang":                   { delay: 35, attackType: 'crush' },
  "Efreeti Ice Staff":                       { delay: 35, attackType: 'crush' },
  "Tae Ew Two Hand Hammer":                  { delay: 35, attackType: 'crush' },
  "Amygdalan War Staff":                     { delay: 36, attackType: 'crush' },
  "Exquisite Velium Brawl Stick":            { delay: 36, attackType: 'crush' },
  "Rod of Mourning":                         { delay: 36, attackType: 'crush' },
  "Tae Ew War Maul":                         { delay: 36, attackType: 'crush' },
  "Wrapped Velium Brawl Stick":              { delay: 36, attackType: 'crush' },
  "Carved Velium Brawl Stick":               { delay: 37, attackType: 'crush' },
  "Massive Velium Brawl Stick":              { delay: 37, attackType: 'crush' },
  "Staff of Battle":                         { delay: 37, attackType: 'crush' },
  "Etched Velium Brawl Stick":              { delay: 38, attackType: 'crush' },
  "Gaudralek, Sword of the Sky":             { delay: 38, attackType: 'slash' },
  "Meljeldin, Bane of Giants":               { delay: 38, attackType: 'slash' },
  "Runestone Maul":                          { delay: 38, attackType: 'crush' },
  "Heavy Velium Brawl Stick":                { delay: 39, attackType: 'crush' },
  "Petrified Heartwood Flamberge":           { delay: 39, attackType: 'slash' },
  "Aggression":                              { delay: 40, attackType: 'crush' },
  "Bloodied Berserker's Blade":              { delay: 40, attackType: 'slash' },
  "Bruiser's Beatstick":                     { delay: 40, attackType: 'crush' },
  "Feartouched Greatsword":                  { delay: 40, attackType: 'slash' },
  "Great Maul of Slaughter":                 { delay: 40, attackType: 'crush' },
  "Greatsword of the Disciple":              { delay: 40, attackType: 'slash' },
  "Imbued Fighters Staff":                   { delay: 40, attackType: 'crush' },
  "Scythe of Shadows":                       { delay: 40, attackType: 'slash' },
  "Ton Po's Bo Stick of Understanding":      { delay: 40, attackType: 'crush' },
  "Yttrium War Hammer":                      { delay: 40, attackType: 'crush' },
  "Rocksmasher":                             { delay: 41, attackType: 'crush' },
  "Facesmasher":                             { delay: 42, attackType: 'crush' },
  "Palladius' Axe of Slaughter":             { delay: 42, attackType: 'slash' },
  "The Sword of Ssraeshza":                  { delay: 42, attackType: 'slash' },
  "Frostreaver":                             { delay: 43, attackType: 'slash' },
  "Herbalists Spade":                        { delay: 43, attackType: 'crush' },
  "Scalecracker":                            { delay: 43, attackType: 'crush' },
  "Shovel of the Harvest":                   { delay: 43, attackType: 'crush' },
  "Ancient Prismatic Brawl Stick":           { delay: 44, attackType: 'crush' },
  "Petrified Rod":                           { delay: 44, attackType: 'crush' },
  "Priceless Velium Brawl Stick":            { delay: 44, attackType: 'crush' },
  "Premier Brawl Stick of Secundae":         { delay: 44, attackType: 'crush' },
  "Primal Velium Brawl Stick":              { delay: 44, attackType: 'crush' },
  "Emaciated Maul of the Overseer":          { delay: 45, attackType: 'crush' },
  "Norge`tal":                               { delay: 45, attackType: 'slash' },
  "Twisted Steel Bastard Sword":             { delay: 45, attackType: 'slash' },
  "Blackstone Maul":                         { delay: 53, attackType: 'crush' },
}

const OFFHAND_PRESETS: Record<string, number> = {
  "Epic Fists":                              16,
  "Dragonrib Club":                          17,
  "Baton of Flame":                          17,
  "Horns of Chaos":                          18,
  "Fist of Nature":                          18,
  "Sceptre of Destruction":                  18,
  "Wurmscale Fistwraps":                     18,
  "Essence Mace":                            18,
  "Bone Spiked Crusher":                     18,
  "Velium Maul of Superiority":              18,
  "Acrylia Handled Broadsword":              19,
  "Fangs of Vyzh`dra":                       19,
  "Fist of Acrylia":                         19,
  "Gharn's Rock of Smashing":                19,
  "Fist of Glowing Acrylia":                 19,
  "Howling Orb":                             19,
  "Sap Encrusted Branch":                    19,
  "Skybreaker":                              19,
  "Fist of Pummeling Prowess":               19,
  "Possessed Sacrificial Club":              19,
  "Blade of Carnage":                        20,
  "Glowing Mithril Ulak":                    20,
  "Priceless Velium Fist Wraps":             20,
  "Primal Velium Fist Wraps":                20,
  "Fist of Mithril":                         22,
  "Ancient Prismatic Fist Wraps":            20,
  "Premier Fist Wraps of Secundae":          20,
  "Etched Bone Ulak":                        20,
  "Primal Velium Battlehammer":              20,
  "Ancient Prismatic Staff":                 20,
  "Priceless Velium Battlehammer":           20,
  "Ancient Prismatic Mace":                  20,
  "Ancient Prismatic Battlehammer":          20,
  "Premier Battlehammer of Secundae":        20,
  "Premier Mace of Secundae":                20,
  "Hammer of the Ironfrost":                 20,
  "Grats Bloodfrenzy":                       20,
  "Bloodfrenzy":                             20,
  "Braid of Golden Hair":                    21,
  "Blackout":                                22,
  "Vius Handwraps":                          22,
  "Astral Handwraps":                        22,
  "White Fire Handwraps":                    22,
  "Wu's Fist of Mastery":                    22,
  "Neb's Warbone":                           23,
  "Vyzh`dra's Render of Souls":              24,
  "Ribcracker":                              25,
  "Ans Fiel`Tian":                           28,
  "Sarnak Lightning Caller":                 28,
  "Skullcrusher":                            28,
  "Skullcrusher of Kragg":                   28,
  "Longsword of Freedom":                    29,
  "Sabertooth":                              29,
  "Fist of Zek":                             30,
  "Jagged Long Sword":                       30,
  "Katana of Endurance":                     30,
  "Smolder":                                 30,
  "Katana of Enduring Stone":                31,
  "Katana of Flowing Water":                 33,
  "Green Jade Axe":                          34,
  "Scimitar of the Emerald Dawn":            34,
}

// Unique sorted swing intervals derived from weapon presets (delay / 10)
const INTERVALS: number[] = [
  ...new Set(Object.values(WEAPON_PRESETS).map(w => w.delay / 10)),
].sort((a, b) => a - b)
const TARGET_OFFSETS = [0, 25, 50, 75, 100, 125, 150, 200, 250]     // ms
const LATENCY_VALUES = [0, 25, 50, 75, 100, 125, 150, 200]           // ms
const CLIP_WINDOWS   = [250, 500, 750, 1000, 1250, 1500, 2000]       // ms
const TARGET_POSITIONS = [10, 14, 18, 22, 26, 30, 35, 40]

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

  // ── Weapon search helper ─────────────────────────────────────
  function setupWeaponSearch(
    searchId: string,
    dropdownId: string,
    currentId: string,
    customRowId: string,
    customInputId: string,
    customSecId: string,
    presets: Record<string, number | { delay: number; attackType: AttackType }>,
    currentDelay: number,
    delayKey: string,
    nameKey: string | null,
    savedName: string | null = null,
    onDelaySelected: ((delay: number, attackType?: AttackType) => void) | null = null,
  ): void {
    const searchEl     = document.getElementById(searchId)     as HTMLInputElement
    const dropdown     = document.getElementById(dropdownId)   as HTMLElement
    const currentEl    = document.getElementById(currentId)    as HTMLElement
    const customRow    = document.getElementById(customRowId)  as HTMLElement
    const customInput  = document.getElementById(customInputId) as HTMLInputElement
    const customSec    = document.getElementById(customSecId)  as HTMLElement

    // Prefer the saved name if it matches the current delay; fall back to first delay match.
    const getDelay = (v: number | { delay: number; attackType: AttackType }) =>
      typeof v === 'number' ? v : v.delay
    const currentName = (savedName && getDelay(presets[savedName]) === currentDelay)
      ? savedName
      : Object.entries(presets).find(([, v]) => getDelay(v) === currentDelay)?.[0] ?? null
    if (currentName) {
      currentEl.textContent = `${currentName}  (${(currentDelay / 10).toFixed(1)}s)`
    } else {
      currentEl.textContent = `${(currentDelay / 10).toFixed(1)}s (custom)`
      customRow.style.display = ''
      customInput.value = String(currentDelay)
      customSec.textContent = `= ${(currentDelay / 10).toFixed(1)}s`
    }

    const showDropdown = (query: string) => {
      const q = query.toLowerCase()
      const matches = Object.entries(presets).filter(([name]) => name.toLowerCase().includes(q))
      dropdown.innerHTML = ''
      if (matches.length === 0) { dropdown.classList.remove('open'); return }
      for (const [name, val] of matches) {
        const delay = getDelay(val)
        const attackType = typeof val === 'object' ? val.attackType : undefined
        const div = document.createElement('div')
        div.textContent = `${name}  (${(delay / 10).toFixed(1)}s)`
        div.addEventListener('mousedown', (e) => {
          e.preventDefault()
          searchEl.value = ''
          dropdown.classList.remove('open')
          currentEl.textContent = `${name}  (${(delay / 10).toFixed(1)}s)`
          customRow.style.display = 'none'
          window.settingsAPI.setSetting(delayKey, delay)
          if (nameKey) window.settingsAPI.setSetting(nameKey, name)
          if (onDelaySelected) onDelaySelected(delay, attackType)
        })
        dropdown.appendChild(div)
      }
      dropdown.classList.add('open')
    }

    searchEl.addEventListener('input', () => showDropdown(searchEl.value))
    searchEl.addEventListener('focus', () => { if (searchEl.value) showDropdown(searchEl.value) })
    searchEl.addEventListener('blur', () => { setTimeout(() => dropdown.classList.remove('open'), 150) })

    customInput.addEventListener('input', () => {
      const v = parseInt(customInput.value, 10)
      if (!isNaN(v) && v > 0) customSec.textContent = `= ${(v / 10).toFixed(1)}s`
    })
    customInput.addEventListener('change', () => {
      const v = parseInt(customInput.value, 10)
      if (!isNaN(v) && v > 0) {
        customSec.textContent = `= ${(v / 10).toFixed(1)}s`
        currentEl.textContent = `${(v / 10).toFixed(1)}s (custom)`
        window.settingsAPI.setSetting(delayKey, v)
        if (nameKey) window.settingsAPI.setSetting(nameKey, '')
      }
    })
  }

  // ── Mainhand swing interval select ──────────────────────────
  // Value 0 = "Auto": derive from weapon delay. Set up before mainhand search
  // so the weapon search callback can update the select.
  const intervalSel = document.getElementById('punchInterval') as HTMLSelectElement | null
  const currentWeaponDelay = { value: s.BASE_WEAPON_DELAY as number }

  function buildIntervalOpts(): [string, number][] {
    return [
      ['Auto (from weapon)', 0],
      ...INTERVALS.map(v => [`${v.toFixed(1)}s`, v] as [string, number]),
    ]
  }

  function populateIntervalSelect(matchInterval: number): void {
    if (!intervalSel) return
    const opts = buildIntervalOpts()
    const autoInterval = currentWeaponDelay.value / 10
    // Select "Auto" if the current interval matches the weapon's base interval
    const effectiveMatch = Math.abs(matchInterval - autoInterval) < 0.01 ? 0 : matchInterval
    populateSelect('punchInterval', opts, effectiveMatch)
  }

  function setIntervalFromWeapon(weaponDelay: number, attackType?: AttackType): void {
    currentWeaponDelay.value = weaponDelay
    const interval = weaponDelay / 10
    populateIntervalSelect(interval)
    window.settingsAPI.setSetting('PUNCH_INTERVAL', interval)
    if (attackType) {
      window.settingsAPI.setSetting('MAINHAND_ATTACK_TYPE', attackType)
      const sel = document.getElementById('mainhandAttackType') as HTMLSelectElement | null
      if (sel) sel.value = attackType
    }
  }

  populateIntervalSelect(s.PUNCH_INTERVAL as number)

  if (intervalSel) {
    intervalSel.addEventListener('change', () => {
      const v = Number(intervalSel.value)
      if (v === 0) {
        // Auto: derive from current weapon delay
        const interval = currentWeaponDelay.value / 10
        window.settingsAPI.setSetting('PUNCH_INTERVAL', interval)
      } else {
        window.settingsAPI.setSetting('PUNCH_INTERVAL', v)
      }
    })
  }

  setupWeaponSearch(
    'mainhandSearch', 'mainhandDropdown', 'mainhandCurrent',
    'mainhandCustomRow', 'mainhandCustom', 'mainhandCustomSec',
    WEAPON_PRESETS, s.BASE_WEAPON_DELAY as number,
    'BASE_WEAPON_DELAY', 'BASE_WEAPON_NAME',
    s.BASE_WEAPON_NAME as string | null ?? null,
    setIntervalFromWeapon,
  )

  setupWeaponSearch(
    'offhandSearch', 'offhandDropdown', 'offhandCurrent',
    'offhandCustomRow', 'offhandCustom', 'offhandCustomSec',
    OFFHAND_PRESETS, s.OFFHAND_WEAPON_DELAY as number,
    'OFFHAND_WEAPON_DELAY', 'OFFHAND_WEAPON_NAME',
  )

  // ── Mainhand attack type dropdown ────────────────────────────
  const attackTypeSel = document.getElementById('mainhandAttackType') as HTMLSelectElement | null
  if (attackTypeSel) {
    attackTypeSel.value = (s.MAINHAND_ATTACK_TYPE as string) ?? 'crush'
    attackTypeSel.addEventListener('change', () => {
      window.settingsAPI.setSetting('MAINHAND_ATTACK_TYPE', attackTypeSel.value)
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

  // ── Weave window override ────────────────────────────────────
  const weaveWindowEl = document.getElementById('weaveWindowMs') as HTMLInputElement | null
  if (weaveWindowEl) {
    weaveWindowEl.value = String(s.WEAVE_WINDOW_MS ?? 500)
    weaveWindowEl.addEventListener('change', () => {
      const v = parseInt(weaveWindowEl.value, 10)
      if (!isNaN(v) && v >= 0) window.settingsAPI.setSetting('WEAVE_WINDOW_MS', v)
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
  setupToggle('offhandCrush',       'OFFHAND_CRUSH_ENABLED', s.OFFHAND_CRUSH_ENABLED as boolean)

  const weaveBandolierOffDelayEl = document.getElementById('weaveBandolierOffDelay') as HTMLInputElement | null
  if (weaveBandolierOffDelayEl) {
    weaveBandolierOffDelayEl.value = String(s.WEAVE_BANDOLIER_OFF_DELAY_MS ?? 400)
    weaveBandolierOffDelayEl.addEventListener('change', () => {
      const v = parseInt(weaveBandolierOffDelayEl.value, 10)
      if (!isNaN(v) && v >= 0) window.settingsAPI.setSetting('WEAVE_BANDOLIER_OFF_DELAY_MS', v)
    })
  }

  const audioDebounceEl = document.getElementById('audioDebounceMs') as HTMLInputElement | null
  if (audioDebounceEl) {
    audioDebounceEl.value = String(s.AUDIO_DEBOUNCE_MS ?? 0)
    audioDebounceEl.addEventListener('change', () => {
      const v = parseInt(audioDebounceEl.value, 10)
      if (!isNaN(v) && v >= 0) window.settingsAPI.setSetting('AUDIO_DEBOUNCE_MS', v)
    })
  }
  setupToggle('windowPinned',       'WINDOW_PINNED',       s.WINDOW_PINNED      as boolean)
  setupToggle('showAllCrits',          'SHOW_ALL_CRITS',             s.SHOW_ALL_CRITS             as boolean)
  setupToggle('positiveAudioInWindow', 'POSITIVE_AUDIO_IN_WINDOW',   s.POSITIVE_AUDIO_IN_WINDOW   as boolean)
  setupToggle('autoDetectLog',         'AUTO_DETECT_LOG',            s.AUTO_DETECT_LOG            as boolean)

  // ── Leaderboard settings ─────────────────────────────────────
  const lbCharName = document.getElementById('lbCharName') as HTMLInputElement | null

  if (lbCharName) lbCharName.value = (s.LEADERBOARD_CHARACTER_NAME as string) ?? ''

  lbCharName?.addEventListener('change', () => {
    window.settingsAPI.setSetting('LEADERBOARD_CHARACTER_NAME', lbCharName.value)
  })

  // ── Close / Save & Close buttons ─────────────────────────────
  document.getElementById('btnClose')?.addEventListener('click', () => {
    window.settingsAPI.close()
  })
  document.getElementById('btnSave')?.addEventListener('click', () => {
    window.settingsAPI.close()
  })
}

init()

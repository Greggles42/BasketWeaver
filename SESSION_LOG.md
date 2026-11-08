# Session Log

Catch-up file for picking this project back up after `/clear` or a new session.
**Most recent entry at top.** Keep entries short — what changed, what state it's
in (released / uncommitted / proposed-but-not-built), and what's open. Full
detail lives in commit messages and the conversation itself, not here.

Check `git status` / `git log -5` against this file's "uncommitted" claims —
this file can go stale, git can't.

## Known issues (open)

- `tasklist scan failed` appears occasionally with no stderr/exit code logged,
  so the cause is undiagnosable. (`findEQProcessIds` error callback.)
- Unrelated tsc residuals (not part of the normal build): `audio-manager.ts`
  Float32Array lib-typing quirk; `mob-ac.ts` JSON vs composite-project file list.

---

## 2026-11-07 — Release v2.5.0

**Status: RELEASED (v2.5.0).** Bundled all the uncommitted 2026-11-01..06 work (disc timers,
debug monitor, settings tabs, capped logs, Zeal update check, memory detection removal,
weave2h fix). Also: banners word-wrap to canvas width (`wrapBannerText` in both overlays);
"Log not updating" threshold 60s -> 15s, reset by a throttled (5s) `EvType.LOG_ACTIVITY`
heartbeat from `log-reader.ts` on any non-empty log line. Notes in the GitHub release.

---

## 2026-11-06 (latest+3) — Bandolier set "weave2h" misread as the weave set

**Status: UNCOMMITTED.** Not a parsing bug: weave-set detection was `name.includes("weave")`,
so "weave2h" (the 2H set) counted as a weave set too, and both swaps looked like weave
swaps. New `isWeaveSetName()` in `log-reader.ts` (used by log-reader + zeal-reader) rejects
names that also contain 2h / 2-hand / two hand. "weave1h" and "gWeave" still match. Build clean.

---

## 2026-11-06 (latest+2) — Settings window split into tabs

**Status: UNCOMMITTED.** `settings.html`/`settings.ts`: tabs Tracking (default; Quick Actions,
Tracking Source, Weave Detection, Weapon & Timing, Leaderboard, Ignored Characters, Rogue
Mode) > Display > Audio (volumes, triggers, Wu) > Debuffs. Ignored Characters is a
collapsed-by-default `<details>`. Build clean; not viewed live.

---

## 2026-11-06 (latest+1) — Direct memory weapon detection removed entirely

**Status: UNCOMMITTED.** Removed as too invasive (ReadProcessMemory on eqgame.exe could
alarm users). Deleted `src/main/eq-memory.ts`, the `koffi` dependency, the
`MEMORY_WEAPON_DETECTION_ENABLED` setting + Settings checkbox, the memory poll/apply
code in `zeal-reader.ts`, and the `memory-detection-disabled` IPC. Weapon detection is
now /mystats and BW2H/BWOH macros only. `zealVersion` is still parsed from
"/zeal version" (feeds the Zeal update check); `zealVersionUnverified` is gone. Dead
`announce` flag handling remains in the overlays (harmless, defaults true). The
ERROR_ACCESS_DENIED known issue is moot. Build clean.

---

## 2026-11-06 — Log files capped at 50MB with a rolling buffer

**Status: UNCOMMITTED.** New `src/main/capped-log.ts` (`appendCappedLog`) now backs all
three file logs in `%APPDATA%\Basketweaver`: `zeal-reader.log`,
`leaderboard-upload.log`, `updater.log` (previously 512KB wipe-to-empty, 512KB
wipe-to-empty, and unbounded respectively). When an append would exceed 50MB it
drops the oldest lines down to 40MB (cut lands on a line boundary; temp-file +
rename swap, falls back to in-place rewrite if the file is locked), so the newest
data is always kept and trimming happens once per ~10MB, not every write. Size is
cached per path, so normal appends don't stat. Verified with a scaled-down
(1000/800 byte) test: size never exceeded the cap, file started on a full line,
newest lines kept, no leftover .tmp. The in-memory debug-monitor buffer (10k
entries) and the exported debug JSON are separate and unchanged.

---

## 2026-11-06 (later) — zeal-reader.log review: pipe retry backoff + wand false-positive

**Status: UNCOMMITTED.** From the user's real log (Nov 3–6): (1) one EQ client with
no Zeal pipe (PID 28492) was retried every 2s for 35 min = ~3,100 log lines, never
connected. `zeal-reader.ts` now backs off per PID (2s, 4s … cap 30s via
`pipeRetryAfter`) and logs only the first 3 attempts plus every 10th
(`shouldLogPipeRetry`); state is cleared on connect or when the PID exits.
(2) Memory detection disabled itself after the user equipped a *Wand of
Imperceptibility* in primary. `pollMemoryWeapons` now maps any cleanly-read
non-weapon item (wand, shield, held clicky) to an empty slot; only unreadable
garbage (`!plausible`) still trips the safeguard, and the dead non-weapon branch in
`applyMemWeapon` was removed. Side effect: a shield in the offhand no longer
disables detection either. Build clean; untested live.

---

## 2026-11-06 — Discipline cooldown is now ONE shared timer

**Status: UNCOMMITTED. Supersedes the per-discipline model in the two entries below.**
User confirmed the server uses a single shared reuse timer for all disciplines.
Replaced the per-discipline `discReadyAt` map (and `applyDiscReadout` nearest-match
heuristic, now deleted) in both overlays with `discReadyAt: number` +
`lastDiscName`. Any activation sets it to now + `computeDiscReuseSeconds(thatDisc)`;
`/disc` (`DISC_TIMER`) overwrites it exactly (0 = ready, clears the name). The three
per-disc chips now only show during their ~12s active window; afterwards a single
cooldown chip shows a generic `DISC M:SS` (deliberately not the last-used disc's
name, to save header space; `lastDiscName` removed). `DISCIPLINE_COLORS` added to
`shared/discipline-timers.ts`. Build clean; untested against live EQ.

---

## 2026-11-05 (latest+1) — `/disc` readout syncs the discipline cooldown timers

**Status: UNCOMMITTED, extends the entry below.** New `EvType.DISC_TIMER`
(`{ remainingSec }`, 0 = ready) emitted by `log-reader.ts` (both parse paths via
`tryEmitDiscReadout`) and `zeal-reader.ts` from the server strings in
`eqmacemu-src/utils/UI/eqstr_en.txt` ("You can use a new discipline in %1
minutes %2 seconds." / "You are ready to use a new discipline now."), patterns in
`config.ts` (`DISC_TIMER_PATTERNS`/`DISC_READY_PATTERNS`).
**Key limitation:** the message never names a discipline — the server
(`client_packet.cpp` Handle_OP_Discipline) reports one shared timer (default rule
`UseDiscTimerGroups=false`: one timer for all discs; if true: soonest of 3 groups).
So `applyDiscReadout()` (`shared/discipline-timers.ts`) snaps the already-tracked
disc whose estimate is nearest to the reported time; with none tracked (e.g.
Basketweaver opened after the disc was used) it sets `genericDiscReadyAt`, shown
as a `DISC M:SS` chip, cleared when a tracked disc is next activated. "Ready"
clears everything. Build clean; untested against live EQ.
Also noted: under default server rules the shared timer means using one disc
blocks all others until it expires — our per-disc `discReadyAt` doesn't model that.

---

## 2026-11-05 (latest) — Discipline reuse-cooldown tracker + Stonestance

**Status: UNCOMMITTED, builds on the earlier 2026-11-05 entries.**

Added a reuse/recast cooldown tracker for Monk disciplines and added Stonestance
to the existing active-buff tracking (previously only Innerflame/Whirlwind):

- **`src/shared/discipline-timers.ts`** (new) — `DISCIPLINE_REUSE_DATA` (Monk
  base reuse seconds + min-use level for stonestance/whirlwind/innerflame) and
  `computeDiscReuseSeconds()`, implementing the real server-side level-scaling
  formula from `C:\Projects\eqmacemu-src\zone\effects.cpp`
  (`Client::CastDiscipline`): reuse shrinks 54s per level above the discipline's
  minimum-use level, clamped to [234s, 4320s]. Confirmed the SQL `recast_time`
  column (`utils/sql/git/required/2015_08_26_disc_spells.sql`) is NOT what's
  actually enforced — the hardcoded C++ switch value is. Also pulled exact
  client gained/fade text for Stonestance from that same SQL file's
  cast_on_you/spell_fades columns ("Your body becomes one with the earth." /
  "You are no longer one with the earth.") — verified Whirlwind/Innerflame's
  already-configured text matches the same source exactly.
- **`src/shared/config.ts`**: added `STONESTANCE_GAINED/LOST_PATTERNS` (same
  shape as the existing Innerflame/Whirlwind pairs) and `CHARACTER_LEVEL: 60` —
  the first level/class tracking anywhere in this app, needed only to compute
  the real per-level reuse timer.
- **Detection** (`log-reader.ts`, `zeal-reader.ts`): mirrored the existing
  Innerflame/Whirlwind wiring exactly for Stonestance (regex compile + emit
  `BUFF_CHANGED` at the same branch locations each file already had duplicated).
- **Settings plumbing**: `CHARACTER_LEVEL` round-trips through `SETTINGS_GET`/
  `SETTINGS_SET`, persists via `loadSettings`/`saveSettings`, and live-pushes to
  an already-open overlay window via new `SET_CHARACTER_LEVEL` IPC (mirrors the
  existing `SET_BASE_WEAPON_DELAY`/`SET_PUNCH_INTERVAL` pattern) — new "Character
  Level" number input in Settings (1-65), wired like the existing `weaveWindowMs`
  field.
- **Renderer** (`overlay-refined.ts` + `overlay-highcontrast.ts`, each file's
  own hand-rolled copy, consistent with how every other buff is already done
  here — no shared buff-list component exists):
  - Stonestance gets the same treatment Whirlwind already had (not Innerflame's
    — Innerflame alone has extra leaderboard fight-fraction tracking that
    Whirlwind doesn't, so Whirlwind was the right-sized precedent): a
    `stonestanceUntil` field, a `BUFF_CHANGED` branch, a `drawStonestanceBar()`
    (stone-gray `rgba(150,150,160,`), a header chip, and a `disciplinesUsed` Set
    entry.
  - New `discReadyAt: Record<DisciplineKey, number>` map, set on every
    discipline's activation via `computeDiscReuseSeconds(key, cfg.CHARACTER_LEVEL)`.
    Deliberately **not** cleared in `clearDisciplineBuffs()` (death) — reuse
    timers survive death/zone in real EQ.
  - Rather than a new UI region, extended the *existing* header chip
    (`drawDisciplineChip()`, new shared-per-file helper) so each of the three
    disciplines' chip stays visible after its ~12s active window ends, switching
    to a dimmed `"NAME M:SS"` countdown via `formatCooldown()` until ready, then
    disappearing.
- `npm run build` passes clean; `tsc --noEmit` on both configs shows no new
  errors beyond the two pre-existing unrelated residuals noted in the earlier
  2026-11-05 entry (Float32Array lib quirk, mob-ac.ts JSON composite-project
  nuance).

**Open:** not tested against a live EQ session (can't run EQ/Zeal from this
environment) — ask the user to verify in-app: set Character Level in Settings,
trigger each discipline (or feed matching lines through a test log), confirm
the chip shows active→cooldown-countdown→gone, and that changing Character
Level changes the countdown length on the next activation.

---

## 2026-11-05 (even later) — Removed dead vertical-overlay-mode code

**Status: UNCOMMITTED, builds on the two debug-monitor entries earlier the same day.**

Per the user confirming the vertical overlay orientation was removed/never
shipped (flagged during the tsc triage above as ~20 permanently-dead
`cfg.ORIENTATION === 'vertical'` call sites), stripped it out entirely:

- `src/shared/config.ts`: removed `ORIENTATION` and `VERT_WINDOW_WIDTH`/
  `VERT_WINDOW_HEIGHT` fields (nothing ever set `ORIENTATION` to `'vertical'` —
  no Settings toggle, no tray action, nothing).
- `overlay-refined.ts` / `overlay-highcontrast.ts`: unwrapped every
  `if (cfg.ORIENTATION === 'horizontal') {...} else {...vertical...}` and
  `const vert = ...` branch down to just the horizontal-path body, across
  `windowSize()`, `computeLayout()`, `hzCenter()`, `projectAt()`,
  `rogueProjectAt()`, `drawDynamicWeaveWindows()`, `drawWeaveWindows()`,
  `drawHitZone()`, `drawMissChip()`/`drawMissFlash()`, `drawClipWarn()`,
  `drawDwRollFail()`, `drawWeaveExplosion()`, `spawnBackstabExplosion()`,
  `drawRogueTrack()`. Dropped now-unused destructured values (`hzy`, `sy`,
  `ey`, etc.) along the way.
- Confirmed via `tsc -p tsconfig.web.json --noEmit`: all 11
  `TS2367 "horizontal"/"vertical" have no overlap` errors are gone, no new
  errors introduced. `npm run build` passes clean (renderer bundle ~14KB
  smaller from the dead-code removal).

---

## 2026-11-05 (later) — tsc triage + bandolier set/weave-attempt logging

**Status: UNCOMMITTED, builds on the debug-monitor work earlier the same day.**

Ran `tsc --noEmit` against both `tsconfig.node.json` and `tsconfig.web.json`
(not part of the normal build — electron-vite/esbuild doesn't typecheck) and
triaged every finding:

- **Fixed (safe, mechanical):** duplicate `os` import in `index.ts`; missing
  `resolveJsonModule`/`DOM.Iterable` lib entries (tsconfig gaps vs. each
  other); `settings.ts` had zero top-level import/export so it wasn't a real
  module — `declare global` was silently failing, which is why `window.settingsAPI`
  threw ~40 cascading "does not exist" errors throughout that file. One `export {}`
  fixed all of them. Also added 4 properties to `main.ts`'s `Window.electronAPI`
  type that `preload.ts` already exposed and overlay code already called
  (`onToggleTripleAttackDetection`, `onToggleWeaveExplode`, `onSetBaseWeaponDelay`,
  `sendLeaderboardRecord`) but were missing from the type, causing real
  "property doesn't exist" + implicit-`any` errors. Fixed 3x `tip` possibly-null
  in `settings.ts`'s tooltip closure (narrowing doesn't cross nested function
  boundaries) with an explicit non-null binding.
- **Flagged, not fixed (need a decision, not a type-level patch):**
  - `Config.ORIENTATION` is typed as the literal `'horizontal'` (`config.ts:163`),
    but `overlay-refined.ts`/`overlay-highcontrast.ts` contain ~20 call sites of
    dead vertical-layout code (`cfg.ORIENTATION === 'vertical'`) that can never
    be true — there is no setting/toggle anywhere that ever assigns `'vertical'`.
    Either this is vestigial dead code from an unfinished vertical-overlay
    feature, or a real feature that's missing its Settings toggle. Left as-is.
  - `audio-manager.ts:61` `copyToChannel(samples, 0)` — a TS-lib version quirk
    (`Float32Array` became generic over `ArrayBufferLike` vs `ArrayBuffer` in
    recent `@types`), not a real bug. Left as-is; a cast would silence it if desired.

Also added **bandolier set / weave-attempt debug logging** per request: both
`LogReader.emit()` and `ZealReader.emit()` now intercept `BANDOLIER_CHANGED` (logs
every set name seen + its `isWeaveSet`/`isBackstabSet` flags — surfaces naming
mismatches, e.g. a set that doesn't contain "weave" in its name) and `FIST_ATTACK`
(logs which bandolier set was active at the moment of each weave attempt) into
the debug-monitor ring buffer, via a new `currentBandolierSetName` field on each
reader class. Shows up in the exported debug report under categories `bandolier`
and `bandolier-weave`.

`npm run build` passes clean after all of the above.

---

## 2026-11-05 — Always-on debug ring buffer + exportable debug report

**Status: UNCOMMITTED (working tree only). Last released version: v2.4.22.**

Built a general debug-monitoring feature so a user having trouble (e.g. "my weave
timing is correct but I'm graded F") can export a single file explaining why,
instead of needing a `__DEV__` build and pasted console output:

- **`src/main/debug-monitor.ts`** (new) — bounded ring buffer (cap 10k entries),
  singleton `debugMonitor`, always-on in the main process. Two entry kinds:
  `classify` (why a log line was classified MAINHAND_CRUSH vs FIST_ATTACK vs
  riposte, etc.) and `anomaly` (failed detections, bad config combos, version
  mismatches, I/O errors).
- **Classification tracing** — every existing `__DEV__`-gated `[mainhand]`/
  `[riposte]` debug site in `log-reader.ts` and `zeal-reader.ts` now also writes
  an always-on `debugMonitor.logClassify(...)` entry alongside the untouched
  `console.debug`. This directly answers disputes like the Wu-proc/punch-verb
  classification question investigated earlier this session.
- **Anomaly logging** — wired at existing `console.warn`/`console.error`/
  `WARNING_BANNER` sites that previously went nowhere in a packaged build:
  `zeal-reader.ts` (pipe failures, memory-detection-disabled, unverified Zeal
  offset profile — via a single hook in `log()`), `eq-memory.ts` (koffi load
  failure), `index.ts` (CharWeapons save, updater errors, weave-key monitor
  unavailable, Zeal-outdated), `leaderboard-manager.ts` (upload-log/save
  failures), `log-reader.ts` (log file open/read errors).
- **Renderer-detected anomalies** forwarded over a new fire-and-forget IPC
  channel (`DEBUG_LOG_EVENT`, `window.debugAPI.logEvent`, exposed from
  `preload.ts`): "Swing Timer Mode" entry (no mainhand weapon detected — the
  likely cause of several "graded F despite good timing" reports) in both
  overlay variants, and the 4 audio-manager.ts failure sites (throttled to 1
  report/5s per instance).
- **Export**: new `DEBUG_EXPORT` IPC handler in `index.ts` (`buildDebugReport()`
  + `dialog.showSaveDialog`, first use of showSaveDialog in this codebase) writes
  a JSON file (app/OS/Zeal version, a config snapshot, all buffered entries) to
  a user-chosen path. Redacts the real Windows username out of the serialized
  JSON before writing (`redact()`) since this file is meant to be attached to
  Discord/GitHub reports. Settings UI: new "Export Debug Report" button next to
  the existing Diagnostic Log row (`settings.html`/`settings.ts`), same
  inline-text-swap pattern as `btnOpenZealLog`.
- No behavior changes to scoring/detection — purely additive instrumentation.
  `npm run build` passes clean; a standalone `tsc -p tsconfig.web.json --noEmit`
  surfaces a large pile of **pre-existing** unrelated errors across the renderer
  (this project isn't typechecked that way day-to-day — esbuild/vite transpiles
  it) — none reference `debugAPI`/`debugMonitor`/`DebugEntry`.

**Open:** not yet tested against a live EQ session (no way to run EQ/Zeal from
this environment) — verify in-app that the export button produces a sane file
and that classify/anomaly entries actually populate during real combat.

---

## 2026-11-01 (later) — Confirmed direct-memory read remains the only viable path for auto weapon detection

**Status: no code changes this session — reconfirms prior decision, nothing to commit.**

Thread: user wanted to revisit whether Zeal exposes more than previously thought for
automatic weapon-swap detection (no `/mystats`). Re-verified against actual Zeal C++
source (not just memory of last session):
- Confirmed again, by reading the exact code that builds every pipe message
  (`named_pipe.cpp`'s `LabelNames`/`GaugeNames` maps + the `player`/`raid`/`group`
  blocks), that **zero equipment/weapon data crosses the named pipe** today.
- Found that Zeal's `get_attack_timer_gauge()` (`labels.cpp:168-220`) — which drives
  EQType 34, the native "attack recovery timer" gauge — reads `CharInfo->InventoryItem[12]`
  (Primary) and applies haste via `ModifyAttackSpeed()`. This is the exact same struct/
  offsets `eq-memory.ts` already reads externally via `ReadProcessMemory` — confirms our
  existing approach targets the right data, it's just not reachable any other way.
- Checked the user's `NillipussUI_1440p` EQUI skin (`C:\Projects\TAKPv22\uifiles\NillipussUI_1440p`):
  its target-window swing-timer bar (`EQUI_TargetWindow.xml`, `<EQType>34</EQType>`,
  `<Fill>AttackDelay</Fill>`) is just UI XML binding to that same native gauge — confirms
  EQUI XML is a pure display/skin layer with no ability to add new data to the named pipe.
  Only C++ changes to `named_pipe.cpp` could do that.
- Drafted (then reverted, at user's request) a ~15-line patch to `named_pipe.cpp` that would
  have added `primary_weapon`/`secondary_weapon` fields to the existing per-tick `player`
  pipe message. **User does not want Zeal source files edited** — this path is closed for
  now. If revisited later, the patch is simple and was verified against the real struct
  layout (`GAMEITEMINFO`/`GAMEITEMCOMMONINFO` in `game_structures.h`), just never compiled.

**Decision: sticking with the direct-memory-read feature already built last session**
(`src/main/eq-memory.ts`, wired into `zeal-reader.ts`) as the long-term approach. No
other avenue (pipe, gauges, UI XML mods) can supply this data without either patching
Zeal or asking its maintainers to add it upstream — neither is happening right now.

**Open:** same as last session — the memory-read feature is still untested against a
live EQ process, and `OFFSET_PROFILES` only has one verified entry (`1.4.8`).

---

## 2026-11-01 — Zeal pipe limits, direct-memory weapon detection, update checker

**Status: all UNCOMMITTED (working tree only). Last released version: v2.4.22.**

Thread: user wanted instant/automatic offhand-weapon-swap detection. Worked
through what Zeal's pipe actually exposes (dug into the user's local Zeal C++
source at `C:\Projects\Zeal`), concluded the pipe has no equipment data at all —
only `/mystats` text, chat, gauges/labels (HP/mana/stats/buffs), position, raid/group
roster. Landed on three incremental features instead of one silver bullet:

1. **`/mystats` offhand auto-detect** (`log-reader.ts`, `zeal-reader.ts`) — the
   "Melee Secondary:" line was already arriving but discarded by a guard regex
   that never actually matched real output. Now parsed and applied the same way
   mainhand already was. New `EvType.OFFHAND_WEAPON_DETECTED`.
2. **Zeal `/pipe` (PipeCmd, outer.type=4) channel wired up** in `zeal-reader.ts` —
   was being silently dropped entirely before. Lets a `/pipe BW2H ...`/`/pipe BWOH ...`
   macro update weapon tracking without printing to chat.
3. **Direct memory read of equipped weapons** (`src/main/eq-memory.ts`, new) — opt-in
   toggle, Hybrid mode only (`Config.MEMORY_WEAPON_DETECTION_ENABLED`). Uses `koffi`
   (new dependency) to call `ReadProcessMemory` on eqgame.exe directly: reads
   `CharInfo->InventoryItem[12/13]` (Primary/Secondary) for name/delay/damage/type/skill,
   polled every 1s in `zeal-reader.ts`. Offsets are hardcoded addresses transcribed from
   the Zeal source (see file header) — **tied to one exact client build, not
   auto-updating**. Safeguard: mirrors Zeal's own `is_weapon()` check; disables itself
   + shows a warning banner if a slot reads back as a non-weapon OR implausible garbage
   (new `plausible` flag — printable-name/VA-range/type-enum sanity checks).
4. **Zeal version awareness** — parses `/zeal version` chat output (user has to run it
   manually once; nothing auto-announces it), feeds an `OFFSET_PROFILES` table in
   `eq-memory.ts` keyed by version string (currently only has `'1.4.8'`, the version
   that was verified against source). Unknown version → falls back to that profile +
   flags itself unverified in Settings/diagnostics. **No code can derive new offsets for
   future Zeal versions — that always requires someone reading that version's source.**
5. **Zeal GitHub release checker** (`src/main/zeal-update-check.ts`, new) — polls
   `github.com/CoastalRedwood/Zeal` releases/latest, compares to the version detected
   in (4), shows a one-time info banner + Settings row if outdated. Checks every 6h,
   cheap re-compare every 30s.

New `EvType.WARNING_BANNER` (generic banner, `code`/`level` fields for main-process
reaction + info-vs-warning coloring) — used by safeguards above and the update checker.

**Open / not done:**
- Bandolier-set-name → weapon mapping (let `BANDOLIER_CHANGED`'s `setName` drive an
  instant weapon-delay lookup with zero macro overhead) was proposed and discussed in
  depth but the user pivoted to direct-memory-read instead — never built.
- None of this session's work has been tested against a live EQ process — can't run
  EQ/Zeal from this environment. Memory offsets in particular need real verification.
- Nothing above has been committed or released yet.

---

## 2026-10-30 — Offhand weapon Settings bugs (v2.4.21 + v2.4.22 hotfix)

**Status: RELEASED (v2.4.21, v2.4.22).**

- **v2.4.21**: Settings' `SETTINGS_GET` never returned `OFFHAND_WEAPON_NAME`, so
  reopening Settings fell back to a delay-only preset match — displayed whichever
  weapon happened to share that delay first in iteration order ("Acrylia Handled
  Broadsword" for most users). Fixed in `main/index.ts`. Bundled with a pre-existing
  uncommitted Click-Through Overlay feature and a Savagery/Ferocity label caps tweak.
- **v2.4.22 hotfix**: `settings.ts` has its own hardcoded copy of `OFFHAND_PRESETS`
  (doesn't import from `shared/config.ts`) — was missing 18 weapons the real list had,
  including "Sword of Primordial Power". Resynced both lists; verified they now match
  exactly (119 entries). Confirmed version bumps are required for `electron-updater`
  to offer the update on relaunch — can't skip that even for a "no new features" fix.
- Separately explained (no code change): a warrior with 2HS main + 1HS offhand gets
  track-shift during weaves because both weapons share an attack-type verb (e.g. slash),
  and the default config can't tell mainhand/offhand swings apart by text alone. Fix is
  the existing **"Offhand Same Attack Type (timing)"** Settings checkbox
  (`OFFHAND_CRUSH_ENABLED`), which most users with this exact setup don't know to enable.

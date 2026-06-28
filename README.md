# Basketweaver

**Real-time weapon-weaving overlay for EverQuest**

Basketweaver is a Windows desktop application that draws a scrolling timing highway on top of EverQuest, showing exactly when to swap to your offhand weapon set so your fist round lands without clipping your mainhand swing timer. It reads combat events directly from your EQ log file or from the Zeal named pipe in real time, measures your actual swing intervals, and grades your performance after every fight.

---

## What Is Weapon Weaving?

Weapon weaving is a technique available to classes with dual wield that lets you slip an offhand swing in between mainhand swings, gaining a "free" bonus round of damage. Your mainhand swing timer does not reset when you swap weapon sets — only when the mainhand weapon actually fires — so if you swap to your offhand set at the right moment, wait for it to swing, and swap back before the mainhand fires, you get both swings without losing any mainhand DPS.

Done correctly this adds approximately **20–30 DPS** against a raid target. Done wrong — swapping too late so the fist round clips the mainhand timer — it costs more DPS than not weaving at all. Basketweaver makes the timing visible and measurable.

---

## Features

### Core Timing Engine

- **Real-time swing interval tracking** — timestamps every mainhand event at arrival, not at log flush, for sub-frame accuracy
- **Rolling-median auto-calibration** — maintains a 6-sample rolling median of measured swing intervals; silently adjusts when measured drift exceeds 50 ms and shows an *Auto-calibrated* banner
- **Haste-aware interval calculation** — interval = `base_delay / (1 + haste%)`, automatically updated on every `/mystats` parse or haste event
- **Multi-attack-type support** — tracks crush, slash, and pierce mainhand weapons; verb-matching patterns update live when a weapon preset is detected mid-session
- **Riposte isolation** — ripostes are counted toward DPS only and never affect the swing timer, regardless of weapon type
- **Out-of-range detection** — pauses swing timer prediction when EQ blocks attacks due to range; plays a two-tone alert and shows an OOR banner
- **Cursor-blocked detection** — detects weapon swap failures caused by items on the cursor and shows a **CURSOR!** banner

### Highway Overlay

- **Scrolling weave window** — green boxes travel right-to-left toward the hit zone at the exact speed of your haste-adjusted interval
- **Hit zone** — gold vertical bar marking the timing target; position is adjustable left/right (cosmetic only)
- **Orange mainhand marker** — thin line marking the predicted moment of the next mainhand swing; displayed at the left edge of the weave window
- **Dynamic Weaving zones** — weave window is color-coded into three segments:
  - **Blue** — offhand still on cooldown, too early to weave
  - **Green** — offhand ready and time remains before mainhand, swap now
  - **Red** — cutting it close, offhand can still fire but risk of clip is elevated
- **Offhand swing timer bar** — thin bar beneath the highway showing remaining cooldown on the offhand weapon; transitions blue → cyan → bright cyan as it approaches ready
- **Clip detection** — red highway wash, strobing hit zone, and **CLIPPED** banner when a fist event lands outside the weave window
- **Miss indicator** — a small *"— missed"* chip near the hit zone fades out when a window passes without a fist attack
- **Combat banners** — floating text messages for calibration events, buffs gained/lost, and status notifications

### No-Log / Stale-Log Notice

When the overlay has no active log, or the selected log file has not received events for more than 60 seconds, a pulsing message appears on the highway:

| Situation | Message |
|---|---|
| No log selected | *No log file selected — Right-click tray → Select Log* |
| Log inactive 60+ s | *Log not updating — Is EQ running?* |

The notice disappears automatically as soon as new combat events arrive.

### Two Overlay Styles

| Style | Description |
|---|---|
| **Refined** (default) | Dark arcade aesthetic — deep navy background, gold hit zone, green weave windows, subtle dot-grid runway |
| **High Contrast** | Black background with vivid yellow/cyan colors — designed for streaming or low-vision use |

### Event Sources

#### Log File Mode (default)
Basketweaver tails your EQ log file at 16 ms poll intervals. All combat verbs, misses, buffs, haste lines, and death events are parsed from the log.

#### Hybrid Mode (Zeal + Log)
Combines the EQ log file with the **Zeal** named pipe for near-zero-latency event delivery:
- Zeal sends combat text over `\\.\pipe\zeal_<PID>` before EQ flushes to disk
- Basketweaver connects to all running `eqgame.exe` processes simultaneously
- Events from both sources are deduplicated so no combat line is processed twice
- Log file continues as fallback if Zeal disconnects mid-session

#### Auto-Detect Active Log
When enabled, Basketweaver monitors all `eqlog_*.txt` files in the log directory every 2 seconds and automatically switches to whichever file is actively growing. This eliminates manual log selection when changing characters.

### Weapon Preset Library

Full preset list covering Classic through Luclin 2H weapons with correct base delays and attack types (crush / slash / pierce). Presets are used for:
- Initial interval calculation before haste sync
- Attack-verb pattern selection (e.g. "You slash" vs "You crush")
- Weapon name display in the overlay header and leaderboard records

Weapons can also be set manually in tenths-of-seconds via a custom delay field.

**Mainhand presets (selected):**

| Weapon | Delay | Type |
|---|---|---|
| Tranquil Staff | 3.0s | crush |
| Bo Staff of Trorsmang | 3.5s | crush |
| Gaudralek, Sword of the Sky | 3.8s | slash |
| Meljeldin, Bane of Giants | 3.8s | slash |
| Heavy Velium Brawl Stick | 3.9s | crush |
| Petrified Heartwood Flamberge | 3.9s | slash |
| Imbued Fighters Staff | 4.0s | crush |
| Scythe of Shadows | 4.0s | slash |
| Palladius' Axe of Slaughter | 4.2s | slash |
| The Sword of Ssraeshza | 4.2s | slash |
| Frostreaver | 4.3s | slash |
| Primal Velium Brawl Stick | 4.4s | crush |
| Norge\`tal | 4.5s | slash |
| Twisted Steel Bastard Sword | 4.5s | slash |

Full preset list visible in Settings → Weapon & Timing or tray → Mainhand Delay.

### Buff & Discipline Tracking

Basketweaver detects the following buffs and disciplines from the log and tracks their active state:

| Buff / Disc | Effect |
|---|---|
| **Avatar** (any tier) | Flagged active; audio cue on gain |
| **Savagery** | Flagged active; audio cue on gain |
| **Innerflame** | Flagged active; audio cue on gain |
| **Whirlwind** | Flagged active |

Active buffs at fight start are recorded with each leaderboard entry.

### Audio System

All sounds are synthesised via the Web Audio API — no external audio files required for core sounds. Additional `.wav` files ship with the app for buff and epic events.

| Sound | Trigger |
|---|---|
| **Punch tick** | Fist attack lands in green window |
| **Whiff** | Weave window passes without a fist attack (if Fist Sound on Miss is on) |
| **Clip error** | Fist attack lands outside the weave window |
| **Epic** | Single hit exceeds the configured crit damage threshold |
| **Oh snap** | Round total damage exceeds the huge-round threshold |
| **Avatar / Savagery** | Buff gained (if Buff Sound is on) |
| **OOR blip** | Two-tone alert while out of range during combat |

**Volume controls:** master, buff/proc, and epic/huge-round volumes are independently adjustable. A debounce window (default 150 ms) prevents double-firing in Hybrid mode.

### Grading & Post-Fight Summary

After each fight (mob death or player death) a grade screen appears:

| Grade | Rounds weaved |
|---|---|
| S | ≥ 95% |
| A | ≥ 85% |
| B | ≥ 75% |
| C | ≥ 60% |
| D | ≥ 45% |
| F | < 45% |

The grade screen shows:
- Grade letter and round count (e.g. *18 / 21 rounds weaved*)
- Net DPS (all melee damage ÷ fight duration)
- Added DPS from fist weaves alone
- Average reaction time (mainhand land → first fist attempt, per round)

**Keystroke Grading** mode grades on keystrokes that land in a weave window rather than log-detected fist events — useful when proc failures or dual-wield misses would otherwise penalise you.

### Fight History & Top Records

- **Recent Fights** — last 5 completed fights shown in the tray submenu; click any entry to copy a full stat line to the clipboard for sharing in Discord or guild chat
- **Top Crits** — session-high critical hits ranked by damage, shown in the tray with mob name and timestamp
- **Top Huge Rounds** — session-high round totals ranked by damage

### Leaderboard

#### Local Leaderboard
Every completed fight is saved to `%APPDATA%\Basketweaver\leaderboard.json`. The Leaderboard window (tray → **Leaderboard…**) shows all records with:

- Mob name, grade, total DPS, added DPS
- Mainhand and offhand weapon names
- ATK rating and haste % at time of fight
- Disciplines and buffs active at fight start
- Engaged time, total duration, round count, weave %
- Character name and timestamp

Records can be filtered by mob and character, sorted by any column, and expanded into an interactive per-second DPS chart. Up to 100 records per mob are kept locally, ranked by total DPS.

#### Community Leaderboard
Fight records are **automatically uploaded** to [basketweaver.vercel.app](https://basketweaver.vercel.app) after each fight when a character name is identified. No API key or URL configuration is required — credentials are embedded in the application at build time.

Uploads are restricted to approved Classic, Kunark, Velious, and Luclin raid bosses:

| Expansion | Notable mobs |
|---|---|
| **Classic** | Lord Nagafen, Lady Vox, Cazic Thule, Innoruuk, Plane of Sky bosses |
| **Kunark** | Trakanon, Venril Sathir, Gorenaire, Severilous, Talendor, Faydedar, VP dragons |
| **Velious** | Dain Frostreaver IV, King Tormax, Lord Yelinak, Tunare, NToV bosses, Kerafyrm, Sleeper's Tomb warders |
| **Luclin** | Emperor Ssraeshza, Lord Inquisitor Seru, Aten Ha Ra, Vex Thal progression, Akheva Ruins |

All kills are saved locally regardless of eligibility.

---

## Settings Reference

### Audio Volumes
| Setting | Default | Description |
|---|---|---|
| Master Volume | 100% | Global multiplier for all sounds |
| Buff / Proc Volume | 100% | Avatar, Savagery, Innerflame sounds |
| Epic / Huge Round Volume | 100% | Epic crit and oh-snap sounds |
| Sound Debounce | 150 ms | Minimum gap between repeated sounds; prevents double-firing in Hybrid mode |

### Sound Triggers
| Setting | Default | Description |
|---|---|---|
| Crit Damage Threshold | 400 | Min single-hit damage to trigger epic.wav |
| Huge Round Threshold | 600 | Min round total to trigger oh_snap.wav |

### Tracking Source
| Option | Description |
|---|---|
| **Log File** | Tail the EQ log file at 16 ms poll intervals |
| **Hybrid (Zeal + Log)** | Combine Zeal named pipe with log file for lowest latency |

### Overlay Style
| Option | Description |
|---|---|
| **Refined** | Dark navy/gold arcade look (default) |
| **High Contrast** | Black background, vivid yellow/cyan |

### Weapon & Timing
| Setting | Description |
|---|---|
| Mainhand Weapon | Select preset; sets base delay and attack type |
| Offhand Weapon | Select preset; sets offhand delay for window calculation |
| Mainhand Swing Interval | Manual override for post-haste interval |
| Target Offset (ms) | Shift hit zone timing later (positive) or earlier |
| Latency Compensation (ms) | Shift scoring timestamp back to correct for network delay |
| Clip Detection Window | Duration after a weave to suppress duplicate clip detections |
| Weave Window (ms, 0=auto) | Override weave window width; 0 = auto from interval minus offhand delay |

### Display
| Setting | Description |
|---|---|
| Target Position (%) | Move hit zone left/right — cosmetic only, timing unaffected |
| Opacity | Overlay transparency (50–100%) |

### Options
| Option | Default | Description |
|---|---|---|
| Audio Enabled | On | Master on/off for all sounds |
| Buff Sound Enabled | On | Play sounds when Avatar, Savagery, Innerflame detected |
| Fist Sound on Miss | On | Play whiff sound when weave window passes without a fist attack |
| Dynamic Weaving | On | Color-coded weave window zones (blue/green/red) |
| Offhand Swing Timer | On | Thin bar beneath highway showing offhand cooldown progress |
| Keystroke Grading | Off | Grade by keystrokes in window rather than log-detected fist events |
| Offhand Same Attack Type | Off | Treat second crush in a round as the offhand event (for Ribcracker-style blunt offhand weapons) |
| Freeze Window Position | On | Lock overlay so it cannot be dragged |
| Show All Crits on Track | On | Show all crit banners, not just those above the epic threshold |
| Positive Audio in Weave Windows | Off | Play punch sound on any in-window attempt; whiff only for out-of-window |
| Weave Off Delay (ms) | 400 | How long to keep weave state active after swap-back bandolier message (Zeal pipe arrives before the hit) |
| Auto-detect Active Log | Off | Monitor log directory and switch automatically to the growing log file |

### Leaderboard
| Setting | Description |
|---|---|
| Character Name | Auto-detected from log filename; override manually if needed |

---

## Tray Menu

| Item | Description |
|---|---|
| Settings… | Open the Settings window |
| Status | IN COMBAT / IDLE (read-only) |
| Select Log File… | Choose a different EQ log file |
| Reset Track | Hard-reset all timing state |
| Clear Buffs (AVT/SAV) | Manually clear Avatar and Savagery tracking |
| Buff Notification Sounds | Toggle buff detection audio |
| Reset Window Position | Snap overlay to center of primary monitor |
| Freeze Window Position | Lock / unlock overlay dragging |
| Recent Fights | Last 5 fight summaries; click to copy to clipboard |
| Top Crits | Session-high critical hits |
| Top Huge Rounds | Session-high round totals |
| Mainhand Delay | Select mainhand weapon preset |
| Offhand Delay | Set offhand weapon delay (1.6–2.8 s) |
| Audio | Toggle all sounds on / off |
| Leaderboard… | Open the Leaderboard window |
| Quit Basketweaver | Exit |

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `↑` / `↓` | Swing interval +0.25 s / −0.25 s |
| `H` | Toggle horizontal / vertical highway orientation |
| `R` | Reset track |
| `M` | Toggle audio mute |
| `Space` | Dismiss grade screen |
| `Escape` | Quit |

---

## Technical Details

- Built with **Electron** + **electron-vite**
- Overlay rendered on an HTML5 **Canvas** at 60 fps via `requestAnimationFrame`
- Audio synthesised via the **Web Audio API** (no external dependency for core sounds)
- Log tailing via `fs.openSync` + `setInterval` at 16 ms for near-real-time delivery
- Zeal pipe read via Node.js net socket connected to `\\.\pipe\zeal_<PID>`
- Settings persisted to `%APPDATA%\Basketweaver\settings.json`
- Leaderboard stored to `%APPDATA%\Basketweaver\leaderboard.json`
- Community leaderboard backend: Vercel serverless functions + Vercel Postgres
- Auto-updater via **electron-updater** (checks GitHub releases)
- Always-on-top, frameless, transparent window; mouse pass-through while not interacting

---

## Installation

Download the latest installer from the [Releases](../../releases) page and run `Basketweaver-Setup-X.X.X.exe`. The app installs per-user and places a tray icon in the system notification area on launch.

> **Requires:** Windows 10 or 11 · EverQuest logging enabled (`/log on`)

---

## Documentation

The full user manual is available in the [Releases](../../releases) page as both `MANUAL.md` and `MANUAL.pdf`.

---

*Basketweaver — designed with monks in mind, built to scale.*

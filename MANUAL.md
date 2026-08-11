# Basketweaver — User Manual
## Version 2.3.1

Basketweaver is a real-time timing overlay for EverQuest weapon-weaving.
It draws a scrolling highway showing when to swap to your offhand weapon set
so your offhand round lands without clipping your mainhand swing timer.

Combat events can be read two ways: from your **EQ log file** (default), or
in **Hybrid mode**, which combines the log file with a **Zeal named pipe** if
you are running the Zeal client plugin. Both modes produce identical overlays —
the difference is only in how data reaches Basketweaver.

---

## Table of Contents

1. [How It Works](#1-how-it-works)
2. [Core Concepts & Definitions](#2-core-concepts--definitions)
3. [First-Time Setup](#3-first-time-setup)
4. [Hybrid Tracking (Zeal + Log)](#4-hybrid-tracking-zeal--log)
5. [Understanding the Overlay](#5-understanding-the-overlay)
6. [Timing Your Weaves](#6-timing-your-weaves)
7. [Calibration](#7-calibration)
8. [Settings Window](#8-settings-window)
9. [Tray Menu Reference](#9-tray-menu-reference)
10. [Leaderboard](#10-leaderboard)
11. [Keyboard Shortcuts](#11-keyboard-shortcuts)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. How It Works

### The Weaving Technique

The weaving technique is viable for any class that has dual wield and access to
strong 2H weapons. The objective is to get a free "bonus" swing with an offhand
weapon in between 2H weapon swings. This works because dual wield runs on an
independent timer from your mainhand, and your primary weapon swing timer is not
reset when you swap weapon sets.

Done well, weaving has the potential to add approximately 20–30 DPS to a raid
target over standard 2H weapon DPS.

The challenge is timing: if you do not swap your weapon set back to your 2H setup
before the mainhand timer resets, you will clip your attack — or swing a 1H weapon
instead of your high-impact 2H weapon. This is called a **clip**, and it costs more
DPS than not weaving at all.

Basketweaver was designed with monks in mind but with additional development can
scale to other classes.

### What Basketweaver Does

Basketweaver watches every mainhand swing in real time and calculates exactly when
your next swing will fire. It draws a scrolling **highway** overlay on top of
EverQuest with a **green weave window** that shows the safe zone for your weapon
swap. The window approaches a fixed **hit zone** at the left of the highway — when
the window reaches the hit zone, swap to your offhand weapon set.

Every event is timestamped at the moment it arrives in the app, not when it was
written to disk, which keeps the overlay accurate even during log-flush delays.

### The Tracking Pipeline

```
EverQuest game client
        │
        ├─── Log file (/log on)                   ← Log File mode
        │         │
        │    Basketweaver tails the file (16 ms poll)
        │
        └─── Zeal named pipe (\\.\pipe\zeal_PID)  ← Hybrid mode (Zeal + Log)
                  │
             Basketweaver connects via TCP socket

Both paths converge here:
        │
        ▼
   Event parser  (detects hits/misses, fist attacks, haste, death)
        │
        ▼
   Rhythm engine  (measures swing intervals, places weave windows, scores attempts)
        │
        ▼
   Canvas overlay  (draws highway, hit zone, banners, grade screen at 60 fps)
```

### Interval Measurement & Auto-Calibration

Basketweaver does not rely solely on your configured weapon delay. After each
mainhand swing, it measures the actual elapsed time since the previous swing and
maintains a rolling median of the last 6 measurements. When the measured median
drifts more than 50 ms from the current interval, the overlay silently adjusts
and shows a brief **Auto-calibrated** banner.

Calibration samples are filtered: any gap larger than 130% of the unhasted weapon
delay is discarded as a skipped swing (out of range, interrupted, etc.) and does
not pollute the median.

### Weapon Attack Types

Basketweaver tracks mainhand swings for all attack types — **crush**, **slash**,
and **pierce** — and automatically switches verb matching when a weapon preset is
detected. Ripostes are never counted as mainhand swing events, regardless of weapon
type; they are credited only toward total DPS.

### Grading

At the end of each fight, Basketweaver grades your performance based on the
fraction of mainhand rounds in which you made a fist weave attempt. By default
grading uses log-detected fist events. If you prefer to grade by keystrokes (so
proc failures and dual-wield misses do not penalise you), enable **Keystroke
Grading** in Settings.

| Grade | Rounds weaved |
|---|---|
| **S** | ≥ 95% |
| **A** | ≥ 85% |
| **B** | ≥ 75% |
| **C** | ≥ 60% |
| **D** | ≥ 45% |
| **F** | < 45% |

---

## 2. Core Concepts & Definitions

**Swing timer**
Each weapon in EQ operates on an independent internal countdown. When auto-attack
is on, the timer counts down and fires the weapon, then resets to the weapon's
delay and counts down again. The timer only runs while auto-attack is active and
you have a valid target in range.

**Weapon delay**
EQ stores weapon delays in tenths of a second (e.g. delay 20 = 2.0 s). Basketweaver
uses this value as the baseline for interval calculations. Set it via tray →
**Mainhand Delay** or the Settings window.

**Haste**
A percentage bonus that shortens effective weapon delays. At 40% haste, a 2.0 s
weapon fires every `2.0 / 1.40 = 1.43 s`. The EQ client cap is **125% haste**,
giving a minimum effective delay of `base / 2.25`. Basketweaver tracks your haste
via `/mystats` output and adjusts the highway speed accordingly.

**Mainhand interval**
The time between consecutive mainhand swings at your current haste level:

```
interval = base_delay_seconds / (1 + haste_pct / 100)
```

Example: 2.0 s staff at 60% haste → `2.0 / 1.60 = 1.25 s` interval.

**Offhand / fist weapon delay**
The delay of your secondary (fist) weapon, also haste-adjusted. This determines
how long the fist timer needs to count down before firing. A shorter fist delay
means a narrower safe weave window. Set via tray → **Offhand Delay** or Settings.

**Weave window**
The safe period between mainhand swings during which the fist weapon can fire
without delaying the next mainhand. Duration:

```
window = mainhand_interval − fist_delay_seconds
```

Example: 1.25 s interval, 0.71 s fist delay → `1.25 − 0.71 = 0.54 s` window.
This is drawn as the **green box** on the highway. A shorter window means tighter
timing is required.

**Clip**
A clip occurs when you initiate a fist weave too late — after the mainhand timer
has already reset for its next swing. Your fist timer fires into the mainhand
window, resetting the mainhand timer and delaying the next crush. Basketweaver
flags clips with a red flash, an error sound, and a **CLIPPED** banner. Clipping
is worse than skipping a weave because it actively delays mainhand damage.

**Hit zone**
The vertical bar on the left side of the highway that acts as the timing target.
Weave actions are judged at this point. When the green window reaches the hit zone,
swap to your offhand weapon set. The hit zone position can be moved left or right via
Settings → **Target Position** (cosmetic only — timing is not affected).

**Target offset**
A timing correction applied to the hit zone, in milliseconds. A positive offset
makes the window appear to arrive at the hit zone slightly later, giving you more
reaction time. Adjust if you consistently feel the window is arriving too early.

**Latency compensation**
Fist attack events (punches) that arrive in the log or pipe after a network delay
would be scored against the wrong window position. Latency compensation shifts the
scoring timestamp backward by the configured amount so the hit is judged at the
correct point on the highway. Typical values: 25–75 ms.

**Round**
A complete mainhand swing cycle — from one swing (or miss) to the next. Basketweaver
clusters rapid successive mainhand events within a 500 ms window into the same round
to handle dual-wield proc firings.

**Reaction time**
The delay between your mainhand swing landing and your first fist attempt in that
round. Shown as **avg reaction** on the grade screen. Lower is better — ideally
under 200 ms.

**Out of range (OOR)**
When you are too far from your target to swing, EQ blocks the attack. Basketweaver
detects OOR messages, plays a brief two-tone alert, and pauses the swing timer
prediction (since the mainhand timer is frozen while OOR).

**Cursor blocked**
EQ refuses weapon swaps when you are holding an item on your cursor. Basketweaver
detects this and shows a **CURSOR!** banner so you know to clear your cursor before
the next weave window.

**Keystroke grading**
An alternate grading mode that counts space-bar or mouse-click presses that land
inside a weave window instead of counting log-detected fist events. Useful when
your fist attack has a proc component that sometimes fails silently, which would
otherwise count as a missed weave under log-based grading.

---

## 3. First-Time Setup

### Launch
Double-click **Basketweaver** from the Start Menu or desktop shortcut.
On first launch a file picker will open automatically.

### Select Your Log File
Navigate to your EverQuest folder and select your character's log file:

```
C:\TAKP\TAKPv22\eqlog_YourName_server.txt
```

> Make sure EverQuest has logging enabled.
> In-game command: `/log on`

Basketweaver remembers your log file and window position between sessions.
Your character name is read from the log filename and displayed in the header.
If the overlay ever ends up off-screen, use tray → **Reset Window Position** to
snap it back to the center of your primary monitor.

### Auto-Detect Active Log

If you play multiple characters or frequently switch between them, enable
**Auto-detect Active Log** in Settings → **Options**. When active, Basketweaver
monitors all `eqlog_*.txt` files in your log directory every 2 seconds and
automatically switches to whichever file is actively growing — no manual log
selection needed when changing characters.

> **Note:** Auto-detect only starts scanning once an initial log file has been
> selected (it needs to know which directory to watch). Select any log file once
> at first launch.

### Open Settings
Right-click the tray icon → **Settings…** to open the Settings window.
All major configuration options live here. See [Section 8](#8-settings-window) for
a full reference.

### Set Your Mainhand Weapon
In Settings → **Weapon & Timing** → **Mainhand Weapon**, type to search your weapon
by name and select it from the dropdown. Alternatively, use tray → **Mainhand Delay**
to pick from the full preset list.

| Weapon | Delay | Type |
|---|---|---|
| Skull Staff of Geoffrey | 2.0s | crush |
| Runed Fighters Staff | 2.0s | crush |
| Wu's Quivering Staff | 2.8s | crush |
| Abashi's Rod of Disempowerment | 3.0s | crush |
| Caen's Bo Staff of Fury | 3.0s | crush |
| Peacebringer | 3.0s | crush |
| The Arm of Quellious | 3.0s | crush |
| Tranquil Staff | 3.0s | crush |
| Bo Staff of Trorsmang | 3.5s | crush |
| Efreeti Ice Staff | 3.5s | crush |
| Tae Ew Two Hand Hammer | 3.5s | crush |
| Amygdalan War Staff | 3.6s | crush |
| Exquisite Velium Brawl Stick | 3.6s | crush |
| Rod of Mourning | 3.6s | crush |
| Tae Ew War Maul | 3.6s | crush |
| Wrapped Velium Brawl Stick | 3.6s | crush |
| Carved Velium Brawl Stick | 3.7s | crush |
| Massive Velium Brawl Stick | 3.7s | crush |
| Staff of Battle | 3.7s | crush |
| Etched Velium Brawl Stick | 3.8s | crush |
| Gaudralek, Sword of the Sky | 3.8s | slash |
| Meljeldin, Bane of Giants | 3.8s | slash |
| Runestone Maul | 3.8s | crush |
| Heavy Velium Brawl Stick | 3.9s | crush |
| Petrified Heartwood Flamberge | 3.9s | slash |
| Aggression | 4.0s | crush |
| Bloodied Berserker's Blade | 4.0s | slash |
| Bruiser's Beatstick | 4.0s | crush |
| Feartouched Greatsword | 4.0s | slash |
| Great Maul of Slaughter | 4.0s | crush |
| Greatsword of the Disciple | 4.0s | slash |
| Imbued Fighters Staff | 4.0s | crush |
| Scythe of Shadows | 4.0s | slash |
| Ton Po's Bo Stick of Understanding | 4.0s | crush |
| Yttrium War Hammer | 4.0s | crush |
| Rocksmasher | 4.1s | crush |
| Facesmasher | 4.2s | crush |
| Palladius' Axe of Slaughter | 4.2s | slash |
| The Sword of Ssraeshza | 4.2s | slash |
| Frostreaver | 4.3s | slash |
| Herbalists Spade | 4.3s | crush |
| Scalecracker | 4.3s | crush |
| Shovel of the Harvest | 4.3s | crush |
| Ancient Prismatic Brawl Stick | 4.4s | crush |
| Petrified Rod | 4.4s | crush |
| Priceless Velium Brawl Stick | 4.4s | crush |
| Premier Brawl Stick of Secundae | 4.4s | crush |
| Primal Velium Brawl Stick | 4.4s | crush |
| Emaciated Maul of the Overseer | 4.5s | crush |
| Norge\`tal | 4.5s | slash |
| Twisted Steel Bastard Sword | 4.5s | slash |
| Blackstone Maul | 5.3s | crush |

### Set Your Offhand (Fist) Weapon Delay
In Settings → **Weapon & Timing** → **Offhand Weapon**, search and select your fist
weapon. Default is 1.6s (delay 16 — standard monk fists). Alternatively, use tray →
**Offhand Delay** to set by delay value.

> **Tip:** Use the `/mystats` calibration macro to auto-detect haste.
> See [Section 7](#7-calibration).

---

## 4. Hybrid Tracking (Zeal + Log)

**Zeal** is a client plugin for EverQuest (TAKP / Project Quarm and similar
servers) that exposes real-time game data through Windows named pipes. In
**Hybrid mode**, Basketweaver reads combat data from both the Zeal named pipe
and the log file simultaneously, combining them for the lowest possible latency.

### Why Use Hybrid Instead of Log Only?

| | Log File | Hybrid (Zeal + Log) |
|---|---|---|
| **Latency** | Bounded by how often EQ flushes the log to disk | Near-instant from Zeal; log fills in anything Zeal misses |
| **Setup** | Requires logging on (`/log on`) | Log still recommended for fallback |
| **Auto-connects to Zeal** | No | Yes — detects EQ automatically |
| **Multiple EQ sessions** | One log file at a time | Connects to all running EQ processes |

### Requirements

- The **Zeal plugin** must be installed and loaded in EverQuest.
  Zeal creates a named pipe (`\\.\pipe\zeal_<PID>`) for each running
  EQ process automatically — no extra configuration is needed.
- Basketweaver and EverQuest must be running on the same machine.

### Enabling Hybrid Tracking

Open **Settings…** → **Tracking Source** → select **Hybrid (Zeal + Log)**.

Basketweaver immediately begins scanning for `eqgame.exe` processes every
2 seconds. Once it finds one, it connects to the Zeal pipe and starts receiving
events alongside the log file. A log entry appears in the console confirming
the connection:

```
[ZealReader] Connected to pipe for PID 12345
```

The overlay behaves identically to log-only mode — swing detection, haste
sync, weapon detection, and `/mystats` calibration all work the same way
because the text content from Zeal is the same combat text that appears in
your log file.

### Switching Back to Log Tracking

Open **Settings…** → **Tracking Source** → select **Log File**.

If you had a log file selected before switching to Hybrid, Basketweaver resumes
tailing it automatically. If not, it will wait for you to select one via
tray → **Select Log File…**.

### How It Works (technical)

Zeal writes JSON messages to its named pipe in the format:

```json
{"type": 0, "character": "Yourname", "data": "{\"type\": 265, \"text\": \"You crush a goblin for 42 points of damage.\"}"}
```

The outer `type` field is the message category (`0` = log text). Basketweaver
only processes log text messages. The inner `text` field is the combat line —
identical to what would be written to your log file, but without the timestamp
prefix.

In Hybrid mode, events from both sources are deduplicated by content so a combat
line seen on both the pipe and the log file is only processed once.

---

## 5. Understanding the Overlay

The overlay is a scrolling "highway" that sits on top of EverQuest.
Weave windows approach from the right and travel left toward the hit zone.
Two visual styles are available via Settings → **Overlay Style**: **Refined**
(default) and **High Contrast**.

```
┌─────────────────────────────────────────────────────────────────┐
│ Taydar  [COMBAT]                                   2.00s  100%  │ ← Header
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ║  ·  ·  ·  ·  ·  ·  [====GREEN BOX====]│  ·  ·  ·  ·  ·  · │ ← Highway
│                                           │                     │
│  ↑                    ← windows travel ← ↑                     │
│ Hit Zone                              Orange Bar                │
│ (gold bar)                         (mainhand swing)             │
│━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━                             │ ← Offhand timer
├─────────────────────────────────────────────────────────────────┤
│  WEAVES 12  ·  NET DPS 245  ·  WEAVED DPS +148                 │ ← Footer
└─────────────────────────────────────────────────────────────────┘
```

### Elements

**║ Hit Zone** (gold vertical bar, left side)
This is your timing target. Weave actions are judged here.

**[===GREEN BOX===]** (green rectangle)
The safe weave window. When **Dynamic Weaving** is enabled (default),
the window is divided into zones:
- **Blue wait zone** — the offhand weapon is still on cooldown from
  your last weave; weaving now would queue too early.
- **Green safe zone** — offhand weapon is ready and you still have
  time to swing before the next mainhand fires. **Swap here.**
- **Red discouraged zone** — you can still get the swing off but you
  are cutting it close; missing the green zone is not ideal.

When Dynamic Weaving is disabled the window reverts to a single solid
bar (legacy behaviour).

**│ Orange Bar** (thin vertical line at left edge of green box)
Marks the exact moment your mainhand will swing next. When the orange bar
reaches the hit zone, your mainhand fires. Do **not** initiate a weave
after this point — you won't have time before the next swing.

**━━━ Offhand Swing Timer** (thin bar at the bottom of the highway)
A progress bar that shows how long until your offhand weapon is ready to
fire again. It shrinks from full width toward zero as the cooldown counts
down. Colour shifts from **blue → cyan → bright cyan** as the weapon
approaches ready. Toggleable via Settings → **Offhand Swing Timer**.

**CURSOR! warning**
If you try to swap weapons while holding an item on your cursor, EQ will
block the swap. Basketweaver detects this, shows a **CURSOR!** banner,
and plays an error sound so you know to clear your cursor immediately.

### No-Log / Stale-Log Notice

When no log file is selected, or when the selected log has not received any
new events for more than 60 seconds, a pulsing message appears on the highway:

| Situation | Line 1 | Line 2 |
|---|---|---|
| No log selected | *No log file selected* | *Right-click tray → Select Log* |
| Log inactive (60 s) | *Log not updating* | *Is EQ running?* |

The notice is hidden as soon as combat events begin arriving. It does not appear
during active combat or on the grade screen.

### Footer Stats

| Stat | Description |
|---|---|
| **WEAVES** | Number of mainhand rounds where a fist weave was attempted |
| **NET DPS** | Total melee DPS for the fight (mainhand + fist + procs) |
| **WEAVED DPS** | DPS contributed specifically by fist weave attacks |

### Overlay Styles

Two visual styles are available via Settings → **Overlay Style**:

| Style | Description |
|---|---|
| **Refined** (default) | Dark arcade look — gold bar hit zone, green weave windows, subtle grid |
| **High Contrast** | Black background, vivid yellow/cyan colors — good for streaming or low-vision use |

---

## 6. Timing Your Weaves

### The Core Loop

```
                        Time flows this way →→→→→→→→
                        Windows scroll this way ←←←←

 ──────────────────────────────────────────────────────────────────
  PAST       Hit Zone          Highway                     FUTURE
 ──────────────────────────────────────────────────────────────────

 Step 1: Green box approaching hit zone
 ·  ·  ·  ║  ·  ·  ·  ·  ·  [====GREEN====]│  ·  ·  ·  ·  ·  ·

 Step 2: GREEN BOX IS AT HIT ZONE — SWAP TO OFFHAND WEAPON SET NOW ✓
 ·  ·  ·  [=║=============]│  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·  ·

 Step 3: Orange bar arrives — mainhand swings, window closes
 ·  ·  ·  ·  ·  ·  ·  ·  ·  │║  ·  ·  ·  [====GREEN====]│  ·  ·
```

### What Good Timing Looks Like

When your fist punch lands inside the green window, the hit zone
flashes gold and you hear the punch sound.

### What a Miss Looks Like

If the weave window passes without a fist attack, a small
**"— missed"** chip appears near the hit zone and fades out.

### What a Clip Looks Like

If your fist attack lands outside the weave window (you swung through
a window you already passed), a **red wash** floods the highway, the
hit zone strobes red, and **CLIPPED** appears in red text. A harsh error
sound plays. This means your offhand fired at the wrong time and may
have clipped your mainhand swing timer.

### End-of-Fight Grade Screen

The grade screen fires when your target dies or when you die. It shows
your performance for that fight:

```
  ┌────────────────────────────────────────┐
  │    S   18/21 rounds weaved             │  ← Grade + rounds with a weave
  │        net 312 dps                     │  ← Total melee DPS
  │        +148 dps from weaving           │  ← Added DPS from fist weaves
  │        142 ms avg reaction             │  ← Crush → fist delay, per round
  └────────────────────────────────────────┘
```

- **Grade** is based on what fraction of mainhand rounds had a fist weave attempt.
- **Net DPS** is your total melee damage output divided by fight duration.
- **+N dps from weaving** is the DPS contribution from fist attacks alone.
- **Avg reaction** is the average time from your mainhand swing to the first fist
  attack in that round — measured per round, one sample per round.

Press **Space** to dismiss.

### Fight History

Fight results are tracked across all overlay styles and sent to the tray.
Open tray → **Recent Fights** to view the last 5 results. The menu entry
shows a compact summary; clicking it copies a full detailed line to the
clipboard — useful for sharing parse results in Discord or guild chat.

All fight records are also stored locally and visible in the
[Leaderboard window](#10-leaderboard).

---

## 7. Calibration

### Automatic Haste Sync

Basketweaver watches for haste information in your log. When your
server reports your haste percentage (via `/mystats` or a spell landing),
it automatically recalculates the interval and adjusts the highway speed.

After a haste sync you will see a banner:

```
  Haste sync: 1.25s  (60% haste)
```

No manual action needed.

### Manual Interval Adjustment

If auto-sync hasn't fired yet (e.g. at the start of a session), you
can set the interval manually:

Open Settings → **Weapon & Timing** → **Mainhand Swing Interval**, or use
the arrow keys while the overlay is focused:
- `↑` — increase interval by 0.25s
- `↓` — decrease interval by 0.25s

### If Weaves Feel Early (green box arrives too soon)

Increase **Target Offset** (shifts the hit zone timing later):

Settings → **Weapon & Timing** → **Target Offset** → try 25 ms, 50 ms steps.

### If Weaves Feel Late (you're always catching the tail of the green box)

Decrease Target Offset back toward 0, or adjust **Latency Comp.**
if your network adds delay between when you act and when EQ registers it:

Settings → **Weapon & Timing** → **Latency Comp.** → try 25–75 ms.

### Calibration Quick Reference

| Symptom | Fix |
|---|---|
| Green box arrives too early, weaves clip | Increase Latency Comp. |
| Green box arrives too late, mainhand delays | Decrease Latency Comp. |
| Notes never reach hit zone | Check your log file is updating (logging on?) |
| Windows don't appear | Enter combat — windows only show during active fighting |
| Interval wrong after buff / zone | Use `↑` / `↓` keys or set Interval in Settings |

---

## 8. Settings Window

Open via tray → **Settings…**. Changes take effect immediately; click **Save & Close**
to persist them across sessions.

### Audio Volumes

| Setting | Description |
|---|---|
| **Master Volume** | Global volume multiplier for all sounds (0–100%) |
| **Buff / Proc Sounds** | Volume for Avatar, Savagery, and other buff sounds |
| **Epic / Huge Round** | Volume for the epic crit and huge-round sounds |
| **Sound Debounce (ms)** | Minimum milliseconds between repeated sounds of the same type. Use 50–150 ms in Hybrid mode to prevent double-firing. Set 0 to disable. |

### Sound Triggers

| Setting | Description |
|---|---|
| **Crit Damage** | Minimum single-hit damage to trigger the epic.wav sound |
| **Huge Round** | Minimum round total damage to trigger the oh_snap.wav sound |

### Tracking Source

| Option | Description |
|---|---|
| **Log File** (default) | Basketweaver tails your EQ log file |
| **Hybrid (Zeal + Log)** | Combines Zeal named pipe with log file; lower latency |

See [Section 4](#4-hybrid-tracking-zeal--log) for full Hybrid mode details.

### Overlay Style

| Option | Description |
|---|---|
| **Refined** (default) | Dark arcade look — gold hit zone, green weave windows, subtle grid |
| **High Contrast** | Black background, vivid yellow/cyan — good for streaming or low-vision |

Changing the style reloads the renderer. Your log file reconnects automatically and
all persisted settings are restored.

### Weapon & Timing

| Setting | Description |
|---|---|
| **Mainhand Weapon** | Search and select your 2H weapon; sets the base delay and attack type |
| **Offhand Weapon** | Search and select your fist/offhand weapon; sets offhand delay |
| **Mainhand Swing Interval** | Override the post-haste swing interval manually |
| **Target Offset** | Fine-tune hit zone timing in ms (positive = later) |
| **Latency Comp.** | Compensate for network/input delay in ms |
| **Clip Window** | Duration after a weave to suppress duplicate detections |
| **Weave Window (ms, 0=auto)** | Override the weave window width. 0 = auto-derived from interval minus offhand delay |

Custom weapon delays can be entered in EQ tenths-of-seconds (e.g. 28 = 2.8 s) using
the custom field that appears when no preset matches your search.

### Display

| Setting | Description |
|---|---|
| **Target Position** | Move the hit zone left or right (cosmetic; timing unaffected) |
| **Opacity** | Overlay transparency (50–100%) |

### Options

| Option | Description |
|---|---|
| **Audio Enabled** | Master toggle for all sounds |
| **Buff Sound Enabled** | Play sounds when Avatar, Savagery, or Innerflame is detected |
| **Fist Sound on Miss** | Play a whiff sound when a fist weave misses |
| **Dynamic Weaving** | Show color-coded weave window zones (blue/green/red) based on offhand cooldown |
| **Offhand Swing Timer** | Show a thin bar at the bottom of the highway indicating offhand weapon readiness |
| **Offhand Same Attack Type (timing)** | Treat a second crush in a round as the offhand event (for blunt offhand weapons like Ribcracker) |
| **Freeze Window Position** | Lock the overlay in place so it cannot be dragged |
| **Show All Crits on Track** | Display all critical hit banners on the highway, not just those above the epic threshold |
| **Positive Feedback Audio in Weave Windows** | Play the punch sound on any in-window attempt; play the whiff sound only for out-of-window swings |
| **Weave Off Delay (ms)** | How long to keep the weave state active after a swap-back bandolier message is detected (Zeal pipe may arrive before the hit) |
| **Auto-detect Active Log** | Monitor all eqlog_*.txt files in the log directory and automatically switch to whichever file is actively growing. Useful when changing characters without restarting Basketweaver. |

### Leaderboard

| Setting | Description |
|---|---|
| **Character Name** | Your character name for leaderboard records. Auto-detected from the log filename — only set this manually if you want to override it. |
| **Opt Out of Leaderboard** | Keep fight records local only — never upload them to the community leaderboard |

---

## 9. Tray Menu Reference

Right-click the Basketweaver icon in the system tray to open the menu.

| Option | Description |
|---|---|
| **Settings…** | Open the Settings window |
| **Status** | Shows IN COMBAT or IDLE (read-only) |
| **Select Log File…** | Choose a different EQ log file |
| **Reset Track** | Hard reset — clears all state if overlay gets out of sync |
| **Clear Buffs (AVT/SAV)** | Manually clear tracked Avatar and Savagery buff states |
| **Buff Notification Sounds** | Toggle buff detection sounds on / off |
| **Reset Window Position** | Snap overlay to a safe central position on the primary monitor |
| **Freeze Window Position** | Lock the overlay window so it cannot be dragged |
| **Recent Fights** | Last 5 fight results; click any entry to copy full stats to clipboard |
| **Top Crits** | Your top critical hits this session (mob name, damage, date) |
| **Top Huge Rounds** | Your top huge-round totals this session (mob name, damage, date) |
| **Mainhand Delay** | Select your mainhand weapon from the full preset list |
| **Offhand Delay** | Set your fist weapon delay by value |
| **Audio** | Toggle all sounds on / off |
| **Leaderboard…** | Open the Leaderboard window |
| **Basketweaver vX.X.X** | Current version (read-only) |
| **Quit Basketweaver** | Exit the app |

---

## 10. Leaderboard

The Leaderboard window stores your fight records locally and automatically uploads
eligible kills to the shared community board at **basketweaver.vercel.app**.

### Opening the Leaderboard

Right-click the tray icon → **Leaderboard…**

### What It Shows

Each row in the table represents one completed fight and includes:

| Column | Description |
|---|---|
| **Mob** | Name of the target you killed |
| **Grade** | Weave grade for that fight (S / A / B / C / D / F) |
| **Total DPS** | All melee DPS (mainhand + fist + procs) |
| **Added DPS** | DPS contributed by fist weave attacks alone |
| **Mainhand** | Detected mainhand weapon name |
| **Offhand** | Offhand weapon from config |
| **ATK** | Your ATK rating at the time of the fight |
| **Haste** | Your haste percentage at the time of the fight |
| **Disciplines** | Disciplines activated during the fight (e.g. Innerflame 45%) |
| **Buffs** | Buffs active during the fight (e.g. Avatar 100%, Savagery 60%) |
| **Engaged** | Time actually in melee range |
| **Duration** | Total wall-clock fight length |
| **Rounds** | Total mainhand rounds |
| **Weave %** | Percentage of rounds where a weave attempt was made |
| **Character** | Your character name |
| **Date** | Date and time the fight ended |

### Filtering and Sorting

Use the **Mob** and **Character** filter boxes at the top to narrow results.
Click any column header to sort by that column; click again to reverse the order.

### DPS Chart

Click any row to open a time-averaged DPS chart for that fight. The chart shows
per-second DPS (normalized over a 15-second window for the first 15 seconds to
remove the initial spike), a peak DPS marker, and a grid with 15-second intervals.
Click **Close Chart** to dismiss.

### Community Leaderboard Uploads

Fight records are **uploaded automatically** after each fight — no configuration
required. Uploads happen when:

1. Your character name has been identified (from the log filename or Zeal pipe), **and**
2. The killed mob is on the approved raid boss list (see below).

All kills are saved to your **local** leaderboard regardless of whether they qualify
for the community board. Only specific Classic, Kunark, Velious, and Luclin raid
bosses are eligible for community upload.

If you'd rather not contribute to the community board at all, enable **Opt Out of
Leaderboard** in Settings → Leaderboard. Your fights are still recorded locally
(Recent Fights, Top Crits, Top Huge Rounds, and the Leaderboard window), they just
won't be uploaded.

**Eligible mobs by expansion:**

| Expansion | Zone | Mobs |
|---|---|---|
| **Classic** | Nagafen's Lair | Lord Nagafen |
| | Permafrost Keep | Lady Vox |
| | Plane of Fear | Cazic Thule, Dread, Fright, Terror |
| | Plane of Hate | Innoruuk |
| | Plane of Sky | Thunder Spirit Princess, Noble Dojorn, Protector of Sky, Gorgalosk, Keeper of Souls, Overseer of Air, Spiroc Guardian, The Spiroc Lord, Bazzt Zzzt, Sister of the Spire, Hand of Veeshan, Eye of Veeshan |
| **Kunark** | Emerald Jungle | Severilous |
| | Skyfire Mountains | Talendor |
| | Timorous Deep | Faydedar |
| | Dreadlands | Gorenaire |
| | Old Sebilis | Trakanon |
| | Karnor's Castle | Venril Sathir |
| | Chardok | King Tearis Thex, Queen Velazul Di'Zok |
| | Veeshan's Peak | Silverwing, Hoshkar, Phara Dar, Nexona, Druushk, Xygoz |
| **Velious** | Icewell Keep | Dain Frostreaver IV |
| | Western Wastes | Klandicar, Sontalak |
| | Dragon Necropolis | Zlandicar |
| | Kael Drakkal | Derakor the Vindicator, Statue of Rallos Zek, King Tormax |
| | Skyshrine | Lord Yelinak |
| | Velketor's Labyrinth | Velketor the Sorcerer |
| | Plane of Growth | Tunare |
| | Wakening Land | Wuoshi, Lord Doljonijiarnimorinar |
| | Sleeper's Tomb | Hraashna, Nanzata, Tukaarak, Ventani, The Progenitor, Master of the Guard, The Final Arbiter, Kerafyrm |
| | Temple of Veeshan | Zeixshi-Kar, Tjudawos, Vyskudra, Kildrukaun the Ancients, Casalem, Essedera, Grozzmel, Krigara, Lepethida, Midayor, Tavekalem, Ymmeln, Zemm |
| | North Temple of Veeshan | Aaryonar, Dozekar the Cursed, Cekenar, Lord Feshlak, Jorlleag, Lord Koi'Doken, Lord Kreizenn, Lendiniara the Keeper, Lady Mirenilla, Lady Nevederia, Sevalak, Lord Vyemm, Dagarn the Destroyer, Zlexak, Eashen of the Sky, Ikatiar the Venom, Gozzrem, Telkorenar, Vulak\`Aerr |
| **Luclin** | Ssraeshza Temple | Xerikizh the Creator, The High Priest of Ssraeshza, Emperor Ssraeshza, A Glyph Covered Serpent, Vyzh\`dra the Exiled, Vyzh\`dra the Cursed |
| | Sanctus Seru | Lord Inquisitor Seru |
| | Acrylia Caverns | Khati Sha the Twisted |
| | Akheva Ruins | The Itraer Vius, Shei Vinitras, The Insanity Crawler |
| | Grieg's End | Grieg Veneficus |
| | Vex Thal | Kaas Thox Xi Ans Dyek, Diabo Xi Xin, Diabo Xi Va, Diabo Xi Xin Thall, Thall Va Kelun, Diabo Xi Va Terminiel, Thunderos Xi Diabo, Va Xi Aten Ha Ra, Aten Ha Ra |

> **Records are stored locally in `%APPDATA%\Basketweaver\leaderboard.json`.**
> Up to 100 records per mob name are kept, ranked by total DPS. History persists
> between sessions.

---

## 11. Keyboard Shortcuts

These work when the Basketweaver window is in focus (click it once).

| Key | Action |
|---|---|
| `↑` / `↓` | Interval +0.25s / −0.25s |
| `H` | Toggle orientation (horizontal ↔ vertical) |
| `R` | Reset track (same as tray Reset Track) |
| `M` | Toggle audio mute |
| `Space` | Dismiss grade screen |
| `Escape` | Quit |

---

## 12. Troubleshooting

**Overlay doesn't show weave windows**
Weave windows only appear once you enter combat. Make sure logging is
enabled (`/log on`) and the correct log file is selected. The header
shows IDLE when no combat is detected.

**"No log file selected" message on the overlay**
No log file has been selected yet. Right-click the tray icon and choose
**Select Log File…**, or enable **Auto-detect Active Log** in Settings to
have Basketweaver find it automatically.

**"Log not updating" message on the overlay**
The selected log file has not received new events in over 60 seconds.
Check that EverQuest is running and that logging is enabled (`/log on`).
The message clears automatically as soon as new events arrive.

**Interval seems wrong after zoning or getting a haste buff**
Press `↑` or `↓` to nudge the interval, or run `/mystats` to let
Basketweaver re-sync automatically.

**Weaves land but are consistently late/early by the same amount**
Use **Target Offset** or **Latency Comp.** in Settings.
Start with 25 ms steps and adjust until the hit zone flashes gold
reliably at the moment you click swap.

**The track gets out of sync mid-fight**
Press `R` or use tray → **Reset Track** to hard-reset the engine
without closing the app.

**Grade screen doesn't appear after a kill**
The grade screen fires when your current target dies — either `You have slain TARGET`
or `TARGET has been slain by X` — provided you attacked that target within the
last 10 seconds. It also fires when you die. Zone and logout end combat silently
with no grade screen.

**Mainhand miss audio not playing after switching weapons**
Basketweaver updates its attack-verb patterns automatically when a weapon
preset is detected via `/mystats`. If you swap to a slash or pierce weapon
mid-session without running `/mystats`, the patterns may not have updated
yet. Run `/mystats` to trigger re-detection.

**Out-of-range alert sound keeps playing**
The two-tone blip plays at most once every 1.5 seconds while you are in
combat and out of range. It stops as soon as your mainhand connects again.
If it fires outside of combat, check that your `COMBAT_END` patterns
match your server's death/zone messages.

**Audio not playing**
Click the overlay window once to focus it, then press `M` to toggle
audio. You can also toggle via tray → **Audio** or Settings → **Audio Enabled**.

**App asks for a log file every time**
If the previously saved log file is deleted or moved, the picker will
open on launch. Select the new path and it will be remembered. Enable
**Auto-detect Active Log** in Settings to avoid manual selection when
switching characters.

**Hybrid mode shows no events from Zeal**
- Confirm Zeal is loaded in EverQuest (`/zeal` should respond in-game).
- Both Basketweaver and EQ must be running on the same machine — pipes
  are local-only.
- Basketweaver scans for `eqgame.exe` every 2 seconds after switching to
  Hybrid mode. If EQ was started after Basketweaver, wait a moment or
  use tray → **Reset Track** to nudge the connection attempt.
- If EQ crashes or exits, Basketweaver detects the pipe closing and will
  reconnect automatically when EQ relaunches.

**Switched to Hybrid but weave windows stopped**
The Zeal plugin must be actively loaded. If you zoned or camped and Zeal
unloaded, it will stop sending pipe data. Reload Zeal in-game and
Basketweaver will reconnect within 2 seconds. Log-based events continue
in the meantime.

**Recent Fights submenu always shows "No fights recorded yet"**
Fight history is recorded after each combat engagement ends (mob death or player
death). If it is empty, no fights have completed since the app launched.

**Leaderboard shows no records**
Records are only saved after a fight completes (mob or player death).
If you have completed fights and still see nothing, check that
`%APPDATA%\Basketweaver\leaderboard.json` exists and is readable.

**Kill record was not uploaded to the community board**
Only the approved raid boss mobs are uploaded (see [Section 10](#10-leaderboard)
for the full list). All other kills are saved locally only. Also confirm that
your character name has been identified — check the header of the overlay or
the Character Name field in Settings → Leaderboard.

---

*Basketweaver — designed with monks in mind, built to scale.*

# Basketweaver — User Manual

Basketweaver is a real-time timing overlay for EverQuest fistweaving monks.
It draws a scrolling highway showing exactly when to swap to your fist weapon
so your offhand round lands without clipping your mainhand swing timer.

Combat events can be read two ways: from your **EQ log file** (default), or
directly from the game via a **Zeal named pipe** if you are running the Zeal
client plugin. Both modes produce identical overlays — the difference is only
in how data reaches Basketweaver.

---

## Table of Contents

1. [How It Works](#1-how-it-works)
2. [Core Concepts & Definitions](#2-core-concepts--definitions)
3. [First-Time Setup](#3-first-time-setup)
4. [Zeal Pipe Tracking](#4-zeal-pipe-tracking)
5. [Understanding the Overlay](#5-understanding-the-overlay)
6. [Timing Your Weaves](#6-timing-your-weaves)
7. [Calibration](#7-calibration)
8. [Tray Menu Reference](#8-tray-menu-reference)
9. [Keyboard Shortcuts](#9-keyboard-shortcuts)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. How It Works

### The Fistweaving Technique

EverQuest monks deal their highest damage by wielding a slow, high-damage staff
in their primary slot and briefly equipping a fast fist weapon in their secondary
slot between mainhand swings. Each weapon fires on its own independent timer, so
a precisely timed fist weave adds a full extra attack without interfering with the
staff swing.

The challenge is timing: if you swap to the fist weapon too late — after your
mainhand timer has already reset — the fist timer will collide with the mainhand
timer and delay your next crush. This is called a **clip**, and it costs more DPS
than not weaving at all.

### What Basketweaver Does

Basketweaver watches every mainhand crush in real time and calculates exactly when
your next swing will fire. It draws a scrolling **highway** overlay on top of
EverQuest with a **green weave window** that shows the safe zone for your fist
swap. The window approaches a fixed **hit zone** at the left of the highway — when
the window reaches the hit zone, swap to your fist weapon.

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
        └─── Zeal named pipe (\\.\pipe\zeal_PID)  ← Zeal Pipe mode
                  │
             Basketweaver connects via TCP socket

Both paths converge here:
        │
        ▼
   Event parser  (detects crush hits/misses, fist attacks, haste, death)
        │
        ▼
   Rhythm engine  (measures swing intervals, places weave windows, scores attempts)
        │
        ▼
   Canvas overlay  (draws highway, hit zone, banners, grade screen at 60 fps)
```

### Interval Measurement & Auto-Calibration

Basketweaver does not rely solely on your configured weapon delay. After each
mainhand crush, it measures the actual elapsed time since the previous crush and
maintains a rolling median of the last 6 measurements. When the measured median
drifts more than 50 ms from the current interval, the overlay silently adjusts
and shows a brief **Auto-calibrated** banner.

Calibration samples are filtered: any gap larger than 130% of the unhasted weapon
delay is discarded as a skipped swing (out of range, interrupted, etc.) and does
not pollute the median.

### Grading

At the end of each fight, Basketweaver grades your performance based on the
fraction of mainhand rounds in which you made a fist weave attempt. By default
grading uses log-detected fist events. If you prefer to grade by keystrokes (so
proc failures and dual-wield misses do not penalise you), enable **Keystroke
Grading** in the tray menu.

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
**Mainhand Delay**.

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
means a narrower safe weave window. Set via tray → **Offhand Delay** or
set via tray → **Offhand Delay**.

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
swap to your fist weapon. The hit zone position can be moved left or right via tray
→ **Target Position** (cosmetic only — timing is not affected).

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
A complete mainhand swing cycle — from one crush (or miss) to the next. Basketweaver
clusters rapid successive mainhand events within a 500 ms window into the same round
to handle dual-wield proc firings.

**Reaction time**
The delay between your mainhand crush landing and your first fist attempt in that
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

### Set Your Mainhand Weapon
Right-click the tray icon → **Mainhand Delay** → select your weapon.

| Weapon | Delay |
|---|---|
| Imbued Fighter's Staff | 4.0s |
| Ton Po's Bo Stick of Understanding | 4.0s |
| Bo Staff of Trorsmang | 3.5s |
| Abashi's Rod of Disillusionment | 3.0s |
| Caen's Bo Staff of Fury | 3.0s |
| Tranquil Staff | 3.0s |

### Set Your Offhand (Fist) Weapon Delay
Right-click the tray icon → **Offhand Delay** → select the delay that matches
your fist weapon. Default is 1.6s (delay 16 — standard monk fists).

> **Tip:** Use the `/mystats` calibration macro to auto-detect this.
> See [Section 8](#8-auto-detection-with-mystats).

---

## 4. Zeal Pipe Tracking

**Zeal** is a client plugin for EverQuest (TAKP / Project Quarm and similar
servers) that exposes real-time game data through Windows named pipes. When
Zeal is running alongside EQ, Basketweaver can read combat messages directly
from the game process instead of parsing the log file.

### Why Use Zeal Pipe Instead of the Log?

| | Log File | Zeal Pipe |
|---|---|---|
| **Latency** | Bounded by how often EQ flushes the log to disk | Near-instant — events arrive as they fire in-game |
| **Setup** | Requires logging on (`/log on`) | No log file needed |
| **Log required?** | Yes | No |
| **Auto-connects** | No — you select a file | Yes — detects EQ automatically |
| **Multiple EQ sessions** | One log file at a time | Connects to all running EQ processes |

### Requirements

- The **Zeal plugin** must be installed and loaded in EverQuest.
  Zeal creates a named pipe (`\\.\pipe\zeal_<PID>`) for each running
  EQ process automatically — no extra configuration is needed.
- Basketweaver and EverQuest must be running on the same machine.

### Enabling Zeal Pipe Tracking

Right-click the tray icon → **Tracking Source** → **Zeal Pipe**.

Basketweaver immediately stops tailing any open log file and begins scanning
for `eqgame.exe` processes every 2 seconds. Once it finds one, it connects
to the Zeal pipe and starts receiving events. A log entry appears in the
console confirming the connection:

```
[ZealReader] Connected to pipe for PID 12345
```

The overlay behaves identically to log-based mode — swing detection, haste
sync, weapon detection, and `/mystats` calibration all work the same way
because the text content coming through the pipe is the same combat text that
would appear in your log file.

### Switching Back to Log Tracking

Right-click the tray icon → **Tracking Source** → **Log File (default)**.

If you had a log file selected before switching to Zeal, Basketweaver resumes
tailing it automatically. If not, it will wait for you to select one via
tray → **Select Log File…**.

### How It Works (technical)

Zeal writes JSON messages to its named pipe in the format:

```json
{"type": 0, "character": "Yourname", "data": "{\"type\": 265, \"text\": \"You crush a goblin for 42 points of damage.\"}"}
```

The outer `type` field is the message category (`0` = log text, `2` = gauges,
`3` = labels, etc.). Basketweaver only processes log text messages. The inner
`type` field is EverQuest's internal channel code, and `text` is the combat
line — identical to what would be written to your log file, but without the
`[Day Mon DD HH:MM:SS YYYY]` timestamp prefix.

Basketweaver applies the same pattern matching it uses for log parsing, so
mainhand crush events, fist attacks, out-of-range messages, target deaths,
and `/mystats` calibration output are all detected exactly as they are in
log mode.

---

## 5. Understanding the Overlay

The overlay is a scrolling "highway" that sits on top of EverQuest.
Weave windows approach from the right and travel left toward the hit zone.
The default style is **Refined**; two alternate styles are available via tray →
**Overlay Style**.

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
├─────────────────────────────────────────────────────────────────┤
│  WEAVES 12  ·  NET DPS 245  ·  WEAVED DPS +148                 │ ← Footer
└─────────────────────────────────────────────────────────────────┘
```

### Elements

**║ Hit Zone** (gold vertical bar, left side)
This is your timing target. Weave actions are judged here.

**[===GREEN BOX===]** (green rectangle)
The safe weave window. This is the time between your mainhand swings
during which it is safe to initiate a fist weave. Width =
`mainhand interval − fist weapon delay`. Swap weapons while this
box is at the hit zone.

**│ Orange Bar** (thin vertical line at left edge of green box)
Marks the exact moment your mainhand will swing next. When the orange bar
reaches the hit zone, your mainhand fires. Do **not** initiate a weave
after this point — you won't have time before the next swing.

**CURSOR! warning**
If you try to swap weapons while holding an item on your cursor, EQ will
block the swap. Basketweaver detects this, shows a **CURSOR!** banner,
and plays an error sound so you know to clear your cursor immediately.

### Footer Stats

| Stat | Description |
|---|---|
| **WEAVES** | Number of mainhand rounds where a fist weave was attempted |
| **NET DPS** | Total melee DPS for the fight (mainhand + fist + procs) |
| **WEAVED DPS** | DPS contributed specifically by fist weave attacks |

### Overlay Styles

Three visual styles are available via tray → **Overlay Style**:

| Style | Description |
|---|---|
| **Refined** (default) | Dark arcade look — gold bar hit zone, green weave windows, subtle grid |
| **Standard** | Original design — blue dot notes, circular hit zone, swing bar |
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

 Step 2: GREEN BOX IS AT HIT ZONE — SWAP TO FIST NOW ✓
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
- **Avg reaction** is the average time from your mainhand crush to the first fist
  attack in that round — measured per round, one sample per round.

Press **Space** to dismiss.

### Fight History (Standard style only)

When using the **Standard** overlay style, fight results are tracked and
sent to the tray. Open tray → **Recent Fights** to view the last 5 results.
Click any entry to copy it to the clipboard — useful for sharing parse
results in Discord or guild chat.

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

Right-click tray icon → **Interval** → select the seconds value that
matches your current haste.

You can also use the arrow keys while the overlay is focused:
- `↑` — increase interval by 0.25s
- `↓` — decrease interval by 0.25s

### If Weaves Feel Early (green box arrives too soon)

Increase **Target Offset** (shifts the hit zone timing later):

Right-click tray → **Target Offset** → try 25 ms, 50 ms steps

Or with the keyboard (Standard style only):
`]` — add 25 ms offset
`[` — remove 25 ms offset

### If Weaves Feel Late (you're always catching the tail of the green box)

Decrease Target Offset back toward 0, or adjust **Latency Comp.**
if your network adds delay between when you act and when EQ registers it:

Right-click tray → **Latency Comp.** → try 25–75 ms

Keyboard (Standard style only):
`'` — add 25 ms latency comp
`;` — remove 25 ms latency comp

### Calibration Quick Reference

| Symptom | Fix |
|---|---|
| Green box arrives too early, weaves clip | Increase Latency Comp. |
| Green box arrives too late, mainhand delays | Decrease Latency Comp. |
| Notes never reach hit zone | Check your log file is updating (logging on?) |
| Windows don't appear | Enter combat — windows only show during active fighting |
| Interval wrong after buff / zone | Use `↑` / `↓` keys or set Interval in tray |

---

## 8. Tray Menu Reference

Right-click the Basketweaver icon in the system tray to open the menu.

| Option | Description |
|---|---|
| **Status** | Shows IN COMBAT or IDLE (read-only) |
| **Select Log File…** | Choose a different EQ log file |
| **Reset Track** | Hard reset — clears all state if overlay gets out of sync |
| **Recent Fights** | Last 5 fight results; click any entry to copy it to clipboard |
| **Target Position** | Move the hit zone left or right on the highway |
| **Reset Window Position** | Snap overlay to a safe central position on the primary monitor |
| **Mainhand Delay** | Select your mainhand weapon from the preset list |
| **Offhand Delay** | Set your fist weapon delay manually |
| **Interval** | Override the post-haste swing interval |
| **Target Offset** | Fine-tune hit zone timing (ms) |
| **Latency Comp.** | Compensate for network/input delay (ms) |
| **Clip Window** | How long after a weave to suppress duplicate detections |
| **Audio** | Toggle all sounds on / off |
| **Orientation** | Switch between horizontal and vertical highway layouts |
| **Overlay Style** | Choose Refined (default), Standard, or High Contrast |
| **Lane Lines** | Show or hide the outer lane dividers on the highway |
| **Fist Sound on Miss** | Play a whiff sound when a round's swings all miss |
| **Keystroke Grading** | Grade weaves by keystrokes rather than log-detected fist attacks |
| **Opacity** | Overlay transparency (50% / 70% / 85% / 100%) |
| **Tracking Source** | Switch between **Log File** (default) and **Zeal Pipe** event tracking |
| **Quit Basketweaver** | Exit the app |

> **Note:** Changing **Overlay Style** reloads the renderer. Your log
> file reconnects automatically; other settings are preserved.

---

## 9. Keyboard Shortcuts

These work when the Basketweaver window is in focus (click it once).

### All Styles

| Key | Action |
|---|---|
| `↑` / `↓` | Interval +0.25s / −0.25s |
| `H` | Toggle orientation (horizontal ↔ vertical) |
| `R` | Reset track (same as tray Reset Track) |
| `M` | Toggle audio mute |
| `Space` | Dismiss grade screen |
| `Escape` | Quit |

### Standard Style Only

| Key | Action |
|---|---|
| `]` / `[` | Target Offset +25ms / −25ms |
| `'` / `;` | Latency Comp. +25ms / −25ms |
| `,` / `.` | Shift hit zone visually left / right (no timing effect) |
| `V` | Copy fight history to clipboard |

---

## 10. Troubleshooting

**Overlay doesn't show weave windows**
Weave windows only appear once you enter combat. Make sure logging is
enabled (`/log on`) and the correct log file is selected. The header
shows IDLE when no combat is detected.

**Interval seems wrong after zoning or getting a haste buff**
Press `↑` or `↓` to nudge the interval, or run `/mystats` to let
Basketweaver re-sync automatically.

**Weaves land but are consistently late/early by the same amount**
Use **Target Offset** or **Latency Comp.** in the tray menu.
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

**Out-of-range alert sound keeps playing**
The two-tone blip plays at most once every 1.5 seconds while you are in
combat and out of range. It stops as soon as your mainhand connects again.
If it fires outside of combat, check that your `COMBAT_END` patterns
match your server's death/zone messages.

**Audio not playing**
Click the overlay window once to focus it, then press `M` to toggle
audio. You can also toggle via tray → **Audio**.

**App asks for a log file every time**
If the previously saved log file is deleted or moved, the picker will
open on launch. Select the new path and it will be remembered. If you
use Zeal Pipe mode, no log file is needed — switch via tray →
**Tracking Source** → **Zeal Pipe** and the prompt will not appear on
subsequent launches.

**Zeal Pipe mode shows no events**
- Confirm Zeal is loaded in EverQuest (`/zeal` should respond in-game).
- Both Basketweaver and EQ must be running on the same machine — pipes
  are local-only.
- Basketweaver scans for `eqgame.exe` every 2 seconds after switching to
  Zeal mode. If EQ was started after Basketweaver, wait a moment or
  use tray → **Reset Track** to nudge the connection attempt.
- If EQ crashes or exits, Basketweaver detects the pipe closing and will
  reconnect automatically when EQ relaunches.

**Switched to Zeal Pipe but weave windows stopped**
The Zeal plugin must be actively loaded. If you zoned or camped and Zeal
unloaded, it will stop sending pipe data. Reload Zeal in-game and
Basketweaver will reconnect within 2 seconds.

**Recent Fights submenu always shows "No fights recorded yet"**
Fight history tracking is only active when using the **Standard** overlay
style. Switch to Standard via tray → **Overlay Style** if you need the
fight history submenu populated.

---

*Basketweaver — built for monks, by monks.*

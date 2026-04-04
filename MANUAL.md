# Basketweaver — User Manual

Basketweaver is a real-time timing overlay for EverQuest fistweaving monks.
It reads your EQ log file and draws a scrolling highway showing exactly when
to swap to your fist weapon so your offhand round lands without clipping your
mainhand swing timer.

---

## Table of Contents

1. [First-Time Setup](#1-first-time-setup)
2. [Understanding the Overlay](#2-understanding-the-overlay)
3. [Timing Your Weaves](#3-timing-your-weaves)
4. [Calibration](#4-calibration)
5. [Auto-Detection with /mystats](#5-auto-detection-with-mystats)
6. [Tray Menu Reference](#6-tray-menu-reference)
7. [Keyboard Shortcuts](#7-keyboard-shortcuts)
8. [Troubleshooting](#8-troubleshooting)

---

## 1. First-Time Setup

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

Basketweaver remembers your log file between sessions.

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
> See [Section 5](#5-auto-detection-with-mystats).

---

## 2. Understanding the Overlay

The overlay is a scrolling "highway" that sits on top of EverQuest.
Notes approach from the right and travel left toward the hit zone.

```
┌─────────────────────────────────────────────────────────────────┐
│ Gabbiz                                              2.0s  100%  │ ← Header
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ◉  ·  ·  ·  ·  ·  ·  [====GREEN BOX====]│  ·  ·  ●  ·  ·  · │ ← Highway
│                                           │                     │
│  ↑                    ← notes travel ←   ↑          ↑          │
│ Hit Zone                              Orange Bar   Blue Dot     │
│                                       (mainhand    (next weave) │
│                                        swing)                   │
├─────────────────────────────────────────────────────────────────┤
│  Score: 850   Combo x3   Acc: 87%                               │ ← Footer
└─────────────────────────────────────────────────────────────────┘
```

### Elements

**◉ Hit Zone** (gold circle, left side)
This is your timing target. Weave actions are judged here.

**● Blue Dot** (note)
Each blue dot represents one upcoming weave opportunity.
It travels left along the highway and should reach the hit zone
while the green box is overlapping it.

**[===GREEN BOX===]** (green rectangle)
The safe weave window. This is the time between your mainhand swings
during which it is safe to initiate a fist weave. Width =
`mainhand interval − fist weapon delay`. Swap weapons while this
box is at the hit zone.

**│ Orange Bar** (thin vertical line at left edge of green box)
Marks the exact moment your mainhand will swing next. When the orange bar
reaches the hit zone, your mainhand fires. Do **not** initiate a weave
after this point — you won't have time before the next swing.

---

## 3. Timing Your Weaves

### The Core Loop

```
                        Time flows this way →→→→→→→→
                        Notes scroll this way ←←←←←←

 ──────────────────────────────────────────────────────────────────
  PAST       Hit Zone          Highway                     FUTURE
 ──────────────────────────────────────────────────────────────────

 Step 1: Green box approaching hit zone
 ·  ·  ·  ◉  ·  ·  ·  ·  ·  [====GREEN====]│  ·  ●  ·  ·  ·  ·

 Step 2: GREEN BOX IS AT HIT ZONE — SWAP TO FIST NOW ✓
 ·  ·  ·  [=◉=============]│  ·  ·  ●  ·  ·  ·  ·  ·  ·  ·  ·

 Step 3: Orange bar arrives — mainhand swings, window closes
 ·  ·  ·  ·  ·  ·  ·  ·  ·  │◉  ·  ·  ·  [====GREEN====]│  ·  ·
```

### What Good Timing Looks Like

When your fist punch lands inside the green window, the hit zone
bursts into a **gold explosion** and you hear the punch sound.

```
  PERFECT WEAVE
  ·  ·  [===◉===]│  ·  ·     ← Note hits hit zone inside green box
               ✦✦✦✦✦           Gold explosion fires
```

### What a Miss Looks Like

If the dual-wield check fails or your weave lands outside the window,
small **grey drops** fall from the hit zone.

```
  MISSED / FAILED
  ·  ·  ·  ·  ◉  ·  ·  ·    ← Note passes hit zone, no weave
              ·  .            Grey drops fall
             .    .
```

### End-of-Fight Grade Screen

When the mob dies, the overlay shows your performance for that fight:

```
  ┌────────────────────────────┐
  │           S                │  ← Letter grade (S / A / B / C / D / F)
  │        96.3%               │  ← Weave accuracy
  │    Avg React: 142 ms       │  ← Average time from swing to your weave
  │    Combo x12               │  ← Longest hit streak
  │    Score: 2840             │
  └────────────────────────────┘
```

Press **Space** or click to dismiss.

---

## 4. Calibration

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

Or with the keyboard while overlay is focused:
`]` — add 25 ms offset
`[` — remove 25 ms offset

### If Weaves Feel Late (you're always catching the tail of the green box)

Decrease Target Offset back toward 0, or adjust **Latency Comp.**
if your network adds delay between when you act and when EQ registers it:

Right-click tray → **Latency Comp.** → try 25–75 ms

Keyboard:
`'` — add 25 ms latency comp
`;` — remove 25 ms latency comp

### Calibration Quick Reference

| Symptom | Fix |
|---|---|
| Green box arrives too early, weaves clip | Increase Latency Comp. |
| Green box arrives too late, mainhand delays | Decrease Latency Comp. |
| Notes never reach hit zone | Check your log file is updating (logging on?) |
| Bars don't appear | Enter combat — bars only show during active fighting |
| Interval wrong after buff / zone | Use `↑` / `↓` keys or set Interval in tray |

---

## 5. Auto-Detection with /mystats

Basketweaver can read your offhand weapon delay automatically from a
**calibration macro** output. This is the most accurate way to set your
fist delay and requires no manual guessing.

### Step 1 — Create the Calibration Macro

In EverQuest, create a social button with the following command:

```
/mystats
```

### Step 2 — Use It In Combat

After fighting with your fist weapon for at least 30–60 seconds
(to build up DPS statistics), press the macro button.

Your log will contain output like:

```
---- Melee Primary: HandToHand ----
---- Melee Secondary: Fangs of Vyzh'dra the Exiled ----
Dmg = 1 to 47, ave = 23.4
DPS = 6.2 to 14.8, ave = 12.3
```

### Step 3 — Auto-Detection Fires

Basketweaver reads this output and calculates the weapon delay from
the damage/DPS ratio. A banner appears:

```
  Offhand: Fangs of Vyzh'dra  (delay 19 → 1.9s)
```

The offhand delay and weapon name are saved automatically and persist
across sessions. The green weave window will immediately resize to match.

> **Note:** The macro must be run while you have HandToHand as your
> **primary** weapon stat. If you have a 2H or other primary equipped,
> the secondary detection will not fire.

---

## 6. Tray Menu Reference

Right-click the Basketweaver icon in the system tray to open the menu.

| Option | Description |
|---|---|
| **Status** | Shows IN COMBAT or IDLE (read-only) |
| **Select Log File…** | Choose a different EQ log file |
| **Reset Track** | Hard reset — clears all state if overlay gets out of sync |
| **Window Size** | Scale overlay to 25% / 50% / 75% / 100% |
| **Target Position** | Move hit zone left/right on the highway |
| **Mainhand Delay** | Select your mainhand weapon |
| **Offhand Delay** | Set your fist weapon delay manually |
| **Interval** | Override the post-haste swing interval |
| **Target Offset** | Fine-tune hit zone timing (ms) |
| **Latency Comp.** | Compensate for network/input delay (ms) |
| **Clip Window** | How long after a weave to suppress duplicate detections |
| **Audio** | Toggle all sounds on / off |
| **Opacity** | Overlay transparency |
| **Quit Basketweaver** | Exit the app |

---

## 7. Keyboard Shortcuts

These work when the Basketweaver window is in focus (click it once).

| Key | Action |
|---|---|
| `↑` / `↓` | Interval +0.25s / −0.25s |
| `]` / `[` | Target Offset +25ms / −25ms |
| `'` / `;` | Latency Comp. +25ms / −25ms |
| `,` / `.` | Shift hit zone visually left / right |
| `R` | Reset track (same as tray Reset Track) |
| `M` | Toggle audio mute |
| `Space` | Dismiss grade screen |
| `Escape` | Quit |

---

## 8. Troubleshooting

**Overlay doesn't show bars**
Bars only appear once you enter combat. Make sure logging is enabled
(`/log on`) and the correct log file is selected. The header shows IDLE
when no combat is detected.

**Interval seems wrong after zoning or getting a haste buff**
Press `↑` or `↓` to nudge the interval, or run `/mystats` to let
Basketweaver re-sync automatically.

**Weaves land but are consistently late/early by the same amount**
Use **Target Offset** or **Latency Comp.** in the tray menu.
Start with 25 ms steps and adjust until the gold explosion fires
reliably at the moment you click swap.

**The track gets out of sync mid-fight**
Press `R` or use tray → **Reset Track** to hard-reset the engine
without closing the app.

**Grade screen doesn't appear after a kill**
The grade screen only fires when the mob you were fighting dies
(`You have slain` / `has been slain`). It does not fire if you zone,
die, or log out mid-fight.

**Audio not playing**
Click the overlay window once to focus it, then press `M` to toggle
audio. You can also toggle via tray → **Audio**.

**App asks for a log file every time**
If the previously saved log file is deleted or moved, the picker will
open on launch. Select the new path and it will be remembered.

---

*Basketweaver — built for monks, by monks.*

# ZealPipes — Design Document

**Author:** OkieDan
**Version:** 0.0.2
**License:** MIT

---

## Overview

ZealPipes is a .NET library that reads real-time game data from **EverQuest** (EQ) via Windows named pipes. It bridges the gap between the Zeal EQ plugin (which creates the pipes) and any .NET application that wants to consume live character data, combat events, or raid information.

Typical use cases include:
- Character HUD overlays and dashboards
- Raid management and roster tools
- Mana/HP tracking with audio feedback
- Combat log parsers

---

## Solution Structure

```
ZealPipes.sln
├── ZealPipes.Common/         # Shared types, enums, and models (netstandard2.0)
├── ZealPipes.Services/       # Core pipe reading and event service (netstandard2.0)
├── ZealPipes.ClientApp/      # Demo console application (.NET Framework 4.8)
└── ZealPipes.ServerTickClient/  # Mana tick audio notifier (.NET Framework 4.8)
```

The two library projects target `netstandard2.0` for broad compatibility. The two client apps target `.NET Framework 4.8` and depend on both libraries.

---

## Architecture

### High-Level Data Flow

```
EverQuest (eqgame.exe)
        │  Zeal plugin creates a named pipe per process
        ▼
\\.\pipe\zeal_<PID>   (Windows Named Pipe)
        │
        ▼
ProcessMonitor  ──── polls every 500ms for new eqgame.exe PIDs
        │  OnNewProcessFound
        ▼
ZealPipeReader  ──── async reads raw bytes from the pipe
        │
        ▼
JsonSplitter  ──── buffers partial data, emits complete JSON objects
        │
        ▼
ZealMessageService  ──── deserializes JSON into typed messages,
        │               aggregates gauge/label/player data per character
        │
        ├── OnLogMessageReceived
        ├── OnLabelMessageReceived
        ├── OnGaugeMessageReceived
        ├── OnPlayerMessageReceived
        ├── OnPipeCmdMessageReceived
        ├── OnRaidMessageReceived
        └── OnCharacterUpdated
                │
                ▼
        Application code (ClientApp, ServerTickClient, etc.)
```

---

## Projects in Detail

### ZealPipes.Common

Shared types consumed by both the service library and application code.

#### ZealSettings

Configuration for the service. Can be loaded from `appsettings.json` or instantiated directly.

| Property | Default | Description |
|---|---|---|
| `EqProcessName` | `"eqgame"` | Name of the EQ process to monitor |
| `PipePrefix` | `"zeal"` | Prefix of the named pipe (`zeal_<PID>`) |
| `BufferSize` | `32768` | Byte buffer for each pipe read |

#### Enums

- **`PipeMessageType`** — The six message categories: `LogText`, `Label`, `Gauge`, `Player`, `PipeCmd`, `Raid`
- **`GaugeType`** — Numeric gauges exposed by EQ: HP, Mana, Stamina, Experience, group member HP, pet gauges, etc.
- **`LabelType`** — String/numeric character attributes: Name, Level, Class, Zone, Stats (STR/STA/INT/…), current buff list, spell gems, etc.
- **`LogType`** — 256+ chat and combat log categories (say, shout, group, guild, combat hits, spells, etc.)
- **`RaidRank`** — `RaidMember`, `GroupLeader`, `RaidLeader`
- **`ClassTypes`** — The 16 playable EQ classes plus NPC

#### Models

| Class | Description |
|---|---|
| `GaugeMessage` | Array of `(GaugeType, Value)` pairs for a character |
| `LabelMessage` | Array of `(LabelType, Value)` string pairs for a character |
| `LogMessage` | Single chat/combat text entry with a `LogType` |
| `PlayerMessage` | World position: `X`, `Y`, `Z`, `ZoneId`, `Heading` |
| `PipeCmdMessage` | Custom command string from Zeal |
| `RaidMessage` | Raid roster entry: Name, Class, Group, Level, Rank |
| `ZealCharacter` | Aggregate of all data for one character; contains a `Detail` object that holds the latest `GaugeData`, `LabelData`, `PlayerData`, and `RaidData` |

---

### ZealPipes.Services

The core library. Consumers only need to interact with `ZealMessageService`.

#### ZealMessageService

The public entry point. Wires together `ProcessMonitor` and `ZealPipeReader`, maintains the character list, and fires events.

**Public API:**

```csharp
// Start monitoring EQ processes and reading pipes
void StartProcessing();

// Stop all monitoring and disconnect from pipes
void StopProcessing();

// Events
event EventHandler<LogMessageReceivedEventArgs>     OnLogMessageReceived;
event EventHandler<LabelMessageReceivedEventArgs>   OnLabelMessageReceived;
event EventHandler<GaugeMessageReceivedEventArgs>   OnGaugeMessageReceived;
event EventHandler<PlayerMessageReceivedEventArgs>  OnPlayerMessageReceived;
event EventHandler<PipeCmdMessageReceivedEventArgs> OnPipeCmdMessageReceived;
event EventHandler<RaidMessageReceivedEventArgs>    OnRaidMessageReceived;
event EventHandler<CharacterUpdatedEventArgs>       OnCharacterUpdated;
```

**`OnCharacterUpdated`** fires whenever a `PlayerMessage` arrives. At that point, `ZealCharacter.Detail` holds a coherent snapshot of the character's gauges, labels, and position, so it acts as a natural "frame complete" trigger.

#### ProcessMonitor

- Runs a background thread that calls `Process.GetProcessesByName()` every 500ms.
- Maintains a set of already-seen PIDs to detect only new processes.
- Fires `OnNewProcessFound` with the PID, prompting `ZealMessageService` to spin up a `ZealPipeReader` for that process.

#### ZealPipeReader

- Connects to `\\.\pipe\{PipePrefix}_{ProcessId}` (e.g., `\\.\pipe\zeal_1234`).
- Reads asynchronously in a loop using the configured `BufferSize`.
- Passes raw bytes to `JsonSplitter` to reconstruct complete JSON objects.
- Deserializes each object into a `PipeMessage` using `System.Text.Json`.
- **Backpressure handling:** if the internal buffer is more than half full, gauge and label messages are skipped to prevent the application from falling behind.
- Fires `OnPipeMessageReceived` for each complete message.

#### JsonSplitter

- Maintains a rolling string buffer of unprocessed bytes.
- Splits on the boundary between consecutive JSON objects using the regex `(?<=\})\s*(?=\{)`.
- Returns all complete objects found in the current buffer, holding any trailing partial object for the next read.

#### PipeMessage (internal model)

Raw deserialized pipe packet:

| Property | Type | Description |
|---|---|---|
| `Type` | `int` | Maps to `PipeMessageType` |
| `DataLen` | `uint` | Length of the `Data` payload |
| `Character` | `string` | Character name the message belongs to |
| `Data` | `string` | JSON payload for the specific message type |

---

### ZealPipes.ClientApp

A menu-driven console application demonstrating the full library API.

**Menu options:**

| Key | Mode | Description |
|---|---|---|
| 1 | Labels | Print each `LabelMessage` as it arrives |
| 2 | Gauges | Print each `GaugeMessage` as it arrives |
| 3 | Player | Print each `PlayerMessage` (position/zone) |
| 4 | Character | Print the full `ZealCharacter.Detail` on `OnCharacterUpdated` |
| 5 | UI | Render live progress-bar gauges (HP, Mana, Stamina, Experience) in-place |
| 6 | Chat Log | Print `LogMessage` entries |
| 7 | /Pipe | Print `PipeCmdMessage` entries |
| 8 | Raid | Print the raid roster on each `RaidMessage` |

**ZealConsoleUi** renders horizontal progress bars using block characters (`█`) and in-place console cursor positioning, allowing gauges to update without scrolling.

Uses Microsoft DI (`Microsoft.Extensions.DependencyInjection`) to wire up `ZealSettings`, `ProcessMonitor`, `ZealPipeReader`, and `ZealMessageService`.

---

### ZealPipes.ServerTickClient

A focused utility that monitors mana and plays audio feedback.

**Behavior:**
- Subscribes to `OnCharacterUpdated`.
- Extracts the current Mana% gauge from `ZealCharacter.Detail.GaugeData`.
- When mana increases (a "server tick" occurred), plays `tick.mp3` via **NAudio**.
- When mana reaches 100%, announces "Full Mana" via `System.Speech.Synthesis`.
- `+` / `-` keys adjust a configurable delay (0–6000 ms) applied before the notification.

---

## Integration Guide

### 1. Add dependencies

Reference `ZealPipes.Common` and `ZealPipes.Services` (or consume them as NuGet packages once published).

### 2. Configure settings

Either via `appsettings.json`:
```json
{
  "ApplicationSettings": {
    "Zeal": {
      "PipePrefix": "zeal",
      "BufferSize": "32768",
      "EqProcessName": "eqgame"
    }
  }
}
```

Or directly:
```csharp
var settings = new ZealSettings("eqgame", "zeal", 32768);
```

### 3. Wire up the service

```csharp
var processMonitor = new ProcessMonitor(settings);
var pipeReader     = new ZealPipeReader(settings);
var service        = new ZealMessageService(settings, processMonitor, pipeReader);
```

### 4. Subscribe to events

```csharp
service.OnCharacterUpdated += (sender, e) =>
{
    var character = e.ZealCharacter;
    var hpGauge = character.Detail.GaugeData
        .FirstOrDefault(g => g.Type == GaugeType.HP);
    Console.WriteLine($"{character.Name} HP: {hpGauge?.Value}%");
};

service.OnLogMessageReceived += (sender, e) =>
{
    Console.WriteLine($"[{e.LogMessage.Type}] {e.LogMessage.Text}");
};
```

### 5. Start and stop

```csharp
service.StartProcessing();
// ... run until done ...
service.StopProcessing();
```

---

## Threading Model

| Component | Thread |
|---|---|
| `ProcessMonitor` | Dedicated background thread, polls every 500ms |
| `ZealPipeReader` | Per-pipe async read loop (one per EQ process) |
| Event handlers | Called on the thread that completed the pipe read |

Event handlers should not block or perform long-running work on the calling thread. If UI or cross-thread work is needed, marshal back to the appropriate synchronization context.

---

## Key Design Decisions

**`OnCharacterUpdated` as a frame trigger** — Gauge and label messages arrive as partial arrays and may be fragmented. Rather than exposing a complex "all data arrived" signal, the service buffers fragments and fires `OnCharacterUpdated` when a `PlayerMessage` is received, treating it as the end of an update cycle.

**Backpressure by dropping gauge/label messages** — If the pipe read buffer is more than half consumed, non-critical messages (gauges and labels) are dropped rather than queued indefinitely. This keeps the application responsive at the cost of occasionally missing an intermediate value.

**`JsonSplitter` for stream reassembly** — Named pipes deliver data as byte streams, not message boundaries. Multiple JSON objects may arrive in a single read, or one object may span multiple reads. `JsonSplitter` handles both cases transparently.

**`netstandard2.0` for the library projects** — Maximises compatibility: the libraries can be consumed by .NET Framework, .NET Core, and .NET 5+ applications.

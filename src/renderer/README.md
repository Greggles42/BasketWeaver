# Basketweaver overlay styles — implementation

Two drop-in TypeScript overlay implementations matching the prototype
explorations in `Basketweaver Overlay.html`. Both follow the same
public API as the existing `Overlay` class in `src/renderer/overlay.ts`,
so they slot into your renderer with minimal changes.

## Files

- `overlay-refined.ts` → exports `RefinedOverlay`
- `overlay-highcontrast.ts` → exports `HighContrastOverlay`

## Install

1. Copy both files into `src/renderer/`.
2. In `src/renderer/main.ts`, import both and instantiate based on a
   user-selected style setting:

```ts
import { RefinedOverlay } from './overlay-refined'
import { HighContrastOverlay } from './overlay-highcontrast'
import { Config } from '../shared/config'

const canvas = document.getElementById('overlay') as HTMLCanvasElement
const style = Config.OVERLAY_STYLE ?? 'refined'   // 'refined' | 'highcontrast'

const overlay = style === 'highcontrast'
  ? new HighContrastOverlay(canvas)
  : new RefinedOverlay(canvas)

overlay.start()

window.electronAPI?.onGameEvent(ev => overlay.handleGameEvent(ev))
window.addEventListener('keydown', e => overlay.handleKey(e.key))
```

3. Add `OVERLAY_STYLE: 'refined' | 'highcontrast'` to `src/shared/config.ts`
   and surface a chooser in your tray/settings menu. On change, persist
   the value, then reload the renderer (or call `overlay = new …Overlay(canvas)`
   after destroying the old loop — easier to just reload).

## Public API parity

Both classes expose the same surface as the existing `Overlay`:

- `start(): void`
- `handleGameEvent(ev: GameEvent): void`
- `handleKey(key: string): void`
- `toggleOrientation(): void`
- `applyTargetPosition(pct: number): void`
- `toggleLaneLines(): void`
- `toggleFistMissSound(): void`
- `toggleHighContrast(): void` (no-op on HighContrastOverlay; preserved
  to keep tray/IPC handlers identical)
- `pinned: boolean`

All visual state (`hitFlash`, `missFlash`, `clipWarn`) is decayed in `update()`
and triggered by the same IPC events as the original class. Both consume
`RhythmEngine` directly, so timing, weave windows, miss detection, and
clip detection are unchanged.

## Behavior summary

### Soft miss (weave passed, unused)

- **Refined** — small grey `— missed` chip at the hit zone, fades in <0.5s. No red, no shake.
- **High Contrast** — small dark grey `— MISS` chip top-right of highway, fades.

### Hard CLIP (player swung through weave window)

- **Refined** — red wash over highway (~28% alpha), red strobe on the hit-zone bar, expanding red ring at the hit point, `CLIPPED` chip in red.
- **High Contrast** — red wash, red border replaces the white outline, hit zone turns red with chunky end caps, black-on-red `CLIPPED` chip.

Engine logic sits in `RhythmEngine.onFistAttack()`'s `isClip` return value
plus the existing `missCount` counter — no engine changes required.

## Notes

- Both files reference `Config`, `EvType`, `GameEvent`, `RhythmEngine`,
  `GradeResult`, and `AudioManager` from your existing modules without
  modification.
- The `weaveCount` and `liveTotalDps` / `liveDps` accessors on
  `RhythmEngine` are used by the footers; they exist in your engine.
- The Refined style uses `Inter` + `JetBrains Mono`. The High Contrast
  style uses `Archivo Narrow` + `Archivo`. Add Google Fonts links to
  `src/renderer/index.html` if not already present:

```html
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;800&family=Archivo+Narrow:wght@800&family=Inter:wght@500;600&family=JetBrains+Mono:wght@500;600;700&display=swap" rel="stylesheet">
```

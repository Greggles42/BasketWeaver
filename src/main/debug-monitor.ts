/**
 * Always-on, bounded ring buffer of classification decisions and anomalies.
 * Lives entirely in the main process — this is where nearly all classification
 * tracing and anomaly detection already happens (log-reader.ts, zeal-reader.ts,
 * index.ts). Renderer-detected anomalies (e.g. Swing Timer Mode,
 * audio failures) are forwarded here over IPC.DEBUG_LOG_EVENT.
 *
 * Purely additive: nothing here changes scoring/detection behavior. It exists
 * so a user having trouble can export a single file (Settings → Export Debug
 * Report) that explains *why* the app classified their log lines the way it
 * did, without needing a __DEV__ build.
 */

import type { DebugEntry, DebugEntryInput, DebugEntryLevel } from '../shared/debug-monitor-types'

class DebugMonitor {
  private buf: DebugEntry[] = []
  private readonly cap = 10_000

  record(entry: DebugEntryInput): void {
    this.buf.push({ ts: Date.now(), ...entry })
    if (this.buf.length > this.cap) this.buf.shift()
  }

  /** Classification trace — "why did this log line get classified this way." Always level 'debug'. */
  logClassify(category: string, message: string, data?: Record<string, unknown>): void {
    this.record({ kind: 'classify', level: 'debug', category, message, data })
  }

  /** A detected anomaly/incompatibility — bad config combo, failed detection, version mismatch, I/O failure. */
  logAnomaly(level: DebugEntryLevel, category: string, message: string, data?: Record<string, unknown>): void {
    this.record({ kind: 'anomaly', level, category, message, data })
  }

  getAll(): DebugEntry[] {
    return this.buf.slice()
  }

  clear(): void {
    this.buf = []
  }
}

export const debugMonitor = new DebugMonitor()

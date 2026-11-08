/**
 * Shared shape for the always-on debug ring buffer (src/main/debug-monitor.ts).
 * Renderer code reports entries over IPC.DEBUG_LOG_EVENT using this same shape
 * (minus `ts`, which the main-process buffer stamps on arrival).
 */

export type DebugEntryKind = 'classify' | 'anomaly'
export type DebugEntryLevel = 'debug' | 'warn' | 'error'

export interface DebugEntry {
  ts: number                 // epoch ms, Date.now()
  kind: DebugEntryKind
  level: DebugEntryLevel
  category: string           // e.g. 'mainhand' | 'riposte' | 'memory' | 'zeal-version' | 'audio' | 'swing-timer-mode'
  message: string
  data?: Record<string, unknown>
}

export type DebugEntryInput = Omit<DebugEntry, 'ts'>

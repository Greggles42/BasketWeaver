/**
 * Append-only text logging with a hard size cap that keeps the most recent data.
 *
 * When an append would push the file past MAX_LOG_BYTES, the oldest lines are
 * dropped so the file shrinks to TRIM_TO_BYTES (leaving headroom so trimming
 * happens once per ~10MB of logging, not on every write). The cut always lands on
 * a line boundary, so the file never starts mid-line.
 */

import * as fs from 'fs'

export const MAX_LOG_BYTES = 50 * 1024 * 1024
const TRIM_TO_BYTES = 40 * 1024 * 1024

// Size cache so the common path is a plain append with no stat() per write.
const knownSizes = new Map<string, number>()

function fileSize(filePath: string): number {
  try { return fs.statSync(filePath).size } catch { return 0 }
}

/** Rewrites the file to contain only (roughly) its last `keepBytes`, starting at a line boundary. Returns the new size. */
function trimToTail(filePath: string, keepBytes: number): number {
  const size = fileSize(filePath)
  if (size <= keepBytes) return size
  const fd = fs.openSync(filePath, 'r')
  let tail: Buffer
  try {
    tail = Buffer.alloc(keepBytes)
    fs.readSync(fd, tail, 0, keepBytes, size - keepBytes)
  } finally {
    fs.closeSync(fd)
  }
  const nl = tail.indexOf(0x0a)
  const kept = nl === -1 ? tail : tail.subarray(nl + 1)
  const tmp = `${filePath}.tmp`
  try {
    fs.writeFileSync(tmp, kept)
    fs.renameSync(tmp, filePath)   // atomic swap — a crash mid-trim can't lose the log
  } catch {
    // e.g. the file is open in an editor and can't be replaced — rewrite in place instead.
    try { fs.unlinkSync(tmp) } catch {}
    fs.writeFileSync(filePath, kept)
  }
  return kept.length
}

export function appendCappedLog(filePath: string, text: string): void {
  const add = Buffer.byteLength(text, 'utf8')
  let size = knownSizes.get(filePath) ?? fileSize(filePath)
  if (size + add > MAX_LOG_BYTES) size = trimToTail(filePath, TRIM_TO_BYTES)
  fs.appendFileSync(filePath, text, 'utf8')
  knownSizes.set(filePath, size + add)
}

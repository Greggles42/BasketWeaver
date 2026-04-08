/**
 * Audio synthesis using the Web Audio API.
 * Replaces numpy/pygame audio from audio_manager.py.
 *
 * All sounds are procedurally generated — no external files required.
 * schedule_tick() uses AudioContext.currentTime for precision scheduling,
 * equivalent to the Python spin-wait approach.
 */

import type { ConfigType } from '../shared/config'

export class AudioManager {
  private ctx: AudioContext | null = null
  enabled = true
  private tempMuted = false
  private cfg: ConfigType

  constructor(cfg: ConfigType) {
    this.cfg = cfg
  }

  private getCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext({ sampleRate: this.cfg.SAMPLE_RATE })
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }
    return this.ctx
  }

  // ── Sound synthesis helpers ───────────────────────────────────

  /** Create an AudioBuffer from a Float32Array of samples [-1, 1]. */
  private makeBuffer(samples: Float32Array): AudioBuffer {
    const ctx = this.getCtx()
    const buf = ctx.createBuffer(1, samples.length, this.cfg.SAMPLE_RATE)
    buf.copyToChannel(samples, 0)
    return buf
  }

  /** Apply a simple attack/release envelope in place. */
  private applyEnvelope(arr: Float32Array, attackSec = 0.005, releaseSec = 0.15): void {
    const sr  = this.cfg.SAMPLE_RATE
    const atk = Math.min(Math.floor(attackSec * sr), arr.length)
    const rel = Math.min(Math.floor(releaseSec * sr), arr.length)
    for (let i = 0; i < atk; i++) arr[i] *= i / atk
    for (let i = 0; i < rel; i++) arr[arr.length - 1 - i] *= i / rel
  }

  private sine(freq: number, durSec: number, vol: number): Float32Array {
    const sr  = this.cfg.SAMPLE_RATE
    const n   = Math.floor(durSec * sr)
    const out = new Float32Array(n)
    const twoPiF = 2 * Math.PI * freq / sr
    for (let i = 0; i < n; i++) out[i] = Math.sin(twoPiF * i) * vol
    return out
  }

  private add(...arrays: Float32Array[]): Float32Array {
    const n   = arrays[0].length
    const out = new Float32Array(n)
    for (const arr of arrays) {
      for (let i = 0; i < Math.min(n, arr.length); i++) out[i] += arr[i]
    }
    return out
  }

  // ── Sound constructors ────────────────────────────────────────

  private makeTick(): AudioBuffer {
    const sr  = this.cfg.SAMPLE_RATE
    const dur = 0.06
    const vol = this.cfg.TICK_VOLUME
    const n   = Math.floor(dur * sr)
    const out = new Float32Array(n)
    const twoPiF = 2 * Math.PI * 880 / sr
    for (let i = 0; i < n; i++) {
      out[i] = Math.sin(twoPiF * i) * Math.exp(-i / sr * 80) * vol
    }
    return this.makeBuffer(out)
  }

  private makePerfect(): AudioBuffer {
    const vol = this.cfg.FX_VOLUME
    const c5  = this.sine(523.25, 0.20, vol * 0.6)
    const e5  = this.sine(659.25, 0.20, vol * 0.5)
    const out = this.add(c5, e5)
    this.applyEnvelope(out, 0.003, 0.10)
    return this.makeBuffer(out)
  }

  private makeGood(): AudioBuffer {
    const out = this.sine(440.0, 0.14, this.cfg.FX_VOLUME)
    this.applyEnvelope(out, 0.005, 0.08)
    return this.makeBuffer(out)
  }

  private makeMiss(): AudioBuffer {
    const sr  = this.cfg.SAMPLE_RATE
    const dur = 0.14
    const vol = this.cfg.FX_VOLUME
    const n   = Math.floor(dur * sr)
    const out = new Float32Array(n)
    // Seeded pseudo-random noise (LCG to match deterministic Python behavior)
    let seed = 42
    for (let i = 0; i < n; i++) {
      seed = (1664525 * seed + 1013904223) & 0x7fffffff
      out[i] = ((seed / 0x3fffffff) - 1.0) * vol * 0.5
    }
    // Simple IIR low-pass
    for (let i = 1; i < n; i++) out[i] = 0.08 * out[i] + 0.92 * out[i - 1]
    this.applyEnvelope(out, 0.003, 0.07)
    return this.makeBuffer(out)
  }

  private makeCombatStart(): AudioBuffer {
    const sr  = this.cfg.SAMPLE_RATE
    const dur = 0.28
    const vol = this.cfg.FX_VOLUME
    const n   = Math.floor(dur * sr)
    const out = new Float32Array(n)
    let phase = 0
    for (let i = 0; i < n; i++) {
      const freq = 300 + (660 * i / n)       // linear sweep 300→960
      phase += 2 * Math.PI * freq / sr
      out[i] = Math.sin(phase) * vol
    }
    this.applyEnvelope(out, 0.005, 0.10)
    return this.makeBuffer(out)
  }

  private makeCrush(): AudioBuffer {
    const sr   = this.cfg.SAMPLE_RATE
    const dur  = 0.09
    const vol  = this.cfg.FX_VOLUME
    const n    = Math.floor(dur * sr)
    const crack = new Float32Array(n)
    const wood  = new Float32Array(n)
    const thump = new Float32Array(n)
    const noise = new Float32Array(n)
    const twoPi = 2 * Math.PI
    let seed = 3
    for (let i = 0; i < n; i++) {
      const t = i / sr
      crack[i] = Math.sin(twoPi * 2600 * t) * Math.exp(-t * 140) * vol * 0.65
      wood[i]  = Math.sin(twoPi * 800  * t) * Math.exp(-t * 60)  * vol * 0.45
      thump[i] = Math.sin(twoPi * 150  * t) * Math.exp(-t * 40)  * vol * 0.35
      seed = (1664525 * seed + 1013904223) & 0x7fffffff
      noise[i] = ((seed / 0x3fffffff) - 1.0) * Math.exp(-t * 250) * vol * 0.25
    }
    const out = this.add(crack, wood, thump, noise)
    this.applyEnvelope(out, 0.0005, 0.04)
    return this.makeBuffer(out)
  }

  private makePunch(): AudioBuffer {
    const sr   = this.cfg.SAMPLE_RATE
    const dur  = 0.12
    const vol  = this.cfg.FX_VOLUME
    const n    = Math.floor(dur * sr)
    const thud  = new Float32Array(n)
    const slap  = new Float32Array(n)
    const noise = new Float32Array(n)
    const filt  = new Float32Array(n)
    const twoPi = 2 * Math.PI
    let seed = 17
    for (let i = 0; i < n; i++) {
      const t = i / sr
      thud[i] = Math.sin(twoPi * 100 * t) * Math.exp(-t * 30) * vol * 0.65
      slap[i] = Math.sin(twoPi * 350 * t) * Math.exp(-t * 90) * vol * 0.40
      seed = (1664525 * seed + 1013904223) & 0x7fffffff
      noise[i] = ((seed / 0x3fffffff) - 1.0) * Math.exp(-t * 150) * vol * 0.30
    }
    filt[0] = noise[0]
    for (let i = 1; i < n; i++) filt[i] = 0.12 * noise[i] + 0.88 * filt[i - 1]
    const out = this.add(thud, slap, filt)
    this.applyEnvelope(out, 0.0005, 0.06)
    return this.makeBuffer(out)
  }

  private makeWhiff(): AudioBuffer {
    const sr  = this.cfg.SAMPLE_RATE
    const dur = 0.13
    const vol = this.cfg.FX_VOLUME * 0.125
    const n   = Math.floor(dur * sr)
    const noise = new Float32Array(n)
    let seed = 77
    for (let i = 0; i < n; i++) {
      seed = (1664525 * seed + 1013904223) & 0x7fffffff
      noise[i] = ((seed / 0x3fffffff) - 1.0) * vol
    }
    // Two-stage low-pass with a sweeping cutoff to get a whoosh character
    const lp1 = new Float32Array(n)
    const lp2 = new Float32Array(n)
    lp1[0] = noise[0]; lp2[0] = noise[0]
    for (let i = 1; i < n; i++) {
      const t      = i / n
      const alpha1 = 0.18 + 0.18 * (1 - t)   // wider at start, narrows at end
      lp1[i] = alpha1 * noise[i] + (1 - alpha1) * lp1[i - 1]
      lp2[i] = 0.04  * noise[i] + 0.96        * lp2[i - 1]
    }
    // Bandpass approximation: difference of two low-passes
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = lp1[i] - lp2[i] * 0.6
    // Soft descending tone underneath for pitch sense
    let phase = 0
    for (let i = 0; i < n; i++) {
      const t    = i / n
      const freq = 280 - 180 * t          // sweeps 280 → 100 Hz
      phase += 2 * Math.PI * freq / sr
      out[i] += Math.sin(phase) * vol * 0.18 * (1 - t)
    }
    this.applyEnvelope(out, 0.002, 0.06)
    return this.makeBuffer(out)
  }

  private makeError(): AudioBuffer {
    const sr  = this.cfg.SAMPLE_RATE
    const vol = this.cfg.FX_VOLUME * 0.50
    // Two dissonant tones played simultaneously — harsh "wrong" sound
    const low  = this.sine(220.0, 0.18, vol * 0.7)
    const high = this.sine(311.1, 0.18, vol * 0.6)  // Eb — dissonant tritone above A
    const out  = this.add(low, high)
    // Extra roughness: slight amplitude modulation via a low-freq component
    const mod = this.sine(7.0, 0.18, 1.0)
    for (let i = 0; i < out.length; i++) out[i] *= 0.75 + 0.25 * mod[i]
    this.applyEnvelope(out, 0.003, 0.08)
    return this.makeBuffer(out)
  }

  private makeOutOfRange(): AudioBuffer {
    const vol = this.cfg.FX_VOLUME * 0.35
    const notes: Array<[number, number]> = [[880.0, 0.07], [440.0, 0.10]]
    const chunks: Float32Array[] = []
    for (const [freq, dur] of notes) {
      const chunk = this.sine(freq, dur, vol)
      this.applyEnvelope(chunk, 0.003, 0.04)
      chunks.push(chunk)
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Float32Array(totalLen)
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
    return this.makeBuffer(out)
  }

  private makeCombatEnd(): AudioBuffer {
    const sr  = this.cfg.SAMPLE_RATE
    const vol = this.cfg.FX_VOLUME
    const notes: Array<[number, number]> = [[392.0, 0.12], [329.63, 0.12], [261.63, 0.22]]
    const chunks: Float32Array[] = []
    for (const [freq, dur] of notes) {
      const chunk = this.sine(freq, dur, vol)
      this.applyEnvelope(chunk, 0.003, 0.06)
      chunks.push(chunk)
    }
    const totalLen = chunks.reduce((s, c) => s + c.length, 0)
    const out = new Float32Array(totalLen)
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
    return this.makeBuffer(out)
  }

  // ── Cached buffers ────────────────────────────────────────────

  private buffers: Map<string, AudioBuffer> = new Map()

  private getBuffer(name: string): AudioBuffer {
    if (!this.buffers.has(name)) {
      switch (name) {
        case 'tick':         this.buffers.set(name, this.makeTick());        break
        case 'perfect':      this.buffers.set(name, this.makePerfect());     break
        case 'good':         this.buffers.set(name, this.makeGood());        break
        case 'miss':         this.buffers.set(name, this.makeMiss());        break
        case 'combat_start': this.buffers.set(name, this.makeCombatStart()); break
        case 'crush':        this.buffers.set(name, this.makeCrush());       break
        case 'punch':        this.buffers.set(name, this.makePunch());       break
        case 'combat_end':   this.buffers.set(name, this.makeCombatEnd());   break
        case 'out_of_range': this.buffers.set(name, this.makeOutOfRange()); break
        case 'whiff':        this.buffers.set(name, this.makeWhiff());      break
        case 'error':        this.buffers.set(name, this.makeError());      break
        default: throw new Error(`Unknown sound: ${name}`)
      }
    }
    return this.buffers.get(name)!
  }

  // ── Public API ────────────────────────────────────────────────

  /** Pre-generate all sound buffers so the first call has no latency. */
  preload(): void {
    for (const name of ['tick', 'perfect', 'good', 'miss',
                        'combat_start', 'crush', 'punch', 'whiff', 'combat_end', 'out_of_range', 'error']) {
      try { this.getBuffer(name) } catch {}
    }
  }

  setTemporaryMute(muted: boolean): void {
    this.tempMuted = muted
  }

  play(name: string, when?: number): void {
    if (!this.enabled || this.tempMuted) return
    try {
      const ctx  = this.getCtx()
      const src  = ctx.createBufferSource()
      src.buffer = this.getBuffer(name)
      src.connect(ctx.destination)
      src.start(when ?? ctx.currentTime)
    } catch (e) {
      console.warn(`[Audio] play(${name}) failed:`, e)
    }
  }

  /**
   * Schedule the tick sound at the given performance.now() target time.
   * Uses AudioContext.currentTime arithmetic for precision — no busy-wait needed.
   */
  scheduleTick(targetMs: number): void {
    if (!this.enabled || this.tempMuted) return
    try {
      const ctx = this.getCtx()
      // Convert from performance.now() domain to AudioContext.currentTime domain.
      // audioCtx.currentTime moves at the same rate as wall clock (seconds).
      const nowMs      = performance.now()
      const delayMs    = targetMs - nowMs
      const audioWhen  = ctx.currentTime + Math.max(0, delayMs / 1000)
      this.play('tick', audioWhen)
    } catch (e) {
      console.warn('[Audio] scheduleTick failed:', e)
    }
  }

  toggle(): boolean {
    this.enabled = !this.enabled
    if (!this.enabled && this.ctx) {
      this.ctx.suspend()
    } else if (this.enabled && this.ctx) {
      this.ctx.resume()
    }
    return this.enabled
  }

  cleanup(): void {
    if (this.ctx) {
      this.ctx.close()
      this.ctx = null
    }
  }
}

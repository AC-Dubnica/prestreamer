import type { Effect, EffectType } from '../shared/mixer'
import type { FxLive } from '../shared/types'
import { reverbImpulse } from '../shared/reverb'

/** Parameter changes glide over ~10 ms, so moving a knob does not click. */
const SMOOTH_S = 0.01
export const param = (p: AudioParam, value: number, ctx: BaseAudioContext): void => { p.setTargetAtTime(value, ctx.currentTime, SMOOTH_S) }

/**
 * One effect of a chain, as audio nodes. `input` and `output` are where the chain connects to it (they can be the same node).
 * An effect that is switched off stays in the graph but passes the signal on unchanged: no rewiring, no click.
 */
export interface Fx {
  id: string
  type: EffectType
  input: AudioNode
  output: AudioNode
  /** Pushes the effect's settings into its nodes. */
  apply(e: Effect): void
  /** Gain reduction in dB (≤ 0) right now; 0 for effects that do not reduce gain. */
  reduction(): number
  /** What goes through the effect right now, for its graph (gate, compressor and EQ only). */
  live?(): FxLive
  dispose(): void
}

/** Number of bands of the spectra the EQ graph draws (log-spaced, 20 Hz to 20 kHz). */
export const SPECTRUM_BANDS = 64
const FLOOR_DB = -100

/** A tap that reports the peak level of what reaches `from`, in dBFS, over the last ~20 ms (the same window the effects' detectors look at). */
function levelTap(ctx: BaseAudioContext, from: AudioNode): { read(): number; dispose(): void } {
  const a = Object.assign(ctx.createAnalyser(), { fftSize: 1024, smoothingTimeConstant: 0 })
  const buf = new Float32Array(a.fftSize)
  from.connect(a)
  return {
    read() {
      a.getFloatTimeDomainData(buf)
      let peak = 0
      for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > peak) peak = v }
      return peak > 1e-5 ? 20 * Math.log10(peak) : FLOOR_DB
    },
    dispose: () => a.disconnect(),
  }
}

/** A tap that reports the spectrum of what reaches `from` as SPECTRUM_BANDS levels in dBFS (a little smoothed, so the picture moves but does not jitter). */
function spectrumTap(ctx: BaseAudioContext, from: AudioNode): { read(): number[]; dispose(): void } {
  const a = Object.assign(ctx.createAnalyser(), { fftSize: 4096, smoothingTimeConstant: 0.6 })
  const bins = new Float32Array(a.frequencyBinCount)
  const hz = ctx.sampleRate / a.fftSize
  from.connect(a)
  return {
    read() {
      a.getFloatFrequencyData(bins)
      const out: number[] = []
      for (let b = 0; b < SPECTRUM_BANDS; b++) {
        const lo = 20 * 1000 ** (b / SPECTRUM_BANDS), hi = 20 * 1000 ** ((b + 1) / SPECTRUM_BANDS)
        const i0 = Math.floor(lo / hz), i1 = Math.max(i0, Math.floor(hi / hz) - 1)
        let v = FLOOR_DB
        if (i1 > i0) for (let i = i0; i <= i1 && i < bins.length; i++) v = Math.max(v, bins[i])
        else { // a band narrower than one bin (the lows): read between the two bins around its middle
          const x = Math.sqrt(lo * hi) / hz, i = Math.min(bins.length - 2, Math.floor(x))
          v = Math.max(FLOOR_DB, bins[i] + (bins[i + 1] - bins[i]) * (x - i))
        }
        out.push(Number.isFinite(v) ? Math.round(Math.max(FLOOR_DB, v)) : FLOOR_DB)
      }
      return out
    },
    dispose: () => a.disconnect(),
  }
}

/** The processor of a worklet node reports its gain reduction on the node's port. */
function worklet(ctx: BaseAudioContext, name: string, onReduction: (db: number) => void): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, name)
  node.port.onmessage = (e: MessageEvent<number>) => onReduction(e.data)
  return node
}

const wp = (node: AudioWorkletNode, name: string): AudioParam => node.parameters.get(name)!

/** A limiter is the compressor worklet with a very high ratio, no knee and a near-instant attack. */
function setLimiter(ctx: BaseAudioContext, node: AudioWorkletNode, on: boolean, ceilingDb: number): void {
  param(wp(node, 'enabled'), on ? 1 : 0, ctx)
  param(wp(node, 'threshold'), ceilingDb, ctx)
  param(wp(node, 'ratio'), 100, ctx)
  param(wp(node, 'knee'), 0, ctx)
  param(wp(node, 'attack'), 0.05, ctx)
  param(wp(node, 'release'), 80, ctx)
  param(wp(node, 'makeup'), 0, ctx)
}

/**
 * `mono`: the chain carries one channel (a strip, before its pan). An effect must then hand on one channel too: a stereo output
 * would turn the strip stereo, and the pan stage after it would pass it 3 dB louder than the same signal as mono.
 */
export function createFx(ctx: AudioContext, e: Effect, mono = false): Fx {
  const base = { id: e.id, type: e.type }
  switch (e.type) {
    case 'hpf': {
      const f = Object.assign(ctx.createBiquadFilter(), { type: 'highpass' as BiquadFilterType })
      f.Q.value = Math.SQRT1_2
      return {
        ...base, input: f, output: f, reduction: () => 0, dispose: () => f.disconnect(),
        apply(x) { if (x.type === 'hpf') param(f.frequency, x.on ? x.freq : 10, ctx) },
      }
    }
    case 'eq': {
      const make = (type: BiquadFilterType) => Object.assign(ctx.createBiquadFilter(), { type })
      const low = make('lowshelf'), mid = make('peaking'), high = make('highshelf')
      const input = ctx.createGain() // the chain connects here, so the sound can be tapped before the filters
      input.connect(low)
      low.connect(mid).connect(high)
      // The chain disconnects an effect's `output` whenever it rewires, which would also cut a tap hung on it: the tap sits on `high`.
      const output = ctx.createGain()
      high.connect(output)
      const before = spectrumTap(ctx, input), after = spectrumTap(ctx, high)
      return {
        ...base, input, output, reduction: () => 0,
        live: () => ({ pre: before.read(), post: after.read() }),
        dispose: () => { before.dispose(); after.dispose(); input.disconnect(); low.disconnect(); mid.disconnect(); high.disconnect(); output.disconnect() },
        apply(x) {
          if (x.type !== 'eq') return
          param(low.frequency, x.lowFreq, ctx); param(low.gain, x.on ? x.lowGainDb : 0, ctx)
          param(mid.frequency, x.midFreq, ctx); param(mid.Q, x.midQ, ctx); param(mid.gain, x.on ? x.midGainDb : 0, ctx)
          param(high.frequency, x.highFreq, ctx); param(high.gain, x.on ? x.highGainDb : 0, ctx)
        },
      }
    }
    case 'gate': {
      let gr = 0
      const n = worklet(ctx, 'gate', (db) => { gr = db })
      const input = ctx.createGain()
      input.connect(n)
      const tap = levelTap(ctx, input)
      return {
        ...base, input, output: n, reduction: () => gr, live: () => ({ inDb: tap.read() }), dispose: () => { tap.dispose(); input.disconnect(); n.disconnect() },
        apply(x) {
          if (x.type !== 'gate') return
          param(wp(n, 'enabled'), x.on ? 1 : 0, ctx); param(wp(n, 'threshold'), x.thresholdDb, ctx); param(wp(n, 'range'), x.rangeDb, ctx)
          param(wp(n, 'attack'), x.attackMs, ctx); param(wp(n, 'hold'), x.holdMs, ctx); param(wp(n, 'release'), x.releaseMs, ctx)
        },
      }
    }
    case 'comp': {
      let gr = 0
      const n = worklet(ctx, 'compressor', (db) => { gr = db })
      const input = ctx.createGain()
      input.connect(n)
      const tap = levelTap(ctx, input)
      return {
        ...base, input, output: n, reduction: () => gr, live: () => ({ inDb: tap.read() }), dispose: () => { tap.dispose(); input.disconnect(); n.disconnect() },
        apply(x) {
          if (x.type !== 'comp') return
          param(wp(n, 'enabled'), x.on ? 1 : 0, ctx); param(wp(n, 'threshold'), x.thresholdDb, ctx); param(wp(n, 'ratio'), x.ratio, ctx)
          param(wp(n, 'knee'), x.kneeDb, ctx); param(wp(n, 'attack'), Math.max(0.01, x.attackMs), ctx); param(wp(n, 'release'), x.releaseMs, ctx)
          param(wp(n, 'makeup'), x.makeupDb, ctx)
        },
      }
    }
    case 'limiter': {
      let gr = 0
      const n = worklet(ctx, 'compressor', (db) => { gr = db })
      return {
        ...base, input: n, output: n, reduction: () => gr, dispose: () => n.disconnect(),
        apply(x) { if (x.type === 'limiter') setLimiter(ctx, n, x.on, x.ceilingDb) },
      }
    }
    case 'deesser': {
      let gr = 0
      const n = worklet(ctx, 'deesser', (db) => { gr = db })
      return {
        ...base, input: n, output: n, reduction: () => gr, dispose: () => n.disconnect(),
        apply(x) {
          if (x.type !== 'deesser') return
          param(wp(n, 'enabled'), x.on ? 1 : 0, ctx); param(wp(n, 'frequency'), x.freq, ctx)
          param(wp(n, 'threshold'), x.thresholdDb, ctx); param(wp(n, 'reduction'), x.reductionDb, ctx)
        },
      }
    }
    case 'reverb': {
      const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain()
      const pre = ctx.createDelay(0.25)
      const conv = ctx.createConvolver()
      input.connect(output) // dry
      // The room is stereo; on a mono strip its tail is folded down to one channel so the strip stays mono.
      const tail: AudioNode = conv
      const wetOut = mono ? Object.assign(ctx.createGain(), { channelCount: 1, channelCountMode: 'explicit' as ChannelCountMode }) : null
      input.connect(pre).connect(conv)
      if (wetOut) tail.connect(wetOut).connect(wet)
      else tail.connect(wet)
      wet.connect(output)
      wet.gain.value = 0
      // Making the impulse response takes a moment, so it is only remade when the room itself (decay, damping) changes.
      let shape = ''
      let timer: ReturnType<typeof setTimeout> | null = null
      const build = (decay: number, damping: number) => {
        const [l, r] = reverbImpulse(ctx.sampleRate, decay, damping)
        const buf = ctx.createBuffer(2, l.length, ctx.sampleRate)
        buf.copyToChannel(l as Float32Array<ArrayBuffer>, 0)
        buf.copyToChannel(r as Float32Array<ArrayBuffer>, 1)
        conv.buffer = buf
      }
      return {
        ...base, input, output, reduction: () => 0,
        dispose: () => { if (timer) clearTimeout(timer); for (const x of [input, output, wet, pre, conv, ...(wetOut ? [wetOut] : [])]) x.disconnect() },
        apply(x) {
          if (x.type !== 'reverb') return
          param(pre.delayTime, x.preDelayMs / 1000, ctx)
          param(wet.gain, x.on ? x.mix : 0, ctx)
          const now = `${x.decaySec}|${x.dampingHz}`
          if (now === shape) return
          const first = shape === ''
          shape = now
          if (timer) clearTimeout(timer)
          if (first) build(x.decaySec, x.dampingHz)
          else timer = setTimeout(() => build(x.decaySec, x.dampingHz), 150)
        },
      }
    }
    case 'syncdelay': {
      const d = ctx.createDelay(2)
      return {
        ...base, input: d, output: d, reduction: () => 0, dispose: () => d.disconnect(),
        apply(x) { if (x.type === 'syncdelay') param(d.delayTime, x.on ? x.timeMs / 1000 : 0, ctx) },
      }
    }
    case 'delay': {
      const input = ctx.createGain(), output = ctx.createGain(), wet = ctx.createGain(), fb = ctx.createGain()
      const dly = ctx.createDelay(1.2)
      const tone = Object.assign(ctx.createBiquadFilter(), { type: 'lowpass' as BiquadFilterType })
      input.connect(output) // dry
      input.connect(dly)
      dly.connect(tone)
      tone.connect(wet).connect(output)
      tone.connect(fb).connect(dly) // the repeats go back in through the tone filter, so each one is a little darker
      wet.gain.value = 0
      fb.gain.value = 0
      return {
        ...base, input, output, reduction: () => 0,
        dispose: () => { for (const x of [input, output, wet, fb, dly, tone]) x.disconnect() },
        apply(x) {
          if (x.type !== 'delay') return
          param(dly.delayTime, x.timeMs / 1000, ctx)
          param(tone.frequency, x.toneHz, ctx)
          param(fb.gain, x.on ? Math.min(0.9, x.feedback) : 0, ctx)
          param(wet.gain, x.on ? x.mix : 0, ctx)
        },
      }
    }
  }
}

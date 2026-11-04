/**
 * Mixer data model: pure functions only, so the console logic can be unit-tested without audio hardware.
 * One strip per device channel (e.g. a Behringer Wing's USB 1-48) feeding a stereo stream bus.
 */

export interface HpfConfig { on: boolean; freq: number }
export interface EqConfig { on: boolean; lowFreq: number; lowGainDb: number; midFreq: number; midGainDb: number; midQ: number; highFreq: number; highGainDb: number }
export interface GateConfig { on: boolean; thresholdDb: number; rangeDb: number; attackMs: number; holdMs: number; releaseMs: number }
export interface CompConfig { on: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
export interface LimiterConfig { on: boolean; ceilingDb: number }

export interface Strip {
  /** Zero-based device channel this strip reads. */
  channel: number
  name: string
  trimDb: number
  faderDb: number
  /** -1 (left) … +1 (right). */
  pan: number
  mute: boolean
  solo: boolean
  hpf: HpfConfig
  eq: EqConfig
  gate: GateConfig
  comp: CompConfig
  limiter: LimiterConfig
}

export interface MixerConfig {
  strips: Strip[]
  masterDb: number
  masterLimiter: LimiterConfig
}

/** [min, max] per parameter: used by the UI sliders and to clamp anything read from disk. */
export const RANGES = {
  trimDb: [-24, 24], faderDb: [-100, 10], pan: [-1, 1], masterDb: [-100, 10],
  hpfFreq: [20, 500],
  eqFreq: [20, 20000], eqGainDb: [-18, 18], eqQ: [0.1, 10],
  gateThresholdDb: [-80, 0], gateRangeDb: [0, 80], gateAttackMs: [0.1, 100], gateHoldMs: [0, 1000], gateReleaseMs: [5, 2000],
  compThresholdDb: [-60, 0], compRatio: [1, 20], compAttackMs: [0, 100], compReleaseMs: [10, 1000], compKneeDb: [0, 40], compMakeupDb: [0, 24],
  limiterCeilingDb: [-20, 0],
} as const satisfies Record<string, readonly [number, number]>

export const MAX_CHANNELS = 48

export const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v))

/** Decibels to linear gain; anything at or below -100 dB is treated as silence. */
export const dbToGain = (db: number): number => (db <= -100 ? 0 : 10 ** (db / 20))

export const gainToDb = (gain: number): number => (gain <= 1e-5 ? -100 : 20 * Math.log10(gain))

export function defaultStrip(channel: number, name = `USB ${channel + 1}`): Strip {
  return {
    channel,
    name,
    trimDb: 0,
    faderDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    hpf: { on: false, freq: 80 },
    eq: { on: false, lowFreq: 100, lowGainDb: 0, midFreq: 1000, midGainDb: 0, midQ: 1, highFreq: 8000, highGainDb: 0 },
    gate: { on: false, thresholdDb: -50, rangeDb: 40, attackMs: 5, holdMs: 50, releaseMs: 200 },
    comp: { on: false, thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 150, kneeDb: 6, makeupDb: 0 },
    limiter: { on: false, ceilingDb: -1 },
  }
}

/** A stereo pair on USB 1-2 panned hard left/right: what you get from a console's stereo stream bus. */
export function defaultMixer(): MixerConfig {
  return {
    strips: [{ ...defaultStrip(0), pan: -1 }, { ...defaultStrip(1), pan: 1 }],
    masterDb: 0,
    masterLimiter: { on: true, ceilingDb: -1 },
  }
}

/**
 * Gain each strip actually passes after mute and solo. Solo works like a console: when any strip is
 * soloed, everything that is not soloed is silent; mute always wins.
 */
export function effectiveGains(m: MixerConfig): number[] {
  const anySolo = m.strips.some((s) => s.solo)
  return m.strips.map((s) => (s.mute || (anySolo && !s.solo) ? 0 : dbToGain(s.faderDb)))
}

const num = (v: unknown, fallback: number, range: readonly [number, number]): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, range) : fallback
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {})

function sanitizeStrip(raw: unknown): Strip | null {
  const r = obj(raw)
  if (typeof r.channel !== 'number' || !Number.isInteger(r.channel) || r.channel < 0 || r.channel >= MAX_CHANNELS) return null
  const d = defaultStrip(r.channel)
  const hpf = obj(r.hpf), eq = obj(r.eq), gate = obj(r.gate), comp = obj(r.comp), lim = obj(r.limiter)
  return {
    channel: r.channel,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 24) : `USB ${r.channel + 1}`,
    trimDb: num(r.trimDb, d.trimDb, RANGES.trimDb),
    faderDb: num(r.faderDb, d.faderDb, RANGES.faderDb),
    pan: num(r.pan, d.pan, RANGES.pan),
    mute: bool(r.mute, false),
    solo: bool(r.solo, false),
    hpf: { on: bool(hpf.on, false), freq: num(hpf.freq, d.hpf.freq, RANGES.hpfFreq) },
    eq: {
      on: bool(eq.on, false),
      lowFreq: num(eq.lowFreq, d.eq.lowFreq, RANGES.eqFreq), lowGainDb: num(eq.lowGainDb, 0, RANGES.eqGainDb),
      midFreq: num(eq.midFreq, d.eq.midFreq, RANGES.eqFreq), midGainDb: num(eq.midGainDb, 0, RANGES.eqGainDb), midQ: num(eq.midQ, d.eq.midQ, RANGES.eqQ),
      highFreq: num(eq.highFreq, d.eq.highFreq, RANGES.eqFreq), highGainDb: num(eq.highGainDb, 0, RANGES.eqGainDb),
    },
    gate: {
      on: bool(gate.on, false),
      thresholdDb: num(gate.thresholdDb, d.gate.thresholdDb, RANGES.gateThresholdDb), rangeDb: num(gate.rangeDb, d.gate.rangeDb, RANGES.gateRangeDb),
      attackMs: num(gate.attackMs, d.gate.attackMs, RANGES.gateAttackMs), holdMs: num(gate.holdMs, d.gate.holdMs, RANGES.gateHoldMs), releaseMs: num(gate.releaseMs, d.gate.releaseMs, RANGES.gateReleaseMs),
    },
    comp: {
      on: bool(comp.on, false),
      thresholdDb: num(comp.thresholdDb, d.comp.thresholdDb, RANGES.compThresholdDb), ratio: num(comp.ratio, d.comp.ratio, RANGES.compRatio),
      attackMs: num(comp.attackMs, d.comp.attackMs, RANGES.compAttackMs), releaseMs: num(comp.releaseMs, d.comp.releaseMs, RANGES.compReleaseMs),
      kneeDb: num(comp.kneeDb, d.comp.kneeDb, RANGES.compKneeDb), makeupDb: num(comp.makeupDb, 0, RANGES.compMakeupDb),
    },
    limiter: { on: bool(lim.on, false), ceilingDb: num(lim.ceilingDb, d.limiter.ceilingDb, RANGES.limiterCeilingDb) },
  }
}

/** Validates untrusted JSON (a file on disk, or an IPC payload). Anything unusable falls back to defaults. */
export function sanitizeMixer(raw: unknown): MixerConfig {
  const r = obj(raw)
  if (!Array.isArray(r.strips)) return defaultMixer()
  const seen = new Set<number>()
  const strips: Strip[] = []
  r.strips.forEach((s) => {
    const strip = sanitizeStrip(s)
    if (strip && !seen.has(strip.channel)) {
      seen.add(strip.channel)
      strips.push(strip)
    }
  })
  const lim = obj(r.masterLimiter)
  return {
    strips,
    masterDb: num(r.masterDb, 0, RANGES.masterDb),
    masterLimiter: { on: bool(lim.on, true), ceilingDb: num(lim.ceilingDb, -1, RANGES.limiterCeilingDb) },
  }
}

/**
 * Mixer data model: pure functions only, so the console logic can be unit-tested without audio hardware.
 * One strip per device channel (e.g. a Behringer Wing's USB 1-48) feeding a stereo stream bus.
 */

export interface HpfConfig { on: boolean; freq: number }
export interface EqConfig { on: boolean; lowFreq: number; lowGainDb: number; midFreq: number; midGainDb: number; midQ: number; highFreq: number; highGainDb: number }
export interface GateConfig { on: boolean; thresholdDb: number; rangeDb: number; attackMs: number; holdMs: number; releaseMs: number }
export interface CompConfig { on: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
export interface LimiterConfig { on: boolean; ceilingDb: number }

/** An audio input on this machine. Test sources use ids starting with "test:". */
export interface StripSource {
  deviceId: string
  label: string
}

export interface Strip {
  /** Zero-based channel of the source this strip reads. */
  channel: number
  /** Which input device the channel comes from. Absent = the default source chosen in the Audio panel. */
  source?: StripSource
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
  /** Delays the whole mix so the sound lines up with the picture (camera and encoding delay the picture). */
  delayMs: number
}

/** [min, max] per parameter: used by the UI sliders and to clamp anything read from disk. */
export const RANGES = {
  trimDb: [-24, 24], faderDb: [-100, 10], pan: [-1, 1], masterDb: [-100, 10], delayMs: [0, 2000],
  hpfFreq: [20, 500],
  eqFreq: [20, 20000], eqGainDb: [-18, 18], eqQ: [0.1, 10],
  gateThresholdDb: [-80, 0], gateRangeDb: [0, 80], gateAttackMs: [0.1, 100], gateHoldMs: [0, 1000], gateReleaseMs: [5, 2000],
  compThresholdDb: [-60, 0], compRatio: [1, 20], compAttackMs: [0, 100], compReleaseMs: [10, 1000], compKneeDb: [0, 40], compMakeupDb: [0, 24],
  limiterCeilingDb: [-20, 0],
} as const satisfies Record<string, readonly [number, number]>

export const MAX_CHANNELS = 48

/**
 * The sound of the video that is playing in the service. It is an input like any device, so it has strips in the mixer
 * (level, EQ, mute) and reaches the stream through the master.
 */
export const VIDEO_SOURCE: StripSource & { channels: number } = { deviceId: 'app:video', label: 'Video playback (stereo)', channels: 2 }

/** Left and right strips for the video's sound, panned hard left and right. */
export function videoStrips(): Strip[] {
  return [
    { ...defaultStrip(0, 'Video L', VIDEO_SOURCE), pan: -1 },
    { ...defaultStrip(1, 'Video R', VIDEO_SOURCE), pan: 1 },
  ]
}

/** Synthetic inputs for trying the mixer without hardware. */
export const TEST_SOURCES: (StripSource & { channels: number })[] = [
  { deviceId: 'test:tones', label: 'Test tones (4 channels)', channels: 4 },
  { deviceId: 'test:beep', label: 'Test beep (stereo)', channels: 2 },
]

export const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v))

/** Decibels to linear gain; anything at or below -100 dB is treated as silence. */
export const dbToGain = (db: number): number => (db <= -100 ? 0 : 10 ** (db / 20))

export const gainToDb = (gain: number): number => (gain <= 1e-5 ? -100 : 20 * Math.log10(gain))

/** "MacBook Pro Microphone (Built-in)" -> "MacBook Pro Microphone": the part of a device label that fits on a strip. */
export function shortDeviceName(label: string): string {
  const base = label.replace(/^default\s*-\s*/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
  return base || label.trim() || 'Input'
}

/** Strips are told apart by device AND channel: channel 1 of two different devices are two different strips. */
export const stripKey = (s: { channel: number; source?: StripSource }): string => `${s.source?.deviceId ?? ''}#${s.channel}`

const stripName = (channel: number, source?: StripSource): string =>
  source ? `${shortDeviceName(source.label)} ${channel + 1}`.slice(0, 24) : `USB ${channel + 1}`

export function defaultStrip(channel: number, name?: string, source?: StripSource): Strip {
  return {
    channel,
    ...(source ? { source } : {}),
    name: name ?? stripName(channel, source),
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

/** A new installation's mixer has the sound of the service's videos in it and nothing else: inputs are added by the user. */
export function defaultMixer(): MixerConfig {
  return {
    strips: videoStrips(),
    masterDb: 0,
    masterLimiter: { on: true, ceilingDb: -1 },
    delayMs: 0,
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
  const rs = obj(r.source)
  const source: StripSource | undefined = typeof rs.deviceId === 'string' && rs.deviceId && rs.deviceId.length <= 300 ? { deviceId: rs.deviceId, label: typeof rs.label === 'string' ? rs.label.slice(0, 120) : rs.deviceId } : undefined
  const d = defaultStrip(r.channel, undefined, source)
  const hpf = obj(r.hpf), eq = obj(r.eq), gate = obj(r.gate), comp = obj(r.comp), lim = obj(r.limiter)
  return {
    channel: r.channel,
    ...(source ? { source } : {}),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 24) : d.name,
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
  const seen = new Set<string>()
  const strips: Strip[] = []
  r.strips.forEach((s) => {
    const strip = sanitizeStrip(s)
    if (strip && !seen.has(stripKey(strip))) {
      seen.add(stripKey(strip))
      strips.push(strip)
    }
  })
  const lim = obj(r.masterLimiter)
  return {
    strips,
    masterDb: num(r.masterDb, 0, RANGES.masterDb),
    masterLimiter: { on: bool(lim.on, true), ceilingDb: num(lim.ceilingDb, -1, RANGES.limiterCeilingDb) },
    delayMs: num(r.delayMs, 0, RANGES.delayMs),
  }
}

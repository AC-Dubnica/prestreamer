/**
 * Mixer data model: pure functions only, so the console logic can be unit-tested without audio hardware.
 * One strip per device channel (e.g. a Behringer Wing's USB 1-48) feeding a stereo stream bus. Every strip, and the master,
 * has a chain: an ordered list of effects (high-pass, EQ, gate, compressor, limiter, de-esser, reverb, delay) that the
 * operator builds, and the signal runs through them one after another.
 */

export interface HpfConfig { on: boolean; freq: number }
export interface EqConfig { on: boolean; lowFreq: number; lowGainDb: number; midFreq: number; midGainDb: number; midQ: number; highFreq: number; highGainDb: number }
export interface GateConfig { on: boolean; thresholdDb: number; rangeDb: number; attackMs: number; holdMs: number; releaseMs: number }
export interface CompConfig { on: boolean; thresholdDb: number; ratio: number; attackMs: number; releaseMs: number; kneeDb: number; makeupDb: number }
export interface LimiterConfig { on: boolean; ceilingDb: number }
/** Tames harsh "s" sounds: lowers only the high band, and only while it is too loud. */
export interface DeesserConfig { on: boolean; freq: number; thresholdDb: number; reductionDb: number }
export interface ReverbConfig { on: boolean; decaySec: number; dampingHz: number; preDelayMs: number; mix: number }
export interface DelayConfig { on: boolean; timeMs: number; feedback: number; toneHz: number; mix: number }

export const EFFECT_TYPES = ['hpf', 'eq', 'gate', 'comp', 'limiter', 'deesser', 'reverb', 'delay'] as const
export type EffectType = (typeof EFFECT_TYPES)[number]

/** One effect in a chain. `id` is stable (the audio engine tells chains apart by it), `type` says what it is. */
type Fx<T extends EffectType, C> = { id: string; type: T } & C
export type Effect =
  | Fx<'hpf', HpfConfig>
  | Fx<'eq', EqConfig>
  | Fx<'gate', GateConfig>
  | Fx<'comp', CompConfig>
  | Fx<'limiter', LimiterConfig>
  | Fx<'deesser', DeesserConfig>
  | Fx<'reverb', ReverbConfig>
  | Fx<'delay', DelayConfig>
export type EffectOf<T extends EffectType> = Extract<Effect, { type: T }>

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
  /** The effects this channel passes through, first to last, between its trim and its fader. */
  chain: Effect[]
}

export interface MixerConfig {
  strips: Strip[]
  masterDb: number
  /** The effects everything passes through together, before the master fader (a limiter, usually). */
  masterChain: Effect[]
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
  deesserFreq: [2000, 12000], deesserThresholdDb: [-60, 0], deesserReductionDb: [0, 24],
  reverbDecaySec: [0.2, 6], reverbDampingHz: [1000, 16000], reverbPreDelayMs: [0, 200], reverbMix: [0, 1],
  delayTimeMs: [10, 1000], delayFeedback: [0, 0.9], delayToneHz: [500, 12000], delayMix: [0, 1],
} as const satisfies Record<string, readonly [number, number]>

export const MAX_CHANNELS = 48
/** A chain is a row of cards on screen and a row of nodes in the audio graph: keep both sane. */
export const MAX_EFFECTS = 12

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

/** What each effect is for, in words for the operator (the Add effect menu and the card tooltips). */
export const EFFECT_INFO: Record<EffectType, { label: string; blurb: string }> = {
  hpf: { label: 'High-pass', blurb: 'Cuts rumble, stand noise and breath pops below a frequency. Almost every vocal and speech channel wants one.' },
  eq: { label: 'EQ', blurb: 'Three-band tone control: clear up a muddy voice, add presence, tame a boomy room.' },
  gate: { label: 'Gate', blurb: 'Closes the channel while nobody is speaking or singing, so open mics do not add room noise.' },
  comp: { label: 'Compressor', blurb: 'Evens out loud and quiet parts, so a quiet verse and a loud chorus both sit right in the stream.' },
  limiter: { label: 'Limiter', blurb: 'A ceiling the signal cannot pass: protects the stream from sudden peaks and clipping.' },
  deesser: { label: 'De-esser', blurb: 'Softens sharp "s" and "t" sounds on vocals and speech, which microphones and streaming exaggerate.' },
  reverb: { label: 'Reverb', blurb: 'Adds a sense of space. Close microphones and direct feeds sound dry on a stream; a little reverb makes it sound like the room.' },
  delay: { label: 'Delay', blurb: 'A soft echo behind the voice or an instrument, common in worship music. Use sparingly.' },
}

/** Ids only need to be unique inside one mixer; they are made once, when the effect is added, and never change. */
let idCounter = 0
export const newEffectId = (): string => `fx-${Date.now().toString(36)}${(idCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
const ID_FORMAT = /^[A-Za-z0-9_-]{1,40}$/

/** An effect with its usual settings. Added effects are on; a chain that is saved keeps each effect's own switch. */
export function defaultEffect<T extends EffectType>(type: T, id: string = newEffectId()): EffectOf<T> {
  const base = { id, type }
  const e: Effect =
    type === 'hpf' ? { ...base, type: 'hpf', on: true, freq: 80 }
    : type === 'eq' ? { ...base, type: 'eq', on: true, lowFreq: 100, lowGainDb: 0, midFreq: 1000, midGainDb: 0, midQ: 1, highFreq: 8000, highGainDb: 0 }
    : type === 'gate' ? { ...base, type: 'gate', on: true, thresholdDb: -50, rangeDb: 40, attackMs: 5, holdMs: 50, releaseMs: 200 }
    : type === 'comp' ? { ...base, type: 'comp', on: true, thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 150, kneeDb: 6, makeupDb: 0 }
    : type === 'limiter' ? { ...base, type: 'limiter', on: true, ceilingDb: -1 }
    : type === 'deesser' ? { ...base, type: 'deesser', on: true, freq: 6500, thresholdDb: -30, reductionDb: 8 }
    : type === 'reverb' ? { ...base, type: 'reverb', on: true, decaySec: 1.4, dampingHz: 6000, preDelayMs: 20, mix: 0.15 }
    : { ...base, type: 'delay', on: true, timeMs: 350, feedback: 0.3, toneHz: 3500, mix: 0.15 }
  return e as EffectOf<T>
}

/** An effect with some settings changed (everything else stays as the defaults have it). */
export function makeEffect<T extends EffectType>(type: T, patch: Partial<Omit<EffectOf<T>, 'id' | 'type'>> = {}, id?: string): EffectOf<T> {
  return { ...defaultEffect(type, id), ...patch } as EffectOf<T>
}

/** The first effect of a type in a chain (the tests and the audio checks use this to read and set one). */
export const findEffect = <T extends EffectType>(chain: Effect[], type: T): EffectOf<T> | undefined => chain.find((e): e is EffectOf<T> => e.type === type)

/** Ready-made chains to start from. They only fill the chain: every card can be changed afterwards. */
export interface ChainPreset { id: string; label: string; blurb: string; build: () => Effect[] }
export const STRIP_PRESETS: ChainPreset[] = [
  { id: 'vocal', label: 'Worship vocal', blurb: 'High-pass, a little clarity, even level, softer "s", a touch of space',
    build: () => [makeEffect('hpf', { freq: 100 }), makeEffect('eq', { midFreq: 300, midGainDb: -2, midQ: 1, highFreq: 8000, highGainDb: 2 }), makeEffect('comp', { thresholdDb: -22, ratio: 3, attackMs: 12, releaseMs: 150, kneeDb: 6, makeupDb: 3 }), makeEffect('deesser'), makeEffect('reverb', { mix: 0.12 })] },
  { id: 'speech', label: 'Speaker / preacher', blurb: 'High-pass, gate against room noise, presence, firm level control',
    build: () => [makeEffect('hpf', { freq: 100 }), makeEffect('gate', { thresholdDb: -45, rangeDb: 30 }), makeEffect('eq', { midFreq: 3000, midGainDb: 2, midQ: 0.8 }), makeEffect('comp', { thresholdDb: -20, ratio: 4, attackMs: 8, releaseMs: 200, kneeDb: 6, makeupDb: 3 }), makeEffect('deesser')] },
  { id: 'instrument', label: 'Instrument', blurb: 'Rumble filter and gentle level control',
    build: () => [makeEffect('hpf', { freq: 60 }), makeEffect('comp', { thresholdDb: -18, ratio: 2, attackMs: 20, releaseMs: 250, kneeDb: 10, makeupDb: 2 })] },
  { id: 'room', label: 'Room / audience mic', blurb: 'Keeps the sound of the room without the rumble and the boom',
    build: () => [makeEffect('hpf', { freq: 150 }), makeEffect('eq', { lowFreq: 250, lowGainDb: -3 }), makeEffect('comp', { thresholdDb: -26, ratio: 2, attackMs: 30, releaseMs: 300, kneeDb: 10, makeupDb: 2 })] },
]
export const MASTER_PRESETS: ChainPreset[] = [
  { id: 'limit', label: 'Safety limiter', blurb: 'Only a ceiling at -1 dB',
    build: () => [makeEffect('limiter', { ceilingDb: -1 })] },
  { id: 'stream', label: 'Stream loudness', blurb: 'Gentle overall level control, then a ceiling: a steady, loud-enough stream',
    build: () => [makeEffect('comp', { thresholdDb: -18, ratio: 2, attackMs: 30, releaseMs: 300, kneeDb: 10, makeupDb: 3 }), makeEffect('limiter', { ceilingDb: -1 })] },
]

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
    chain: [],
  }
}

/** A new installation's mixer has the sound of the service's videos in it and nothing else: inputs are added by the user. */
export function defaultMixer(): MixerConfig {
  return {
    strips: videoStrips(),
    masterDb: 0,
    masterChain: [makeEffect('limiter', { ceilingDb: -1 }, 'master-limiter')],
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

/** Settings of one effect, read from untrusted JSON: every value clamped, anything missing taken from the defaults. */
function effectParams(type: EffectType, r: Record<string, unknown>, d: Effect): Effect {
  const n = (key: string, range: readonly [number, number]) => num(r[key], (d as unknown as Record<string, number>)[key], range)
  const on = bool(r.on, d.on)
  switch (type) {
    case 'hpf': return { id: d.id, type, on, freq: n('freq', RANGES.hpfFreq) }
    case 'eq': return {
      id: d.id, type, on,
      lowFreq: n('lowFreq', RANGES.eqFreq), lowGainDb: n('lowGainDb', RANGES.eqGainDb),
      midFreq: n('midFreq', RANGES.eqFreq), midGainDb: n('midGainDb', RANGES.eqGainDb), midQ: n('midQ', RANGES.eqQ),
      highFreq: n('highFreq', RANGES.eqFreq), highGainDb: n('highGainDb', RANGES.eqGainDb),
    }
    case 'gate': return { id: d.id, type, on, thresholdDb: n('thresholdDb', RANGES.gateThresholdDb), rangeDb: n('rangeDb', RANGES.gateRangeDb), attackMs: n('attackMs', RANGES.gateAttackMs), holdMs: n('holdMs', RANGES.gateHoldMs), releaseMs: n('releaseMs', RANGES.gateReleaseMs) }
    case 'comp': return { id: d.id, type, on, thresholdDb: n('thresholdDb', RANGES.compThresholdDb), ratio: n('ratio', RANGES.compRatio), attackMs: n('attackMs', RANGES.compAttackMs), releaseMs: n('releaseMs', RANGES.compReleaseMs), kneeDb: n('kneeDb', RANGES.compKneeDb), makeupDb: n('makeupDb', RANGES.compMakeupDb) }
    case 'limiter': return { id: d.id, type, on, ceilingDb: n('ceilingDb', RANGES.limiterCeilingDb) }
    case 'deesser': return { id: d.id, type, on, freq: n('freq', RANGES.deesserFreq), thresholdDb: n('thresholdDb', RANGES.deesserThresholdDb), reductionDb: n('reductionDb', RANGES.deesserReductionDb) }
    case 'reverb': return { id: d.id, type, on, decaySec: n('decaySec', RANGES.reverbDecaySec), dampingHz: n('dampingHz', RANGES.reverbDampingHz), preDelayMs: n('preDelayMs', RANGES.reverbPreDelayMs), mix: n('mix', RANGES.reverbMix) }
    case 'delay': return { id: d.id, type, on, timeMs: n('timeMs', RANGES.delayTimeMs), feedback: n('feedback', RANGES.delayFeedback), toneHz: n('toneHz', RANGES.delayToneHz), mix: n('mix', RANGES.delayMix) }
  }
}

const isType = (v: unknown): v is EffectType => typeof v === 'string' && (EFFECT_TYPES as readonly string[]).includes(v)

/**
 * A chain read from untrusted JSON: unknown effect types are dropped, values clamped, the length capped. An effect keeps the
 * id it had (the audio engine tells chains apart by id, so ids must not change between saves); one without a usable or with a
 * repeated id gets a new one.
 */
export function sanitizeChain(raw: unknown, used: Set<string>): Effect[] {
  if (!Array.isArray(raw)) return []
  const out: Effect[] = []
  for (const item of raw) {
    if (out.length >= MAX_EFFECTS) break
    const r = obj(item)
    if (!isType(r.type)) continue
    let id = typeof r.id === 'string' && ID_FORMAT.test(r.id) && !used.has(r.id) ? r.id : newEffectId()
    while (used.has(id)) id = newEffectId()
    used.add(id)
    out.push(effectParams(r.type, r, defaultEffect(r.type, id)))
  }
  return out
}

/** Files saved before chains had fixed modules (hpf, eq, gate, comp, limiter, in that order). Only the ones in use come over. */
const LEGACY_ORDER = ['hpf', 'eq', 'gate', 'comp', 'limiter'] as const
function legacyChain(r: Record<string, unknown>, used: Set<string>): Effect[] {
  const out: Effect[] = []
  for (const type of LEGACY_ORDER) {
    const old = obj(r[type])
    if (!Object.keys(old).length) continue
    const e = effectParams(type, { on: false, ...old }, defaultEffect(type, newEffectId())) // the old modules were off unless saved as on
    const { id: _id, type: _type, on: _on, ...settings } = e
    const { id: _did, type: _dtype, on: _don, ...defaults } = defaultEffect(type, '')
    // Untouched modules that were simply off are the old "nothing here": they do not become cards.
    if (!e.on && JSON.stringify(settings) === JSON.stringify(defaults)) continue
    used.add(e.id)
    out.push(e)
  }
  return out
}

function sanitizeStrip(raw: unknown, used: Set<string>): Strip | null {
  const r = obj(raw)
  if (typeof r.channel !== 'number' || !Number.isInteger(r.channel) || r.channel < 0 || r.channel >= MAX_CHANNELS) return null
  const rs = obj(r.source)
  const source: StripSource | undefined = typeof rs.deviceId === 'string' && rs.deviceId && rs.deviceId.length <= 300 ? { deviceId: rs.deviceId, label: typeof rs.label === 'string' ? rs.label.slice(0, 120) : rs.deviceId } : undefined
  const d = defaultStrip(r.channel, undefined, source)
  return {
    channel: r.channel,
    ...(source ? { source } : {}),
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 24) : d.name,
    trimDb: num(r.trimDb, d.trimDb, RANGES.trimDb),
    faderDb: num(r.faderDb, d.faderDb, RANGES.faderDb),
    pan: num(r.pan, d.pan, RANGES.pan),
    mute: bool(r.mute, false),
    solo: bool(r.solo, false),
    chain: Array.isArray(r.chain) ? sanitizeChain(r.chain, used) : legacyChain(r, used),
  }
}

/** Validates untrusted JSON (a file on disk, or an IPC payload). Anything unusable falls back to defaults. */
export function sanitizeMixer(raw: unknown): MixerConfig {
  const r = obj(raw)
  if (!Array.isArray(r.strips)) return defaultMixer()
  const seen = new Set<string>()
  const used = new Set<string>() // effect ids are unique across the whole mixer, so meters can be looked up by id
  const strips: Strip[] = []
  r.strips.forEach((s) => {
    const strip = sanitizeStrip(s, used)
    if (strip && !seen.has(stripKey(strip))) {
      seen.add(stripKey(strip))
      strips.push(strip)
    }
  })
  let masterChain: Effect[]
  if (Array.isArray(r.masterChain)) masterChain = sanitizeChain(r.masterChain, used)
  else if (Object.keys(obj(r.masterLimiter)).length) { // saved before the master had a chain: its limiter becomes the chain
    const lim = obj(r.masterLimiter)
    masterChain = sanitizeChain([{ type: 'limiter', id: 'master-limiter', on: lim.on, ceilingDb: lim.ceilingDb }], used)
  } else masterChain = defaultMixer().masterChain
  return {
    strips,
    masterDb: num(r.masterDb, 0, RANGES.masterDb),
    masterChain,
    delayMs: num(r.delayMs, 0, RANGES.delayMs),
  }
}

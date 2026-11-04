import { describe, expect, it } from 'vitest'
import { MAX_CHANNELS, RANGES, clamp, dbToGain, defaultMixer, defaultStrip, effectiveGains, gainToDb, sanitizeMixer, type MixerConfig } from '../src/shared/mixer'

describe('decibel conversion', () => {
  it('maps common values', () => {
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(-6)).toBeCloseTo(0.501, 3)
    expect(dbToGain(20)).toBeCloseTo(10, 6)
  })
  it('treats -100 dB and below as silence', () => {
    expect(dbToGain(-100)).toBe(0)
    expect(dbToGain(-150)).toBe(0)
    expect(gainToDb(0)).toBe(-100)
  })
  it('round-trips', () => {
    for (const db of [-60, -12, -3, 0, 6]) expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 6)
  })
})

describe('effectiveGains (mute and solo)', () => {
  const mix = (...strips: Partial<ReturnType<typeof defaultStrip>>[]): MixerConfig => ({
    ...defaultMixer(),
    strips: strips.map((s, i) => ({ ...defaultStrip(i), ...s })),
  })

  it('passes each strip at its fader level', () => {
    const g = effectiveGains(mix({ faderDb: 0 }, { faderDb: -6 }))
    expect(g[0]).toBe(1)
    expect(g[1]).toBeCloseTo(0.501, 3)
  })
  it('mute silences a strip', () => {
    expect(effectiveGains(mix({ mute: true }, {}))).toEqual([0, 1])
  })
  it('solo silences every strip that is not soloed', () => {
    expect(effectiveGains(mix({}, { solo: true }, {}))).toEqual([0, 1, 0])
  })
  it('allows several solos at once', () => {
    expect(effectiveGains(mix({ solo: true }, { solo: true }, {}))).toEqual([1, 1, 0])
  })
  it('mute wins over solo on the same strip', () => {
    expect(effectiveGains(mix({ solo: true, mute: true }, {}))).toEqual([0, 0])
  })
})

describe('defaults', () => {
  it('starts as a stereo pair on USB 1-2, hard left and right, master limiter on', () => {
    const m = defaultMixer()
    expect(m.strips.map((s) => [s.channel, s.pan])).toEqual([[0, -1], [1, 1]])
    expect(m.masterLimiter.on).toBe(true)
  })
  it('names strips after their USB channel', () => {
    expect(defaultStrip(2).name).toBe('USB 3')
  })
})

describe('sanitizeMixer (untrusted JSON from disk or IPC)', () => {
  it('falls back to the default for anything that is not a mixer', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { strips: 'no' }]) expect(sanitizeMixer(bad)).toEqual(defaultMixer())
  })

  it('clamps out-of-range numbers', () => {
    const m = sanitizeMixer({ strips: [{ channel: 0, trimDb: 99, faderDb: -999, pan: 5, comp: { ratio: 1000 } }], masterDb: 50 })
    expect(m.strips[0].trimDb).toBe(RANGES.trimDb[1])
    expect(m.strips[0].faderDb).toBe(RANGES.faderDb[0])
    expect(m.strips[0].pan).toBe(1)
    expect(m.strips[0].comp.ratio).toBe(RANGES.compRatio[1])
    expect(m.masterDb).toBe(RANGES.masterDb[1])
  })

  it('replaces NaN, Infinity and wrong types with defaults', () => {
    const m = sanitizeMixer({ strips: [{ channel: 0, trimDb: NaN, faderDb: Infinity, mute: 'yes', eq: { midQ: 'wide' } }] })
    expect(m.strips[0].trimDb).toBe(0)
    expect(m.strips[0].faderDb).toBe(0)
    expect(m.strips[0].mute).toBe(false)
    expect(m.strips[0].eq.midQ).toBe(defaultStrip(0).eq.midQ)
  })

  it('drops strips with an invalid channel and keeps only the first of duplicates', () => {
    const m = sanitizeMixer({ strips: [{ channel: -1 }, { channel: MAX_CHANNELS }, { channel: 1.5 }, { channel: 'x' }, { channel: 3, name: 'first' }, { channel: 3, name: 'second' }] })
    expect(m.strips.map((s) => [s.channel, s.name])).toEqual([[3, 'first']])
  })

  it('limits names to 24 characters and replaces blank ones', () => {
    const m = sanitizeMixer({ strips: [{ channel: 0, name: 'x'.repeat(40) }, { channel: 1, name: '   ' }] })
    expect(m.strips[0].name).toHaveLength(24)
    expect(m.strips[1].name).toBe('USB 2')
  })

  it('is idempotent on its own output', () => {
    const once = sanitizeMixer({ strips: [{ channel: 5, faderDb: -3, solo: true, gate: { on: true } }], masterDb: -2 })
    expect(sanitizeMixer(once)).toEqual(once)
  })

  it('clamp helper respects both ends', () => {
    expect(clamp(5, [0, 3])).toBe(3)
    expect(clamp(-5, [0, 3])).toBe(0)
    expect(clamp(2, [0, 3])).toBe(2)
  })
})

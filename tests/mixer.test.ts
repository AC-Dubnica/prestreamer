import { describe, expect, it } from 'vitest'
import { MAX_CHANNELS, RANGES, TEST_SOURCES, clamp, defaultMonitor, dbToGain, defaultMixer, defaultStrip, effectiveGains, findEffect, gainToDb, sanitizeMixer, shortDeviceName, stripKey, type MixerConfig } from '../src/shared/mixer'

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
    expect(m.masterChain.map((e) => e.type)).toEqual(['limiter', 'syncdelay'])
    expect(m.masterChain[0]).toMatchObject({ type: 'limiter', on: true, ceilingDb: -1 })
    expect(m.masterChain[1]).toMatchObject({ type: 'syncdelay', timeMs: 0 })
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
    const m = sanitizeMixer({ strips: [{ channel: 0, trimDb: 99, faderDb: -999, pan: 5, chain: [{ type: 'comp', id: 'c1', ratio: 1000 }] }], masterDb: 50 })
    expect(m.strips[0].trimDb).toBe(RANGES.trimDb[1])
    expect(m.strips[0].faderDb).toBe(RANGES.faderDb[0])
    expect(m.strips[0].pan).toBe(1)
    expect(findEffect(m.strips[0].chain, 'comp')?.ratio).toBe(RANGES.compRatio[1])
    expect(m.masterDb).toBe(RANGES.masterDb[1])
  })

  it('replaces NaN, Infinity and wrong types with defaults', () => {
    const m = sanitizeMixer({ strips: [{ channel: 0, trimDb: NaN, faderDb: Infinity, mute: 'yes', chain: [{ type: 'eq', id: 'e1', midQ: 'wide' }] }] })
    expect(m.strips[0].trimDb).toBe(0)
    expect(m.strips[0].faderDb).toBe(0)
    expect(m.strips[0].mute).toBe(false)
    expect(findEffect(m.strips[0].chain, 'eq')?.midQ).toBe(1)
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
    const once = sanitizeMixer({ strips: [{ channel: 5, faderDb: -3, solo: true, chain: [{ type: 'gate', id: 'g1', on: true }] }], masterDb: -2 })
    expect(sanitizeMixer(once)).toEqual(once)
  })

  it('clamp helper respects both ends', () => {
    expect(clamp(5, [0, 3])).toBe(3)
    expect(clamp(-5, [0, 3])).toBe(0)
    expect(clamp(2, [0, 3])).toBe(2)
  })
})

describe('strips with their own input device', () => {
  const mic = { deviceId: 'abc123', label: 'MacBook Pro Microphone (Built-in)' }
  const usb = { deviceId: 'def456', label: 'USB Audio Device (0d8c:0014)' }

  it('shortens a device label to what fits on a strip', () => {
    expect(shortDeviceName('MacBook Pro Microphone (Built-in)')).toBe('MacBook Pro Microphone')
    expect(shortDeviceName('Default - BlackHole 2ch (Virtual)')).toBe('BlackHole 2ch')
    expect(shortDeviceName('Plain Name')).toBe('Plain Name')
    expect(shortDeviceName('')).toBe('Input')
    expect(shortDeviceName('(only brackets)')).toBe('(only brackets)')
  })

  it('names a strip after its device and channel, and keeps "USB n" only for the default source', () => {
    expect(defaultStrip(0).name).toBe('USB 1')
    expect(defaultStrip(1, undefined, mic).name).toBe('MacBook Pro Microphone 2'.slice(0, 24))
    expect(defaultStrip(1, undefined, mic).name.length).toBeLessThanOrEqual(24)
    expect(defaultStrip(1, undefined, usb).name).toBe('USB Audio Device 2')
  })

  it('tells strips apart by device AND channel', () => {
    expect(stripKey({ channel: 0 })).not.toBe(stripKey({ channel: 0, source: mic }))
    expect(stripKey({ channel: 0, source: mic })).not.toBe(stripKey({ channel: 0, source: usb }))
    expect(stripKey({ channel: 0, source: mic })).toBe(stripKey({ channel: 0, source: { ...mic, label: 'renamed' } })) // the id identifies the device, not its label
  })

  it('keeps channel 1 of two different devices as two strips, and drops a true duplicate', () => {
    const m = sanitizeMixer({ strips: [{ channel: 0, source: mic }, { channel: 0, source: usb }, { channel: 0, source: mic }, { channel: 0 }] })
    expect(m.strips.map((x) => [x.source?.deviceId ?? 'default', x.channel])).toEqual([['abc123', 0], ['def456', 0], ['default', 0]])
  })

  it('keeps a valid source through validation', () => {
    expect(sanitizeMixer({ strips: [{ channel: 3, source: usb }] }).strips[0]).toMatchObject({ channel: 3, source: usb, name: 'USB Audio Device 4' })
  })

  it('ignores a malformed source instead of failing: the strip falls back to the default source', () => {
    for (const bad of [{ deviceId: 5 }, { deviceId: '' }, { deviceId: 'x'.repeat(301) }, 'mic', null]) {
      const strip = sanitizeMixer({ strips: [{ channel: 1, source: bad }] }).strips[0]
      expect(strip.source, JSON.stringify(bad)).toBeUndefined()
      expect(strip.name).toBe('USB 2')
    }
  })

  it('limits an over-long device label', () => {
    expect(sanitizeMixer({ strips: [{ channel: 0, source: { deviceId: 'a', label: 'L'.repeat(500) } }] }).strips[0].source?.label).toHaveLength(120)
  })

  it('is stable: sanitising a mixer with sources changes nothing', () => {
    const once = sanitizeMixer({ strips: [{ channel: 2, source: mic, faderDb: -6 }, { channel: 0 }] })
    expect(sanitizeMixer(once)).toEqual(once)
  })

  it('offers synthetic test sources with ids the engine recognises', () => {
    for (const t of TEST_SOURCES) {
      expect(t.deviceId.startsWith('test:')).toBe(true)
      expect(t.channels).toBeGreaterThan(0)
    }
  })
})

describe('the monitor output (listening to the stream mix)', () => {
  it('is off by default, on the default output, at -6 dB', () => {
    expect(defaultMixer().monitor).toEqual({ on: false, deviceId: '', label: '', gainDb: -6 })
    expect(defaultMonitor.on).toBe(false)
  })
  it('keeps its settings through validation', () => {
    const monitor = { on: true, deviceId: 'abc', label: 'Headphones (USB)', gainDb: -12 }
    expect(sanitizeMixer({ strips: [], monitor }).monitor).toEqual(monitor)
  })
  it('a mixer file from before it existed gets the defaults', () => {
    expect(sanitizeMixer({ strips: [{ channel: 0 }] }).monitor).toEqual(defaultMonitor)
  })
  it('clamps the level and replaces wrong types', () => {
    expect(sanitizeMixer({ strips: [], monitor: { gainDb: 99 } }).monitor.gainDb).toBe(RANGES.monitorDb[1])
    expect(sanitizeMixer({ strips: [], monitor: { gainDb: -999 } }).monitor.gainDb).toBe(RANGES.monitorDb[0])
    expect(sanitizeMixer({ strips: [], monitor: { on: 'yes', deviceId: 5, label: 7, gainDb: 'loud' } }).monitor).toEqual(defaultMonitor)
  })
  it('limits an over-long device id and label', () => {
    const m = sanitizeMixer({ strips: [], monitor: { deviceId: 'x'.repeat(301), label: 'L'.repeat(500) } }).monitor
    expect(m.deviceId).toBe('')
    expect(m.label).toHaveLength(120)
  })
  it('is stable: sanitising its own output changes nothing', () => {
    const once = sanitizeMixer({ strips: [], monitor: { on: true, deviceId: 'd', label: 'x', gainDb: -3 } })
    expect(sanitizeMixer(once)).toEqual(once)
  })
})

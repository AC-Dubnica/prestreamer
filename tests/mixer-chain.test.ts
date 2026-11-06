import { describe, expect, it } from 'vitest'
import {
  EFFECT_INFO, EFFECT_TYPES, MASTER_PRESETS, MAX_EFFECTS, RANGES, STRIP_PRESETS, defaultEffect, defaultMixer, defaultStrip, findEffect, makeEffect, newEffectId, sanitizeChain, sanitizeMixer,
  type Effect, type MixerConfig,
} from '../src/shared/mixer'

const ids = (chain: Effect[]) => chain.map((e) => e.id)
const types = (chain: Effect[]) => chain.map((e) => e.type)

describe('the default mixer', () => {
  it('has strips with an empty chain, and a master chain with a limiter and a sync delay (at 0 ms) whose ids never change', () => {
    expect(defaultStrip(0).chain).toEqual([])
    expect(defaultMixer().masterChain).toEqual([{ id: 'master-limiter', type: 'limiter', on: true, ceilingDb: -1 }, { id: 'master-sync-delay', type: 'syncdelay', on: true, timeMs: 0 }])
    expect(defaultMixer()).toEqual(defaultMixer())
  })
  it('gives every effect an id of its own', () => {
    expect(newEffectId()).not.toBe(newEffectId())
    expect(defaultEffect('comp').id).not.toBe(defaultEffect('comp').id)
    expect(defaultEffect('comp', 'fixed').id).toBe('fixed')
  })
})

describe('effects', () => {
  it('every type has defaults, a name and a description, and is on when added', () => {
    for (const type of EFFECT_TYPES) {
      const e = defaultEffect(type)
      expect(e.type).toBe(type)
      expect(e.on).toBe(true)
      expect(EFFECT_INFO[type].label.length).toBeGreaterThan(1)
      expect(EFFECT_INFO[type].blurb.length).toBeGreaterThan(20)
    }
  })
  it('makeEffect changes only what it is told to', () => {
    const e = makeEffect('comp', { ratio: 8 })
    expect(e).toMatchObject({ type: 'comp', ratio: 8, thresholdDb: defaultEffect('comp').thresholdDb, on: true })
  })
  it('findEffect finds the first one of a type', () => {
    const chain = [makeEffect('eq'), makeEffect('comp', { ratio: 2 }), makeEffect('comp', { ratio: 9 })]
    expect(findEffect(chain, 'comp')?.ratio).toBe(2)
    expect(findEffect(chain, 'gate')).toBeUndefined()
  })
})

describe('sanitizeChain (untrusted JSON)', () => {
  it('keeps every kind of effect, with its id and settings, unchanged', () => {
    const chain = EFFECT_TYPES.map((t) => defaultEffect(t))
    expect(sanitizeChain(chain, new Set())).toEqual(chain)
  })
  it('keeps the order', () => {
    const chain = [makeEffect('limiter'), makeEffect('hpf'), makeEffect('comp'), makeEffect('eq')]
    expect(types(sanitizeChain(chain, new Set()))).toEqual(['limiter', 'hpf', 'comp', 'eq'])
  })
  it('drops what is not an effect we know, and anything that is not a list', () => {
    expect(types(sanitizeChain([{ type: 'flanger' }, 5, null, 'comp', { id: 'a' }, { type: 'comp' }], new Set()))).toEqual(['comp'])
    for (const bad of [null, undefined, 5, 'x', {}]) expect(sanitizeChain(bad, new Set())).toEqual([])
  })
  it('clamps every setting and replaces wrong types with the defaults', () => {
    const [d, r, e] = sanitizeChain([
      { type: 'deesser', id: 'd', freq: 99999, thresholdDb: -999, reductionDb: 'lots' },
      { type: 'reverb', id: 'r', decaySec: 1000, mix: 7, preDelayMs: -5, dampingHz: NaN },
      { type: 'delay', id: 'e', feedback: 5, timeMs: 0, mix: -1, toneHz: Infinity },
    ], new Set()) as [Effect, Effect, Effect]
    expect(d).toMatchObject({ freq: 12000, thresholdDb: -60, reductionDb: 8 })
    expect(r).toMatchObject({ decaySec: 6, mix: 1, preDelayMs: 0, dampingHz: 6000 })
    expect(e).toMatchObject({ feedback: 0.9, timeMs: 10, mix: 0, toneHz: 3500 })
  })
  it('never lets a delay feed back on itself without end', () => {
    for (const fb of [1, 2, 100]) expect((sanitizeChain([{ type: 'delay', id: 'x', feedback: fb }], new Set())[0] as { feedback: number }).feedback).toBeLessThan(1)
  })
  it('caps the length of a chain', () => {
    const many = Array.from({ length: 40 }, () => defaultEffect('eq'))
    expect(sanitizeChain(many, new Set())).toHaveLength(MAX_EFFECTS)
  })
  it('keeps an id it was given and only makes a new one when it is missing, malformed or repeated', () => {
    const out = sanitizeChain([{ type: 'eq', id: 'keep-me' }, { type: 'eq' }, { type: 'eq', id: 'keep-me' }, { type: 'eq', id: 'has space' }, { type: 'eq', id: 5 }], new Set())
    expect(out[0].id).toBe('keep-me')
    expect(new Set(ids(out)).size).toBe(5)
    for (const e of out) expect(e.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/)
  })
  it('is stable: sanitising its own output changes nothing, ids included', () => {
    const once = sanitizeChain([{ type: 'gate' }, { type: 'comp' }, { type: 'reverb' }], new Set())
    expect(sanitizeChain(once, new Set())).toEqual(once)
  })
})

describe('sanitizeMixer with chains', () => {
  const mixer = (): MixerConfig => ({
    ...defaultMixer(),
    strips: [{ ...defaultStrip(0), chain: [makeEffect('hpf'), makeEffect('comp')] }, { ...defaultStrip(1), chain: [makeEffect('eq'), makeEffect('deesser')] }],
    masterChain: [makeEffect('comp'), makeEffect('limiter')],
  })

  it('round-trips a mixer with chains on its strips and its master, ids and all', () => {
    const m = mixer()
    expect(sanitizeMixer(m)).toEqual(m)
  })
  it('keeps effect ids unique across strips and the master (the meters are looked up by id)', () => {
    const m = mixer()
    m.strips[1].chain[0].id = m.strips[0].chain[0].id
    m.masterChain[0].id = m.strips[0].chain[0].id
    const out = sanitizeMixer(m)
    const all = [...out.strips.flatMap((s) => ids(s.chain)), ...ids(out.masterChain)]
    expect(new Set(all).size).toBe(all.length)
  })
  it('an empty master chain stays empty (no limiter is forced back in)', () => {
    expect(sanitizeMixer({ ...mixer(), masterChain: [] }).masterChain).toEqual([])
  })
  it('a mixer file without any master settings gets the default master chain', () => {
    expect(sanitizeMixer({ strips: [] }).masterChain).toEqual(defaultMixer().masterChain)
  })
})

describe('mixer files saved before chains existed', () => {
  const old = (patch: object) => ({ ...defaultStrip(2), ...patch })
  const legacyOff = {
    hpf: { on: false, freq: 80 },
    eq: { on: false, lowFreq: 100, lowGainDb: 0, midFreq: 1000, midGainDb: 0, midQ: 1, highFreq: 8000, highGainDb: 0 },
    gate: { on: false, thresholdDb: -50, rangeDb: 40, attackMs: 5, holdMs: 50, releaseMs: 200 },
    comp: { on: false, thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 150, kneeDb: 6, makeupDb: 0 },
    limiter: { on: false, ceilingDb: -1 },
  }
  const withoutChain = (s: object) => { const { chain: _c, ...rest } = s as { chain?: unknown }; return rest }

  it('turns the modules that were in use into a chain, in the old fixed order, keeping their switches and settings', () => {
    const strip = { ...withoutChain(old({})), ...legacyOff, limiter: { on: true, ceilingDb: -6 }, hpf: { on: true, freq: 120 }, comp: { ...legacyOff.comp, on: true, ratio: 4 } }
    const m = sanitizeMixer({ strips: [strip] })
    expect(types(m.strips[0].chain)).toEqual(['hpf', 'comp', 'limiter'])
    expect(m.strips[0].chain[0]).toMatchObject({ on: true, freq: 120 })
    expect(m.strips[0].chain[1]).toMatchObject({ on: true, ratio: 4 })
    expect(m.strips[0].chain[2]).toMatchObject({ on: true, ceilingDb: -6 })
  })
  it('leaves out modules that were off and untouched: they were just "nothing here"', () => {
    expect(sanitizeMixer({ strips: [{ ...withoutChain(old({})), ...legacyOff }] }).strips[0].chain).toEqual([])
  })
  it('keeps a module that was switched off but had been set up', () => {
    const strip = { ...withoutChain(old({})), ...legacyOff, eq: { ...legacyOff.eq, midGainDb: 6 } }
    const chain = sanitizeMixer({ strips: [strip] }).strips[0].chain
    expect(chain).toHaveLength(1)
    expect(chain[0]).toMatchObject({ type: 'eq', on: false, midGainDb: 6 })
  })
  it('does not switch on a module that is missing its switch', () => {
    const chain = sanitizeMixer({ strips: [{ channel: 0, comp: { ratio: 8 } }] }).strips[0].chain
    expect(chain[0]).toMatchObject({ type: 'comp', on: false, ratio: 8 })
  })
  it('turns the old master limiter into the master chain', () => {
    expect(sanitizeMixer({ strips: [], masterLimiter: { on: true, ceilingDb: -3 } }).masterChain).toMatchObject([{ type: 'limiter', on: true, ceilingDb: -3 }])
    expect(sanitizeMixer({ strips: [], masterLimiter: { on: false, ceilingDb: -1 } }).masterChain).toMatchObject([{ type: 'limiter', on: false }])
  })
  it('migrating twice gives the same result as migrating once', () => {
    const strip = { ...withoutChain(old({})), ...legacyOff, gate: { ...legacyOff.gate, on: true } }
    const once = sanitizeMixer({ strips: [strip], masterLimiter: { on: true, ceilingDb: -2 } })
    expect(sanitizeMixer(once)).toEqual(once)
  })
})

describe('the sync delay effect', () => {
  it('is an effect like the others, on a channel or on the master, with its time clamped', () => {
    expect(EFFECT_TYPES).toContain('syncdelay')
    expect(EFFECT_INFO.syncdelay.label).toBe('Sync delay')
    expect(defaultEffect('syncdelay')).toMatchObject({ type: 'syncdelay', on: true, timeMs: 150 })
    const [a, b] = sanitizeChain([{ type: 'syncdelay', id: 'a', timeMs: 99999 }, { type: 'syncdelay', id: 'b', timeMs: -5 }], new Set())
    expect([(a as { timeMs: number }).timeMs, (b as { timeMs: number }).timeMs]).toEqual([RANGES.syncDelayMs[1], 0])
  })
})

describe('mixer files saved when the master delay was a box of its own', () => {
  const limiter = [{ type: 'limiter', id: 'master-limiter', on: true, ceilingDb: -1 }]
  const sync = (m: MixerConfig) => m.masterChain.filter((e) => e.type === 'syncdelay') as { timeMs: number; id: string; on: boolean }[]

  it('turns a delay into a Sync delay effect at the end of the master chain, with the same time', () => {
    const m = sanitizeMixer({ strips: [], masterChain: limiter, delayMs: 250 })
    expect(types(m.masterChain)).toEqual(['limiter', 'syncdelay'])
    expect(sync(m)[0]).toMatchObject({ timeMs: 250, on: true, id: 'master-sync-delay' })
  })
  it('a delay of 0 still brings the Sync delay along, so the master keeps showing a place for it', () => {
    expect(sync(sanitizeMixer({ strips: [], masterChain: limiter, delayMs: 0 }))[0].timeMs).toBe(0)
  })
  it('works together with the old master limiter', () => {
    const m = sanitizeMixer({ strips: [], masterLimiter: { on: true, ceilingDb: -3 }, delayMs: 120 })
    expect(types(m.masterChain)).toEqual(['limiter', 'syncdelay'])
    expect(sync(m)[0].timeMs).toBe(120)
  })
  it('clamps a silly delay', () => {
    expect(sync(sanitizeMixer({ strips: [], masterChain: limiter, delayMs: 99999 }))[0].timeMs).toBe(RANGES.syncDelayMs[1])
  })
  it('does not add a second one when the chain already has a Sync delay, nor to a chain with no room', () => {
    const own = [...limiter, { type: 'syncdelay', id: 'mine', on: true, timeMs: 40 }]
    expect(sync(sanitizeMixer({ strips: [], masterChain: own, delayMs: 250 }))).toHaveLength(1)
    const full = Array.from({ length: MAX_EFFECTS }, () => defaultEffect('eq'))
    expect(sanitizeMixer({ strips: [], masterChain: full, delayMs: 250 }).masterChain).toHaveLength(MAX_EFFECTS)
  })
  it('a file in the new format (no delay setting) is left as it is, even without a Sync delay', () => {
    expect(sanitizeMixer({ strips: [], masterChain: limiter }).masterChain).toHaveLength(1)
    expect(sanitizeMixer({ strips: [], masterChain: [] }).masterChain).toEqual([])
  })
  it('migrating twice gives the same as migrating once (and the delay setting is gone)', () => {
    const once = sanitizeMixer({ strips: [], masterChain: limiter, delayMs: 180 })
    expect(sanitizeMixer(once)).toEqual(once)
    expect('delayMs' in once).toBe(false)
  })
})

describe('chain presets', () => {
  const all = [...STRIP_PRESETS, ...MASTER_PRESETS]
  it('are named and described, and build chains that are valid as they are', () => {
    for (const p of all) {
      expect(p.label.length).toBeGreaterThan(2)
      expect(p.blurb.length).toBeGreaterThan(10)
      const chain = p.build()
      expect(chain.length).toBeGreaterThan(0)
      expect(chain.length).toBeLessThanOrEqual(MAX_EFFECTS)
      expect(sanitizeChain(chain, new Set())).toEqual(chain)
    }
  })
  it('give every build new ids, so two channels never share an effect id', () => {
    for (const p of all) expect(new Set([...ids(p.build()), ...ids(p.build())]).size).toBe(p.build().length * 2)
  })
  it('the vocal chain follows the usual order: filter, tone, level, de-esser, space', () => {
    expect(types(STRIP_PRESETS.find((p) => p.id === 'vocal')!.build())).toEqual(['hpf', 'eq', 'comp', 'deesser', 'reverb'])
  })
  it('the master presets end with a limiter, so nothing gets past the ceiling', () => {
    for (const p of MASTER_PRESETS) expect(types(p.build()).at(-1)).toBe('limiter')
  })
})

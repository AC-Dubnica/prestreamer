import { describe, expect, it } from 'vitest'
import { compOutDb, eqResponseDb, gateOutDb, limiterOutDb, moveBefore, normToValue, snap, valueToNorm } from '../src/shared/curves'
import { defaultStrip } from '../src/shared/mixer'

const eqOn = (patch: object) => ({ ...defaultStrip(0).eq, on: true, ...patch })

describe('knob mapping', () => {
  it('maps linearly and back', () => {
    expect(normToValue(0.5, [-24, 24])).toBe(0)
    expect(valueToNorm(0, [-24, 24])).toBe(0.5)
  })
  it('maps log ranges: the middle of 20–20000 Hz is 632 Hz', () => {
    expect(normToValue(0.5, [20, 20000], true)).toBeCloseTo(632.5, 0)
    expect(valueToNorm(632.455, [20, 20000], true)).toBeCloseTo(0.5, 3)
  })
  it('clamps out-of-range input and snaps to steps', () => {
    expect(normToValue(2, [0, 10])).toBe(10)
    expect(valueToNorm(-5, [0, 10])).toBe(0)
    expect(snap(3.26, 0.5)).toBe(3.5)
  })
})

describe('moveBefore', () => {
  const k = (s: string) => s
  it('moves before and after a target', () => {
    expect(moveBefore(['a', 'b', 'c', 'd'], k, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveBefore(['a', 'b', 'c', 'd'], k, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd'])
  })
  it('returns the same list for no-ops and unknown keys', () => {
    const l = ['a', 'b', 'c']
    expect(moveBefore(l, k, 'a', 'a')).toBe(l)
    expect(moveBefore(l, k, 'a', 'b')).toBe(l) // already just before b
    expect(moveBefore(l, k, 'b', 'a', true)).toBe(l) // already just after a
    expect(moveBefore(l, k, 'x', 'a')).toBe(l)
    expect(moveBefore(l, k, 'a', 'x')).toBe(l)
  })
})

describe('eqResponseDb', () => {
  it('is flat when off or at 0 dB gain', () => {
    expect(eqResponseDb({ ...defaultStrip(0).eq, midGainDb: 12 }, 1000)).toBe(0)
    expect(eqResponseDb(eqOn({}), 1000)).toBeCloseTo(0, 6)
  })
  it('peaks by the mid gain at the mid frequency', () => {
    expect(eqResponseDb(eqOn({ midGainDb: 9, midFreq: 2000 }), 2000)).toBeCloseTo(9, 1)
  })
  it('low shelf boosts the bass and leaves the treble; high shelf the reverse', () => {
    const low = eqOn({ lowGainDb: 10 })
    expect(eqResponseDb(low, 30)).toBeGreaterThan(9)
    expect(Math.abs(eqResponseDb(low, 10000))).toBeLessThan(1)
    const high = eqOn({ highGainDb: -10 })
    expect(eqResponseDb(high, 18000)).toBeLessThan(-8)
    expect(Math.abs(eqResponseDb(high, 200))).toBeLessThan(1)
  })
})

describe('dynamics curves', () => {
  const comp = { thresholdDb: -24, ratio: 4, kneeDb: 0, makeupDb: 0 }
  it('compressor leaves quiet sound alone and divides the excess by the ratio', () => {
    expect(compOutDb(comp, -40)).toBe(-40)
    expect(compOutDb(comp, -4)).toBe(-24 + 20 / 4)
  })
  it('make-up gain lifts everything; a soft knee is continuous at the knee edges', () => {
    expect(compOutDb({ ...comp, makeupDb: 6 }, -40)).toBe(-34)
    const soft = { ...comp, kneeDb: 10 }
    expect(compOutDb(soft, -29)).toBeCloseTo(-29, 6)
    expect(compOutDb(soft, -19)).toBeCloseTo(-24 + 5 / 4, 6)
  })
  it('gate turns down what is under the threshold by the range', () => {
    expect(gateOutDb({ thresholdDb: -50, rangeDb: 40 }, -60)).toBe(-100)
    expect(gateOutDb({ thresholdDb: -50, rangeDb: 40 }, -30)).toBe(-30)
  })
  it('limiter stops at the ceiling', () => {
    expect(limiterOutDb(-1, 6)).toBe(-1)
    expect(limiterOutDb(-1, -20)).toBe(-20)
  })
})

import { describe, expect, it } from 'vitest'
import { reverbImpulse } from '../src/shared/reverb'

const energy = (a: Float32Array, from: number, to: number) => { let e = 0; for (let i = from; i < to; i++) e += a[i] * a[i]; return e }
/** Energy of the sample-to-sample change: large for bright (high-frequency) content, small for dark. */
const brightness = (a: Float32Array) => { let e = 0; for (let i = 1; i < a.length; i++) e += (a[i] - a[i - 1]) ** 2; return e / (energy(a, 0, a.length) || 1) }

describe('reverbImpulse', () => {
  const sr = 48000
  it('is as long as the decay and has two different channels', () => {
    const [l, r] = reverbImpulse(sr, 1.5, 6000)
    expect(l.length).toBe(72000)
    expect(r.length).toBe(72000)
    expect(l).not.toEqual(r)
  })
  it('is the same every time for the same settings (no hidden randomness)', () => {
    expect(reverbImpulse(sr, 1, 6000)[0]).toEqual(reverbImpulse(sr, 1, 6000)[0])
  })
  it('fades away: the last quarter holds far less energy than the first', () => {
    const [l] = reverbImpulse(sr, 2, 8000)
    const q = Math.floor(l.length / 4)
    expect(energy(l, 3 * q, l.length)).toBeLessThan(energy(l, 0, q) / 50)
  })
  it('stays within a sane level and starts silent (no click)', () => {
    const [l, r] = reverbImpulse(sr, 1, 8000)
    for (const ch of [l, r]) { expect(Math.max(...ch.map(Math.abs))).toBeLessThanOrEqual(1); expect(ch[0]).toBe(0) }
  })
  it('is darker with lower damping', () => {
    expect(brightness(reverbImpulse(sr, 1, 1500)[0])).toBeLessThan(brightness(reverbImpulse(sr, 1, 12000)[0]) / 2)
  })
  it('holds its length within limits whatever it is asked for', () => {
    expect(reverbImpulse(sr, 100, 6000)[0].length).toBe(6 * sr)
    expect(reverbImpulse(sr, 0, 6000)[0].length).toBeGreaterThan(0)
  })
})

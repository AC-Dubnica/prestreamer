import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The audio worklets are plain scripts for the browser's audio thread. Here they run in Node with the three things they expect
 * (AudioWorkletProcessor, registerProcessor, sampleRate) stood in, fed with synthetic signals, and their output is measured.
 */
const SR = 48000
type Params = Record<string, number>
interface Proc { port: { messages: number[]; postMessage(x: number): void }; process(i: Float32Array[][], o: Float32Array[][], p: Record<string, number[]>): boolean }

function load(file: string): new () => Proc {
  const code = readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8')
  let found: (new () => Proc) | null = null
  class AudioWorkletProcessor { port = { messages: [] as number[], postMessage(x: number) { this.messages.push(x) } } }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', code)(AudioWorkletProcessor, (_name: string, ctor: new () => Proc) => { found = ctor }, SR)
  return found!
}

/** Runs whole signals through a processor in 128-frame blocks, like the browser does. */
function run(Ctor: new () => Proc, params: Params, channels: Float32Array[]): { out: Float32Array[]; proc: Proc } {
  const proc = new Ctor()
  const out = channels.map((c) => new Float32Array(c.length))
  const p = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, [v]]))
  for (let at = 0; at < channels[0].length; at += 128) {
    const block = (arr: Float32Array[]) => arr.map((c) => c.subarray(at, Math.min(at + 128, c.length)))
    proc.process([block(channels)], [block(out)], p)
  }
  return { out, proc }
}

const sine = (freq: number, amp: number, seconds = 1) => Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * freq * i) / SR))
const rms = (a: Float32Array, fromFraction = 0.5) => { let e = 0; const from = Math.floor(a.length * fromFraction); for (let i = from; i < a.length; i++) e += a[i] * a[i]; return Math.sqrt(e / (a.length - from)) }
const db = (x: number) => 20 * Math.log10(x)
const maxDiff = (a: Float32Array, b: Float32Array) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m }

describe('de-esser worklet', () => {
  const Deesser = load('deesser-worklet.js')
  const on = { enabled: 1, frequency: 6500, threshold: -30, reduction: 8 }

  it('passes the signal on unchanged while switched off', () => {
    const x = sine(7000, 0.5)
    expect(maxDiff(run(Deesser, { ...on, enabled: 0 }, [x]).out[0], x)).toBe(0)
  })
  it('leaves a signal below its threshold exactly as it was (the split adds back up to the input)', () => {
    const x = sine(7000, 0.001)
    expect(maxDiff(run(Deesser, on, [x]).out[0], x)).toBeLessThan(1e-6)
  })
  it('turns down a loud sibilant tone by about the amount set (the split filter can add a dB or two)', () => {
    for (const freq of [5500, 7000, 9000]) {
      const x = sine(freq, 0.5)
      const cut = db(rms(x)) - db(rms(run(Deesser, on, [x]).out[0]))
      expect(cut, `${freq} Hz`).toBeGreaterThan(6)
      expect(cut, `${freq} Hz`).toBeLessThan(11)
    }
  })
  it('turns down more with a bigger amount', () => {
    const x = sine(7000, 0.5)
    const cut = (reduction: number) => db(rms(x)) - db(rms(run(Deesser, { ...on, reduction }, [x]).out[0]))
    expect(cut(16)).toBeGreaterThan(cut(8) + 4)
    expect(cut(0)).toBeLessThan(0.1)
  })
  it('does not touch a loud low tone: only the high band is reduced', () => {
    const x = sine(200, 0.5)
    expect(Math.abs(db(rms(x)) - db(rms(run(Deesser, on, [x]).out[0])))).toBeLessThan(0.5)
  })
  it('reduces both channels of a stereo signal by the same amount', () => {
    const x = sine(7000, 0.5)
    const { out } = run(Deesser, on, [x, x])
    expect(Math.abs(db(rms(out[0])) - db(rms(out[1])))).toBeLessThan(0.01)
  })
  it('reports how much it is reducing, as a number of dB at or below zero', () => {
    const { proc } = run(Deesser, on, [sine(7000, 0.5)])
    expect(proc.port.messages.length).toBeGreaterThan(5)
    expect(proc.port.messages.at(-1)!).toBeLessThan(-3)
    expect(Math.max(...proc.port.messages)).toBeLessThanOrEqual(0)
  })
})

describe('gate worklet', () => {
  const Gate = load('gate-worklet.js')
  const closed = { enabled: 1, threshold: -20, range: 40, attack: 1, hold: 10, release: 20 }

  it('passes the signal on unchanged while switched off', () => {
    const x = sine(440, 0.5)
    expect(maxDiff(run(Gate, { ...closed, enabled: 0 }, [x]).out[0], x)).toBe(0)
  })
  it('lets a signal above the threshold through', () => {
    const x = sine(440, 0.5)
    expect(Math.abs(db(rms(x)) - db(rms(run(Gate, closed, [x]).out[0])))).toBeLessThan(0.5)
  })
  it('closes on a signal below the threshold, by the range', () => {
    const x = sine(440, 0.01) // -40 dBFS
    const cut = db(rms(x)) - db(rms(run(Gate, closed, [x]).out[0]))
    expect(cut).toBeGreaterThan(35)
  })
  it('treats a stereo signal as one: a loud left channel keeps the quiet right one open', () => {
    const { out } = run(Gate, closed, [sine(440, 0.5), sine(880, 0.01)])
    expect(Math.abs(db(rms(out[1])) - db(rms(sine(880, 0.01))))).toBeLessThan(0.5)
  })
  it('applies the same gain to both channels, so the stereo image does not move', () => {
    const x = sine(440, 0.01)
    const { out } = run(Gate, closed, [x, x])
    expect(maxDiff(out[0], out[1])).toBe(0)
  })
  it('reports how far it is closed (0 dB open, negative when closed)', () => {
    const open = run(Gate, closed, [sine(440, 0.5)]).proc.port.messages
    const shut = run(Gate, closed, [sine(440, 0.01)]).proc.port.messages
    expect(open.at(-1)!).toBeGreaterThan(-1)
    expect(shut.at(-1)!).toBeLessThan(-30)
  })
})

/**
 * Pure maths behind the mixer's knobs and graphs: how a knob position maps to a value, and the response curves drawn for
 * the EQ, compressor and gate. They mirror what the audio engine does, so the picture shows what is heard.
 */
import type { CompConfig, EqConfig, GateConfig } from './mixer'

/** Knob position 0…1 → value. Frequencies and times feel natural on a log scale. */
export function normToValue(norm: number, [lo, hi]: readonly [number, number], log = false): number {
  const n = Math.min(1, Math.max(0, norm))
  return log && lo > 0 ? lo * (hi / lo) ** n : lo + (hi - lo) * n
}

export function valueToNorm(value: number, [lo, hi]: readonly [number, number], log = false): number {
  const v = Math.min(hi, Math.max(lo, value))
  if (hi === lo) return 0
  return log && lo > 0 ? Math.log(v / lo) / Math.log(hi / lo) : (v - lo) / (hi - lo)
}

/** Rounds to the step, so a dragged knob lands on tidy numbers. */
export const snap = (v: number, step: number): number => Math.round(v / step) * step

/** Moves one item of a list to sit before (or after) another, found by key. Returns the same order if nothing would change. */
export function moveBefore<T>(items: T[], key: (t: T) => string, fromKey: string, toKey: string, after = false): T[] {
  if (fromKey === toKey) return items
  const from = items.findIndex((i) => key(i) === fromKey)
  if (from < 0 || !items.some((i) => key(i) === toKey)) return items
  const rest = items.filter((_, i) => i !== from)
  const to = rest.findIndex((i) => key(i) === toKey)
  const out = [...rest.slice(0, after ? to + 1 : to), items[from], ...rest.slice(after ? to + 1 : to)]
  return out.every((x, i) => x === items[i]) ? items : out
}

type Biquad = { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

/** RBJ cookbook coefficients for the three filter types the EQ uses (Web Audio's shelves use S = 1). */
function biquad(type: 'lowshelf' | 'highshelf' | 'peaking', freq: number, gainDb: number, q: number, sampleRate: number): Biquad {
  const A = 10 ** (gainDb / 40)
  const w0 = (2 * Math.PI * freq) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  if (type === 'peaking') {
    const alpha = sin / (2 * q)
    return { b0: 1 + alpha * A, b1: -2 * cos, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * cos, a2: 1 - alpha / A }
  }
  const alpha = (sin / 2) * Math.SQRT2 // shelf slope 1
  const k = 2 * Math.sqrt(A) * alpha
  return type === 'lowshelf'
    ? { b0: A * (A + 1 - (A - 1) * cos + k), b1: 2 * A * (A - 1 - (A + 1) * cos), b2: A * (A + 1 - (A - 1) * cos - k), a0: A + 1 + (A - 1) * cos + k, a1: -2 * (A - 1 + (A + 1) * cos), a2: A + 1 + (A - 1) * cos - k }
    : { b0: A * (A + 1 + (A - 1) * cos + k), b1: -2 * A * (A - 1 + (A + 1) * cos), b2: A * (A + 1 + (A - 1) * cos - k), a0: A + 1 - (A - 1) * cos + k, a1: 2 * (A - 1 - (A + 1) * cos), a2: A + 1 - (A - 1) * cos - k }
}

function magnitudeDb(c: Biquad, freq: number, sampleRate: number): number {
  const w = (2 * Math.PI * freq) / sampleRate
  const cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * cw + c.b2 * c2, ni = -(c.b1 * sw + c.b2 * s2)
  const dr = c.a0 + c.a1 * cw + c.a2 * c2, di = -(c.a1 * sw + c.a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

/** Total EQ gain in dB at a frequency. Flat (0 dB) when the EQ is off. */
export function eqResponseDb(eq: EqConfig, freq: number, sampleRate = 48000): number {
  if (!eq.on) return 0
  const f = (x: number) => Math.min(x, sampleRate * 0.45)
  return (
    magnitudeDb(biquad('lowshelf', f(eq.lowFreq), eq.lowGainDb, 1, sampleRate), freq, sampleRate) +
    magnitudeDb(biquad('peaking', f(eq.midFreq), eq.midGainDb, eq.midQ, sampleRate), freq, sampleRate) +
    magnitudeDb(biquad('highshelf', f(eq.highFreq), eq.highGainDb, 1, sampleRate), freq, sampleRate)
  )
}

/** Compressor output level for an input level, with the soft knee used by the engine's worklet (make-up included). */
export function compOutDb(c: Pick<CompConfig, 'thresholdDb' | 'ratio' | 'kneeDb' | 'makeupDb'>, inDb: number): number {
  const over = inDb - c.thresholdDb
  let out: number
  if (2 * over < -c.kneeDb) out = inDb
  else if (c.kneeDb > 0 && 2 * Math.abs(over) <= c.kneeDb) out = inDb + ((1 / c.ratio - 1) * (over + c.kneeDb / 2) ** 2) / (2 * c.kneeDb)
  else out = c.thresholdDb + over / c.ratio
  return out + c.makeupDb
}

/** Gate output level: below the threshold the signal is turned down by the range. */
export const gateOutDb = (g: Pick<GateConfig, 'thresholdDb' | 'rangeDb'>, inDb: number): number => (inDb >= g.thresholdDb ? inDb : inDb - g.rangeDb)

/** Hard limiter: nothing passes the ceiling. */
export const limiterOutDb = (ceilingDb: number, inDb: number): number => Math.min(inDb, ceilingDb)

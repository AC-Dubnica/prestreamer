/**
 * The impulse response behind the Reverb effect: noise that fades away exponentially (60 dB down after `decaySec`),
 * darker the lower `dampingHz` is. Made, not recorded, so no audio file ships with the app and the same settings always
 * give the same sound (a fixed random seed per channel; the two channels differ, which is what makes it wide).
 */
export function reverbImpulse(sampleRate: number, decaySec: number, dampingHz: number): [Float32Array, Float32Array] {
  const length = Math.max(1, Math.round(sampleRate * Math.min(6, Math.max(0.1, decaySec))))
  const lowpass = 1 - Math.exp((-2 * Math.PI * Math.min(dampingHz, sampleRate * 0.45)) / sampleRate)
  return [make(length, sampleRate, lowpass, 0x9e3779b9), make(length, sampleRate, lowpass, 0x85ebca6b)]
}

/** Small deterministic random numbers (mulberry32), so an impulse response is reproducible. */
function random(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

function make(length: number, sampleRate: number, lowpass: number, seed: number): Float32Array {
  const rnd = random(seed)
  const out = new Float32Array(length)
  const decayPerSample = Math.log(1000) / length // 60 dB over the whole response
  let state = 0
  for (let i = 0; i < length; i++) {
    state += (rnd() - state) * lowpass
    out[i] = state * Math.exp(-decayPerSample * i)
  }
  // The first milliseconds ramp up, so the tail does not start with a click.
  const ramp = Math.min(length, Math.round(sampleRate * 0.002))
  for (let i = 0; i < ramp; i++) out[i] = out[i] * (i / ramp) + 0 // + 0 turns a negative zero into a plain one
  return out
}

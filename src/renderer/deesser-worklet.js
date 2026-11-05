// De-esser: lowers only the high band, and only while it is too loud, so a sharp "s" is softened and the rest of the voice is
// untouched. Runs in AudioWorkletGlobalScope, on any number of channels (one detector listens to all of them).
//   detector : band-pass around `frequency`
//   split    : low-pass at 0.5 x `frequency`; high = input - low, so with no reduction the output equals the input exactly
//              (a low-pass split keeps the high band in phase with the input, so the amount set is what a sibilant gets)
//   reduction: 4:1 above `threshold`; the high band is never turned down by more than `reduction` dB. A sibilant is turned down by about
//              that much (the split filter's slope can add a dB or two around its corner).
// The reduction is reported ~20 times a second for the meters.
class Deesser extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'frequency', defaultValue: 6500, minValue: 1000, maxValue: 16000, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -30, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'reduction', defaultValue: 8, minValue: 0, maxValue: 30, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.det = { x1: 0, x2: 0, y1: 0, y2: 0 }
    this.hp = [] // one filter memory per channel, created when the channel count is known
    this.env = 0
    this.grDb = 0
    this.sinceReport = 0
  }

  static coefficients(type, freq, q) {
    const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate
    const cos = Math.cos(w0)
    const alpha = Math.sin(w0) / (2 * q)
    const a0 = 1 + alpha
    if (type === 'bandpass') return { b0: alpha / a0, b1: 0, b2: -alpha / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
    return { b0: ((1 - cos) / 2) / a0, b1: (1 - cos) / a0, b2: ((1 - cos) / 2) / a0, a1: (-2 * cos) / a0, a2: (1 - alpha) / a0 }
  }

  process(inputs, outputs, p) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output || output.length === 0) return true
    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0)
      return true
    }
    const channels = Math.min(input.length, output.length)
    const frames = input[0].length

    if (p.enabled[0] < 0.5) {
      for (let c = 0; c < channels; c++) output[c].set(input[c])
      this.grDb = 0
      this.env = 0
    } else {
      const freq = p.frequency[0]
      const threshold = p.threshold[0]
      const maxReduction = p.reduction[0]
      const bp = Deesser.coefficients('bandpass', freq, 1.0)
      const lpc = Deesser.coefficients('lowpass', freq * 0.5, Math.SQRT1_2)
      while (this.hp.length < channels) this.hp.push({ x1: 0, x2: 0, y1: 0, y2: 0 })
      const attack = 1 - Math.exp(-1 / (0.001 * sampleRate))
      const release = 1 - Math.exp(-1 / (0.06 * sampleRate))
      const grAttack = 1 - Math.exp(-1 / (0.001 * sampleRate))
      const grRelease = 1 - Math.exp(-1 / (0.04 * sampleRate))
      const d = this.det
      for (let i = 0; i < frames; i++) {
        let mono = 0
        for (let c = 0; c < channels; c++) mono += input[c][i]
        mono /= channels
        const y = bp.b0 * mono + bp.b1 * d.x1 + bp.b2 * d.x2 - bp.a1 * d.y1 - bp.a2 * d.y2
        d.x2 = d.x1; d.x1 = mono; d.y2 = d.y1; d.y1 = y
        const level = Math.abs(y)
        this.env += (level - this.env) * (level > this.env ? attack : release)
        const levelDb = 20 * Math.log10(this.env + 1e-9)
        const over = levelDb - threshold
        const targetDb = over > 0 ? -Math.min(maxReduction, over * 0.75) : 0
        this.grDb += (targetDb - this.grDb) * (targetDb < this.grDb ? grAttack : grRelease)
        const gain = 10 ** (this.grDb / 20)
        for (let c = 0; c < channels; c++) {
          const h = this.hp[c]
          const x = input[c][i]
          const low = lpc.b0 * x + lpc.b1 * h.x1 + lpc.b2 * h.x2 - lpc.a1 * h.y1 - lpc.a2 * h.y2
          h.x2 = h.x1; h.x1 = x; h.y2 = h.y1; h.y1 = low
          output[c][i] = low + (x - low) * gain
        }
      }
    }

    this.sinceReport += frames
    if (this.sinceReport >= sampleRate / 20) {
      this.sinceReport = 0
      this.port.postMessage(this.grDb)
    }
    return true
  }
}
registerProcessor('deesser', Deesser)

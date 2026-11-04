// Downward-expander noise gate. Runs in AudioWorkletGlobalScope (mono in, mono out).
// Parameters are k-rate so the console UI can change them live.
class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: 40, minValue: 0, maxValue: 90, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 5, minValue: 0.1, maxValue: 200, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 50, minValue: 0, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 200, minValue: 1, maxValue: 5000, automationRate: 'k-rate' },
    ]
  }

  constructor() {
    super()
    this.env = 0 // peak envelope of the input
    this.gain = 1 // smoothed gate gain
    this.holdLeft = 0 // samples left before the gate may close
  }

  process(inputs, outputs, params) {
    const input = inputs[0] && inputs[0][0]
    const output = outputs[0] && outputs[0][0]
    if (!output) return true
    if (!input) {
      output.fill(0)
      return true
    }
    if (params.enabled[0] < 0.5) {
      output.set(input)
      this.gain = 1
      return true
    }

    const threshold = 10 ** (params.threshold[0] / 20)
    const floor = 10 ** (-params.range[0] / 20)
    const holdSamples = (params.hold[0] / 1000) * sampleRate
    const attackCoeff = 1 - Math.exp(-1 / ((params.attack[0] / 1000) * sampleRate))
    const releaseCoeff = 1 - Math.exp(-1 / ((params.release[0] / 1000) * sampleRate))
    const envDecay = Math.exp(-1 / (0.005 * sampleRate)) // 5 ms: fast enough to follow speech, smooth enough not to chatter

    for (let i = 0; i < input.length; i++) {
      const level = Math.abs(input[i])
      this.env = level > this.env ? level : this.env * envDecay
      if (this.env > threshold) this.holdLeft = holdSamples
      else if (this.holdLeft > 0) this.holdLeft--
      const target = this.env > threshold || this.holdLeft > 0 ? 1 : floor
      this.gain += (target - this.gain) * (target > this.gain ? attackCoeff : releaseCoeff)
      output[i] = input[i] * this.gain
    }
    return true
  }
}
registerProcessor('gate', Gate)

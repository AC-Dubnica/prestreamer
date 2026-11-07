// Runs in AudioWorkletGlobalScope: plays the multichannel samples the main process reads from an audio interface (see shared/native-audio.ts).
// The samples come from the interface's clock and are played on the mixer's, so they are buffered: a little cushion absorbs the
// uneven arrival, and when the clocks drift apart a single frame is dropped or repeated now and then to keep the cushion steady.
class NativeIn extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const { channels, targetMs } = options.processorOptions
    this.channels = channels
    this.capacity = sampleRate // one second per channel
    this.ring = Array.from({ length: channels }, () => new Float32Array(this.capacity))
    this.read = 0
    this.fill = 0
    this.target = Math.round((sampleRate * (targetMs || 60)) / 1000)
    this.band = Math.round(this.target / 2)
    this.primed = false
    this.fadeIn = false // the block after a start or a jump begins with a short ramp, so the join does not click
    this.port.onmessage = (e) => this.push(e.data)
  }

  /** Adds interleaved frames (a Float32Array). What does not fit pushes out the oldest. */
  push(data) {
    const ch = this.channels
    const frames = Math.floor(data.length / ch)
    if (frames > this.capacity) return
    const overflow = this.fill + frames - this.capacity
    if (overflow > 0) { this.read = (this.read + overflow) % this.capacity; this.fill -= overflow }
    let at = (this.read + this.fill) % this.capacity
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < ch; c++) this.ring[c][at] = data[i * ch + c]
      if (++at === this.capacity) at = 0
    }
    this.fill += frames
    // A long stall leaves a backlog that would stay as delay: keep only the newest cushion.
    if (this.fill > sampleRate / 4) { const drop = this.fill - this.target; this.read = (this.read + drop) % this.capacity; this.fill = this.target }
  }

  process(_inputs, outputs) {
    const out = outputs[0]
    const frames = out[0].length
    if (!this.primed) {
      if (this.fill < this.target) return true // the outputs are already silent
      this.primed = true
      this.fadeIn = true
    }
    // A backlog (the samples came in a burst after a stall) is cut back to the cushion at once. Taking it off one frame per block
    // instead would play everything slightly fast for seconds, which is audible as a wrong pitch.
    if (this.fill > this.target + this.band + sampleRate / 100) {
      const drop = this.fill - this.target
      this.read = (this.read + drop) % this.capacity
      this.fill = this.target
      this.fadeIn = true
    }
    // Within the band the clocks agree; outside it, take one frame more or less than the block asks for.
    const step = this.fill > this.target + this.band ? frames + 1 : this.fill < this.target - this.band ? frames - 1 : frames
    if (this.fill < step) { this.primed = false; return true } // ran dry: silence, then refill to the cushion
    const n = Math.min(out.length, this.channels)
    for (let c = 0; c < n; c++) {
      const ring = this.ring[c]
      const dest = out[c]
      let at = this.read
      for (let i = 0; i < frames; i++) {
        dest[i] = ring[at]
        if (++at === this.capacity) at = 0
      }
    }
    if (this.fadeIn) {
      this.fadeIn = false
      for (let c = 0; c < n; c++) for (let i = 0; i < frames; i++) out[c][i] *= i / frames
    }
    this.read = (this.read + step) % this.capacity
    this.fill -= step
    return true
  }
}
registerProcessor('native-in', NativeIn)

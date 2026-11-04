// Runs in AudioWorkletGlobalScope: taps the stereo stream mix and forwards interleaved f32 PCM.
class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (!input || input.length < 2) return true
    const frames = input[0].length
    const out = new Float32Array(frames * 2)
    for (let i = 0; i < frames; i++) {
      out[2 * i] = input[0][i]
      out[2 * i + 1] = input[1][i]
    }
    this.port.postMessage(out.buffer, [out.buffer])
    return true
  }
}
registerProcessor('pcm-tap', PcmTap)

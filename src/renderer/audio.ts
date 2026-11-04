import type { AudioApi } from '../preload/audio'
import { dbToGain, effectiveGains, gainToDb, type MixerConfig, type Strip } from '../shared/mixer'
import type { AudioConfig, Meters } from '../shared/types'

declare const audioBridge: AudioApi

const SAMPLE_RATE = 48000
const BATCH_FRAMES = 1024
const METER_INTERVAL_MS = 50
const SMOOTH_S = 0.01 // parameter changes glide over ~10 ms, so moving a fader does not click

interface StripNodes {
  channel: number
  trim: GainNode
  hpf: BiquadFilterNode
  low: BiquadFilterNode
  mid: BiquadFilterNode
  high: BiquadFilterNode
  gate: AudioWorkletNode
  comp: AudioWorkletNode
  limiter: AudioWorkletNode
  fader: GainNode
  pan: StereoPannerNode
  meter: AnalyserNode
  buf: Float32Array<ArrayBuffer>
  /** Latest compressor gain reduction in dB (≤ 0), reported by its worklet. */
  reductionDb: number
}

interface Graph {
  ctx: AudioContext
  stream: MediaStream | null
  channelCount: number
  splitter: ChannelSplitterNode
  sum: GainNode
  masterLimiter: AudioWorkletNode
  masterGain: GainNode
  masterMeters: [AnalyserNode, AnalyserNode]
  mute: GainNode
  strips: Map<number, StripNodes>
  timers: ReturnType<typeof setInterval>[]
  stop: (() => void)[]
}

let graph: Graph | null = null
let mixer: MixerConfig | null = null

function teardown(): void {
  const g = graph
  graph = null
  if (!g) return
  g.timers.forEach(clearInterval)
  g.stop.forEach((fn) => fn())
  g.stream?.getTracks().forEach((t) => t.stop())
  void g.ctx.close()
}

const param = (p: AudioParam, value: number, ctx: BaseAudioContext) => p.setTargetAtTime(value, ctx.currentTime, SMOOTH_S)

function createStrip(g: Graph, channel: number): StripNodes {
  const { ctx } = g
  const filter = (type: BiquadFilterType) => Object.assign(ctx.createBiquadFilter(), { type })
  const n: StripNodes = {
    channel,
    trim: ctx.createGain(),
    hpf: filter('highpass'),
    low: filter('lowshelf'),
    mid: filter('peaking'),
    high: filter('highshelf'),
    gate: new AudioWorkletNode(ctx, 'gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] }),
    comp: new AudioWorkletNode(ctx, 'compressor'),
    limiter: new AudioWorkletNode(ctx, 'compressor'),
    fader: ctx.createGain(),
    pan: ctx.createStereoPanner(),
    meter: ctx.createAnalyser(),
    buf: new Float32Array(1024),
    reductionDb: 0,
  }
  n.comp.port.onmessage = (e: MessageEvent<number>) => { n.reductionDb = e.data }
  n.meter.fftSize = 1024
  n.hpf.Q.value = Math.SQRT1_2
  if (channel < g.channelCount) g.splitter.connect(n.trim, channel, 0) // a channel the device does not have stays silent
  n.trim.connect(n.hpf).connect(n.low).connect(n.mid).connect(n.high).connect(n.gate).connect(n.comp).connect(n.limiter).connect(n.fader).connect(n.pan)
  n.pan.connect(n.meter)
  n.pan.connect(g.sum)
  n.meter.connect(g.mute) // analysers are only pulled when something downstream consumes them
  return n
}

function destroyStrip(n: StripNodes): void {
  for (const node of [n.trim, n.hpf, n.low, n.mid, n.high, n.gate, n.comp, n.limiter, n.fader, n.pan, n.meter]) node.disconnect()
}

/** Pushes one strip's settings into its nodes. "Off" sections are set to be transparent rather than rewired. */
function applyStrip(ctx: BaseAudioContext, n: StripNodes, s: Strip, gain: number): void {
  param(n.trim.gain, dbToGain(s.trimDb), ctx)
  param(n.hpf.frequency, s.hpf.on ? s.hpf.freq : 10, ctx)

  param(n.low.frequency, s.eq.lowFreq, ctx)
  param(n.low.gain, s.eq.on ? s.eq.lowGainDb : 0, ctx)
  param(n.mid.frequency, s.eq.midFreq, ctx)
  param(n.mid.Q, s.eq.midQ, ctx)
  param(n.mid.gain, s.eq.on ? s.eq.midGainDb : 0, ctx)
  param(n.high.frequency, s.eq.highFreq, ctx)
  param(n.high.gain, s.eq.on ? s.eq.highGainDb : 0, ctx)

  const gp = (name: string) => n.gate.parameters.get(name)!
  param(gp('enabled'), s.gate.on ? 1 : 0, ctx)
  param(gp('threshold'), s.gate.thresholdDb, ctx)
  param(gp('range'), s.gate.rangeDb, ctx)
  param(gp('attack'), s.gate.attackMs, ctx)
  param(gp('hold'), s.gate.holdMs, ctx)
  param(gp('release'), s.gate.releaseMs, ctx)

  const cp = (name: string) => n.comp.parameters.get(name)!
  param(cp('enabled'), s.comp.on ? 1 : 0, ctx)
  param(cp('threshold'), s.comp.thresholdDb, ctx)
  param(cp('ratio'), s.comp.ratio, ctx)
  param(cp('knee'), s.comp.kneeDb, ctx)
  param(cp('attack'), Math.max(0.01, s.comp.attackMs), ctx)
  param(cp('release'), s.comp.releaseMs, ctx)
  param(cp('makeup'), s.comp.makeupDb, ctx)

  configureLimiter(ctx, n.limiter, s.limiter.on, s.limiter.ceilingDb)
  param(n.fader.gain, gain, ctx)
  param(n.pan.pan, s.pan, ctx)
}

/** A limiter is the compressor worklet with a very high ratio, no knee and a near-instant attack. */
function configureLimiter(ctx: BaseAudioContext, node: AudioWorkletNode, on: boolean, ceilingDb: number): void {
  const p = (name: string) => node.parameters.get(name)!
  param(p('enabled'), on ? 1 : 0, ctx)
  param(p('threshold'), ceilingDb, ctx)
  param(p('ratio'), 100, ctx)
  param(p('knee'), 0, ctx)
  param(p('attack'), 0.05, ctx)
  param(p('release'), 80, ctx)
  param(p('makeup'), 0, ctx)
}

/** Brings the graph in line with the mixer: adds/removes strips, then updates every parameter. */
function applyMixer(m: MixerConfig): void {
  mixer = m
  const g = graph
  if (!g) return
  const wanted = new Set(m.strips.map((s) => s.channel))
  for (const [channel, nodes] of g.strips) {
    if (!wanted.has(channel)) {
      destroyStrip(nodes)
      g.strips.delete(channel)
    }
  }
  const gains = effectiveGains(m)
  m.strips.forEach((s, i) => {
    let nodes = g.strips.get(s.channel)
    if (!nodes) {
      nodes = createStrip(g, s.channel)
      g.strips.set(s.channel, nodes)
    }
    applyStrip(g.ctx, nodes, s, gains[i])
  })
  param(g.masterGain.gain, dbToGain(m.masterDb), g.ctx)
  configureLimiter(g.ctx, g.masterLimiter, m.masterLimiter.on, m.masterLimiter.ceilingDb)
}

const peakOf = (buf: Float32Array): number => {
  let peak = 0
  for (let i = 0; i < buf.length; i++) {
    const v = Math.abs(buf[i])
    if (v > peak) peak = v
  }
  return peak
}

function readMeters(g: Graph, m: MixerConfig): Meters {
  const strips = m.strips.map((s) => {
    const n = g.strips.get(s.channel)
    if (!n) return { peakDb: -100, rmsDb: -100, reductionDb: 0 }
    n.meter.getFloatTimeDomainData(n.buf)
    let sumSq = 0
    for (let i = 0; i < n.buf.length; i++) sumSq += n.buf[i] * n.buf[i]
    return { peakDb: gainToDb(peakOf(n.buf)), rmsDb: gainToDb(Math.sqrt(sumSq / n.buf.length)), reductionDb: n.reductionDb }
  })
  const master = g.masterMeters.map((a) => {
    const buf = new Float32Array(a.fftSize)
    a.getFloatTimeDomainData(buf)
    return gainToDb(peakOf(buf))
  }) as [number, number]
  return { strips, masterPeakDb: master }
}

/** 1 kHz beep at the start of every wall-clock second, for the A/V sync check. Returns a stop function. */
function startBeeps(c: AudioContext, out: AudioNode): () => void {
  const osc = c.createOscillator()
  osc.frequency.value = 1000
  const gate = c.createGain()
  gate.gain.value = 0
  osc.connect(gate).connect(out)
  osc.start()
  let scheduledUntil = 0
  const schedule = () => {
    const wallOffset = Date.now() - c.currentTime * 1000 // audio-clock -> wall-clock
    const horizon = Date.now() + 2000
    let next = Math.max(scheduledUntil + 1000, Math.ceil(Date.now() / 1000) * 1000)
    for (; next <= horizon; next += 1000) {
      const t = (next - wallOffset) / 1000
      gate.gain.setValueAtTime(0.5, t)
      gate.gain.setValueAtTime(0, t + 0.1)
      scheduledUntil = next
    }
  }
  schedule()
  const timer = setInterval(schedule, 500)
  return () => clearInterval(timer)
}

/** Four steady tones on four channels (220, 440, 880, 1760 Hz at -12 dBFS): lets the mixer be tested without hardware. */
function startMultiTones(c: AudioContext, merger: ChannelMergerNode): void {
  ;[220, 440, 880, 1760].forEach((freq, ch) => {
    const osc = c.createOscillator()
    osc.frequency.value = freq
    const level = c.createGain()
    level.gain.value = 0.25
    osc.connect(level).connect(merger, 0, ch)
    osc.start()
  })
}

async function apply(cfg: AudioConfig, initialMixer: MixerConfig): Promise<void> {
  teardown()
  mixer = initialMixer
  if (cfg.source.type === 'silence') return audioBridge.report({ state: 'idle', message: 'Silence', channelCount: 0 })

  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule('pcm-worklet.js')
    await ctx.audioWorklet.addModule('gate-worklet.js')
    await ctx.audioWorklet.addModule('comp-worklet.js')
    const c = ctx
    const stop: (() => void)[] = []
    let stream: MediaStream | null = null
    let sourceNode: AudioNode
    let channelCount: number
    let message: string

    if (cfg.source.type === 'test') {
      const merger = c.createChannelMerger(2)
      const mono = c.createGain()
      mono.connect(merger, 0, 0)
      mono.connect(merger, 0, 1)
      stop.push(startBeeps(c, mono))
      sourceNode = merger
      channelCount = 2
      message = 'Test beep (1 kHz each second)'
    } else if (cfg.source.type === 'multitest') {
      const merger = c.createChannelMerger(4)
      startMultiTones(c, merger)
      sourceNode = merger
      channelCount = 4
      message = 'Multichannel test: 220 / 440 / 880 / 1760 Hz on channels 1-4'
    } else {
      // Processing constraints can force mono/stereo downmix, so they are all switched off.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: cfg.source.deviceId }, channelCount: { ideal: 48 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      })
      channelCount = stream.getAudioTracks()[0].getSettings().channelCount ?? 2
      sourceNode = c.createMediaStreamSource(stream)
      message = `${cfg.source.label}: ${channelCount} channel(s) delivered`
    }

    const splitter = c.createChannelSplitter(Math.max(channelCount, 1))
    sourceNode.connect(splitter)
    const sum = c.createGain()
    const masterLimiter = new AudioWorkletNode(c, 'compressor', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
    const masterGain = c.createGain()
    const delay = c.createDelay(5)
    delay.delayTime.value = Math.min(5, Math.max(0, cfg.delayMs / 1000))
    const tap = new AudioWorkletNode(c, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
    const mute = c.createGain()
    mute.gain.value = 0 // keeps analysers and the tap pulled by the graph without playing anything out loud
    sum.connect(masterLimiter).connect(masterGain).connect(delay).connect(tap).connect(mute).connect(c.destination)

    const masterSplit = c.createChannelSplitter(2)
    masterGain.connect(masterSplit)
    const masterMeters = [c.createAnalyser(), c.createAnalyser()] as [AnalyserNode, AnalyserNode]
    masterMeters.forEach((a, i) => { a.fftSize = 1024; masterSplit.connect(a, i); a.connect(mute) })

    const g: Graph = { ctx: c, stream, channelCount, splitter, sum, masterLimiter, masterGain, masterMeters, mute, strips: new Map(), timers: [], stop }
    graph = g
    applyMixer(initialMixer)

    let batch: Float32Array[] = []
    let frames = 0
    tap.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
      const chunk = new Float32Array(e.data)
      batch.push(chunk)
      frames += chunk.length / 2
      if (frames < BATCH_FRAMES) return
      const out = new Float32Array(frames * 2)
      let offset = 0
      for (const b of batch) { out.set(b, offset); offset += b.length }
      batch = []
      frames = 0
      audioBridge.pcm(out.buffer)
    }
    g.timers.push(setInterval(() => { if (mixer) audioBridge.meters(readMeters(g, mixer)) }, METER_INTERVAL_MS))

    audioBridge.report({ state: 'running', message, channelCount })
  } catch (err) {
    teardown()
    void ctx?.close()
    audioBridge.report({ state: 'error', message: (err as Error).message, channelCount: 0 })
  }
}

audioBridge.onApply(({ config, mixer: m }) => void apply(config, m))
audioBridge.onMixer((m) => applyMixer(m))

import type { AudioApi } from '../preload/audio'
import { dbToGain, effectiveGains, gainToDb, stripKey, type Effect, type MixerConfig, type Strip } from '../shared/mixer'
import { createFx, param, type Fx } from './effects'
import { mediaUrl, type AudioConfig, type Meters, type PlaybackState } from '../shared/types'

declare const audioBridge: AudioApi

const SAMPLE_RATE = 48000
const BATCH_FRAMES = 1024
const METER_INTERVAL_MS = 50

interface StripNodes {
  key: string
  channel: number
  /** The source this strip is currently wired to (null until its device is open). */
  from: Source | null
  trim: GainNode
  /** trim -> the strip's effects -> fader */
  rig: Rig
  fader: GainNode
  pan: StereoPannerNode
  meter: AnalyserNode
  buf: Float32Array<ArrayBuffer>
}

/**
 * A chain of effects between two fixed nodes (a strip's trim and fader, or the master's sum and master fader). The effects
 * are rewired only when the chain's makeup changes (one added, removed or moved); settings changes never touch the wiring.
 */
interface Rig { head: AudioNode; tail: AudioNode; fx: Fx[]; shape: string }

const shapeOf = (chain: Effect[]): string => chain.map((e) => `${e.id}:${e.type}`).join(',')

/** Makes the audio chain match the settings: effects with the same id are kept (with their state, e.g. a reverb tail), others are made or dropped. */
function syncChain(ctx: AudioContext, rig: Rig, chain: Effect[]): void {
  const shape = shapeOf(chain)
  if (shape !== rig.shape) {
    const old = new Map(rig.fx.map((f) => [f.id, f]))
    const next = chain.map((e) => {
      const kept = old.get(e.id)
      if (kept && kept.type === e.type) { old.delete(e.id); return kept }
      return createFx(ctx, e)
    })
    for (const f of old.values()) f.dispose()
    rig.head.disconnect()
    for (const f of next) f.output.disconnect()
    let prev: AudioNode = rig.head
    for (const f of next) { prev.connect(f.input); prev = f.output }
    prev.connect(rig.tail)
    rig.fx = next
    rig.shape = shape
  }
  chain.forEach((e, i) => rig.fx[i].apply(e))
}

/** The gain reduction of a rig's compressors and limiters: the most any of them is taking off right now (≤ 0). */
const rigReduction = (rig: Rig): number => Math.min(0, ...rig.fx.filter((f) => f.type === 'comp' || f.type === 'limiter').map((f) => f.reduction()))

/** One open input: a real device, or a synthetic test source. */
interface Source {
  key: string
  label: string
  channelCount: number
  splitter: ChannelSplitterNode | null
  stream: MediaStream | null
  error?: string
  stop: () => void
}

interface Graph {
  ctx: AudioContext
  sum: GainNode
  /** sum -> the master's effects -> masterGain */
  masterRig: Rig
  masterGain: GainNode
  delay: DelayNode
  masterMeters: [AnalyserNode, AnalyserNode]
  mute: GainNode
  strips: Map<string, StripNodes>
  sources: Map<string, Source>
  opening: Map<string, Promise<void>>
  /** What strips without a device of their own read from (null = nothing). */
  defaultKey: string | null
  defaultLabel: string
  timers: ReturnType<typeof setInterval>[]
}

let graph: Graph | null = null
let mixer: MixerConfig | null = null
/** The shared video clock, and the element that plays the current video's soundtrack into the mixer (while that input is open). */
let playback: PlaybackState | null = null
let videoEl: HTMLAudioElement | null = null

function teardown(): void {
  const g = graph
  graph = null
  if (!g) return
  g.timers.forEach(clearInterval)
  for (const src of g.sources.values()) closeSource(src)
  void g.ctx.close()
}

function closeSource(src: Source): void {
  src.stop()
  src.stream?.getTracks().forEach((t) => t.stop())
  src.splitter?.disconnect()
}

const sourceKeyOf = (g: Graph, strip: Strip): string | null => strip.source?.deviceId ?? g.defaultKey

function createStrip(g: Graph, strip: Strip): StripNodes {
  const { ctx } = g
  const trim = ctx.createGain()
  const fader = ctx.createGain()
  const n: StripNodes = {
    key: stripKey(strip),
    channel: strip.channel,
    from: null,
    trim,
    rig: { head: trim, tail: fader, fx: [], shape: '\u0000' }, // a shape no chain has, so the first sync wires it
    fader,
    pan: ctx.createStereoPanner(),
    meter: ctx.createAnalyser(),
    buf: new Float32Array(1024),
  }
  n.meter.fftSize = 1024
  trim.connect(fader) // until the effects are wired
  fader.connect(n.pan)
  n.pan.connect(n.meter)
  n.pan.connect(g.sum)
  n.meter.connect(g.mute) // analysers are only pulled when something downstream consumes them
  wireInput(g, n, strip)
  return n
}

/** Connects a strip's input to its source's channel, if that source is open and has the channel (else it stays silent). */
function wireInput(g: Graph, n: StripNodes, strip: Strip): void {
  const key = sourceKeyOf(g, strip)
  const src = key === null ? undefined : g.sources.get(key)
  if (n.from && n.from !== src) { try { n.from.splitter?.disconnect(n.trim) } catch { /* already gone */ } n.from = null }
  if (src?.splitter && !n.from && strip.channel < src.channelCount) {
    src.splitter.connect(n.trim, strip.channel, 0)
    n.from = src
  }
}

function destroyStrip(n: StripNodes): void {
  n.rig.fx.forEach((f) => f.dispose())
  for (const node of [n.trim, n.fader, n.pan, n.meter]) node.disconnect()
  try { n.from?.splitter?.disconnect(n.trim) } catch { /* the source may already be closed */ }
}

/** Pushes one strip's settings into its nodes. */
function applyStrip(ctx: AudioContext, n: StripNodes, s: Strip, gain: number): void {
  param(n.trim.gain, dbToGain(s.trimDb), ctx)
  syncChain(ctx, n.rig, s.chain)
  param(n.fader.gain, gain, ctx)
  param(n.pan.pan, s.pan, ctx)
}

/**
 * Brings the graph in line with the mixer: adds/removes strips, updates every parameter, and opens or closes the input
 * devices strips need (a strip added while running opens its device on the fly).
 */
function applyMixer(m: MixerConfig): void {
  mixer = m
  const g = graph
  if (!g) return
  const wanted = new Set(m.strips.map(stripKey))
  for (const [key, nodes] of g.strips) {
    if (!wanted.has(key)) {
      destroyStrip(nodes)
      g.strips.delete(key)
    }
  }
  const gains = effectiveGains(m)
  m.strips.forEach((s, i) => {
    const key = stripKey(s)
    let nodes = g.strips.get(key)
    if (!nodes) {
      nodes = createStrip(g, s)
      g.strips.set(key, nodes)
    }
    applyStrip(g.ctx, nodes, s, gains[i])
  })
  param(g.masterGain.gain, dbToGain(m.masterDb), g.ctx)
  param(g.delay.delayTime, Math.min(5, Math.max(0, m.delayMs / 1000)), g.ctx) // changes live, from the mixer's master section
  syncChain(g.ctx, g.masterRig, m.masterChain)

  // Close inputs no strip uses any more; open the ones that are new.
  const needed = new Map<string, string>()
  for (const s of m.strips) {
    const key = sourceKeyOf(g, s)
    if (key !== null) needed.set(key, s.source?.label ?? g.defaultLabel)
  }
  let changed = false
  for (const [key, src] of g.sources) {
    if (!needed.has(key)) { closeSource(src); g.sources.delete(key); changed = true }
  }
  for (const [key, label] of needed) {
    if (g.sources.has(key) || g.opening.has(key)) continue
    const task = openSource(g, key, label).then((src) => {
      if (graph !== g) return closeSource(src) // torn down while the device was opening
      g.sources.set(key, src)
      for (const strip of m.strips) { const n = g.strips.get(stripKey(strip)); if (n && sourceKeyOf(g, strip) === key) wireInput(g, n, strip) }
    }).finally(() => { g.opening.delete(key); if (graph === g) reportStatus(g) })
    g.opening.set(key, task)
  }
  if (changed) reportStatus(g)
}

/** Reports every open input and what it delivered, so the interface can show them and offer the right channels. */
function reportStatus(g: Graph): void {
  const devices = [...g.sources.values()].map((s) => ({ id: s.key, label: s.label, channels: s.channelCount, ...(s.error ? { error: s.error } : {}) }))
  const failed = devices.filter((d) => d.error)
  const allFailed = devices.length > 0 && failed.length === devices.length
  const message = devices.length
    ? devices.map((d) => `${d.label}: ${d.error ? `cannot open (${d.error})` : `${d.channels} channel${d.channels === 1 ? '' : 's'}`}`).join(' · ')
    : 'Running, no inputs in the mix yet'
  const def = g.defaultKey ? g.sources.get(g.defaultKey) : undefined
  audioBridge.report({ state: allFailed ? 'error' : 'running', message, channelCount: def?.channelCount ?? 0, devices })
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
    const n = g.strips.get(stripKey(s))
    if (!n) return { peakDb: -100, rmsDb: -100, reductionDb: 0 }
    n.meter.getFloatTimeDomainData(n.buf)
    let sumSq = 0
    for (let i = 0; i < n.buf.length; i++) sumSq += n.buf[i] * n.buf[i]
    return { peakDb: gainToDb(peakOf(n.buf)), rmsDb: gainToDb(Math.sqrt(sumSq / n.buf.length)), reductionDb: rigReduction(n.rig) }
  })
  // Every effect that takes gain off reports it, by id, so its card in the chain can show it.
  const reductions: Record<string, number> = {}
  for (const rig of [...g.strips.values()].map((n) => n.rig).concat(g.masterRig)) {
    for (const f of rig.fx) if (f.type === 'gate' || f.type === 'comp' || f.type === 'limiter' || f.type === 'deesser') reductions[f.id] = f.reduction()
  }
  const master = g.masterMeters.map((a) => {
    const buf = new Float32Array(a.fftSize)
    a.getFloatTimeDomainData(buf)
    return gainToDb(peakOf(buf))
  }) as [number, number]
  return { strips, masterPeakDb: master, reductions }
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
  return () => { clearInterval(timer); osc.stop() }
}

/** Four steady tones on four channels (220, 440, 880, 1760 Hz at -12 dBFS): lets the mixer be tested without hardware. */
function startMultiTones(c: AudioContext, merger: ChannelMergerNode): () => void {
  const oscs = [220, 440, 880, 1760].map((freq, ch) => {
    const osc = c.createOscillator()
    osc.frequency.value = freq
    const level = c.createGain()
    level.gain.value = 0.25
    osc.connect(level).connect(merger, 0, ch)
    osc.start()
    return osc
  })
  return () => oscs.forEach((o) => o.stop())
}

/** Opens one input. A device that cannot be opened (permission, unplugged, busy) comes back with an error instead of throwing. */
/**
 * Makes the current video cue's soundtrack follow the shared clock (play, pause, seek), so it can be mixed. The picture is
 * shown by the output windows; this is a second, audio-only player for the same file, kept within ~150 ms of the clock.
 */
function applyVideoPlayback(): void {
  const el = videoEl
  if (!el) return
  const st = playback
  if (!st?.file) {
    if (el.dataset.file) { el.pause(); el.removeAttribute('src'); delete el.dataset.file; el.load() }
    return
  }
  if (el.dataset.file !== st.file) { el.src = mediaUrl(st.file); el.dataset.file = st.file }
  const expected = st.playing ? Math.min(st.durationSec, st.positionSec + (Date.now() - st.atMs) / 1000) : st.positionSec
  if (Math.abs(el.currentTime - expected) > (st.playing ? 0.15 : 0.05)) el.currentTime = expected
  if (st.playing && el.paused && expected < st.durationSec) void el.play().catch(() => {})
  else if (!st.playing && !el.paused) el.pause()
}

async function openSource(g: Graph, key: string, label: string): Promise<Source> {
  const { ctx } = g
  const finish = (node: AudioNode, channelCount: number, stop: () => void, stream: MediaStream | null = null): Source => {
    const splitter = ctx.createChannelSplitter(Math.max(channelCount, 1))
    node.connect(splitter)
    return { key, label, channelCount, splitter, stream, stop }
  }
  if (key === 'app:video') {
    // crossOrigin is required, or the browser would deliver silence from a media element on another origin
    const el = new Audio()
    el.crossOrigin = 'anonymous'
    el.preload = 'auto'
    videoEl = el
    const upmix = ctx.createGain() // a mono soundtrack is spread over both channels
    upmix.channelCount = 2
    upmix.channelCountMode = 'explicit'
    upmix.channelInterpretation = 'speakers'
    ctx.createMediaElementSource(el).connect(upmix)
    const timer = setInterval(applyVideoPlayback, 250) // also corrects drift while playing
    applyVideoPlayback()
    return finish(upmix, 2, () => {
      clearInterval(timer)
      el.pause()
      el.removeAttribute('src')
      el.load()
      if (videoEl === el) videoEl = null
    })
  }
  if (key === 'test:beep') {
    const merger = ctx.createChannelMerger(2)
    const mono = ctx.createGain()
    mono.connect(merger, 0, 0)
    mono.connect(merger, 0, 1)
    return finish(merger, 2, startBeeps(ctx, mono))
  }
  if (key === 'test:tones') {
    const merger = ctx.createChannelMerger(4)
    return finish(merger, 4, startMultiTones(ctx, merger))
  }
  try {
    // Processing constraints can force mono/stereo downmix, so they are all switched off.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: key }, channelCount: { ideal: 48 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    const channelCount = stream.getAudioTracks()[0].getSettings().channelCount ?? 2
    return finish(ctx.createMediaStreamSource(stream), channelCount, () => {}, stream)
  } catch (err) {
    return { key, label, channelCount: 0, splitter: null, stream: null, error: (err as Error).message, stop: () => {} }
  }
}

/** Which input strips without a device of their own use: the Audio panel's source. */
function defaultSource(cfg: AudioConfig): { key: string | null; label: string } {
  switch (cfg.source.type) {
    case 'device': return { key: cfg.source.deviceId, label: cfg.source.label }
    case 'test': return { key: 'test:beep', label: 'Test beep (stereo)' }
    case 'multitest': return { key: 'test:tones', label: 'Test tones (4 channels)' }
    default: return { key: null, label: '' }
  }
}

async function apply(cfg: AudioConfig, initialMixer: MixerConfig): Promise<void> {
  teardown()
  mixer = initialMixer
  const def = defaultSource(cfg)
  // The engine runs for a default source, or when the mixer's Start was pressed and strips name devices of their own.
  if (def.key === null && !(cfg.mixerSources && initialMixer.strips.some((s) => s.source))) {
    return audioBridge.report({ state: 'idle', message: 'Audio is off', channelCount: 0, devices: [] })
  }

  let ctx: AudioContext | null = null
  try {
    ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule('pcm-worklet.js')
    await ctx.audioWorklet.addModule('gate-worklet.js')
    await ctx.audioWorklet.addModule('comp-worklet.js')
    await ctx.audioWorklet.addModule('deesser-worklet.js')
    const c = ctx

    const sum = c.createGain()
    const masterGain = c.createGain()
    masterGain.channelCount = 2 // the master is always stereo, whatever its effects do
    masterGain.channelCountMode = 'explicit'
    const delay = c.createDelay(5)
    delay.delayTime.value = Math.min(5, Math.max(0, initialMixer.delayMs / 1000))
    const tap = new AudioWorkletNode(c, 'pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' })
    const mute = c.createGain()
    mute.gain.value = 0 // keeps analysers and the tap pulled by the graph without playing anything out loud
    sum.connect(masterGain) // until the master's effects are wired
    masterGain.connect(delay).connect(tap).connect(mute).connect(c.destination)

    const masterSplit = c.createChannelSplitter(2)
    masterGain.connect(masterSplit)
    const masterMeters = [c.createAnalyser(), c.createAnalyser()] as [AnalyserNode, AnalyserNode]
    masterMeters.forEach((a, i) => { a.fftSize = 1024; masterSplit.connect(a, i); a.connect(mute) })

    const g: Graph = { ctx: c, sum, masterRig: { head: sum, tail: masterGain, fx: [], shape: '\u0000' }, masterGain, delay, masterMeters, mute, strips: new Map(), sources: new Map(), opening: new Map(), defaultKey: def.key, defaultLabel: def.label, timers: [] }
    graph = g
    applyMixer(initialMixer)
    await Promise.allSettled([...g.opening.values()]) // wait for the first devices so the status already says what each delivered

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
    reportStatus(g)
  } catch (err) {
    teardown()
    void ctx?.close()
    audioBridge.report({ state: 'error', message: (err as Error).message, channelCount: 0, devices: [] })
  }
}

audioBridge.onApply(({ config, mixer: m }) => void apply(config, m))
audioBridge.onPlayback((st) => { playback = st; applyVideoPlayback() })
audioBridge.onMixer((m) => applyMixer(m))

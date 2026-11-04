import { app, type BrowserWindow } from 'electron'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultMixer, defaultStrip, type MixerConfig } from '../shared/mixer'
import { defaultAudio, type Slide, type StreamStartRequest } from '../shared/types'
import type { AudioBridge } from './audio'
import { importMediaFile } from './library'
import type { Playback } from './playback'
import type { ScreenManager } from './screens'
import type { Streamer } from './streamer'
import { importVideoFile } from './video'

export interface DevContext {
  screens: ScreenManager
  streamer: Streamer
  audio: AudioBridge
  playback: Playback
  operator: () => BrowserWindow | null
  startStream: (req: StreamStartRequest) => Promise<void>
  presentSlide: (slide: Slide | null) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Scripted scenarios for development and the end-to-end tests. Each is switched on by an environment
 * variable, does its work against the real app, writes its evidence to disk and quits:
 *   PRESTREAMER_SNAPSHOT=out.png   capture the operator window
 *   PRESTREAMER_EVAL="js"          run JS in the operator before the snapshot (prints the result)
 *   PRESTREAMER_STREAMTEST=out.mkv stream the test pattern to a file (PRESTREAMER_SECONDS, PRESTREAMER_AUDIO=test)
 *   PRESTREAMER_BGTEST=dir         image/video slide backgrounds, with test.png and test.mp4 in dir
 *   PRESTREAMER_VIDEOTEST=dir      video import plans and synchronised playback, with t.* files in dir
 *   PRESTREAMER_MIXERTEST=out.f32  steps the mixer through a scripted sequence and records its PCM (scripts/e2e-mixer.mjs)
 * PRESTREAMER_FFMPEG_LOG=level prints ffmpeg's own log during any of them.
 */
export function runDevHooks(ctx: DevContext): void {
  const { screens, streamer, audio, playback, startStream, presentSlide } = ctx
  // Dev aid: PRESTREAMER_SNAPSHOT=/path/out.png captures the operator window and quits.
  const snapshotPath = process.env.PRESTREAMER_SNAPSHOT
  // Dev aid: PRESTREAMER_STREAMTEST=/path/out.mkv streams the test pattern to a file for 5s, then quits.
  const streamTestPath = process.env.PRESTREAMER_STREAMTEST
  // Dev aid: PRESTREAMER_BGTEST=/dir (with test.png and test.mp4) shows each as a slide background and
  // writes operator-<kind>.png and a 3s stream-<kind>.mkv into /dir, then quits.
  const bgTestDir = process.env.PRESTREAMER_BGTEST
  if (bgTestDir) {
    setTimeout(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const [first, second] = screens.getState().screens
      screens.setLive(second.id, true)
      screens.setLive(first.id, true)
      for (const kind of ['image', 'video'] as const) {
        const background = importMediaFile(join(bgTestDir, kind === 'image' ? 'test.png' : 'test.mp4'), kind)
        screens.showSlide({ label: 'Verse 1', text: 'Amazing grace, how sweet the sound\nThat saved a wretch like me', background })
        await sleep(1500)
        await startStream({ screenId: second.id, mode: 'file', filePath: join(bgTestDir, `stream-${kind}.mkv`) })
        await sleep(3000)
        await streamer.stop()
        writeFileSync(join(bgTestDir, `operator-${kind}.png`), (await ctx.operator()!.webContents.capturePage()).toPNG())
      }
      app.quit()
    }, 2000)
  }
  // Dev aid: PRESTREAMER_VIDEOTEST=/dir imports t.mp4 t.mov t.mkv t-hevc.mkv t-prores.mov (printing the import plan),
  // then plays the converted mkv on all screens while streaming to /dir/vstream.mkv, logging each window's position.
  const videoTestDir = process.env.PRESTREAMER_VIDEOTEST
  if (videoTestDir) {
    setTimeout(async () => {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const imported: Record<string, Awaited<ReturnType<typeof importVideoFile>>> = {}
      for (const name of ['t.mp4', 't.mov', 't.mkv', 't-hevc.mkv', 't-prores.mov']) {
        const t0 = Date.now()
        imported[name] = await importVideoFile(join(videoTestDir, name))
        console.log('IMPORT', name, imported[name].plan, `${imported[name].durationSec.toFixed(1)}s`, `${Date.now() - t0}ms`)
      }
      const v = imported['t.mkv'] ?? Object.values(imported)[0]
      const [first, second] = screens.getState().screens
      screens.setLive(second.id, true)
      screens.setLive(first.id, true)
      presentSlide({ label: 'Video', text: 'test', video: { file: v.file, title: 'test', durationSec: v.durationSec } })
      await sleep(1500)
      await startStream({ screenId: second.id, mode: 'file', filePath: join(videoTestDir, 'vstream.mkv') })
      const log = (tag: string) => console.log('POS', tag, 'clock', playback.position().toFixed(2), JSON.stringify(screens.getPositions(), (_k, x) => (typeof x === 'number' ? Number(x.toFixed(2)) : x)))
      log('loaded (paused)')
      playback.command({ type: 'play' })
      await sleep(2500)
      log('playing')
      writeFileSync(join(videoTestDir, 'operator-video-play.png'), (await ctx.operator()!.webContents.capturePage()).toPNG())
      playback.command({ type: 'pause' })
      await sleep(800)
      log('paused')
      playback.command({ type: 'seek', sec: 6 })
      playback.command({ type: 'play' })
      await sleep(2000)
      log('after seek to 6 + play')
      console.log('STREAM BEFORE STOP', JSON.stringify({ ...streamer.getStatus(), target: '' }))
      await streamer.stop()
      console.log('STREAM AFTER STOP', JSON.stringify({ ...streamer.getStatus(), target: '' }))
      app.quit()
    }, 2000)
  }
  if (snapshotPath || streamTestPath) {
    setTimeout(async () => {
      const [first, second] = screens.getState().screens
      if (streamTestPath) {
        screens.update(second.id, { look: { ...second.look, source: { type: 'testpattern' } } })
      }
      screens.setLive(second.id, true)
      screens.setLive(first.id, true)
      screens.showSlide({ label: 'Verse 1', text: 'Amazing grace, how sweet the sound\nThat saved a wretch like me' })
      if (streamTestPath) {
        // PRESTREAMER_AUDIO=test adds the 1 kHz beep that pairs with the pattern's flash (A/V sync check).
        if (process.env.PRESTREAMER_AUDIO === 'test') console.log('AUDIO', JSON.stringify(await audio.configure({ ...defaultAudio, source: { type: 'test' } })))
        await new Promise((r) => setTimeout(r, 1000))
        await startStream({ screenId: second.id, mode: 'file', filePath: streamTestPath })
        await new Promise((r) => setTimeout(r, Number(process.env.PRESTREAMER_SECONDS || 8) * 1000))
        console.log('STREAM STATUS', JSON.stringify(streamer.getStatus()))
        await streamer.stop()
        console.log('STREAM FINAL', JSON.stringify(streamer.getStatus()))
      }
      await new Promise((r) => setTimeout(r, 1500))
      // Dev aid: PRESTREAMER_EVAL="js" runs in the operator window before the snapshot (e.g. click buttons).
      if (process.env.PRESTREAMER_EVAL) {
        console.log('EVAL', JSON.stringify(await ctx.operator()!.webContents.executeJavaScript(process.env.PRESTREAMER_EVAL)))
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (snapshotPath) writeFileSync(snapshotPath, (await ctx.operator()!.webContents.capturePage()).toPNG())
      app.quit()
    }, 2000)
  }
  const mixerTestPath = process.env.PRESTREAMER_MIXERTEST
  if (mixerTestPath) setTimeout(() => void mixerTest(ctx, mixerTestPath), 2000)
}

/** One mixer setting per segment, applied to a fresh base mix; the analysis script checks each segment's spectrum. */
const MIXER_SEGMENTS: { name: string; channels: number[]; apply: (m: MixerConfig) => void }[] = [
  { name: 'baseline', channels: [1], apply: () => {} },
  { name: 'fader-12', channels: [1], apply: (m) => { m.strips[0].faderDb = -12 } },
  { name: 'eq+12', channels: [1], apply: (m) => { Object.assign(m.strips[0].eq, { on: true, midFreq: 440, midGainDb: 12, midQ: 1 }) } },
  { name: 'compressor', channels: [1], apply: (m) => { Object.assign(m.strips[0].comp, { on: true, thresholdDb: -30, ratio: 20, kneeDb: 0, attackMs: 1, releaseMs: 100 }) } },
  { name: 'compressor+makeup', channels: [1], apply: (m) => { Object.assign(m.strips[0].comp, { on: true, thresholdDb: -30, ratio: 20, kneeDb: 0, attackMs: 1, releaseMs: 100, makeupDb: 10 }) } },
  { name: 'limiter', channels: [1], apply: (m) => { Object.assign(m.strips[0].limiter, { on: true, ceilingDb: -20 }) } },
  { name: 'gate', channels: [1], apply: (m) => { Object.assign(m.strips[0].gate, { on: true, thresholdDb: -6, rangeDb: 60 }) } },
  { name: 'mute', channels: [1], apply: (m) => { m.strips[0].mute = true } },
  { name: 'solo-880', channels: [1, 2], apply: (m) => { m.strips[1].solo = true } },
  { name: 'ch0-baseline', channels: [0], apply: () => {} },
  { name: 'ch0-hpf500', channels: [0], apply: (m) => { Object.assign(m.strips[0].hpf, { on: true, freq: 500 }) } },
]
const SEGMENT_SECONDS = 3

/**
 * Steps the mixer through MIXER_SEGMENTS on four test tones and records the stereo PCM it produces.
 * Segment boundaries are sample positions in that recording, so the analysis does not depend on wall-clock
 * timing, the encoder, or how busy the machine is.
 */
async function mixerTest(ctx: DevContext, outPath: string): Promise<void> {
  const { audio } = ctx
  const baseFor = (channels: number[]): MixerConfig => ({
    ...defaultMixer(),
    strips: channels.map((c) => defaultStrip(c)),
    masterLimiter: { on: false, ceilingDb: -1 },
  })

  const chunks: Buffer[] = []
  let bytes = 0
  audio.pcmTap = (chunk) => { chunks.push(chunk); bytes += chunk.length }
  audio.setMixer(baseFor(MIXER_SEGMENTS[0].channels))
  console.log('AUDIO', JSON.stringify(await audio.configure({ ...defaultAudio, source: { type: 'multitest' } })))
  await sleep(500)

  const frames = () => bytes / 8 // stereo f32 = 8 bytes per frame
  const segments: { name: string; startFrame: number; endFrame: number }[] = []
  for (const seg of MIXER_SEGMENTS) {
    const m = baseFor(seg.channels)
    seg.apply(m)
    audio.setMixer(m)
    const startFrame = frames()
    await sleep(SEGMENT_SECONDS * 1000)
    segments.push({ name: seg.name, startFrame, endFrame: frames() })
  }
  audio.pcmTap = null
  writeFileSync(outPath, Buffer.concat(chunks))
  writeFileSync(`${outPath}.segments.json`, JSON.stringify({ sampleRate: 48000, segments }, null, 2))
  app.quit()
}

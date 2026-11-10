import { app, BrowserWindow, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultMixer, defaultStrip, makeEffect, type MixerConfig, type StripSource } from '../shared/mixer'
import { defaultAudio, type Slide, type StreamStartRequest } from '../shared/types'
import { nativeKey } from '../shared/native-audio'
import type { AudioBridge } from './audio'
import { TEST_RIG, testRigHz } from './native-audio'
import { importMediaFile, mediaDir } from './library'
import type { Playback } from './playback'
import type { ScreenManager } from './screens'
import type { Streamer } from './streamer'
import { importVideoFile } from './video'
import { renderPdfPages } from './pdf'
import { renderPptxSlides } from './pptx'

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
 *   PRESTREAMER_ATEM=1             look for an ATEM even with PRESTREAMER_USER_DATA set (tests normally send no network packets)
 *   PRESTREAMER_LANG=en|sk         the interface language (with PRESTREAMER_USER_DATA set the tests run in English otherwise)
 *   PRESTREAMER_DMX_FAKE=file      runs DMX output into a file (its latest frame: start code, then 512 slots) instead of a USB interface
 *   PRESTREAMER_NO_AUTO_OPEN=1     with SNAPSHOT/EVAL: do not open the screens or show a slide first (to test how the app opens)
 *   PRESTREAMER_STREAMTEST=out.mkv stream the test pattern to a file (PRESTREAMER_SECONDS, PRESTREAMER_AUDIO=test|multitest,
 *                                  PRESTREAMER_AUDIO_STOP=seconds, PRESTREAMER_LAYOUT=lower-third)
 *                                  PRESTREAMER_CAMERA_ONLY=1 streams in camera-only mode, PRESTREAMER_NO_SOURCE=1 leaves the camera out,
 *                                  PRESTREAMER_ANNOUNCE="text" puts an announcement on air
 *   PRESTREAMER_LOOK_BG=file       with STREAMTEST: a picture (.png) or video (.mp4) behind the text of the stream screen
 *   PRESTREAMER_MEDIA_FILE=file    stands in for the picture/video file dialog
 *   PRESTREAMER_VIDEO_FILE=file    stands in for the dialog of the run sheet's video import
 *   PRESTREAMER_MAKEPDF=file.pdf   writes a 3-page test PDF and quits; PRESTREAMER_PRESENTATION_FILE=file stands in for the import dialog;
 *                                  PRESTREAMER_PICTURE_PDF=file.pdf shows its first page as a presentation slide (with STREAMTEST/SNAPSHOT)
 *   PRESTREAMER_BGTEST=dir         image/video slide backgrounds, with test.png and test.mp4 in dir
 *   PRESTREAMER_VIDEOTEST=dir      video import plans and synchronised playback, with t.* files in dir
 *   PRESTREAMER_MIXERTEST=out.f32  steps the mixer through a scripted sequence and records its PCM (scripts/e2e-mixer.mjs)
 *   PRESTREAMER_NATIVETEST=out.f32 reads a stand-in 32-channel interface (PRESTREAMER_NATIVE_TEST=1) through the native capture path and records the mix (scripts/e2e-native.mjs)
 * PRESTREAMER_FFMPEG_LOG=level prints ffmpeg's own log during any of them.
 */
/** A PDF with one solid-colour page per colour, made by Chromium's own printer (so the tests need no external tools). */
export async function makeTestPdf(path: string, colors: string[]): Promise<void> {
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
  const pages = colors.map((c, i) => `<div style="height:100vh;background:${c};page-break-after:always;display:flex;align-items:center;justify-content:center;font:200px sans-serif;color:#fff">${i + 1}</div>`).join('')
  await win.loadURL(`data:text/html,<html><body style="margin:0">${encodeURIComponent(pages)}</body></html>`)
  writeFileSync(path, await win.webContents.printToPDF({ landscape: true, pageSize: 'A4', printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } }))
  win.destroy()
}

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
      // Keep the operator window above other windows without taking keyboard focus: macOS stops painting a window that is
      // completely covered, and a capture of it would then show a stale picture.
      ctx.operator()?.setAlwaysOnTop(true, 'floating')
      ctx.operator()?.showInactive()
      const [first, second] = screens.getState().screens
      if (streamTestPath) {
        // PRESTREAMER_LAYOUT=lower-third puts the text in a caption bar over the (simulated) camera picture.
        const lower = process.env.PRESTREAMER_LAYOUT === 'lower-third'
        screens.update(second.id, {
          look: { ...second.look, source: process.env.PRESTREAMER_NO_SOURCE ? { type: 'none' as const } : { type: 'testpattern' as const }, ...(lower ? { layout: 'lower-third' as const, textBoxOpacity: 0.6, fontSize: 48 } : {}) },
        })
      }
      // PRESTREAMER_LOOK_BG=file.png|file.mp4 puts that picture or video behind the text on the stream screen.
      if (process.env.PRESTREAMER_LOOK_BG && streamTestPath) {
        const p = process.env.PRESTREAMER_LOOK_BG
        const bg = importMediaFile(p, /\.(mp4|mov|webm|m4v)$/i.test(p) ? 'video' : 'image') as { kind: 'image' | 'video'; file: string }
        screens.update(second.id, { look: { backgroundMedia: bg } as never })
      }
      // PRESTREAMER_NO_AUTO_OPEN=1 leaves the screens as the app itself has them (to test how it opens).
      if (!process.env.PRESTREAMER_NO_AUTO_OPEN) {
        screens.setLive(second.id, true)
        screens.setLive(first.id, true)
        screens.showSlide({ label: 'Verse 1', text: 'Amazing grace, how sweet the sound\nThat saved a wretch like me' })
      }
      // PRESTREAMER_PICTURE_PDF=file.pdf puts the first page of that PDF on air as a presentation slide.
      if (process.env.PRESTREAMER_PICTURE_PDF) {
        const [file] = await renderPdfPages(readFileSync(process.env.PRESTREAMER_PICTURE_PDF), mediaDir(), (i) => `devpic-${i}.png`)
        screens.showSlide({ label: 'Slide 1 / 3', text: '', picture: { file } })
      }
      if (streamTestPath) {
        // PRESTREAMER_AUDIO=test adds the 1 kHz beep that pairs with the pattern's flash (A/V sync check).
        if (process.env.PRESTREAMER_AUDIO === 'test') console.log('AUDIO', JSON.stringify(await audio.configure({ ...defaultAudio, source: { type: 'test' } })))
        // PRESTREAMER_AUDIO=multitest streams the MIXER's output: four tones in, only channel 2 (440 Hz) in the mix.
        if (process.env.PRESTREAMER_AUDIO === 'multitest') {
          audio.setMixer({ ...defaultMixer(), strips: [defaultStrip(1)], masterChain: [] })
          console.log('AUDIO', JSON.stringify(await audio.configure({ ...defaultAudio, source: { type: 'multitest' } })))
        }
        await new Promise((r) => setTimeout(r, 1000))
        await startStream({ screenId: second.id, mode: 'file', filePath: streamTestPath })
      if (process.env.PRESTREAMER_CAMERA_ONLY) screens.setCameraOnly(true) // the stream shows only the camera
      // PRESTREAMER_ANNOUNCE="text" puts a live announcement on every screen once the stream is running.
      if (process.env.PRESTREAMER_ANNOUNCE) screens.showAnnouncement({ text: process.env.PRESTREAMER_ANNOUNCE, style: process.env.PRESTREAMER_ANNOUNCE_STYLE === 'fullscreen' ? 'fullscreen' : 'banner-bottom', tone: 'alert', screens: null, autoHideSec: null })
        // PRESTREAMER_AUDIO_STOP=n stops the mixer n seconds into the stream, to prove the stream does not stall.
        const total = Number(process.env.PRESTREAMER_SECONDS || 8) * 1000
        const stopAt = Number(process.env.PRESTREAMER_AUDIO_STOP || 0) * 1000
        if (stopAt) {
          await new Promise((r) => setTimeout(r, stopAt))
          await audio.configure({ ...defaultAudio, source: { type: 'silence' } })
          await new Promise((r) => setTimeout(r, Math.max(0, total - stopAt)))
        } else if (process.env.PRESTREAMER_EVAL_LIVE) {
          // PRESTREAMER_EVAL_LIVE="js" runs in the operator window while the stream is running (prints EVAL_LIVE), to inspect the health panel.
          await new Promise((r) => setTimeout(r, total * 0.7))
          console.log('EVAL_LIVE', JSON.stringify(await ctx.operator()!.webContents.executeJavaScript(process.env.PRESTREAMER_EVAL_LIVE)))
          await new Promise((r) => setTimeout(r, total * 0.3))
        } else {
          await new Promise((r) => setTimeout(r, total))
        }
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
  // PRESTREAMER_PPTXTEST=dir with PRESTREAMER_PPTX=file.pptx: draws every slide with the built-in renderer into dir and reports.
  if (process.env.PRESTREAMER_PPTXTEST && process.env.PRESTREAMER_PPTX) {
    setTimeout(async () => {
      try {
        const { files, info } = await renderPptxSlides(readFileSync(process.env.PRESTREAMER_PPTX!), process.env.PRESTREAMER_PPTXTEST!, (i) => `slide-${i + 1}.png`)
        console.log('PPTXTEST', JSON.stringify({ files, info }))
      } catch (err) {
        console.log('PPTXTEST', JSON.stringify({ error: (err as Error).message }))
      }
      app.quit()
    }, 1500)
  }
  // PRESTREAMER_MAKEPDF=path.pdf: writes a 3-page (red, green, blue) PDF and quits, as a test deck for the other hooks.
  if (process.env.PRESTREAMER_MAKEPDF) {
    setTimeout(async () => {
      await makeTestPdf(process.env.PRESTREAMER_MAKEPDF!, ['#ff0000', '#00ff00', '#0000ff'])
      app.quit()
    }, 800)
  }
  // PRESTREAMER_PDFTEST=dir: makes a 3-page PDF, draws it with the PDF renderer, and reports each page's size and colour.
  const pdfTestDir = process.env.PRESTREAMER_PDFTEST
  if (pdfTestDir) {
    setTimeout(async () => {
      try {
        mkdirSync(pdfTestDir, { recursive: true })
        const pdf = join(pdfTestDir, 'test.pdf')
        await makeTestPdf(pdf, ['#ff0000', '#00ff00', '#0000ff'])
        const files = await renderPdfPages(readFileSync(pdf), pdfTestDir, (i) => `page-${i + 1}.png`)
        const pages = files.map((f) => {
          const img = nativeImage.createFromPath(join(pdfTestDir, f))
          const { width, height } = img.getSize()
          const bmp = img.toBitmap() // BGRA
          const o = (Math.floor(height / 8) * width + Math.floor(width / 8)) * 4 // near a corner, away from the page number
          return { f, width, height, rgb: [bmp[o + 2], bmp[o + 1], bmp[o]] }
        })
        console.log('PDFTEST', JSON.stringify(pages))
      } catch (err) {
        console.log('PDFTEST', JSON.stringify({ error: (err as Error).message }))
      }
      app.quit()
    }, 1500)
  }
  const nativeTestPath = process.env.PRESTREAMER_NATIVETEST
  if (nativeTestPath) setTimeout(() => void nativeTest(ctx, nativeTestPath), 2000)
  const mixerTestPath = process.env.PRESTREAMER_MIXERTEST
  if (mixerTestPath) setTimeout(() => void mixerTest(ctx, mixerTestPath), 2000)
}

/** Channels of the stand-in interface heard in each segment of the native capture test (channel numbers count from 0). */
const NATIVE_SEGMENTS: { name: string; channels: number[] }[] = [
  { name: 'ch5', channels: [4] },
  { name: 'ch21', channels: [20] },
  { name: 'ch5+ch32', channels: [4, 31] },
]

/** Records the mix of strips taken from the stand-in 32-channel interface, so the analysis can check that every channel comes out as itself. */
async function nativeTest(ctx: DevContext, outPath: string): Promise<void> {
  const { audio } = ctx
  // PRESTREAMER_NATIVETEST_DEVICE=WING PRESTREAMER_NATIVETEST_CHANNELS=15,16,17 records each of those (counting from 1) of a real interface, one segment per channel.
  const realDevice = process.env.PRESTREAMER_NATIVETEST_DEVICE
  const segmentList = realDevice ? (process.env.PRESTREAMER_NATIVETEST_CHANNELS ?? '1').split(',').map((c) => ({ name: `ch${c}`, channels: [Number(c) - 1] })) : NATIVE_SEGMENTS
  const source: StripSource = { deviceId: nativeKey(realDevice ?? TEST_RIG.name), label: realDevice ?? TEST_RIG.name }
  const baseFor = (channels: number[]): MixerConfig => ({ ...defaultMixer(), strips: channels.map((c) => defaultStrip(c, undefined, source)), masterChain: [] })
  const chunks: Buffer[] = []
  let bytes = 0
  audio.pcmTap = (chunk) => { chunks.push(chunk); bytes += chunk.length }
  audio.setMixer(baseFor(segmentList[0].channels))
  console.log('AUDIO', JSON.stringify(await audio.configure({ ...defaultAudio, source: { type: 'silence' }, mixerSources: true })))
  await sleep(4000) // ffmpeg and the mixer's window take a moment to start
  console.log('STATUS', JSON.stringify(audio.getStatus()))
  const segments: { name: string; startFrame: number; endFrame: number }[] = []
  for (const seg of segmentList) {
    audio.setMixer(baseFor(seg.channels))
    const startFrame = bytes / 8
    await sleep(3000)
    segments.push({ name: seg.name, startFrame, endFrame: bytes / 8 })
  }
  audio.pcmTap = null
  writeFileSync(outPath, Buffer.concat(chunks))
  writeFileSync(`${outPath}.segments.json`, JSON.stringify({ sampleRate: 48000, segments, hz: Object.fromEntries(Array.from({ length: TEST_RIG.channels }, (_, c) => [c, testRigHz(c)])) }, null, 2))
  app.quit()
}

/** One mixer setting per segment, applied to a fresh base mix; the analysis script checks each segment's spectrum. */
const BEEP: StripSource = { deviceId: 'test:beep', label: 'Test beep (stereo)' }
const MIXER_SEGMENTS: { name: string; channels: (number | { channel: number; source: StripSource })[]; apply: (m: MixerConfig) => void }[] = [
  { name: 'baseline', channels: [1], apply: () => {} },
  { name: 'fader-12', channels: [1], apply: (m) => { m.strips[0].faderDb = -12 } },
  { name: 'eq+12', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('eq', { midFreq: 440, midGainDb: 12, midQ: 1 })) } },
  { name: 'compressor', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('comp', { thresholdDb: -30, ratio: 20, kneeDb: 0, attackMs: 1, releaseMs: 100 })) } },
  { name: 'compressor+makeup', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('comp', { thresholdDb: -30, ratio: 20, kneeDb: 0, attackMs: 1, releaseMs: 100, makeupDb: 10 })) } },
  { name: 'limiter', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('limiter', { ceilingDb: -20 })) } },
  { name: 'gate', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('gate', { thresholdDb: -6, rangeDb: 60 })) } },
  { name: 'mute', channels: [1], apply: (m) => { m.strips[0].mute = true } },
  { name: 'solo-880', channels: [1, 2], apply: (m) => { m.strips[1].solo = true } },
  // Channel 2 of the default source (440 Hz tone) together with a channel of a different source (the 1 kHz beep).
  { name: 'two-sources', channels: [1, { channel: 0, source: BEEP }], apply: () => {} },
  { name: 'ch0-baseline', channels: [0], apply: () => {} },
  { name: 'ch0-hpf500', channels: [0], apply: (m) => { m.strips[0].chain.push(makeEffect('hpf', { freq: 500 })) } },
  // The chain: the order of the effects matters. A compressor then +12 dB of EQ ends about 11 dB louder than EQ then the compressor.
  { name: 'order-comp-eq', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('comp', { thresholdDb: -30, ratio: 20, kneeDb: 0, attackMs: 1, releaseMs: 100 }), makeEffect('eq', { midFreq: 440, midGainDb: 12, midQ: 1 })) } },
  { name: 'order-eq-comp', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('eq', { midFreq: 440, midGainDb: 12, midQ: 1 }), makeEffect('comp', { thresholdDb: -30, ratio: 20, kneeDb: 0, attackMs: 1, releaseMs: 100 })) } },
  // An effect that is switched off leaves the signal alone, however it is set.
  { name: 'bypassed-comp', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('comp', { on: false, thresholdDb: -60, ratio: 20 })) } },
  { name: 'bypassed-eq', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('eq', { on: false, midFreq: 440, midGainDb: 12 })) } },
  { name: 'bypassed-gate', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('gate', { on: false, thresholdDb: 0, rangeDb: 80 })) } },
  { name: 'bypassed-delay', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('delay', { on: false, mix: 1 })) } },
  { name: 'bypassed-reverb', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('reverb', { on: false, mix: 1 })) } },
  { name: 'bypassed', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('comp', { on: false, thresholdDb: -60, ratio: 20 }), makeEffect('eq', { on: false, midFreq: 440, midGainDb: 12 }), makeEffect('gate', { on: false, thresholdDb: 0, rangeDb: 80 }), makeEffect('delay', { on: false, mix: 1 }), makeEffect('reverb', { on: false, mix: 1 })) } },
  { name: 'ch3-baseline', channels: [3], apply: () => {} },
  { name: 'deesser', channels: [3], apply: (m) => { m.strips[0].chain.push(makeEffect('deesser', { freq: 2000, thresholdDb: -40, reductionDb: 12 })) } },
  // 227.27 ms is exactly 100 periods of 440 Hz: with no feedback and the echo as loud as the voice, the two add up in phase (+6 dB).
  { name: 'delay-in-phase', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('delay', { timeMs: 227.27, feedback: 0, toneHz: 12000, mix: 1 })) } },
  { name: 'reverb', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('reverb', { decaySec: 1, dampingHz: 8000, preDelayMs: 0, mix: 1 })) } },
  // The monitor output is a copy of the mix: switching it on (here at -60 dB, so it cannot be heard) must not change the mix.
  { name: 'monitor-on', channels: [1], apply: (m) => { m.monitor = { on: true, deviceId: '', label: '', gainDb: -60 } } },
  // A sync delay holds the signal back by a fixed time and changes nothing else.
  { name: 'syncdelay', channels: [1], apply: (m) => { m.strips[0].chain.push(makeEffect('syncdelay', { timeMs: 500 })) } },
  // The master has a chain of its own: a limiter there holds the whole mix.
  { name: 'master-limiter', channels: [1], apply: (m) => { m.masterChain = [makeEffect('limiter', { ceilingDb: -20 })] } },
]
const SEGMENT_SECONDS = 3

/**
 * Steps the mixer through MIXER_SEGMENTS on four test tones and records the stereo PCM it produces.
 * Segment boundaries are sample positions in that recording, so the analysis does not depend on wall-clock
 * timing, the encoder, or how busy the machine is.
 */
async function mixerTest(ctx: DevContext, outPath: string): Promise<void> {
  const { audio } = ctx
  const baseFor = (channels: (typeof MIXER_SEGMENTS)[number]['channels']): MixerConfig => ({
    ...defaultMixer(),
    strips: channels.map((c) => (typeof c === 'number' ? defaultStrip(c) : defaultStrip(c.channel, undefined, c.source))),
    masterChain: [],
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

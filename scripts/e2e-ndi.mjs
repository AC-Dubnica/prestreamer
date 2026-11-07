// End-to-end check of NDI output. For each sound choice of an 'NDI screen' the real app opens one with a solid colour, and a second
// program (the sender's own receive mode) finds the source on the network, connects to it and reports the size and centre pixel of
// the picture and the level, pitch and gaps of the sound that arrive. The mixer carries a 440 Hz tone the whole time; in the
// 'video' run an 880 Hz video plays as well, so each choice must come out as its own pitch (or as no sound at all).
// Needs NDI's library (PRESTREAMER_NDI_LIB, or NDI Tools installed, or one under vendor/ndi), ffmpeg and a display.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const library = [process.env.PRESTREAMER_NDI_LIB, '/usr/local/lib/libndi.dylib', join('vendor/ndi', `mac-${process.arch}`, 'libndi.dylib'), '/usr/lib/libndi.so.6'].find((p) => p && existsSync(p))
const helper = 'dist/native/ndisend'
if (!library) { console.log('SKIP  no NDI library found (set PRESTREAMER_NDI_LIB)'); process.exit(0) }
if (!existsSync(helper)) { console.error('FAIL  dist/native/ndisend is missing: run npm run build'); process.exit(1) }

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e-ndi')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const video = join(outDir, 'tone880.mp4')
const made = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=40', '-f', 'lavfi', '-i', 'sine=f=880:duration=40', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video])
if (made.status !== 0) { console.error('FAIL  ffmpeg could not make the test video'); process.exit(1) }

async function run(mode) {
  const name = `PS E2E ${mode} ${process.pid}`
  const playVideo = mode === 'video'
  const evalJs = `(async () => {
    const sc = await prestreamer.addNdiScreen(${JSON.stringify(name)}, { width: 640, height: 360 })
    await prestreamer.updateScreen(sc.id, { ndiSound: ${JSON.stringify(mode)}, look: { background: '#2064c8', showMedia: false } })
    // The mixer carries a 440 Hz tone (channel 1 of the built-in test tones) on one strip, centred.
    const mixer = await prestreamer.audioMixerGet()
    const strip = { channel: 1, source: { deviceId: 'test:tones', label: 'Test tones' }, name: 'Tone', trimDb: 0, faderDb: 0, pan: 0, mute: false, solo: false, chain: [] }
    await prestreamer.audioMixerSet({ ...mixer, strips: [strip], masterChain: [] })
    await prestreamer.audioConfigure({ source: { type: 'silence' }, mixerSources: true })
    ${playVideo ? `const v = await prestreamer.videoImport()
    await prestreamer.showSlide({ label: 'Video', text: 'x', video: { file: v.file, title: 'tone', durationSec: v.durationSec } })
    await prestreamer.playbackCommand({ type: 'play' })` : ''}
    await prestreamer.setLive(sc.id, true)
    await new Promise((r) => setTimeout(r, 11000))
    return (await prestreamer.getState()).ndi
  })()`
  const app = spawn(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_NDI_LIB: library, PRESTREAMER_NO_AUTO_OPEN: '1', PRESTREAMER_VIDEO_FILE: video, PRESTREAMER_EVAL: evalJs, PRESTREAMER_SNAPSHOT: join(outDir, `op-${mode}.png`), PRESTREAMER_USER_DATA: join(outDir, `userdata-${mode}`) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let appOut = ''
  app.stdout.on('data', (d) => { appOut += d })
  const closed = new Promise((r) => app.on('close', r))
  await new Promise((r) => setTimeout(r, 7000)) // the app starts, adds the screen, opens it and (for 'video') starts the video
  const rx = spawnSync(helper, ['receive', library, name, '5000'], { encoding: 'utf8', timeout: 20_000 })
  await closed
  const [frames, w, h, b, g, r, , samples, channels, rate, peak, hz, gapMs] = rx.stdout.trim().split(/\s+/).map(Number)
  return { frames, w, h, b, g, r, samples, channels, rate, peak, hz, gapMs, rxStatus: rx.status, rxErr: rx.stderr.trim(), appOut }
}

const near = (a, e) => Math.abs(a - e) <= 24 // NDI compresses and the window's colours are managed, so they come back close (about 10 off), not exact; black would be 100+ off
const checks = []
const stream = await run('stream')
checks.push(
  ['the NDI source was found and frames arrived', stream.rxStatus === 0 && stream.frames > 10, `${stream.frames} frames  ${stream.rxErr}`],
  ["the frames have the screen's size (640×360)", stream.w === 640 && stream.h === 360, `${stream.w}×${stream.h}`],
  ["the picture is the screen's colour (#2064c8)", near(stream.r, 0x20) && near(stream.g, 0x64) && near(stream.b, 0xc8), `R${stream.r} G${stream.g} B${stream.b}`],
  ['stream sound: 48 kHz stereo, most of the 5 s window', stream.channels === 2 && stream.rate === 48000 && stream.samples > 3.5 * 48000, `${stream.channels} ch, ${stream.rate} Hz, ${(stream.samples / 48000).toFixed(2)} s`],
  ["stream sound is the mixer's tone (440 Hz) at the right level", Math.abs(stream.hz - 440) <= 5 && stream.peak > 150 && stream.peak < 300, `${stream.hz} Hz, peak ${stream.peak / 1000}`],
  ['stream sound has no gaps (no wait over 100 ms between blocks)', stream.gapMs > 0 && stream.gapMs < 100, `${stream.gapMs} ms`],
  ['the app reports the output as sending, with the stream sound', /"state":"sending".*stream/.test(stream.appOut), (stream.appOut.match(/EVAL .*/) ?? [''])[0]],
)
const vid = await run('video')
checks.push(
  ['video sound: the 880 Hz video comes through, not the 440 Hz mixer tone', Math.abs(vid.hz - 880) <= 10 && vid.peak > 50, `${vid.hz} Hz, peak ${vid.peak / 1000}, ${(vid.samples / 48000).toFixed(2)} s`],
  ['video sound has no gaps', vid.gapMs > 0 && vid.gapMs < 100, `${vid.gapMs} ms`],
)
const none = await run('none')
checks.push(['no sound: the picture arrives and no audio does', none.frames > 10 && none.samples === 0, `${none.frames} frames, ${none.samples} audio samples`])

let failed = 0
for (const [label, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} NDI checks passed`)
process.exit(failed ? 1 : 0)

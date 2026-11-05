// End-to-end streaming check: runs the real app for a few seconds with the animated test pattern and a test beep,
// streams to a local file, and verifies what ffmpeg actually wrote. Needs ffmpeg + ffprobe on PATH and a display.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const SECONDS = 8
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
for (const d of readdirSync(outDir)) if (d.startsWith('userdata-') && d.endsWith('-stream')) rmSync(join(outDir, d), { recursive: true, force: true }) // every run starts from a fresh installation (the panel remembers collapsed sections)
const out = join(outDir, 'stream.mkv')

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_STREAMTEST: out, PRESTREAMER_AUDIO: 'test', PRESTREAMER_SECONDS: String(SECONDS), PRESTREAMER_USER_DATA: join(outDir, 'userdata') },
  encoding: 'utf8',
  timeout: 120_000,
})
if (run.status !== 0) {
  console.error('App did not exit cleanly', run.status, run.stderr?.slice(-500))
  process.exit(1)
}
const final = /STREAM FINAL (\{.*\})/.exec(run.stdout)
const status = final ? JSON.parse(final[1]) : null

const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height', '-show_entries', 'format=duration', '-of', 'json', out], { encoding: 'utf8' })
const info = probe.status === 0 ? JSON.parse(probe.stdout) : { streams: [], format: {} }
const video = info.streams.find((s) => s.codec_type === 'video')
const audio = info.streams.find((s) => s.codec_type === 'audio')
const duration = Number(info.format.duration) || 0

const checks = [
  ['the stream ended cleanly (state idle, "Stopped")', status?.state === 'idle' && status?.message === 'Stopped', JSON.stringify(status?.state)],
  ['video is H.264 1920x1080', video?.codec_name === 'h264' && video?.width === 1920 && video?.height === 1080, `${video?.codec_name} ${video?.width}x${video?.height}`],
  ['audio track is AAC', audio?.codec_name === 'aac', audio?.codec_name],
  // Loose lower bound: a loaded CI machine may drop frames, but a working pipeline writes most of the run.
  [`file holds at least half of the ${SECONDS} s that were streamed`, duration >= SECONDS / 2, `${duration.toFixed(1)} s`],
  ['frames were sent to the encoder', (status?.frames ?? 0) > SECONDS * 10, `${status?.frames} frames, ${status?.dropped} dropped`],
]

// --- The stream's audio is the MIXER's output ---------------------------------------------------------------------------
// Four tones go in, only channel 2 (440 Hz) is in the mix, and the mixer is stopped 4 s into a 9 s stream. The file must
// carry that one tone, then silence, and must not stall when the mixer stops.
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const mixOut = join(outDir, 'stream-mixer.mkv')
const run2 = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_STREAMTEST: mixOut, PRESTREAMER_AUDIO: 'multitest', PRESTREAMER_AUDIO_STOP: '4', PRESTREAMER_SECONDS: '9', PRESTREAMER_USER_DATA: join(outDir, 'userdata-mixer-stream') },
  encoding: 'utf8',
  timeout: 120_000,
})
const probe2 = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mixOut], { encoding: 'utf8' })
const duration2 = Number(probe2.stdout) || 0
/** Level (dB) of one tone, or of everything (freq = 0), in a window of the file. Several narrow band-pass filters in a row isolate the tone. */
function level(start, dur, freq) {
  const bands = freq ? ['bandpass=f=' + freq + ':width_type=h:w=60', 'bandpass=f=' + freq + ':width_type=h:w=60', 'bandpass=f=' + freq + ':width_type=h:w=60'] : []
  const r = spawnSync(ffmpeg, ['-hide_banner', '-ss', String(start), '-t', String(dur), '-i', mixOut, '-vn', '-af', [...bands, 'volumedetect'].join(','), '-f', 'null', '-'], { encoding: 'utf8' })
  const m = /mean_volume:\s*(-?[\d.]+|-inf) dB/.exec(r.stderr)
  return m && m[1] !== '-inf' ? Number(m[1]) : -100
}
const tone440 = level(1.2, 2, 440)
const tone880 = level(1.2, 2, 880)
const tail = level(6.5, 2, 0)
checks.push(
  ['the app streamed with the mixer as audio and exited cleanly', run2.status === 0 && /STREAM FINAL/.test(run2.stdout ?? ''), `exit ${run2.status}`],
  ['the stream carries the tone that is in the mix (440 Hz)', tone440 > -40, `${tone440.toFixed(1)} dB`],
  ['...and not the tones that are not in the mix (880 Hz)', tone880 < tone440 - 25, `${tone880.toFixed(1)} dB vs ${tone440.toFixed(1)} dB`],
  ['stopping the mixer mid-stream leaves silence, not a stalled stream', tail < -60 && duration2 >= 7, `tail ${tail.toFixed(1)} dB, file ${duration2.toFixed(1)} s of 9`],
)

// --- Stream settings are applied, and the health panel shows live numbers ----------------------------------------------
// 720p at 25 fps, 2000 kb/s video, 96 kb/s audio. The panel is read while the stream is running.
const settingsOut = join(outDir, 'stream-settings.mkv')
const wanted = { width: 1280, height: 720, fps: 25, videoKbps: 2000, audioKbps: 96, keyframeSec: 2, encoder: 'libx264', preset: 'veryfast' }
const panel = `(() => { try { const h = document.querySelector('.health'); const c = h.querySelector('canvas'); const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let drawn = 0; for (let i = 3; i < px.length; i += 4) if (px[i] > 0) drawn++; const vis = (e) => getComputedStyle(e).display !== 'none'; const head = document.getElementById('streamtools').parentElement; const mini = document.querySelector('.healthmini'); document.getElementById('healthtitle').click(); const collapsed = { miniShown: vis(mini), fullHidden: !vis(h), miniText: mini.textContent }; mini.click(); collapsed.expandedFromStrip = vis(h) && !vis(mini); head.click(); collapsed.sectionMini = vis(document.querySelector('.healthmini')); collapsed.formHidden = !vis(document.querySelector('#stream .panelbox')); head.click(); collapsed.restored = vis(h) && vis(document.querySelector('#stream .panelbox')); return { collapsed, label: document.querySelector('#healthtitle b').textContent, dot: document.querySelector('#healthtitle .hdot').className, sub: h.querySelector('.hsub').textContent, cells: [...h.querySelectorAll('.hcell')].map((x) => x.querySelector('.hv').textContent), drawn } } catch (e) { return { error: String(e) } } })()`
const run3 = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_STREAMTEST: settingsOut, PRESTREAMER_AUDIO: 'test', PRESTREAMER_SECONDS: '9', PRESTREAMER_STREAM_SETTINGS: JSON.stringify(wanted), PRESTREAMER_EVAL_LIVE: panel, PRESTREAMER_USER_DATA: join(outDir, 'userdata-settings-stream') },
  encoding: 'utf8',
  timeout: 120_000,
})
const live = /^EVAL_LIVE (.*)$/m.exec(run3.stdout ?? '')
const livePanel = live ? JSON.parse(live[1]) : null
const finalLine = /STREAM FINAL (\{.*\})/.exec(run3.stdout ?? '')
const finalStats = finalLine ? JSON.parse(finalLine[1]).stats : null
const probe3 = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate', '-of', 'json', settingsOut], { encoding: 'utf8' }).stdout || '{"streams":[{}]}').streams[0]
const keyTimes = (spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', settingsOut], { encoding: 'utf8' }).stdout || '').trim().split('\n').map(Number).filter(Number.isFinite)
const gaps = keyTimes.slice(1).map((t, i) => t - keyTimes[i])
checks.push(
  ['the stream uses the chosen picture size and frame rate', probe3.width === 1280 && probe3.height === 720 && probe3.r_frame_rate === '25/1', `${probe3.width}x${probe3.height} ${probe3.r_frame_rate}`],
  ['keyframes come at the chosen interval (2 s)', gaps.length >= 2 && gaps.every((g) => g > 1.5 && g < 2.6), gaps.map((g) => g.toFixed(2)).join(', ')],
  ['the health panel shows a rating, live time, size and frame rate while streaming', livePanel && /^(Good|Unstable|Poor)$/.test(livePanel.label) && /LIVE \d\d:\d\d:\d\d/.test(livePanel.sub) && /1280×720 @ 25/.test(livePanel.sub), JSON.stringify(livePanel && [livePanel.label, livePanel.sub])],
  ['...with a bitrate reading and a graph', livePanel && /^[\d,]+ kb\/s$/.test(livePanel.cells[0]) && livePanel.drawn > 0, JSON.stringify(livePanel && [livePanel.cells[0], livePanel.drawn])],
  ['collapsing the statistics while streaming leaves a one-line summary with the dropped-frame share (60 s)', livePanel?.collapsed?.miniShown === true && livePanel.collapsed.fullHidden === true && /LIVE 00:/.test(livePanel.collapsed.miniText) && /Dropped \d+(\.\d)?% \(60 s\)/.test(livePanel.collapsed.miniText), JSON.stringify(livePanel?.collapsed)],
  ['the statistics expand again by clicking the summary strip', livePanel?.collapsed?.expandedFromStrip === true, ''],
  ['collapsing the whole Stream section (click its title) hides the form but keeps the summary; expanding restores everything', livePanel?.collapsed?.sectionMini === true && livePanel.collapsed.formHidden === true && livePanel.collapsed.restored === true, ''],
  ['the final statistics carry the chosen targets', finalStats && finalStats.targetFps === 25 && finalStats.targetKbps === 2096 && finalStats.width === 1280 && finalStats.bitrateKbps > 100, JSON.stringify(finalStats && { fps: finalStats.targetFps, target: finalStats.targetKbps, bitrate: finalStats.bitrateKbps })],
)

// --- The real streaming protocol: RTMP to a local server -----------------------------------------------------------------
// ffmpeg itself listens as an RTMP server and records what it receives (standing in for YouTube's ingest). PreStreamer
// streams to it exactly as it would to YouTube, and the health panel is read while it runs.
const rtmpIn = join(outDir, 'rtmp-received.flv')
const rtmpUrl = 'rtmp://127.0.0.1:19350/live/test'
const server = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'warning', '-y', '-listen', '1', '-i', rtmpUrl, '-c', 'copy', rtmpIn], { stdio: 'ignore' })
await new Promise((r) => setTimeout(r, 1200)) // let it start listening
const run4 = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_STREAMTEST: join(outDir, 'unused.mkv'), PRESTREAMER_RTMP_URL: rtmpUrl, PRESTREAMER_AUDIO: 'multitest', PRESTREAMER_SECONDS: '22', PRESTREAMER_STREAM_SETTINGS: JSON.stringify({ ...wanted, width: 1920, height: 1080, fps: 30, videoKbps: 3000 }), PRESTREAMER_EVAL_LIVE: panel, PRESTREAMER_USER_DATA: join(outDir, 'userdata-rtmp-stream') },
  encoding: 'utf8',
  timeout: 120_000,
})
await new Promise((resolve) => { const t = setTimeout(() => { server.kill(); resolve() }, 8000); server.on('close', () => { clearTimeout(t); resolve() }) })
const live4 = /^EVAL_LIVE (.*)$/m.exec(run4.stdout ?? '')
const panel4 = live4 ? JSON.parse(live4[1]) : null
if (panel4?.error) console.log("PANEL ERROR", panel4.error)
if (!panel4) console.log("RTMP run output tail:", (run4.stdout ?? "").slice(-400), (run4.stderr ?? "").slice(-600))
const probe4 = JSON.parse(spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,codec_type,width,height:format=duration', '-of', 'json', rtmpIn], { encoding: 'utf8' }).stdout || '{"streams":[],"format":{}}')
const v4 = probe4.streams.find((x) => x.codec_type === 'video')
const a4 = probe4.streams.find((x) => x.codec_type === 'audio')
const bitrate4 = panel4 ? Number(panel4.cells[0].replace(/[^\d]/g, '')) : 0
checks.push(
  ['an RTMP server receives the stream: H.264 1920x1080 video and AAC audio', v4?.codec_name === 'h264' && v4?.width === 1920 && a4?.codec_name === 'aac', JSON.stringify([v4?.codec_name, v4?.width, a4?.codec_name])],
  ['...for most of the time that was streamed', Number(probe4.format.duration) >= 10, `${Number(probe4.format.duration || 0).toFixed(1)} s of 22`],
  ['on a live RTMP stream the panel shows a real, steady bitrate', bitrate4 > 300 && bitrate4 < 6000, `${bitrate4} kb/s (target 3,128)`],
  ['...and rates the stream', panel4 && /^(Good|Unstable|Poor)$/.test(panel4.label), panel4?.label],
)

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
}
console.log(`\n${checks.length - failed}/${checks.length} streaming checks passed`)
process.exit(failed ? 1 : 0)

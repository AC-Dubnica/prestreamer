// End-to-end streaming check: runs the real app for a few seconds with the animated test pattern and a test beep,
// streams to a local file, and verifies what ffmpeg actually wrote. Needs ffmpeg + ffprobe on PATH and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe'
const SECONDS = 8
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
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
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
}
console.log(`\n${checks.length - failed}/${checks.length} streaming checks passed`)
process.exit(failed ? 1 : 0)

// End-to-end check of "Camera only": streams a slide AND an announcement with no camera. Normally the stream shows them
// (bright text on the screen's background); in camera-only mode the stream frame must be plain black. Needs ffmpeg and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })

function stream(name, extraEnv) {
  const file = join(outDir, `camonly-${name}.mkv`)
  const run = spawnSync(electronPath, ['.'], {
    env: { ...process.env, PRESTREAMER_STREAMTEST: file, PRESTREAMER_SECONDS: '6', PRESTREAMER_NO_SOURCE: '1', PRESTREAMER_ANNOUNCE: 'SERVICE STARTS IN 5 MINUTES', PRESTREAMER_USER_DATA: join(outDir, `userdata-camonly-${name}`), ...extraEnv },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const frame = spawnSync(ffmpeg, ['-v', 'error', '-ss', '3', '-i', file, '-frames:v', '1', '-vf', 'scale=320:180', '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 })
  const px = frame.stdout
  let max = 0, sum = 0
  for (const v of px) { if (v > max) max = v; sum += v }
  return { exit: run.status, max, mean: px.length ? sum / px.length : -1, size: px.length }
}

const normal = stream('normal', {})
const camOnly = stream('camera-only', { PRESTREAMER_CAMERA_ONLY: '1' })
const checks = [
  ['both runs streamed a frame', normal.size === 320 * 180 && camOnly.size === 320 * 180, `${normal.size}, ${camOnly.size}`],
  ['normally the stream shows the slide text and announcement', normal.max > 200 && normal.mean > 15, `max ${normal.max}, mean ${normal.mean.toFixed(1)}`],
  ['in camera-only mode the stream is plain black: no text, no announcement, no background', camOnly.max <= 16, `max ${camOnly.max}, mean ${camOnly.mean.toFixed(1)}`],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} camera-only checks passed`)
process.exit(failed ? 1 : 0)

// End-to-end video check: generates sample files in several containers/codecs, has the real app import each one
// (checking the copy / remux / transcode decision) and play one on all screens, and verifies that every window
// follows the shared clock through play, pause and seek. Needs ffmpeg on PATH and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
const dir = join(outDir, 'video')
mkdirSync(dir, { recursive: true })

const encoders = spawnSync(ffmpeg, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? ''
const has = (name) => new RegExp(`\\b${name}\\b`).test(encoders)
const source = ['-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=10', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=10']
const make = (file, ...codec) => spawnSync(ffmpeg, ['-v', 'error', '-y', ...source, ...codec, '-shortest', join(dir, file)], { encoding: 'utf8' }).status === 0

make('t.mp4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac')
make('t.mov', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac')
make('t.mkv', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac')
if (has('libx265')) make('t-hevc.mkv', '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac')
if (has('prores_ks')) make('t-prores.mov', '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le')

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_VIDEOTEST: dir, PRESTREAMER_USER_DATA: join(outDir, 'userdata-video') }, encoding: 'utf8', timeout: 180_000 })
if (run.status !== 0) {
  console.error('App did not exit cleanly', run.status, run.stderr?.slice(-500))
  process.exit(1)
}

const plans = Object.fromEntries([...run.stdout.matchAll(/IMPORT (\S+) (\S+) /g)].map((m) => [m[1], m[2]]))
const positions = Object.fromEntries([...run.stdout.matchAll(/POS (.+?) clock ([\d.]+) (\{.*\})/g)].map((m) => [m[1], { clock: Number(m[2]), windows: Object.values(JSON.parse(m[3])) }]))
const spread = (p) => (p ? Math.max(...p.windows) - Math.min(...p.windows) : Infinity)

const checks = [
  ['H.264/AAC mp4 is copied unchanged', plans['t.mp4'] === 'copy', plans['t.mp4']],
  ['H.264 in a .mov is re-wrapped, not re-encoded', plans['t.mov'] === 'remux', plans['t.mov']],
  ['H.264 in a .mkv is re-wrapped, not re-encoded', plans['t.mkv'] === 'remux', plans['t.mkv']],
  ...(plans['t-hevc.mkv'] !== undefined || has('libx265') ? [['HEVC is transcoded to H.264', plans['t-hevc.mkv'] === 'transcode', plans['t-hevc.mkv']]] : []),
  ...(plans['t-prores.mov'] !== undefined || has('prores_ks') ? [['ProRes is transcoded to H.264', plans['t-prores.mov'] === 'transcode', plans['t-prores.mov']]] : []),
  ['video loads paused at 0 on every screen', positions['loaded (paused)']?.windows.every((w) => w === 0), JSON.stringify(positions['loaded (paused)']?.windows)],
  ['all screens follow the clock while playing (within 0.75 s of each other)', spread(positions.playing) < 0.75 && positions.playing?.windows.every((w) => w > 0.5), `spread ${spread(positions.playing).toFixed(2)} s, windows ${JSON.stringify(positions.playing?.windows)}`],
  ['pause freezes every screen at the same moment', spread(positions.paused) < 0.75, `spread ${spread(positions.paused).toFixed(2)} s`],
  ['seeking works (the screens jump to the new position)', positions['after seek to 6 + play']?.windows.every((w) => w > 5.5), JSON.stringify(positions['after seek to 6 + play']?.windows)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
}
console.log(`\n${checks.length - failed}/${checks.length} video checks passed`)
process.exit(failed ? 1 : 0)

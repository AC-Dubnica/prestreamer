// End-to-end check of the native multichannel capture (what lets a 32-channel USB interface show all its channels, where the
// browser stops at two). A stand-in interface is made by ffmpeg: 32 channels, channel n a sine of 300 + 100·n Hz. Strips
// take channels of it, the app records the mix, and each segment must contain exactly the frequencies of the channels chosen.
// That proves the whole path: ffmpeg → byte alignment → IPC → buffer → the right channel of the mixer. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e-native')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'native.f32')

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_NATIVE_TEST: '1', PRESTREAMER_NATIVETEST: out, PRESTREAMER_USER_DATA: join(outDir, 'userdata') }, encoding: 'utf8', timeout: 120_000 })
if (run.status !== 0) {
  console.error('App did not exit cleanly', run.status, run.stderr?.slice(-500))
  process.exit(1)
}
console.log((run.stdout.match(/^(AUDIO|STATUS) .*$/gm) ?? []).join("\n"))

const raw = readFileSync(out)
const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
const { sampleRate, segments: list, hz } = JSON.parse(readFileSync(`${out}.segments.json`, 'utf8'))
const segments = Object.fromEntries(list.map((s) => [s.name, s]))

/** Level of one frequency in dB relative to a full-scale sine, over the middle of a segment. */
function level(segment, freq) {
  const start = segment.startFrame + Math.round(0.8 * sampleRate)
  const end = segment.endFrame - Math.round(0.3 * sampleRate)
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end; i++) {
    const s0 = (pcm[2 * i] + pcm[2 * i + 1]) / 2 + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const n = end - start
  const amplitude = 2 * Math.sqrt(Math.max((s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n), 0))
  return amplitude < 1e-6 ? -120 : 20 * Math.log10(amplitude)
}

const f = (ch) => hz[ch]
const fmt = (db) => `${db.toFixed(1)} dB`
const heard = (seg, ch) => level(segments[seg], f(ch))
const base = heard('ch5', 4)
const checks = [
  ['channel 5 is audible (700 Hz)', base > -30, fmt(base)],
  ['channel 5 alone: channel 21 (2300 Hz) is silent', heard('ch5', 20) < base - 50, fmt(heard('ch5', 20))],
  ['channel 5 alone: channel 6 (800 Hz) is silent', heard('ch5', 5) < base - 50, fmt(heard('ch5', 5))],
  ['channel 21 alone is audible at its own frequency', Math.abs(heard('ch21', 20) - base) < 1, fmt(heard('ch21', 20))],
  ['channel 21 alone: channel 5 is silent', heard('ch21', 4) < base - 50, fmt(heard('ch21', 4))],
  ['channels 5 and 32 together: both are audible', heard('ch5+ch32', 4) > base - 1 && heard('ch5+ch32', 31) > base - 1, `${fmt(heard('ch5+ch32', 4))} / ${fmt(heard('ch5+ch32', 31))}`],
  ['channels 5 and 32 together: channel 21 stays silent', heard('ch5+ch32', 20) < base - 50, fmt(heard('ch5+ch32', 20))],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
  if (!ok) failed++
}
console.log(`\n${checks.length - failed}/${checks.length} native capture checks passed`)
process.exit(failed ? 1 : 0)

// End-to-end mixer check. Launches the real app, steps the mixer through a scripted sequence of settings on four
// test tones, records the PCM the mixer produces, and measures each tone's level per segment with a Goertzel filter.
// No encoder or ffmpeg involved, so the result does not depend on how busy the machine is.
// Needs a display (the app opens real windows).
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'mixer.f32')

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_MIXERTEST: out, PRESTREAMER_USER_DATA: join(outDir, 'userdata') }, encoding: 'utf8', timeout: 120_000 })
if (run.status !== 0) {
  console.error('App did not exit cleanly', run.status, run.stderr?.slice(-500))
  process.exit(1)
}

const raw = readFileSync(out)
const pcm = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4))
const { sampleRate, segments: list } = JSON.parse(readFileSync(`${out}.segments.json`, 'utf8'))
const segments = Object.fromEntries(list.map((s) => [s.name, s]))

/** Level of one frequency in dB relative to a full-scale sine, over the middle of a segment (settling time skipped). */
function level(segment, freq) {
  const start = segment.startFrame + Math.round(0.9 * sampleRate)
  const end = segment.endFrame - Math.round(0.4 * sampleRate)
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = start; i < end; i++) {
    const mono = (pcm[2 * i] + pcm[2 * i + 1]) / 2 // left + right: a centre-panned tone keeps its level
    const s0 = mono + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  const n = end - start
  const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n) // |X[k]|^2 / N^2
  const amplitude = 2 * Math.sqrt(Math.max(power, 0)) // peak amplitude of that frequency
  return amplitude < 1e-6 ? -120 : 20 * Math.log10(amplitude)
}

const L = (name, freq) => level(segments[name], freq)
const base = L('baseline', 440)
const fmt = (db) => `${db.toFixed(1)} dB`
const checks = [
  ['the mix is audible (channel 2, 440 Hz)', base > -30, fmt(base)],
  ['channels not in the mix are silent (220 Hz)', L('baseline', 220) < base - 50, fmt(L('baseline', 220))],
  ['channels not in the mix are silent (880 Hz)', L('baseline', 880) < base - 50, fmt(L('baseline', 880))],
  ['fader -12 dB lowers the level by 12 dB', Math.abs(L('fader-12', 440) - (base - 12)) < 1, fmt(L('fader-12', 440) - base)],
  ['EQ mid +12 dB raises the level by 12 dB', Math.abs(L('eq+12', 440) - (base + 12)) < 2, fmt(L('eq+12', 440) - base)],
  ['compressor 20:1 reduces the level (-30 dB threshold)', L('compressor', 440) < base - 10, fmt(L('compressor', 440) - base)],
  ['compressor make-up +10 dB adds 10 dB back', Math.abs(L('compressor+makeup', 440) - (L('compressor', 440) + 10)) < 1.5, fmt(L('compressor+makeup', 440) - L('compressor', 440))],
  ['limiter holds the signal near its -20 dB ceiling', L('limiter', 440) < base - 6 && L('limiter', 440) > -30, fmt(L('limiter', 440))],
  ['gate closes below its threshold', L('gate', 440) < base - 30, fmt(L('gate', 440) - base)],
  ['mute silences the strip', L('mute', 440) < base - 60, fmt(L('mute', 440) - base)],
  ['solo lets only the soloed strip through', L('solo-880', 880) > L('solo-880', 440) + 40, `880 Hz ${fmt(L('solo-880', 880))} vs 440 Hz ${fmt(L('solo-880', 440))}`],
  ['strips from two different inputs mix together: the default source\'s 440 Hz tone is still there', Math.abs(L('two-sources', 440) - base) < 1.5, fmt(L('two-sources', 440) - base)],
  ['...and the other input (a 1 kHz beep) is heard too, while it is absent from the single-source mix', L('two-sources', 1000) > -40 && L('baseline', 1000) < -70, `${fmt(L('two-sources', 1000))} vs ${fmt(L('baseline', 1000))}`],
  ['the order of the effects matters: compressor then +12 dB EQ ends louder than EQ then the compressor', L('order-comp-eq', 440) > L('order-eq-comp', 440) + 6, `${fmt(L('order-comp-eq', 440))} vs ${fmt(L('order-eq-comp', 440))}`],
  ['each effect on its own, switched off, leaves the level alone (a reverb used to make a mono strip 3 dB louder)', ['comp', 'eq', 'gate', 'delay', 'reverb'].every((k) => Math.abs(L(`bypassed-${k}`, 440) - base) < 0.5), ['comp', 'eq', 'gate', 'delay', 'reverb'].map((k) => `${k} ${fmt(L(`bypassed-${k}`, 440) - base)}`).join(', ')],
  ['effects that are switched off leave the signal untouched, however they are set', Math.abs(L('bypassed', 440) - base) < 1, fmt(L('bypassed', 440) - base)],
  ['the de-esser lowers a 1760 Hz tone above its threshold', L('deesser', 1760) < L('ch3-baseline', 1760) - 5, fmt(L('deesser', 1760) - L('ch3-baseline', 1760))],
  ['a delay with no feedback and an echo as loud as the voice adds 6 dB when the two line up', Math.abs(L('delay-in-phase', 440) - (base + 6)) < 1.5, fmt(L('delay-in-phase', 440) - base)],
  ['reverb passes the signal on (neither silent nor wildly louder)', L('reverb', 440) > base - 20 && L('reverb', 440) < base + 12, fmt(L('reverb', 440) - base)],
  ['switching the monitor output on leaves the stream mix as it was (the monitor is a copy of it)', Math.abs(L('monitor-on', 440) - base) < 1, fmt(L('monitor-on', 440) - base)],
  ['a sync delay passes the signal on at the same level (it only holds it back)', Math.abs(L('syncdelay', 440) - base) < 1, fmt(L('syncdelay', 440) - base)],
  ['a limiter in the MASTER chain holds the whole mix at its -20 dB ceiling', Math.abs(L('master-limiter', 440) + 20) < 1.5, fmt(L('master-limiter', 440))],
  ['high-pass at 500 Hz cuts a 220 Hz tone', L('ch0-hpf500', 220) < L('ch0-baseline', 220) - 8, fmt(L('ch0-hpf500', 220) - L('ch0-baseline', 220))],
]

let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (${detail})`)
}
console.log(`\n${checks.length - failed}/${checks.length} mixer checks passed`)
process.exit(failed ? 1 : 0)

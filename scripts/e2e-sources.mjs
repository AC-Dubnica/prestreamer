// End-to-end check of the mixer's input sources: the Mixer tab lists EVERY audio input on the machine (not only USB ones)
// plus test sources, a strip can be added from any of them, strips from different inputs run together, and the stream panel
// says what the stream carries. Needs a display. Real devices are only listed and counted, never opened, so no microphone
// permission prompt is needed; the synthetic test sources do the actual mixing.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-sources')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const button = (text) => qa('#view-mixer button').find((b) => b.textContent.trim() === text)
  const selects = () => qa('#view-mixer .mxadd select')
  const choose = async (sel, value) => { sel.value = value; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(400) }
  const strips = () => qa('#view-mixer .strip:not(.master):not(.monitor):not(.audience)')
  const status = () => prestreamer.audioGetStatus()
  const r = {}

  const machine = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications')
  tab('Mixer').click(); await w(1500)
  const options = [...selects()[0].options].map((o) => ({ v: o.value, t: o.textContent }))
  r.machineInputs = machine.length
  r.everyInputListed = machine.every((d) => options.some((o) => o.v === d.deviceId))
  r.listedDeviceOptions = options.filter((o) => !o.v.startsWith('test:') && !o.v.startsWith('app:')).length // real devices only
  r.testSourcesListed = ['app:video', 'test:tones', 'test:beep'].every((id) => options.some((o) => o.v === id))
  r.noGenericUsbNames = !options.some((o) => /^USB \\d+$/.test(o.t))
  // A device plugged in (or out) shows up (or goes) by itself, with no refresh button
  const realEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
  const fake = { kind: 'audioinput', deviceId: 'fake-usb-mixer', label: 'Plugged-in USB mixer', groupId: 'g', toJSON() { return this } }
  navigator.mediaDevices.enumerateDevices = async () => [...(await realEnumerate()), fake]
  navigator.mediaDevices.dispatchEvent(new Event('devicechange')); await w(500)
  r.hotplug = { noButton: !button('Refresh inputs'), appeared: [...selects()[0].options].some((o) => o.value === 'fake-usb-mixer') }
  navigator.mediaDevices.enumerateDevices = realEnumerate
  navigator.mediaDevices.dispatchEvent(new Event('devicechange')); await w(500)
  r.hotplug.gone = ![...selects()[0].options].some((o) => o.value === 'fake-usb-mixer')
  r.initialStrips = strips().map((s) => q('.dev', s)?.textContent)
  r.runningAtStart = { state: (await status()).state, startButton: !!button('Start mixer'), stopButton: !!button('Stop mixer') }

  // Add channel 2 of the test tones: the mixer starts by itself
  await choose(selects()[0], 'test:tones')
  r.toneChannelChoices = selects()[1].options.length
  await choose(selects()[1], '1')
  button('Add channel').click(); await w(1500)
  let st = await status()
  r.afterFirstAdd = { state: st.state, devices: (st.devices || []).map((d) => d.id + ':' + d.channels) }
  const sticksOut = (box) => qa('*', box).filter((e) => { const a = e.getBoundingClientRect(); const b = box.getBoundingClientRect(); return a.width > 0 && (a.right > b.right + 0.5 || a.left < b.left - 0.5) }).map((e) => (e.className && e.className.baseVal === undefined ? e.className : e.tagName) + ':' + (e.textContent || '').slice(0, 12))
  r.overflow = qa('#view-mixer .strip').flatMap((box) => sticksOut(box))
  r.stripDevice = strips().map((s) => q('.dev', s)?.textContent)

  // A channel from a DIFFERENT input joins it
  await choose(selects()[0], 'test:beep')
  r.beepChannelChoices = selects()[1].options.length
  button('Add channel').click(); await w(1500)
  st = await status()
  r.afterSecondAdd = (st.devices || []).map((d) => d.id + ':' + d.channels).sort()
  const count = strips().length
  button('Add channel').click(); await w(400) // the same channel again
  r.duplicateIgnored = strips().length === count
  r.saved = (await prestreamer.audioMixerGet()).strips.filter((s) => s.source).map((s) => s.source.deviceId + '#' + s.channel).sort()

  // The stream panel says what the stream carries
  tab('Present').click(); await w(400)
  const line = () => qa('#stream .status:not([hidden])').map((e) => e.textContent).find((t) => /^The (mixer|stream will)/.test(t))
  r.streamLineRunning = line()
  r.stillRunning = (await status()).state
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'sources.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The sources scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const checks = [
  ['every audio input on this machine is offered as a source (not only USB ones)', r.everyInputListed === true && r.listedDeviceOptions === r.machineInputs, `${r.listedDeviceOptions} listed, ${r.machineInputs} on the machine`],
  ['the video playback input and the test sources are offered too', r.testSourcesListed === true, ''],
  ['a device plugged in appears in the Mixer by itself, goes when unplugged, and there is no refresh button', r.hotplug.noButton && r.hotplug.appeared && r.hotplug.gone, JSON.stringify(r.hotplug)],
  ['sources are named by their device, not as "USB 1…"', r.noGenericUsbNames === true, ''],
  ['the mixer runs by itself from the start: no Start or Stop button', r.runningAtStart.state === 'running' && !r.runningAtStart.startButton && !r.runningAtStart.stopButton, JSON.stringify(r.runningAtStart)],
  ['the channel list follows the chosen source (4 tones, stereo beep)', r.toneChannelChoices === 4 && r.beepChannelChoices === 2, `${r.toneChannelChoices} and ${r.beepChannelChoices}`],
  ['adding a channel from a new input opens that input straight away', r.afterFirstAdd?.state === 'running' && r.afterFirstAdd?.devices?.includes('test:tones:4'), JSON.stringify(r.afterFirstAdd)],
  ['the strip shows which device it reads', r.stripDevice?.includes('Test tones'), JSON.stringify(r.stripDevice)],
  ['a channel from a second, different input runs alongside the first (and the video playback input)', JSON.stringify(r.afterSecondAdd) === JSON.stringify(['app:video:2', 'test:beep:2', 'test:tones:4']), JSON.stringify(r.afterSecondAdd)],
  ['a new mixer starts with the video playback pair in it', JSON.stringify(r.initialStrips) === JSON.stringify(['Video playback', 'Video playback']), JSON.stringify(r.initialStrips)],
  ['nothing inside a strip (master included) sticks out of it', r.overflow?.length === 0, JSON.stringify(r.overflow?.slice(0, 4))],
  ['adding the same channel again does not duplicate it', r.duplicateIgnored === true, ''],
  ['the strips and their devices are saved', JSON.stringify(r.saved) === JSON.stringify(['app:video#0', 'app:video#1', 'test:beep#0', 'test:tones#1']), JSON.stringify(r.saved)],
  ['the stream panel stays quiet while the mixer runs (no "master goes to the stream" line)', r.streamLineRunning === undefined, String(r.streamLineRunning)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} input-source checks passed`)
process.exit(failed ? 1 : 0)

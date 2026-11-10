// End-to-end check of DMX lighting without an interface: the real `dmxsend` helper runs in its file mode (PRESTREAMER_DMX_FAKE) and
// the frame it leaves behind is read back. Settings → DMX switches it on and patches two lights, the Present tab recalls a scene
// and sets the master; nothing is sent before that. Needs a display.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-dmx')
const frameFile = join(outDir, 'dmx-frame.bin')
rmSync(userData, { recursive: true, force: true })
rmSync(frameFile, { force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (n) => qa('#tabs button').find((b) => b.textContent.trim() === n)
  const r = {}
  await w(700)
  r.hiddenBefore = q('#dmxsec').hidden === true
  r.statusBefore = (await prestreamer.dmxGet()).state

  tab('Settings').click(); await w(400)
  qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'DMX').click(); await w(500)
  const page = () => q('#view-settings .setbody').textContent
  r.page = { off: /Switched off/.test(page()), noLights: /No lights yet/.test(page()) }
  qa('#view-settings input[type=checkbox]')[0].click(); await w(600)
  r.on = { ready: /Ready/.test(page()), panelStillHidden: q('#dmxsec').hidden === false, state: (await prestreamer.dmxGet()).state }
  const add = () => qa('#view-settings button').find((b) => b.textContent.trim() === 'Add light')
  add().click(); await w(400); add().click(); await w(400)
  const s = (await prestreamer.dmxGet()).settings
  r.lights = s.fixtures.map((f) => [f.kind, f.address, f.channels])
  await prestreamer.dmxSetSettings({ ...s,
    fixtures: s.fixtures.map((f, i) => ({ ...f, name: i ? 'Right wash' : 'Left wash' })),
    scenes: [
      { id: 'worship', name: 'Worship', fadeSec: 0, values: { [s.fixtures[0].id]: [200, 0, 100], [s.fixtures[1].id]: [0, 0, 255] } },
      { id: 'sermon', name: 'Sermon', fadeSec: null, values: { [s.fixtures[0].id]: [255, 255, 255], [s.fixtures[1].id]: [255, 255, 255] } },
    ] })
  await w(500)
  r.rows = qa('#view-settings .dmxrow').length

  tab('Present').click(); await w(500)
  r.panel = { shown: q('#dmxsec').hidden === false, scenes: qa('#dmx .atembtn').map((b) => b.textContent), sliders: qa('#dmx .dmxlevels input[type=range]').length }
  r.idle = (await prestreamer.dmxGet()).state // still nothing sent: no scene recalled, no fader moved
  qa('#dmx .atembtn').find((b) => b.textContent === 'Worship').click(); await w(1500)
  r.afterScene = { state: (await prestreamer.dmxGet()).state, on: qa('#dmx .atembtn.on').map((b) => b.textContent), slider: q('#dmx .dmxlevels input[type=range]').value }
  const m = q('#dmx .dmxmix input[type=range]'); m.value = '50'; m.dispatchEvent(new Event('input', { bubbles: true })); await w(1200)
  r.master = (await prestreamer.dmxGet()).master
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_DMX_FAKE: frameFile, PRESTREAMER_SNAPSHOT: join(outDir, 'dmx.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 90_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The DMX scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const frame = existsSync(frameFile) ? readFileSync(frameFile) : Buffer.alloc(0)
const j = JSON.stringify
const checks = [
  ['switched off, there is no DMX section and nothing is open', r.hiddenBefore && r.statusBefore === 'off', j([r.hiddenBefore, r.statusBefore])],
  ['Settings → DMX says it is switched off and has no lights', r.page.off && r.page.noLights, j(r.page)],
  ['ticking "Use DMX" shows the panel, and still sends nothing', r.on.ready && r.on.panelStillHidden && r.on.state === 'idle', j(r.on)],
  ['Add light puts the lights on free addresses (1 and 4, RGB)', j(r.lights) === j([['rgb', 1, 3], ['rgb', 4, 3]]), j(r.lights)],
  ['each light and scene is a row in Settings', r.rows === 4, String(r.rows)],
  ['the Present tab shows both scenes and a fader per channel', r.panel.shown && j(r.panel.scenes) === j(['Worship', 'Sermon']) && r.panel.sliders === 6, j(r.panel)],
  ['nothing is sent until a scene is recalled', r.idle === 'idle', r.idle],
  ['recalling Worship starts the output, lights its button and moves the faders', r.afterScene.state !== 'idle' && j(r.afterScene.on) === j(['Worship']) && r.afterScene.slider === '200', j(r.afterScene)],
  ['the master is applied', r.master === 50, String(r.master)],
  ['the helper left a frame: start code 0 and 512 slots', frame.length === 513 && frame[0] === 0, String(frame.length)],
  ['the slots are the scene at 50 %: 100,0,50 and 0,0,128 at addresses 1 and 4', j([...frame.subarray(1, 7)]) === j([100, 0, 50, 0, 0, 128]) && frame.subarray(7).every((b) => b === 0), j([...frame.subarray(0, 8)])],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} DMX checks passed`)
process.exit(failed ? 1 : 0)

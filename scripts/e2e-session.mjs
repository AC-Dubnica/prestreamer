// End-to-end check that the app opens the way it was left: runs it twice on the same data folder. The first run changes the
// tab, the service, the selected screen and which screens are open; the second run must find all of that as it was left.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-session')
rmSync(userData, { recursive: true, force: true })

const helpers = `
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const card = (name) => qa('#screens .screen').find((c) => q('.name', c).textContent === name)
`

const first = `(async () => {${helpers}
  await w(500)
  const s = await prestreamer.getState()
  const stream = s.screens.find((x) => x.kind === 'virtual')
  // a second service, selected
  const sel = q('#servicesel'); sel.value = 'sunday-sample'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(300)
  const serviceBefore = q('#servicesel').value
  // select the Stream screen card, open it, and go to the Mixer tab
  card('Stream').click(); await w(300)
  await prestreamer.setLive(stream.id, true); await w(500)
  tab('Mixer').click(); await w(700)
  return { serviceBefore, live: (await prestreamer.getState()).live.length }
})()`

const second = `(async () => {${helpers}
  await w(1500)
  const s = await prestreamer.getState()
  const stream = s.screens.find((x) => x.kind === 'virtual')
  return {
    activeTab: qa('#tabs button').find((b) => b.classList.contains('on'))?.textContent.trim(),
    mixerVisible: q('#view-mixer').classList.contains('active'),
    service: q('#servicesel').value,
    selectedScreen: qa('#screens .screen.sel').map((c) => q('.name', c).textContent),
    liveStream: s.live.includes(stream.id),
    liveAudience: s.live.includes(s.screens.find((x) => x.name === 'Audience').id),
    streaming: (await prestreamer.streamGetStatus()).state,
  }
})()`

const run = (scenario) => {
  const r = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'session.png'), PRESTREAMER_EVAL: scenario, PRESTREAMER_NO_AUTO_OPEN: '1' }, encoding: 'utf8', timeout: 120_000 })
  const line = /^EVAL (.*)$/m.exec(r.stdout ?? '')
  if (!line) { console.error('A session run did not report a result.', r.status, (r.stderr || '').slice(-500), (r.stdout || '').slice(-500)); process.exit(1) }
  return JSON.parse(line[1])
}
const a = run(first)
const saved = JSON.parse(readFileSync(join(userData, 'session.json'), 'utf8'))
const b = run(second)

const checks = [
  ['the first run changed things: a service chosen and a screen opened', a.serviceBefore === 'sunday-sample' && a.live >= 1, JSON.stringify(a)],
  ['the open screens were written down when the app quit (not forgotten while closing them)', saved.liveScreens.length >= 1, JSON.stringify(saved.liveScreens)],
  ['it opens on the tab it was left on (Mixer)', b.activeTab === 'Mixer' && b.mixerVisible === true, `${b.activeTab}`],
  ['it opens with the same service selected', b.service === 'sunday-sample', b.service],
  ['it opens with the same screen selected', JSON.stringify(b.selectedScreen) === JSON.stringify(['Stream']), JSON.stringify(b.selectedScreen)],
  ['the screen that was open is open again', b.liveStream === true, ''],
  ['a screen that was closed stays closed', b.liveAudience === false, ''],
  ['it never starts streaming by itself', b.streaming === 'idle', b.streaming],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} session checks passed`)
process.exit(failed ? 1 : 0)

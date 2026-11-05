// End-to-end check of the ATEM panel without a switcher: it is shown greyed out ("not connected"), nothing in it can be
// pressed, the address dialog still works and refuses nonsense. (The switching itself is unit-tested against a fake.) Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-atem')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const r = {}
  const panel = () => q('#atem .atem')
  await w(500)
  const buttons = () => qa('button', panel())
  r.off = { present: !!panel(), greyed: panel().classList.contains('off'), ariaDisabled: panel().getAttribute('aria-disabled') === 'true', title: q('#atem .hhead b').textContent, note: q('#atem .status').textContent }
  r.off.allDisabled = buttons().length >= 6 && buttons().every((b) => b.disabled)
  r.status = await prestreamer.atemGet()

  // The gear in the ATEM header stays usable; a bad address is refused, a good one is remembered
  const gear = q('#atemtools button')
  r.gear = { enabled: !!gear && !gear.disabled }
  gear.click(); await w(300)
  const dlg = q('#modal:not([hidden]) .dialog')
  r.dialog = !!dlg && /ATEM address/.test(dlg.textContent)
  const input = q('input', dlg)
  r.dialogValue = input.value
  input.value = 'http://nope'; input.dispatchEvent(new Event('input', { bubbles: true }))
  qa('button', dlg).find((b) => b.textContent.trim() === 'Connect').click(); await w(400)
  r.refused = /not an IP address/.test(q('#atem .status').textContent)
  gear.click(); await w(300)
  const input2 = q('#modal:not([hidden]) input')
  input2.value = '10.20.30.40'; input2.dispatchEvent(new Event('input', { bubbles: true }))
  qa('#modal:not([hidden]) button').find((b) => b.textContent.trim() === 'Connect').click(); await w(500)
  r.saved = { address: (await prestreamer.atemGet()).address, note: q('#atem .status').textContent, stillOff: panel().classList.contains('off') }
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'atem.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 90_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The ATEM scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const j = JSON.stringify
const checks = [
  ['with no switcher the ATEM panel is there but greyed out and says it is not connected', r.off.present && r.off.greyed && r.off.ariaDisabled && r.off.title === 'ATEM not connected' && /No ATEM found at 192\.168\.10\.240/.test(r.off.note), j(r.off)],
  ['every switching button (inputs, Cut, Auto) is disabled', r.off.allDisabled === true, ''],
  ['the status says searching at the factory address', r.status.state === 'searching' && r.status.address === '192.168.10.240', j(r.status)],
  ['the address button stays usable and opens a dialog showing the current address', r.gear.enabled && r.dialog && r.dialogValue === '192.168.10.240', j([r.gear, r.dialog, r.dialogValue])],
  ['an address that is not an IP or host name is refused', r.refused === true, ''],
  ['a valid address is remembered and the panel keeps waiting for a switcher there', r.saved.address === '10.20.30.40' && /10\.20\.30\.40/.test(r.saved.note) && r.saved.stillOff, j(r.saved)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} ATEM panel checks passed`)
process.exit(failed ? 1 : 0)

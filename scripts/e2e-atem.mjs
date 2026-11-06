// End-to-end check of ATEM control without a switcher: no ATEM section is shown anywhere, and Settings → ATEM holds the address
// (the dialog refuses nonsense) and the button choices. (The switching itself is unit-tested against a fake.) Needs a display.
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
  const tab = (n) => qa('header button, nav button, .tabs button').find((b) => b.textContent.trim() === n)
  const r = {}
  await w(600)
  // Without a switcher nobody sees an ATEM section: not in the Present tab, not in the Monitor tab
  r.hidden = { present: q('#atemsec').hidden === true }
  tab('Monitor').click(); await w(500)
  r.hidden.monitor = q('#view-monitor .matem').hidden === true
  tab('Present').click(); await w(300)
  r.status = await prestreamer.atemGet()

  // Everything about the switcher is in Settings → ATEM
  tab('Settings').click(); await w(400)
  qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'ATEM').click(); await w(400)
  const page = () => q('#view-settings .setbody').textContent
  r.page = { notConnected: /Not connected/.test(page()), searching: /No ATEM found at 192\.168\.10\.240/.test(page()), boxes: qa('#view-settings input[type=checkbox]').length }
  const change = () => qa('#view-settings button').find((b) => b.textContent.trim().startsWith('Change'))
  change().click(); await w(300)
  const dlg = q('#modal:not([hidden]) .dialog')
  r.dialog = !!dlg && /ATEM address/.test(dlg.textContent)
  const input = q('input', dlg)
  r.dialogValue = input.value
  input.value = 'http://nope'; input.dispatchEvent(new Event('input', { bubbles: true }))
  qa('button', dlg).find((b) => b.textContent.trim() === 'Connect').click(); await w(500)
  r.refused = /not an IP address/.test(page())
  change().click(); await w(300)
  const input2 = q('#modal:not([hidden]) input')
  input2.value = '10.20.30.40'; input2.dispatchEvent(new Event('input', { bubbles: true }))
  qa('#modal:not([hidden]) button').find((b) => b.textContent.trim() === 'Connect').click(); await w(600)
  r.saved = { address: (await prestreamer.atemGet()).address, shown: /10\.20\.30\.40/.test(page()), sectionStillHidden: q('#atemsec').hidden === true }

  // Hiding switching buttons is remembered (and kept when the address changes)
  qa('#view-settings input[type=checkbox]')[0].click(); await w(500)
  r.buttons = (await prestreamer.atemGet()).buttons
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
  ['with no switcher there is no ATEM section in the Present tab or the Monitor tab', r.hidden.present && r.hidden.monitor, j(r.hidden)],
  ['the status says searching at the factory address', r.status.state === 'searching' && r.status.address === '192.168.10.240', j(r.status)],
  ['Settings → ATEM says it is not connected, where it looked, and offers the three button choices', r.page.notConnected && r.page.searching && r.page.boxes === 3, j(r.page)],
  ['Change… opens a dialog showing the current address', r.dialog && r.dialogValue === '192.168.10.240', j([r.dialog, r.dialogValue])],
  ['an address that is not an IP or host name is refused', r.refused === true, ''],
  ['a valid address is remembered and shown, and the sections stay hidden while no switcher answers', r.saved.address === '10.20.30.40' && r.saved.shown && r.saved.sectionStillHidden, j(r.saved)],
  ['unticking Preview is remembered', r.buttons.preview === false && r.buttons.cut === true && r.buttons.auto === true, j(r.buttons)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} ATEM panel checks passed`)
process.exit(failed ? 1 : 0)

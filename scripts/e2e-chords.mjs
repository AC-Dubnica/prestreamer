// End-to-end check of chords: a song with chord lines in its text, a stage monitor with and without "Chords", and the plain slides
// that never show them. The screen's card in the Present tab uses the same drawing code as the real output window. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-chords')
rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
// The song and a service with it are there from the start, as a real library would be.
writeFileSync(join(userData, 'songs.json'), JSON.stringify([{ id: 'cs', title: 'Chord song', body: '[Verse 1]\n  G     D\nAmazing grace\n  Em    C\nhow sweet', background: null }]))
writeFileSync(join(userData, 'services.json'), JSON.stringify([{ id: 'svc', name: 'Chords', items: [{ id: 'i1', kind: 'song', songId: 'cs' }] }]))

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (n) => qa('#tabs button').find((b) => b.textContent.trim() === n)
  const r = {}
  await w(800)
  const sel = q('#servicesel'); sel.value = 'svc'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(500)
  qa('#schedule .srow')[0].click(); await w(600)
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await w(600)

  const stage = await prestreamer.addDisplayScreen('Stage monitor', { stage: true }); await w(400)
  await prestreamer.setLive(stage.id, true); await w(500)
  const cardText = () => { const c = qa('#screens .screen').find((c) => /Stage monitor/.test(q('.name', c).textContent)); return c ? q('[data-slide-text]', c)?.textContent ?? '' : null }
  r.state = (await prestreamer.getState()).slide
  r.off = cardText()
  await prestreamer.updateScreen(stage.id, { look: { showChords: true } }); await w(700)
  r.on = cardText()
  await prestreamer.updateScreen(stage.id, { look: { showChords: false } }); await w(700)
  r.offAgain = cardText()

  // The checkbox in the screen's edit dialog does the same (Settings → Screens → the pencil)
  tab('Settings').click(); await w(500)
  qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'Screens').click(); await w(400)
  const card = qa('#view-settings .setcard').find((c) => /Stage monitor/.test(q('.scname', c)?.textContent ?? ''))
  qa('button', card).find((b) => /^Change name/.test(b.title)).click(); await w(500)
  const dlg = q('#modal:not([hidden]) .dialog')
  const chordsRow = qa('label.sdrow', dlg).find((l) => l.textContent.trim().startsWith('Chords'))
  r.formHasChords = !!chordsRow
  chordsRow.querySelector('input').click(); await w(200)
  qa('button', dlg).find((b) => b.textContent.trim() === 'Apply').click(); await w(800)
  r.afterForm = (await prestreamer.getState()).screens.find((s) => s.id === stage.id).look.showChords
  tab('Present').click(); await w(600)
  r.onFromForm = cardText()
  return r
})()`

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'chords.png'), PRESTREAMER_EVAL: scenario }, encoding: 'utf8', timeout: 90_000 })
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The chords scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const j = JSON.stringify
const checks = [
  ['the slide on air has the lyrics only as its text and the chord lines in `chords`', r.state?.text === 'Amazing grace\nhow sweet' && /G {5}D\nAmazing grace\n {2}Em {4}C\nhow sweet/.test(r.state?.chords ?? ''), j(r.state)],
  ['a stage monitor without Chords shows the lyrics only', !!r.off && !/\bG\b|\bEm\b/.test(r.off) && r.off.includes('Amazing grace'), j(r.off)],
  ['with Chords on it shows the chord lines above the words', /G {5}D/.test(r.on ?? '') && /Em/.test(r.on ?? '') && r.on.includes('Amazing grace'), j(r.on)],
  ['switching Chords off hides them again', !/\bEm\b/.test(r.offAgain ?? ''), j(r.offAgain)],
  ['the screen dialog has the Chords checkbox, and Apply turns it on', r.formHasChords && r.afterForm === true && /\bEm\b/.test(r.onFromForm ?? ''), j([r.formHasChords, r.afterForm])],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} chord checks passed`)
process.exit(failed ? 1 : 0)

// End-to-end Bible check: imports two invented Zefania files with Slovak-style book names (no real Scripture), then drives
// the real Bible tab: reference box, book/chapter pickers, a second version alongside, adding a reading to the service,
// and showing / stepping through its slides. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
const fixtures = join(outDir, 'bible-fixtures')
const userData = join(outDir, 'userdata-bible')
rmSync(userData, { recursive: true, force: true })
mkdirSync(fixtures, { recursive: true })

const xml = (name, john, corinthians, verse) => `<?xml version="1.0" encoding="utf-8"?>
<XMLBIBLE biblename="${name}" type="x-bible">
  <BIBLEBOOK bnumber="43" bname="${john}" bsname="Jn"><CHAPTER cnumber="3">
    ${[16, 17, 18, 19, 20].map((n) => `<VERS vnumber="${n}">${verse} ${n}.</VERS>`).join('\n    ')}
  </CHAPTER></BIBLEBOOK>
  <BIBLEBOOK bnumber="46" bname="${corinthians}" bsname="1Kor"><CHAPTER cnumber="13"><VERS vnumber="1">${verse} lásky.</VERS></CHAPTER></BIBLEBOOK>
</XMLBIBLE>`
writeFileSync(join(fixtures, 'rohacek.xml'), xml('Roháček (test)', 'Ján', '1. Korinťanom', 'Vymyslená veta číslo'))
writeFileSync(join(fixtures, 'ekumenicky.xml'), xml('Ekumenický (test)', 'Evanjelium podľa Jána', '1. list Korinťanom', 'Iná vymyslená veta číslo'))
writeFileSync(join(fixtures, 'notes.txt'), 'not a bible')
writeFileSync(join(fixtures, 'page.xml'), '<html><body>not a bible</body></html>')

const scenario = `(async () => {
  const fixtures = ${JSON.stringify(fixtures)}
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const modal = () => q('#modal:not([hidden]) .dialog')
  const field = () => q('#view-bible .bbar input[type=text]')
  const enter = async (text) => { const f = field(); f.value = text; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await w(500) }
  const selects = () => qa('#view-bible .bbar select')
  const choose = async (sel, value) => { sel.value = value; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(500) }
  const r = {}

  r.imports = await prestreamer.bibleImportPaths([fixtures + '/rohacek.xml', fixtures + '/ekumenicky.xml', fixtures + '/notes.txt', fixtures + '/page.xml'])
  r.reimport = (await prestreamer.bibleImportPaths([fixtures + '/rohacek.xml']))[0].status

  tab('Bible').click(); await w(700)
  r.versions = qa('#view-bible aside .item .t').map((e) => e.textContent)
  r.firstVersionSelected = q('#view-bible aside .item.sel .t')?.textContent

  // A version with long book names ("Evanjelium podľa Jána"): the word "jan" must still find the book
  await enter('jan 3,16-18')
  r.longRows = qa('#view-bible .bverse').length
  r.longRef = field().value
  // Switch to the version with short names for the rest
  qa('#view-bible aside .item').find((i) => i.textContent.includes('Roháček')).click(); await w(500)
  r.mainVersion = q('#view-bible aside .item.sel .t')?.textContent

  // Diacritics-free reference with Slovak comma notation
  await enter('jan 3,16-18')
  r.rows = qa('#view-bible .bverse').length
  r.selectedRows = qa('#view-bible .bverse.sel').length
  r.refBox = field().value
  r.slideCount = qa('#view-bible .card').length      // "fit to the slide" puts three short verses on one slide
  const per = qa('#view-bible .bopts select')[0]; await choose(per, '1')
  r.slidesOneVerseEach = qa('#view-bible .card .tag').map((t) => t.textContent)

  // Pickers
  await choose(selects()[0], '1'); r.afterBookPick = field().value // book index 1 = 1. Korinťanom
  await enter('1 kor 13'); r.corinthians = qa('#view-bible .bverse').length
  await enter('Ján 3,16-18')

  // Second version alongside
  const compare = selects()[2]
  r.compareOptions = [...compare.options].map((o) => o.textContent)
  await choose(compare, [...compare.options].find((o) => o.value)?.value)
  r.compareLines = qa('#view-bible .bcmp').length
  r.slideWithTwoVersions = qa('#view-bible .card')[0] ? true : false

  // Friendly errors
  await enter('Nothing 3,16'); r.unknownBook = q('#view-bible aside .status.error')?.textContent
  await enter('Ján 99'); r.badChapter = q('#view-bible aside .status.error')?.textContent
  await enter('Ján 3,16-18')

  // Add to the service and use it from the Present tab
  const before = (await prestreamer.servicesList())[0].items.length
  qa('#view-bible button').find((b) => b.textContent.includes('Add to service')).click(); await w(600)
  const service = (await prestreamer.servicesList())[0]
  const added = service.items[service.items.length - 1]
  r.added = { count: [before, service.items.length], kind: added?.kind, title: added?.title, slides: added?.slides?.length, firstText: added?.slides?.[0]?.text }
  r.addNote = q('#view-bible aside .status')?.textContent

  tab('Present').click(); await w(400)
  const rows = qa('#schedule .srow'); rows[rows.length - 1].click(); await w(400)
  // the slide view lists every item of the service; the reading is the last section
  const readingSection = () => qa('#center section.slist').pop()
  r.centerTitle = q('h1', readingSection())?.textContent
  r.centerCards = qa('.card', readingSection()).length
  qa('.card', readingSection())[0].click(); await w(400)
  let st = await prestreamer.getState()
  r.shown = { label: st.slide?.label, text: st.slide?.text, hasItem: !!st.slide?.itemId }
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await w(400)
  st = await prestreamer.getState()
  r.afterNext = st.slide?.label

  // Removing a version asks first
  tab('Bible').click(); await w(500)
  qa('#view-bible aside .item button')[0].click(); await w(300)
  r.removeDialog = q('.dhead', modal())?.textContent
  qa('button', modal()).find((b) => b.textContent === 'Remove').click(); await w(600)
  r.versionsAfterRemove = qa('#view-bible aside .item .t').map((e) => e.textContent)
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'bible.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The Bible scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const status = (file) => r.imports?.find((i) => i.file === file)

const checks = [
  ['two Bibles import with the names stated in their files', status('rohacek.xml')?.status === 'imported' && status('rohacek.xml')?.name === 'Roháček (test)' && status('ekumenicky.xml')?.name === 'Ekumenický (test)', JSON.stringify(r.imports?.slice(0, 2).map((i) => i.name))],
  ['a text file and a non-Bible XML are refused, with a reason', status('notes.txt')?.status === 'failed' && status('page.xml')?.status === 'failed' && /Zefania/.test(status('page.xml')?.error ?? ''), status('page.xml')?.error],
  ['importing the same version again replaces it', r.reimport === 'replaced', r.reimport],
  ['both versions are listed, alphabetically', JSON.stringify(r.versions) === JSON.stringify(['Ekumenický (test)', 'Roháček (test)']), JSON.stringify(r.versions)],
  ['a long book name ("Evanjelium podľa Jána") is found by the word "jan"', r.longRows === 5 && r.longRef === 'Evanjelium podľa Jána 3:16–18', `${r.longRows} verses, "${r.longRef}"`],
  ['"jan 3,16-18" (no accents, Slovak comma) opens Ján 3 with 3 of 5 verses selected', r.rows === 5 && r.selectedRows === 3 && r.refBox === 'Ján 3:16–18', `${r.rows} verses, ${r.selectedRows} selected, box "${r.refBox}"`],
  ['"fit to the slide" puts three short verses on one slide', r.slideCount === 1, String(r.slideCount)],
  ['"1 verse" per slide makes one slide per verse, labelled with the reference', JSON.stringify(r.slidesOneVerseEach) === JSON.stringify(['Ján 3:16', 'Ján 3:17', 'Ján 3:18']), JSON.stringify(r.slidesOneVerseEach)],
  ['the book picker works', r.afterBookPick?.startsWith('1. Korinťanom'), r.afterBookPick],
  ['"1 kor 13" finds 1. Korinťanom 13', r.corinthians === 1, String(r.corinthians)],
  ['a second version can be shown alongside', r.compareOptions?.length === 2 && r.compareLines === 5 && r.mainVersion === 'Roháček (test)', `${r.compareLines} comparison lines`],
  ['an unknown book gives a clear message', /Could not understand/.test(r.unknownBook ?? ''), r.unknownBook?.slice(0, 60)],
  ['a chapter that does not exist gives a clear message', /Ján has only 3 chapters\./.test(r.badChapter ?? ''), r.badChapter],
  ['"Add to service" appends a reading with its slides', r.added?.count?.[1] === r.added?.count?.[0] + 1 && r.added?.kind === 'scripture' && r.added?.slides === 3, JSON.stringify(r.added?.count)],
  ['the reading is titled with the passage and both versions', /^Ján 3:16–18 · Roháček \(test\) \/ Ekumenický \(test\)$/.test(r.added?.title ?? ''), r.added?.title],
  ['each slide shows the verse text of both versions and the reference', /16 Vymyslená/.test(r.added?.firstText ?? '') && /16 Iná vymyslená/.test(r.added?.firstText ?? '') && /Ján 3:16 · /.test(r.added?.firstText ?? ''), JSON.stringify(r.added?.firstText)],
  ['the service confirms what was added', /Added/.test(r.addNote ?? ''), r.addNote],
  ['the reading appears in the run sheet with its slides', /Ján 3:16–18/.test(r.centerTitle ?? '') && r.centerCards === 3, `${r.centerTitle} / ${r.centerCards} slides`],
  ['clicking a slide shows it on the screens', r.shown?.label === 'Ján 3:16' && /Vymyslená/.test(r.shown?.text ?? '') && r.shown?.hasItem === true, JSON.stringify(r.shown?.label)],
  ['the arrow key steps to the next verse', r.afterNext === 'Ján 3:17', r.afterNext],
  ['removing a version asks first, then removes it', /Remove "Ekumenický \(test\)"\?/.test(r.removeDialog ?? '') && JSON.stringify(r.versionsAfterRemove) === JSON.stringify(['Roháček (test)']), `${r.removeDialog} -> ${JSON.stringify(r.versionsAfterRemove)}`],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} Bible checks passed`)
process.exit(failed ? 1 : 0)

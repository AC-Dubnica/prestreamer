// End-to-end UI check: drives the real operator window (service dialogs, per-screen settings popup) by clicking its
// actual buttons, and checks both what the UI shows and what was saved. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-ui')
rmSync(userData, { recursive: true, force: true }) // every run starts from a fresh installation

// Runs inside the operator window. Returns plain data; the assertions are below.
const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const modal = () => q('#modal:not([hidden]) .dialog')
  const button = (text, root = document) => qa('button', root).find((b) => b.textContent.trim() === text)
  const tool = (title) => q('#svctools button[title="' + title + '"]')
  const type = (input, value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) }
  const options = () => qa('#servicesel option').map((o) => o.textContent)
  const selected = () => { const s = q('#servicesel'); return s.options[s.selectedIndex]?.textContent }
  const saved = async () => (await prestreamer.servicesList())
  const screens = async () => (await prestreamer.getState()).screens
  const r = {}
  try {

  // --- services
  r.startOptions = options()
  tool('New service').click(); await w(200)
  r.newDialogOpen = !!modal()
  r.newDialogDefault = q('input', modal()).value
  type(q('input', modal()), ''); await w(50)
  r.emptyNameDisablesCreate = button('Create', modal()).disabled
  button('Cancel', modal()).click(); await w(100)
  r.cancelClosesAndAddsNothing = !modal() && options().length === r.startOptions.length

  tool('New service').click(); await w(200)
  type(q('input', modal()), 'Easter 2026'); await w(50)
  button('Create', modal()).click(); await w(400)
  r.createdSelected = selected()
  r.createdSaved = (await saved()).map((s) => s.name)

  tool('Rename this service').click(); await w(200)
  r.renamePrefilled = q('input', modal()).value
  type(q('input', modal()), 'Easter Sunday'); await w(50)
  button('Rename', modal()).click(); await w(400)
  r.renamedSelected = selected()
  r.renamedSaved = (await saved()).map((s) => s.name)

  tool('New service').click(); await w(200)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(100)
  r.escapeClosesDialog = !modal()

  const sel = q('#servicesel'); sel.value = 'sunday-sample'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(200)
  const before = (await saved()).find((s) => s.id === 'sunday-sample')
  tool('Duplicate this service (start from a copy)').click(); await w(200)
  r.duplicatePrefilled = q('input', modal()).value
  button('Duplicate', modal()).click(); await w(400)
  const after = await saved()
  const copy = after.find((s) => s.name === 'Sunday service (copy)')
  r.duplicateItemCount = [before.items.length, copy?.items.length]
  r.duplicateHasNewItemIds = !!copy && copy.items.every((it) => !before.items.some((o) => o.id === it.id))
  r.duplicateSelected = selected()

  tool('Delete this service').click(); await w(200)
  r.deleteDialogTitle = q('.dhead', modal())?.textContent
  button('Cancel', modal()).click(); await w(300)
  r.cancelKeepsService = (await saved()).some((s) => s.name === 'Sunday service (copy)')
  tool('Delete this service').click(); await w(200)
  button('Delete service', modal()).click(); await w(400)
  r.afterDeleteSaved = (await saved()).map((s) => s.name)
  r.afterDeleteSelectedStillExists = options().length > 0 && !!selected()

  // --- screens
  const card = (name) => qa('#screens .screen').find((c) => q('.name', c).textContent === name)
  const before2 = await screens()
  q('button[title^="Settings for Stream"]', card('Stream')).click(); await w(300)
  r.screenDialogTitle = q('.sdtitle')?.textContent
  const layout = qa('select', modal()).find((s) => [...s.options].some((o) => o.value === 'lower-third'))
  layout.value = 'lower-third'; layout.dispatchEvent(new Event('change', { bubbles: true })); await w(400)
  let st = (await screens()).find((s) => s.id === 'stream')
  r.streamLayout = [st.look.layout, st.look.textBoxOpacity]
  const size = qa('input[type=number]', modal())[0]
  size.value = '52'; size.dispatchEvent(new Event('change', { bubbles: true })); await w(400)
  st = (await screens()).find((s) => s.id === 'stream')
  r.streamAfterFont = [st.look.layout, st.look.fontSize]
  r.audienceUntouched = (await screens()).find((s) => s.id === 'audience').look.layout === before2.find((s) => s.id === 'audience').look.layout
  button('Done', modal()).click(); await w(200)
  r.doneClosesDialog = !modal()

  q('button[title^="Settings for Audience"]', card('Audience')).click(); await w(300)
  const swatch = qa('.sw button', modal()).find((b) => !b.classList.contains('picked') && b.title.startsWith('linear'))
  swatch.click(); await w(400)
  const now = await screens()
  r.audienceBackgroundChanged = now.find((s) => s.id === 'audience').look.background !== before2.find((s) => s.id === 'audience').look.background
  r.streamBackgroundUntouched = now.find((s) => s.id === 'stream').look.background === before2.find((s) => s.id === 'stream').look.background
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(150)

  q('.pv', card('Audience')).click(); await w(200)
  r.cardClickSelects = card('Audience').classList.contains('sel') && !card('Stream').classList.contains('sel')
  q('.pv', card('Stream')).click(); await w(200)
  r.cardClickMovesSelection = card('Stream').classList.contains('sel') && !card('Audience').classList.contains('sel')

  // --- header: spacing, plain labels, open all / close all (with a confirmation), closing a single screen
  const hdr = qa('#headbtns button')
  const rects = hdr.map((b) => b.getBoundingClientRect())
  r.headerLabels = hdr.map((b) => b.textContent.trim())
  r.headerGaps = rects.slice(1).map((rc, i) => Math.round(rc.left - rects[i].right))
  const openAll = hdr.find((b) => b.textContent.trim() === 'Open all screens')
  const closeAll = hdr.find((b) => b.textContent.trim() === 'Close all screens')
  r.cardButtons = qa('#screens .screen .bar button').map((b) => b.textContent.trim()).filter((t) => t === 'Open' || t === 'Close')
  const total = (await prestreamer.getState()).screens.length
  r.start = { live: (await prestreamer.getState()).live.length, total, closeEnabled: !closeAll.disabled, openDisabled: openAll.disabled }
  closeAll.click(); await w(300)
  r.closeAllTitle = q('.dhead', modal())?.textContent
  button('Cancel', modal()).click(); await w(300)
  r.cancelKeepsOpen = (await prestreamer.getState()).live.length === total
  closeAll.click(); await w(300); button('Close all screens', modal()).click(); await w(800)
  r.afterCloseAll = { live: (await prestreamer.getState()).live.length, openEnabled: !openAll.disabled, closeDisabled: closeAll.disabled, cardButtons: qa('#screens .screen .bar button').map((b) => b.textContent.trim()).filter((t) => t === 'Open' || t === 'Close') }
  openAll.click(); await w(1000)
  r.afterOpenAll = { live: (await prestreamer.getState()).live.length, openDisabled: openAll.disabled }
  q('button[title="Close Stream"]', card('Stream')).click(); await w(600)
  r.closeOne = (await prestreamer.getState()).live
  return r
  } catch (e) { r.error = String((e && e.stack) || e); return r }
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'ui.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The UI scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])

const checks = [
  ['the scenario ran to the end without an error', !r.error, (r.error || '').split('\n').slice(0, 3).join(' | ')],
  ['starts with the sample service', r.startOptions?.[0]?.startsWith('Sunday service'), JSON.stringify(r.startOptions)],
  ['New service asks for a name (dialog opens with a default)', r.newDialogOpen && r.newDialogDefault?.startsWith('Sunday '), r.newDialogDefault],
  ['an empty name cannot be created', r.emptyNameDisablesCreate === true, ''],
  ['Cancel closes the dialog and adds nothing', r.cancelClosesAndAddsNothing === true, ''],
  ['a named service is created, selected and saved', r.createdSelected?.startsWith('Easter 2026') && r.createdSaved?.includes('Easter 2026'), r.createdSelected],
  ['Rename is prefilled with the current name', r.renamePrefilled === 'Easter 2026', r.renamePrefilled],
  ['Rename updates the selector and the saved service', r.renamedSelected?.startsWith('Easter Sunday') && r.renamedSaved?.includes('Easter Sunday') && !r.renamedSaved?.includes('Easter 2026'), JSON.stringify(r.renamedSaved)],
  ['Esc closes a dialog', r.escapeClosesDialog === true, ''],
  ['Duplicate suggests "<name> (copy)"', r.duplicatePrefilled === 'Sunday service (copy)', r.duplicatePrefilled],
  ['Duplicate copies every item, with new ids', r.duplicateItemCount?.[0] > 0 && r.duplicateItemCount[0] === r.duplicateItemCount[1] && r.duplicateHasNewItemIds, JSON.stringify(r.duplicateItemCount)],
  ['the copy becomes the current service', r.duplicateSelected?.startsWith('Sunday service (copy)'), r.duplicateSelected],
  ['Delete asks first and names the service', r.deleteDialogTitle === 'Delete "Sunday service (copy)"?', r.deleteDialogTitle],
  ['Cancel on the delete dialog keeps the service', r.cancelKeepsService === true, ''],
  ['confirming Delete removes it, and another service is selected', !r.afterDeleteSaved?.includes('Sunday service (copy)') && r.afterDeleteSelectedStillExists === true, JSON.stringify(r.afterDeleteSaved)],
  ['the screen popup is titled with the screen it edits', r.screenDialogTitle?.startsWith('Stream'), r.screenDialogTitle],
  ['changing the layout changes that screen (lower third with a text box)', r.streamLayout?.[0] === 'lower-third' && r.streamLayout?.[1] > 0, JSON.stringify(r.streamLayout)],
  ['a second change does not undo the first (no stale overwrite)', r.streamAfterFont?.[0] === 'lower-third' && r.streamAfterFont?.[1] === 52, JSON.stringify(r.streamAfterFont)],
  ['editing one screen leaves the others alone', r.audienceUntouched === true && r.streamBackgroundUntouched === true && r.audienceBackgroundChanged === true, ''],
  ['Done closes the popup', r.doneClosesDialog === true, ''],
  ['clicking anywhere on a screen card selects it', r.cardClickSelects === true && r.cardClickMovesSelection === true, ''],
  ['the header buttons say what they do', JSON.stringify(r.headerLabels) === JSON.stringify(['Announce', 'Clear slide', 'Open all screens', 'Close all screens']), JSON.stringify(r.headerLabels)],
  ['the header buttons have space between them', r.headerGaps?.length === 3 && r.headerGaps.every((g) => g >= 8), JSON.stringify(r.headerGaps)],
  ['each screen has an Open / Close button (not "Go live")', r.cardButtons?.length === 2 && r.cardButtons.every((t) => t === 'Close'), JSON.stringify(r.cardButtons)],
  ['with everything open: Close all is enabled, Open all is greyed out', r.start?.live === r.start?.total && r.start?.closeEnabled === true && r.start?.openDisabled === true, JSON.stringify(r.start)],
  ['Close all screens asks first', r.closeAllTitle === 'Close all screens?', r.closeAllTitle],
  ['Cancel leaves every screen open', r.cancelKeepsOpen === true, ''],
  ['confirming closes every screen, and the buttons follow', r.afterCloseAll?.live === 0 && r.afterCloseAll?.openEnabled === true && r.afterCloseAll?.closeDisabled === true && r.afterCloseAll?.cardButtons?.every((t) => t === 'Open'), JSON.stringify(r.afterCloseAll)],
  ['one click on Open all screens opens them all', r.afterOpenAll?.live === r.start?.total && r.afterOpenAll?.openDisabled === true, JSON.stringify(r.afterOpenAll)],
  ['closing a single screen closes only that one', JSON.stringify(r.closeOne) === '["audience"]', JSON.stringify(r.closeOne)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} UI checks passed`)
process.exit(failed ? 1 : 0)

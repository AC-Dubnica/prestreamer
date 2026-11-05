// End-to-end check of the stage monitor: it is added from Settings, shown in the Present tab, and its screen shows the
// current slide, the NEXT slide and the clock, following the arrow keys. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-stage')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const st = async () => await prestreamer.getState()
  const key = async (k) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await w(500) }
  const stageCard = () => qa('#screens .screen').find((c) => /Stage monitor/.test(q('.name', c).textContent))
  const r = {}

  const before = (await st()).screens.length
  tab('Settings').click(); await w(500)
  qa('#view-settings button').find((b) => b.textContent.trim() === 'Stage monitor').click(); await w(600)
  const s = await st()
  const stage = s.screens.find((x) => x.look.layout === 'stage')
  r.added = { count: s.screens.length - before, kind: stage?.kind, background: stage?.look.background, showMedia: stage?.look.showMedia }

  tab('Present').click(); await w(500)
  r.cardPresent = !!stageCard()
  const sel = q('#servicesel'); sel.value = 'sunday-sample'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(500)
  await key('ArrowRight'); await key('ArrowRight')
  const s2 = await st()
  r.current = s2.slide?.text
  r.nextInState = s2.next?.text
  const card = stageCard()
  const root = card && q('[data-stage-next]', card)
  r.cardShowsNext = root ? root.textContent : null
  r.cardShowsClock = /\\d{1,2}[:.]\\d{2}/.test(q('[data-stage-clock]', card)?.textContent ?? '')
  r.cardShowsCurrent = !!card && card.textContent.includes((s2.slide?.text ?? '?').split('\\n')[0])
  await key('ArrowRight')
  const s3 = await st()
  r.nextMoved = s3.next?.text !== s2.next?.text && s3.slide?.text === s2.next?.text
  await key('Escape')
  r.nextClearedWithSlide = (await st()).next === null

  // Reordering in Settings reorders the cards in the Present tab
  const presentOrder = () => qa('#screens .screen .name').map((n) => n.textContent)
  const settingsCard = () => qa('#view-settings .setcard').find((c) => /Stage monitor/.test(q('input', c)?.value ?? c.textContent))
  tab('Settings').click(); await w(500)
  const orderBefore = (await st()).screens.map((x) => x.name)
  settingsCard().querySelector('button[title="Move up: higher priority"]').click(); await w(600)
  const orderAfter = (await st()).screens.map((x) => x.name)
  tab('Present').click(); await w(400)
  r.reorder = { saved: orderAfter, present: presentOrder(), changed: JSON.stringify(orderBefore) !== JSON.stringify(orderAfter) }

  // Lower third with a dark box and NO slide: nothing at all is drawn (no empty box); with a slide the caption is back
  const audience = (await st()).screens.find((x) => x.name === 'Audience')
  await prestreamer.updateScreen(audience.id, { look: { layout: 'lower-third', textBoxOpacity: 0.55 } }); await w(400)
  const audCard = () => qa('#screens .screen').find((c) => q('.name', c).textContent === 'Audience')
  const caption = () => getComputedStyle(q('[data-slide-text]', audCard())).display
  tab('Present').click(); await w(300)
  r.emptyCaption = { noSlide: caption() }
  await prestreamer.showSlide({ label: 'Verse', text: 'Hello caption' }); await w(400)
  r.emptyCaption.withSlide = caption()
  await prestreamer.showSlide(null); await w(400)
  r.emptyCaption.cleared = caption()

  // The camera-only icon button in the Stream header toggles the mode (and no switch with a long label is left)
  const cam = q('button[aria-pressed]', q('#streamtools'))
  r.camera = { exists: !!cam, noSwitch: !q('#stream input.switch'), offAtStart: (await st()).cameraOnly === false }
  await prestreamer.showSlide({ label: 'Verse', text: 'Hello preview' }); await w(300)
  const streamCaption = () => getComputedStyle(q('[data-slide-text]', qa('#screens .screen').find((c) => q('.name', c).textContent === 'Stream'))).display
  const streamAnn = () => getComputedStyle(q('[data-announcement]', qa('#screens .screen').find((c) => q('.name', c).textContent === 'Stream'))).display
  r.camera.previewBefore = streamCaption()
  cam.click(); await w(400)
  r.camera.previewOn = streamCaption()
  r.camera.annOn = streamAnn()
  r.camera.on = (await st()).cameraOnly === true && cam.classList.contains('primary') && cam.getAttribute('aria-pressed') === 'true' && /Camera only is ON/.test(q('#stream').textContent)
  cam.click(); await w(400)
  r.camera.previewAfter = streamCaption()
  r.camera.off = (await st()).cameraOnly === false && !cam.classList.contains('primary')

  // Removing a screen asks in a dialog (cancel keeps it, confirm removes it)
  tab('Settings').click(); await w(500)
  const count = (await st()).screens.length
  const trash = () => qa('#view-settings .setcard').find((c) => /Stage monitor/.test(q('input', c)?.value ?? c.textContent))?.querySelector('button[title="Remove this screen"]')
  const modal = () => q('#modal:not([hidden]) .dialog')
  const btn = (t) => qa('button', modal()).find((b) => b.textContent.trim() === t)
  trash().click(); await w(300)
  r.removeAsksInDialog = !!modal() && /Remove Stage monitor/.test(modal().textContent)
  btn('Cancel').click(); await w(300)
  r.cancelKeeps = (await st()).screens.length === count && !modal()
  trash().click(); await w(300)
  btn('Remove screen').click(); await w(500)
  r.confirmRemoves = (await st()).screens.length === count - 1

  // A stream mirror: a display screen that shows exactly what the stream shows
  tab('Settings').click(); await w(400)
  const beforeMirror = (await st()).screens.length
  qa('#view-settings button').find((b) => b.textContent.trim() === 'Stream mirror').click(); await w(600)
  const sMirror = await st()
  const stream = sMirror.screens.find((x) => x.kind === 'virtual')
  const mirror = sMirror.screens.find((x) => x.mirrorOf)
  r.mirror = { added: sMirror.screens.length - beforeMirror, follows: mirror?.mirrorOf === stream.id, kind: mirror?.kind }
  await prestreamer.updateScreen(stream.id, { look: { background: '#123456', videoAudio: true } }); await w(300)
  let pl = await prestreamer.outputInit(mirror.id)
  r.mirror.payload = { id: pl.screen.id === stream.id, bg: pl.screen.look.background, silent: pl.screen.look.videoAudio === false, camOnly: pl.cameraOnly }
  await prestreamer.setCameraOnly(true); await w(300)
  pl = await prestreamer.outputInit(mirror.id)
  r.mirror.camOnlyFollows = pl.cameraOnly === true
  await prestreamer.setCameraOnly(false); await w(200)
  const sel2 = qa('#view-settings .setcard').find((c) => q('input', c)?.value === mirror.name).querySelector('select[title^="Show exactly"]')
  sel2.value = ''; sel2.dispatchEvent(new Event('change', { bubbles: true })); await w(400)
  r.mirror.stopped = !(await st()).screens.find((x) => x.id === mirror.id).mirrorOf
  await prestreamer.updateScreen(mirror.id, { mirrorOf: stream.id }); await w(300)
  await prestreamer.removeScreen(stream.id); await w(400)
  r.mirror.sourceRemoved = !(await st()).screens.find((x) => x.id === mirror.id).mirrorOf
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'stage.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The stage scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const j = JSON.stringify
const checks = [
  ['the Stage monitor button in Settings adds a display screen with the stage layout, on black, without slide media', r.added.count === 1 && r.added.kind === 'display' && r.added.background === '#000' && r.added.showMedia === false, j(r.added)],
  ['it appears in the Present tab', r.cardPresent === true, ''],
  ['the arrow keys put a slide on air, and the state knows the slide after it', !!r.current && !!r.nextInState && r.current !== r.nextInState, j([r.current, r.nextInState])],
  ['the stage screen shows the current slide', r.cardShowsCurrent === true, ''],
  ['...and the NEXT slide', typeof r.cardShowsNext === 'string' && r.cardShowsNext.startsWith('NEXT') && r.cardShowsNext.includes((r.nextInState ?? '?').split('\n')[0]), j(r.cardShowsNext)],
  ['...and the clock', r.cardShowsClock === true, ''],
  ['stepping forward moves "next" along', r.nextMoved === true, ''],
  ['clearing the slide clears "next" too', r.nextClearedWithSlide === true, ''],
  ['moving a screen up in Settings moves it in the Present tab too', r.reorder.changed === true && JSON.stringify(r.reorder.present) === JSON.stringify(r.reorder.saved), JSON.stringify(r.reorder)],
  ['a Stream mirror display follows the stream screen: same look, silent, camera-only too; it can stop mirroring; it becomes ordinary if its source is removed', r.mirror.added === 1 && r.mirror.kind === 'display' && r.mirror.follows && r.mirror.payload.id && r.mirror.payload.bg === '#123456' && r.mirror.payload.silent && r.mirror.payload.camOnly === false && r.mirror.camOnlyFollows && r.mirror.stopped && r.mirror.sourceRemoved, JSON.stringify(r.mirror)],
  ['lower third: no text block (no empty dark box) without a slide; the caption appears with one and goes away again', r.emptyCaption.noSlide === 'none' && r.emptyCaption.withSlide === 'flex' && r.emptyCaption.cleared === 'none', JSON.stringify(r.emptyCaption)],
  ['the stream card preview in the Present tab follows camera only: text shown, then hidden (with announcements), then back', r.camera.previewBefore === 'flex' && r.camera.previewOn === 'none' && r.camera.annOn === 'none' && r.camera.previewAfter === 'flex', JSON.stringify([r.camera.previewBefore, r.camera.previewOn, r.camera.annOn, r.camera.previewAfter])],
  ['camera only is an icon button in the Stream header: it switches the mode on, says so, and switches it off', r.camera.exists && r.camera.noSwitch && r.camera.offAtStart && r.camera.on && r.camera.off, JSON.stringify(r.camera)],
  ['removing a screen asks in a dialog; Cancel keeps it', r.removeAsksInDialog === true && r.cancelKeeps === true, ''],
  ['...and confirming removes it', r.confirmRemoves === true, ''],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} stage monitor checks passed`)
process.exit(failed ? 1 : 0)

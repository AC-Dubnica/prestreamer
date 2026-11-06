// End-to-end check of the Monitor tab (a draft): a big preview of the selected screen with slide, camera-only and open/close
// controls, and a strip of previews to pick another screen. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-monitor')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const st = async () => await prestreamer.getState()
  const btn = (t) => qa('#view-monitor .mbar button').find((b) => b.textContent.trim() === t)
  const r = {}
  const sel = q('#servicesel'); sel.value = 'sunday-sample'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(400)

  r.tabExists = !!tab('Monitor')
  r.noPreviewsBefore = qa('#view-monitor .monthumb').length === 0
  await prestreamer.showSlide(null); await w(300) // selecting the service may already have put its first slide on air
  tab('Monitor').click(); await w(600)
  const s0 = await st()
  r.big = { box: !!q('#view-monitor .mbig canvas, #view-monitor .mbig div'), title: q('#view-monitor .mtitle').textContent, thumbs: qa('#view-monitor .monthumb').length, screens: s0.screens.length }
  r.nothing = q('#view-monitor .mnow').textContent

  // Next puts the first slide on air, shows what is on air and what comes next
  btn('Next').click(); await w(500)
  const s1 = await st()
  r.onAir = { slide: !!s1.slide, text: q('#view-monitor .mnow').textContent, next: q('#view-monitor .mnext').textContent, nextInState: !!s1.next }
  btn('Next').click(); await w(500)
  r.moved = (await st()).slide?.text !== s1.slide?.text
  btn('Previous').click(); await w(500)
  r.back = (await st()).slide?.text === s1.slide?.text
  // Clear on a screen's own picture takes the slide off that screen only, and Show brings it back
  const tool = (t) => qa('#view-monitor .mbig .mtool').find((b) => b.textContent.trim() === t)
  const shownId = q('#view-monitor .monthumb.sel').dataset.id
  tool('Clear').click(); await w(500)
  const afterClear = await st()
  r.cleared = afterClear.slide !== null && afterClear.blank.includes(shownId) && afterClear.blank.length === 1 && !!tool('Show')
  tool('Show').click(); await w(500)
  r.shownAgain = (await st()).blank.length === 0
  // Open / close the shown screen from its own picture
  const wasLive = (await st()).live.includes(shownId)
  tool(wasLive ? 'Close' : 'Open').click(); await w(600)
  r.toggled = (await st()).live.includes(shownId) !== wasLive && !!tool(wasLive ? 'Open' : 'Close')
  tool(wasLive ? 'Open' : 'Close').click(); await w(600)
  await prestreamer.showSlide(null); await w(300)

  // Picking another screen in the strip changes the big preview
  const thumbs = () => qa('#view-monitor .monthumb')
  const other = thumbs().find((t) => !t.classList.contains('sel'))
  const otherName = q('.monname', other).textContent
  other.click(); await w(500)
  r.pick = { title: q('#view-monitor .mtitle').textContent, selMarked: thumbs().filter((t) => t.classList.contains('sel')).length === 1 && q('.monname', q('#view-monitor .monthumb.sel')).textContent === otherName, name: otherName }

  // Camera only is offered for the stream (virtual) screen only
  const stream = (await st()).screens.find((x) => x.kind === 'virtual')
  const display = (await st()).screens.find((x) => x.kind === 'display')
  thumbs().find((t) => t.dataset.id === display.id).click(); await w(400)
  const cam = () => qa('#view-monitor .mbar button').find((b) => b.getAttribute('aria-label')?.startsWith('Camera only'))
  r.cameraHiddenOnDisplay = cam().hidden === true
  thumbs().find((t) => t.dataset.id === stream.id).click(); await w(400)
  cam().click(); await w(400)
  r.camera = { shown: cam().hidden === false, on: (await st()).cameraOnly === true && cam().classList.contains('primary') }
  cam().click(); await w(300)

  // The arrow keys work here too
  await prestreamer.showSlide(null); await w(200)
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await w(500)
  r.keys = (await st()).slide !== null

  // The big picture fills the room: its width is limited only by the room (width or height), and it keeps its shape
  tab('Monitor').click(); await w(500)
  const seg = (name) => qa('#view-monitor .seg button').find((b) => b.textContent.trim() === name)
  seg('One screen').click(); await w(500)
  const fit = q('#view-monitor .mcontent .mfit').getBoundingClientRect(), bigR = q('#view-monitor .mbig').getBoundingClientRect()
  const ar = parseFloat(q('#view-monitor .mbig').style.getPropertyValue('--ar'))
  r.fills = { fitW: fit.width, fitH: fit.height, bigW: bigR.width, bigH: bigR.height, ar, touches: Math.abs(bigR.width - fit.width) < 3 || Math.abs(bigR.height - fit.height) < 3, shape: Math.abs(bigR.width / bigR.height - ar) < 0.05, inside: bigR.width <= fit.width + 1 && bigR.height <= fit.height + 1 }

  // All screens at once: a grid with every screen, the strip is gone, the controls stay, double-click goes back to one
  seg('All screens').click(); await w(700)
  const cellsNow = () => qa('#view-monitor .moncell')
  const total = (await st()).screens.length
  const gridR = q('#view-monitor .mgrid').getBoundingClientRect()
  r.multi = { buttons: seg('All screens').getAttribute('aria-pressed') === 'true', cells: cellsNow().length, total, stripHidden: getComputedStyle(q('#view-monitor .mstrip')).display === 'none', title: q('#view-monitor .mtitle').textContent, barStays: !!btn('Next'), cols: getComputedStyle(q('#view-monitor .mgrid')).gridTemplateColumns.split(' ').length, allInsideGrid: cellsNow().every((c) => { const b = c.getBoundingClientRect(); return b.right <= gridR.right + 1 && b.bottom <= gridR.bottom + 1 }), noScroll: q('#view-monitor .mmain').scrollHeight <= q('#view-monitor .mmain').clientHeight + 1 }
  r.multi.saved = localStorage.getItem('prestreamer.monitorMode')
  const aCell = cellsNow()[1]
  aCell.click(); await w(400)
  r.multi.selectMarks = cellsNow().filter((c) => c.classList.contains('sel')).length === 1 && cellsNow()[1].classList.contains('sel')
  cellsNow()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await w(600)
  r.multi.dblclickGoesBack = seg('One screen').getAttribute('aria-pressed') === 'true' && !!q('#view-monitor .mbig') && !q('#view-monitor .mgrid .moncell')
  seg('All screens').click(); await w(500)
  tab('Present').click(); await w(300)
  r.multi.disposed = qa('#view-monitor .moncell').length === 0 && qa('#view-monitor .monthumb').length === 0
  tab('Monitor').click(); await w(500)
  r.multi.remembered = seg('All screens').getAttribute('aria-pressed') === 'true' && qa('#view-monitor .moncell').length === total
  seg('One screen').click(); await w(300)

  // Leaving the tab drops the previews again
  tab('Present').click(); await w(400)
  r.disposed = qa('#view-monitor .monthumb').length === 0
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'monitor.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The monitor scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const j = JSON.stringify
const checks = [
  ['there is a Monitor tab, and its previews exist only while it is open', r.tabExists && r.noPreviewsBefore && r.disposed, ''],
  ['it shows a big preview of the selected screen and one small preview per screen', r.big.box && r.big.thumbs === r.big.screens && /\d+×\d+/.test(r.big.title), j(r.big)],
  ['it says "Nothing on air" at first', r.nothing === 'Nothing on air', j(r.nothing)],
  ['Next puts a slide on air and names it and the one after it', r.onAir.slide && /^On air: /.test(r.onAir.text) && r.onAir.nextInState && /^Next: /.test(r.onAir.next), j(r.onAir)],
  ['Next and Previous step through the slides', r.moved && r.back, j([r.moved, r.back])],
  ['Clear on a screen clears only that screen, Show brings it back', r.cleared && r.shownAgain, j([r.cleared, r.shownAgain])],
  ['Open/Close works from the screen\'s own picture', r.toggled === true, ''],
  ['clicking a small preview selects that screen for the big one', r.pick.selMarked && r.pick.title.startsWith(r.pick.name), j(r.pick)],
  ['Camera only appears for the stream screen only, and switches the mode', r.cameraHiddenOnDisplay && r.camera.shown && r.camera.on, j([r.cameraHiddenOnDisplay, r.camera])],
  ['the arrow keys step through the slides on this tab too', r.keys === true, ''],
  ['the big picture fills the room it is given (limited only by the width or the height of the space, never both unused) and keeps its shape', r.fills.touches && r.fills.shape && r.fills.inside, j(r.fills)],
  ['"All screens" shows every screen at once in a grid that fits the room; the strip is replaced by the grid, the controls stay', r.multi.buttons && r.multi.cells === r.multi.total && r.multi.stripHidden && /All screens/.test(r.multi.title) && r.multi.barStays && r.multi.allInsideGrid && r.multi.noScroll && r.multi.cols >= 1, j(r.multi)],
  ['in the grid a click selects a screen and a double-click shows it large; the choice is remembered and the previews are dropped when the tab is left', r.multi.selectMarks && r.multi.dblclickGoesBack && r.multi.disposed && r.multi.remembered && r.multi.saved === 'all', j([r.multi.selectMarks, r.multi.dblclickGoesBack, r.multi.disposed, r.multi.remembered, r.multi.saved])],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} monitor checks passed`)
process.exit(failed ? 1 : 0)

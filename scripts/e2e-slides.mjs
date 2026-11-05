// End-to-end check of the slide view: the whole service is one list (every song, one after another), the slides use the
// full width, the arrow keys flow from one song into the next, and a click on a song in the run sheet scrolls to it and
// pins its title at the top. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-slides')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const st = async () => await prestreamer.getState()
  const key = async (k) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await w(350) }
  const center = q('#center')
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const r = {}
  await w(600)

  const sections = qa('#center section.slist')
  r.sections = sections.map((s) => q('h1', s).textContent.trim().replace(/\\s+/g, ' '))
  r.grids = qa('#center .grid').length
  const cards = qa('.card', sections[0])
  const firstRow = cards.filter((c) => c.offsetTop === cards[0].offsetTop).length
  r.cards = cards.length
  r.firstRow = firstRow
  const widest = Math.max(...cards.filter((c) => c.offsetTop === cards[0].offsetTop).map((c) => c.getBoundingClientRect().right))
  r.rowFillsWidth = center.getBoundingClientRect().right - widest < 40

  // The arrow keys run on from the end of the first song into the second
  const serviceItems = (await prestreamer.servicesList()).find((x) => x.id === 'sunday-sample').items
  await key('ArrowRight')
  const firstSlide = (await st()).slide
  for (let i = 1; i < cards.length; i++) await key('ArrowRight')
  const lastOfFirst = (await st()).slide
  await key('ArrowRight')
  const intoSecond = (await st()).slide
  r.flow = { first: firstSlide?.itemId === serviceItems[0].id, last: lastOfFirst?.itemId === serviceItems[0].id, second: intoSecond?.itemId === serviceItems[1].id }
  const liveCard = q('.card.live', center)
  const cr = center.getBoundingClientRect(), lr = liveCard.getBoundingClientRect()
  r.liveVisible = lr.top >= cr.top - 1 && lr.bottom <= cr.bottom + 1

  // Click the FIRST song in the run sheet: it jumps to the top of the view; click the second: that one is pinned at the top
  const rows = qa('#schedule .srow')
  rows[0].click(); await w(400)
  r.afterFirstClick = center.scrollTop
  rows[1].click(); await w(400)
  const second = sections[1] && qa('#center section.slist')[1]
  const head = q('h1', second)
  const pinned = () => Math.abs(head.getBoundingClientRect().top - center.getBoundingClientRect().top)
  r.pinnedAtJump = pinned()
  center.scrollTop += 150; await w(200)
  r.pinnedAfterScroll = pinned()
  r.selectedMarked = second.classList.contains('sel')

  // Cmd+N / Ctrl+N: jump to the Nth item; the next arrow key starts it with its first slide
  const combo = async (k, mod) => { const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...mod }); document.body.dispatchEvent(ev); await w(400); return ev.defaultPrevented }
  const firstOf = (n) => qa('#center section.slist')[n].querySelector('.card .tag + div, .card').textContent
  await key('Escape') // nothing live, so the jump has to start the item
  tab('Mixer').click(); await w(300) // from another tab too
  r.cmd2 = await combo('2', { metaKey: true })
  r.cmd2State = { tab: qa('#tabs button').find((b) => b.classList.contains('on')).textContent.trim(), selected: qa('#schedule .srow.sel').length === 1 && qa('#schedule .srow')[1].classList.contains('sel') }
  await key('ArrowRight')
  const s2 = (await st()).slide
  r.cmd2Starts = s2?.itemId === serviceItems[1].id && qa('#center section.slist')[1].querySelector('.card').classList.contains('live')
  r.ctrl1 = await combo('1', { ctrlKey: true })
  await key('ArrowRight')
  const s1 = (await st()).slide
  r.ctrl1Starts = s1?.itemId === serviceItems[0].id && qa('#center section.slist')[0].querySelector('.card').classList.contains('live')
  r.noSuchItem = await combo('9', { metaKey: true }) // there is no 9th item: the key is left alone
  r.plainDigit = await combo('2', {})
  return r
})()`

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'slides.png'), PRESTREAMER_EVAL: scenario, PRESTREAMER_NO_AUTO_OPEN: '1' }, encoding: 'utf8', timeout: 120_000 })
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) { console.error('The slides scenario did not report a result.', run.status, (run.stderr || '').slice(-500), (run.stdout || '').slice(-500)); process.exit(1) }
const r = JSON.parse(line[1])
const checks = [
  ['every song of the service is in the list, one after another, each under its own title', r.sections.length === 2 && /Amazing Grace/.test(r.sections[0]) && /How Great Thou Art/.test(r.sections[1]), JSON.stringify(r.sections)],
  ['the slides of a song are one grid (not one small grid per verse)', r.grids === 2, `${r.grids} grids`],
  ['more than two slides fit on a row, and the row fills the width', r.firstRow >= 3 && r.rowFillsWidth === true, `${r.firstRow} per row of ${r.cards}`],
  ['the arrow keys start at the first song, run to its last slide and go on into the next song', r.flow.first && r.flow.last && r.flow.second, JSON.stringify(r.flow)],
  ['the live slide is kept in view while navigating', r.liveVisible === true, ''],
  ['clicking the first song in the run sheet shows the top of the list', r.afterFirstClick < 40, `${r.afterFirstClick}`],
  ['clicking another song scrolls it to the top with its title pinned there', r.pinnedAtJump < 4, `${r.pinnedAtJump.toFixed(1)} px`],
  ['...and the title stays pinned while its slides scroll', r.pinnedAfterScroll < 4, `${r.pinnedAfterScroll.toFixed(1)} px`],
  ['the clicked song is marked as selected', r.selectedMarked === true, ''],
  ['Cmd+2 jumps to the second item, from any tab, back in the Present tab with it selected', r.cmd2 === true && r.cmd2State.tab === 'Present' && r.cmd2State.selected === true, JSON.stringify(r.cmd2State)],
  ['...and the next arrow key starts that item at its first slide', r.cmd2Starts === true, ''],
  ['Ctrl+1 jumps back to the first item and starts it with the arrow key', r.ctrl1 === true && r.ctrl1Starts === true, ''],
  ['a number with no such item, or without Cmd/Ctrl, is left alone', r.noSuchItem === false && r.plainDigit === false, ''],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} slide view checks passed`)
process.exit(failed ? 1 : 0)

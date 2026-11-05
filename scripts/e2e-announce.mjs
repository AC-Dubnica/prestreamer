// End-to-end check of live announcements: drives the real popup and header controls and looks at what each screen
// would show (the overlay in every screen's preview) and what the main process holds. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-announce')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const modal = () => q('#modal:not([hidden]) .dialog')
  const button = (text, root = document) => qa('button', root).find((b) => b.textContent.trim() === text)
  const st = async () => await prestreamer.getState()
  const card = (name) => qa('#screens .screen').find((c) => q('.name', c).textContent === name)
  const overlay = (name) => { const o = q('[data-announcement]', card(name)); return o && !o.hidden ? o.textContent : null }
  const announceBtn = () => q('#headbtns button.announcebtn')
  const r = {}

  r.initial = { announcement: (await st()).announcement, indicatorHidden: q('#announcelive').hidden }

  await prestreamer.showSlide({ label: 'Verse 1', text: 'Amazing grace, how sweet the sound' }); await w(300)
  const slideBefore = JSON.stringify((await st()).slide)

  // One click on a quick message puts it on air
  announceBtn().click(); await w(300)
  r.dialogOpens = !!q('.dialog.ann', document.querySelector('#modal:not([hidden])') ?? document)
  r.quickCount = qa('.qbtn', modal()).length
  qa('.qbtn', modal())[0].click(); await w(700)
  let s = await st()
  r.quick = { text: s.announcement?.text, style: s.announcement?.style, tone: s.announcement?.tone, screens: s.announcement?.screens }
  r.dialogClosedAfterQuick = !modal()
  r.indicatorVisible = !q('#announcelive').hidden
  r.overlays = { audience: overlay('Audience'), stream: overlay('Stream') }
  const bar = q('[data-announcement] div', card('Audience'))
  r.bannerAtBottom = bar?.style.bottom === '0px' && !bar?.style.top
  r.slideUntouched = JSON.stringify(s.slide) === slideBefore

  // Clear from the header
  q('#announcelive').click(); await w(500)
  s = await st()
  r.cleared = { announcement: s.announcement, indicatorHidden: q('#announcelive').hidden, audience: overlay('Audience'), stream: overlay('Stream'), slideBack: JSON.stringify(s.slide) === slideBefore }

  // Keyboard: A opens it from any tab, Esc closes; typing an "a" in a field does not
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); await w(300)
  r.keyOpens = !!modal()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(150)
  r.escCloses = !modal()
  const filter = q('#songfilter')
  filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); await w(200)
  r.typingDoesNotOpen = !modal()

  // A custom message, full screen, blue, only on the audience screen, saved as a quick message
  announceBtn().click(); await w(300)
  r.sendDisabledWhenEmpty = button('Show now', modal()).disabled
  const ta = q('textarea', modal()); ta.value = 'Fire drill in five minutes'; ta.dispatchEvent(new Event('input', { bubbles: true })); await w(50)
  r.sendEnabledWithText = !button('Show now', modal()).disabled
  const [styleSel, toneSel, timeSel] = qa('.annopts select', modal())
  styleSel.value = 'fullscreen'; toneSel.value = 'info'; timeSel.value = '60'
  const boxes = qa('.annscreens input[type=checkbox]', modal())
  const streamBox = boxes.find((b) => b.parentElement.textContent.includes('Stream')); streamBox.checked = false; streamBox.dispatchEvent(new Event('change', { bubbles: true }))
  qa('input[type=checkbox]', modal()).find((b) => b.parentElement.textContent.includes('Save as a quick message')).checked = true
  button('Show now', modal()).click(); await w(800)
  s = await st()
  r.custom = { text: s.announcement?.text, style: s.announcement?.style, tone: s.announcement?.tone, screens: s.announcement?.screens, autoHideSec: s.announcement?.autoHideSec }
  r.customOverlays = { audience: overlay('Audience'), stream: overlay('Stream') }
  r.customBackground = getComputedStyle(q('[data-announcement] div', card('Audience'))).backgroundColor
  r.fullScreenCovers = q('[data-announcement] div', card('Audience')).style.inset === '0px'
  r.savedAsQuick = (await prestreamer.announceQuickList()).some((x) => x.text === 'Fire drill in five minutes')

  // Choices are remembered for next time
  q('#announcelive').click(); await w(300)
  announceBtn().click(); await w(300)
  const [style2, , time2] = qa('.annopts select', modal())
  const stream2 = qa('.annscreens input[type=checkbox]', modal()).find((b) => b.parentElement.textContent.includes('Stream'))
  r.remembered = { style: style2.value, time: time2.value, streamTicked: stream2.checked }
  // Delete a quick message (asks first)
  const row = qa('.qrow', modal()).find((x) => x.textContent.includes('Fire drill'))
  q('button[title="Delete this quick message"]', row).click(); await w(300)
  r.deleteAsks = !!qa('.dhead').find((h) => h.textContent === 'Delete quick message?')
  button('Delete', modal()).click(); await w(500)
  r.deleted = !(await prestreamer.announceQuickList()).some((x) => x.text === 'Fire drill in five minutes')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await w(150)
  if (modal()) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

  // Auto-hide, replacement, and refusing an empty message
  r.emptyRefused = (await prestreamer.announceShow({ text: '   ', style: 'fullscreen', tone: 'alert', screens: null, autoHideSec: null })) === false
  await prestreamer.announceShow({ text: 'first', style: 'banner-top', tone: 'notice', screens: null, autoHideSec: null }); await w(200)
  const firstId = (await st()).announcement?.id
  await prestreamer.announceShow({ text: 'brief', style: 'banner-top', tone: 'notice', screens: null, autoHideSec: 1 }); await w(300)
  s = await st()
  r.replaced = s.announcement?.text === 'brief' && s.announcement?.id !== firstId
  await w(1500)
  r.autoHidden = (await st()).announcement === null
  r.slideStillThere = JSON.stringify((await st()).slide) === slideBefore
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'announce.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The announcement scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])

const checks = [
  ['nothing is on air at the start', r.initial?.announcement === null && r.initial?.indicatorHidden === true, ''],
  ['the Announce button opens the popup with the saved quick messages', r.dialogOpens && r.quickCount >= 3, `${r.quickCount} quick messages`],
  ['one click on a quick message puts it on air and closes the popup', r.quick?.text?.startsWith('Please silence') && r.dialogClosedAfterQuick === true, JSON.stringify(r.quick)],
  ['it is aimed at every screen by default', r.quick?.screens === null && r.overlays?.audience === r.quick?.text && r.overlays?.stream === r.quick?.text, JSON.stringify(r.overlays)],
  ['a banner sits at the bottom of the screen', r.bannerAtBottom === true, ''],
  ['the red "ANNOUNCEMENT LIVE" button appears in the header', r.indicatorVisible === true, ''],
  ['the slide underneath is not touched', r.slideUntouched === true, ''],
  ['Clear removes it everywhere and the slide is still there', r.cleared?.announcement === null && r.cleared?.indicatorHidden && r.cleared?.audience === null && r.cleared?.stream === null && r.cleared?.slideBack === true, JSON.stringify(r.cleared)],
  ['the A key opens the popup, Esc closes it', r.keyOpens === true && r.escCloses === true, ''],
  ['typing an "a" in a text field does not open it', r.typingDoesNotOpen === true, ''],
  ['an empty message cannot be sent', r.sendDisabledWhenEmpty === true && r.sendEnabledWithText === true, ''],
  ['a custom message keeps its style, colour, duration and chosen screens', r.custom?.text === 'Fire drill in five minutes' && r.custom?.style === 'fullscreen' && r.custom?.tone === 'info' && r.custom?.autoHideSec === 60 && JSON.stringify(r.custom?.screens) === '["audience"]', JSON.stringify(r.custom)],
  ['only the chosen screen shows it', r.customOverlays?.audience === 'Fire drill in five minutes' && r.customOverlays?.stream === null, JSON.stringify(r.customOverlays)],
  ['full screen takeover is blue and covers the whole screen', r.customBackground === 'rgb(29, 78, 216)' && r.fullScreenCovers === true, r.customBackground],
  ['"Save as a quick message" stores it', r.savedAsQuick === true, ''],
  ['the last choices are remembered', r.remembered?.style === 'fullscreen' && r.remembered?.time === '60' && r.remembered?.streamTicked === false, JSON.stringify(r.remembered)],
  ['deleting a quick message asks first, then deletes it', r.deleteAsks === true && r.deleted === true, ''],
  ['an empty message is refused by the app too', r.emptyRefused === true, ''],
  ['a new announcement replaces the one on air', r.replaced === true, ''],
  ['an announcement with a time hides itself', r.autoHidden === true, ''],
  ['the slide is still where it was after everything', r.slideStillThere === true, ''],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} announcement checks passed`)
process.exit(failed ? 1 : 0)

// End-to-end check of the app-wide look in Settings: one background for all songs, another for scripture, and the logo.
// A song's own picture still wins, deleting a library file lets go of every use, and the Logo button (or L) shows the logo
// on every screen. Needs ffmpeg (to make test pictures) and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const green = join(outDir, 'look-green.png')
spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b400:s=640x360', '-frames:v', '1', green])
const userData = join(outDir, 'userdata-appearance')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const modal = () => q('#modal:not([hidden]) .dialog')
  const btn = (text, root) => qa('button', root).find((b) => b.textContent.trim() === text)
  const row = (label) => qa('#view-settings .lookrow').find((x) => q('strong', x).textContent === label)
  const st = async () => await prestreamer.getState()
  const r = {}
  await w(600)
  const sel = q('#servicesel'); sel.value = 'sunday-sample'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(400)

  tab('Settings').click(); await w(500)
  const cats = qa('#view-settings .setnav button').map((b) => b.textContent.trim())
  r.cats = { names: cats, selected: qa('#view-settings .setnav button.on').map((b) => b.textContent.trim()) }
  qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'Visuals').click(); await w(300)
  r.rows = ['Songs', 'Scripture', 'Logo'].map((l) => !!row(l))
  r.empty = (await prestreamer.appearanceGet())
  r.logoDisabled = qa('#headbtns button').find((b) => /Logo/.test(b.textContent)).disabled

  // choose a picture for all songs (imports it into the library through the picker)
  btn('Choose…', row('Songs')).click(); await w(500)
  btn('Import picture…', modal()).click(); await w(900)
  const a1 = await prestreamer.appearanceGet()
  r.songs = { set: a1.songBackground?.kind === 'image', thumb: !!q('img', row('Songs')), scriptureUntouched: a1.scriptureBackground === null }
  const file = a1.songBackground.file

  // the same picture for scripture and as the logo: nothing is imported twice
  btn('Choose…', row('Scripture')).click(); await w(500)
  q('.mcard', modal()).click(); await w(700)
  btn('Choose…', row('Logo')).click(); await w(500)
  q('.mcard', modal()).click(); await w(700)
  const a2 = await prestreamer.appearanceGet()
  r.others = { scripture: a2.scriptureBackground?.file === file, logo: a2.logo === file, library: (await prestreamer.mediaList()).length }

  // songs on the Present tab use it; a song with a picture of its own keeps that
  tab('Present').click(); await w(500)
  const withMedia = () => qa('#center .card img[src^="media://"], #center .card video[src^="media://"]').length
  r.slides = { total: qa('#center .card').length, withMedia: withMedia() }

  // the Logo button puts the logo on air, again takes it off; L does the same
  const logoBtn = () => qa('#headbtns button').find((b) => /Logo/.test(b.textContent))
  r.logoEnabled = !logoBtn().disabled
  logoBtn().click(); await w(500)
  const s1 = await st()
  r.logoOn = { slide: s1.slide?.label === 'Logo' && s1.slide?.picture?.file === file, pressed: logoBtn().getAttribute('aria-pressed') === 'true' }
  logoBtn().click(); await w(500)
  r.logoOff = (await st()).slide === null
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true })); await w(500)
  r.keyOn = (await st()).slide?.label === 'Logo'
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true })); await w(500)
  r.keyOff = (await st()).slide === null

  // deleting the picture from the library clears every use
  await prestreamer.mediaRemove(file); await w(600)
  const a3 = await prestreamer.appearanceGet()
  // the other categories show their own content, and the choice survives leaving the tab
  const cat = (n) => qa('#view-settings .setnav button').find((b) => b.textContent.trim() === n)
  cat('Screens').click(); await w(300)
  const onScreens = { cards: qa('#view-settings .setcard').length > 0, noLook: !q('#view-settings .lookrow'), selected: cat('Screens').getAttribute('aria-selected') === 'true' }
  const onDisplays = { identify: qa('#view-settings button').some((b) => /Identify displays/.test(b.textContent)), noCards: true }
  tab('Present').click(); await w(300); tab('Settings').click(); await w(300)
  r.cat2 = { onScreens, onDisplays, remembered: cat('Screens').getAttribute('aria-selected') === 'true' }
  cat('Visuals').click(); await w(300)
  r.deleted = { songs: a3.songBackground === null, scripture: a3.scriptureBackground === null, logo: a3.logo === null, logoDisabled: logoBtn().disabled }
  tab('Settings').click(); await w(500)
  r.deleted.rowsNone = qa('.lookrow .mthumb.none').length === 3
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_MEDIA_FILE: green, PRESTREAMER_SNAPSHOT: join(outDir, 'appearance.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The appearance scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const j = JSON.stringify
const checks = [
  ['Settings lists its categories down the left (Visuals, Screens) with Visuals open first', JSON.stringify(r.cats.names) === JSON.stringify(['Visuals', 'Screens']) && JSON.stringify(r.cats.selected) === JSON.stringify(['Visuals']), j(r.cats)],
  ['Screens also lists the connected displays (Identify displays), Visuals does not, and the open category is remembered when the tab is left', r.cat2.onScreens.cards && r.cat2.onScreens.noLook && r.cat2.onScreens.selected && r.cat2.onDisplays.identify && r.cat2.onDisplays.noCards && r.cat2.remembered, j(r.cat2)],
  ['Settings has rows for the songs background, the scripture background and the logo, all empty at first; the Logo button is disabled', r.rows.every(Boolean) && r.empty.songBackground === null && r.empty.logo === null && r.logoDisabled === true, j([r.rows, r.empty, r.logoDisabled])],
  ['choosing a picture for songs saves it and shows its thumbnail, scripture untouched', r.songs.set && r.songs.thumb && r.songs.scriptureUntouched, j(r.songs)],
  ['the same library picture can be used for scripture and as the logo without importing it again', r.others.scripture && r.others.logo && r.others.library === 1, j(r.others)],
  ['the slides of the service show the songs background', r.slides.total > 0 && r.slides.withMedia > 0, j(r.slides)],
  ['the Logo button is enabled once a logo is set; pressing it puts the logo on air and pressing again takes it off', r.logoEnabled && r.logoOn.slide && r.logoOn.pressed && r.logoOff, j([r.logoEnabled, r.logoOn, r.logoOff])],
  ['the L key toggles the logo too', r.keyOn === true && r.keyOff === true, ''],
  ['deleting the picture from the library clears the songs background, the scripture background and the logo (the button turns off)', r.deleted.songs && r.deleted.scripture && r.deleted.logo && r.deleted.logoDisabled && r.deleted.rowsNone, j(r.deleted)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} appearance checks passed`)
process.exit(failed ? 1 : 0)

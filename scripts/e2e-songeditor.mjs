// End-to-end check of the song editor's visuals: every slide shows as a card with a picture button, a slide's own picture is
// saved WITH the song (only after Save, and the editor says so until then), the song details are kept, and shortening the text
// drops pictures of slides that no longer exist. Needs ffmpeg (to make a test picture) and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const green = join(outDir, 'songeditor-green.png')
spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b400:s=640x360', '-frames:v', '1', green])
const userData = join(outDir, 'userdata-songeditor')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const modal = () => q('#modal:not([hidden]) .dialog')
  const btn = (text, root) => qa('button', root).find((b) => b.textContent.trim() === text)
  const saveBtn = () => q('#songeditor button[title="Save song"]')
  const r = {}
  await w(600)
  tab('Songs').click(); await w(700)
  const songId = (await prestreamer.songsList())[0].id
  const cards = () => qa('#songeditor .sstrip .card')
  r.slides = cards().length
  r.dirtyAtStart = q('#songeditor .dirty').textContent

  // a picture for slide 2 only: it is on the draft (marked), not yet in the saved song
  const picBtn = (i) => q('.cardbg', cards()[i])
  picBtn(1).click(); await w(500)
  btn('Import picture…', modal()).click(); await w(900)
  r.afterPick = { on: picBtn(1).classList.contains('on'), others: cards().filter((c, i) => i !== 1).every((c) => !q('.cardbg', c).classList.contains('on')), dirty: q('#songeditor .dirty').textContent, savedYet: ((await prestreamer.songsList()).find((s) => s.id === songId).slideBackgrounds ?? []).filter(Boolean).length }
  r.thumbShows = !!q('img[src^="media://"]', cards()[1])

  saveBtn().click(); await w(700)
  const saved = (await prestreamer.songsList()).find((s) => s.id === songId)
  r.saved = { second: saved.slideBackgrounds?.[1]?.kind, first: saved.slideBackgrounds?.[0] ?? null, dirty: q('#songeditor .dirty').textContent, stillMarked: picBtn(1).classList.contains('on') }

  // song details are kept
  const details = q('#songeditor details')
  details.open = true
  const author = qa('label', details).find((l) => l.textContent === 'Author').nextElementSibling // by its label: the song number comes first
  author.value = 'Anna Author'; author.dispatchEvent(new Event('input', { bubbles: true })); await w(200)
  r.detailDirty = q('#songeditor .dirty').textContent
  saveBtn().click(); await w(700)
  r.author = (await prestreamer.songsList()).find((s) => s.id === songId).author
  r.detailsOpenAgain = q('#songeditor details').open

  // shorten the text to one slide: the picture of the slide that is gone is dropped on save
  const ta = q('#songeditor textarea')
  ta.value = '[Verse 1]\\nOnly slide'; ta.dispatchEvent(new Event('input', { bubbles: true })); await w(700)
  r.cardsAfterShorten = cards().length
  saveBtn().click(); await w(700)
  r.trimmed = ((await prestreamer.songsList()).find((s) => s.id === songId).slideBackgrounds ?? []).length
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_MEDIA_FILE: green, PRESTREAMER_SNAPSHOT: join(outDir, 'songeditor.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The song editor scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const j = JSON.stringify
const checks = [
  ['the editor shows every slide of the song as a card, and says nothing about unsaved changes at first', r.slides >= 2 && r.dirtyAtStart === '', j([r.slides, r.dirtyAtStart])],
  ['a picture chosen for one slide is marked on that card only, shows in its thumbnail, and is "Unsaved changes" until Save', r.afterPick.on && r.afterPick.others && r.thumbShows && r.afterPick.dirty === 'Unsaved changes' && r.afterPick.savedYet === 0, j(r.afterPick)],
  ['Save stores the slide picture in the song itself (slide 2 only) and clears the note', r.saved.second === 'image' && r.saved.first === null && r.saved.dirty === '' && r.saved.stillMarked, j(r.saved)],
  ['song details (author...) count as changes and are saved with the song; the details stay open when they have content', r.detailDirty === 'Unsaved changes' && r.author === 'Anna Author' && r.detailsOpenAgain === true, j([r.detailDirty, r.author, r.detailsOpenAgain])],
  ['shortening the text to one slide drops the picture of the slide that no longer exists', r.cardsAfterShorten === 1 && r.trimmed === 0, j([r.cardsAfterShorten, r.trimmed])],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} song editor checks passed`)
process.exit(failed ? 1 : 0)

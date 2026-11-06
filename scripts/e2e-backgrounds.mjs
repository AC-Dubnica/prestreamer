// End-to-end check of picture and video backgrounds: the picker (library of everything imported, import, "none"), a background
// for a whole screen and for a song, and what the STREAM shows behind the text. Needs ffmpeg and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const green = join(outDir, 'bg-green.png')
const blue = join(outDir, 'bg-blue.mp4')
spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x00b400:s=640x360', '-frames:v', '1', green])
spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0000d2:s=640x360:r=25:d=2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', blue])

const userData = join(outDir, 'userdata-backgrounds')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const modal = () => q('#modal:not([hidden]) .dialog')
  const btn = (text, root) => qa('button', root).find((b) => b.textContent.trim() === text)
  const st = async () => await prestreamer.getState()
  const streamLook = async () => (await st()).screens.find((x) => x.kind === 'virtual').look
  const card = () => qa('#screens .screen').find((c) => q('.name', c).textContent === 'Stream')
  const openDialog = async () => { q('button[title^="Settings for Stream"]', card()).click(); await w(400) }
  const r = {}
  try {
  await w(600)

  // no library yet: the picker says so; importing a picture picks it and brings the screen dialog back
  await openDialog()
  btn('Picture or video…', modal()).click(); await w(500)
  r.emptyPicker = !!modal()?.classList.contains('bgpicker') && /Nothing imported yet/.test(modal().textContent)
  btn('Import picture…', modal()).click(); await w(800)
  r.importWaits = (await streamLook()).backgroundMedia === null
  const back = !!modal() && /screen settings/.test(modal().textContent), thumb = !!q('.bgcur img', modal())
  btn('Apply', modal()).click(); await w(400)
  const look1 = await streamLook()
  r.imported = { kind: look1.backgroundMedia?.kind, back, thumb }
  r.cardShows = !!q('img[src^="media://"]', card())
  const list1 = await prestreamer.mediaList()
  r.library1 = list1.length

  // remove it, then choose it again from the library: nothing is imported twice
  await openDialog()
  btn('Remove', modal()).click(); await w(400)
  btn('Apply', modal()).click(); await w(400)
  r.removed = (await streamLook()).backgroundMedia === null
  await openDialog()
  btn('Picture or video…', modal()).click(); await w(500)
  r.pickerCards = qa('.mcard', modal()).length
  q('.mcard', modal()).click(); await w(800)
  btn('Apply', modal()).click(); await w(400)
  r.reused = { same: (await streamLook()).backgroundMedia?.file === list1[0].file, library: (await prestreamer.mediaList()).length }

  // "No picture or video" in the picker clears it
  await openDialog()
  btn('Picture or video…', modal()).click(); await w(500)
  btn('No picture or video', modal()).click(); await w(800)
  btn('Apply', modal()).click(); await w(400)
  r.cleared = (await streamLook()).backgroundMedia === null

  // the song editor uses the same picker; a song's own picture shows in its preview
  qa('#tabs button').find((b) => b.textContent.trim() === 'Songs').click(); await w(600)
  btn('Picture or video…', q('#songeditor')).click(); await w(500)
  r.songPicker = qa('.mcard', modal()).length
  q('.mcard', modal()).click(); await w(500)
  r.songBg = { label: !!q('#songeditor .bgcur img'), preview: !!q('#songeditor img[src^="media://"]') }

  // --- one slide, all slides, removing, deleting from the library
  qa('#tabs button').find((b) => b.textContent.trim() === 'Present').click(); await w(500)
  const sections = () => qa('#center section.slist')
  const songNow = async () => (await prestreamer.songsList()).find((x) => x.id === 'amazing-grace')
  const cardsOf = (n) => qa('.card', sections()[n])
  const hasImg = (c) => !!q('img[src^="media://"]', c)
  const before = (await songNow()).slideBackgrounds ?? []
  q('.cardbg', cardsOf(0)[1]).click(); await w(500)
  r.slidePicker = /slide 2 only/i.test(modal()?.textContent ?? '') && qa('.mcard', modal()).length === 1
  q('.mcard', modal()).click(); await w(700)
  let song = await songNow()
  r.oneSlide = { saved: song.slideBackgrounds?.[1]?.kind, others: !song.slideBackgrounds?.[0] && !song.slideBackgrounds?.[2], thumbs: cardsOf(0).map(hasImg) }
  cardsOf(0)[1].click(); await w(500)
  r.oneSlideOnAir = (await st()).slide?.background?.kind === 'image'

  // all slides at once: one picture for every slide of the song, replacing the single-slide ones
  btn('Background', sections()[0]).click(); await w(500)
  r.allPicker = /all slides of Amazing Grace/.test(modal()?.textContent ?? '')
  q('.mcard', modal()).click(); await w(700)
  song = await songNow()
  r.allSlides = { background: song.background?.kind, reset: (song.slideBackgrounds ?? []).length === 0, thumbs: cardsOf(0).every(hasImg), otherSongUntouched: !cardsOf(1).some(hasImg) }

  // a slide goes back to the song's background with the first choice in its picker
  q('.cardbg', cardsOf(0)[2]).click(); await w(500)
  q('.mcard', modal()).click(); await w(600)
  q('.cardbg', cardsOf(0)[2]).click(); await w(500)
  btn("Use the song's background", modal()).click(); await w(600)
  song = await songNow()
  r.slideReset = !song.slideBackgrounds?.[2]

  // delete from the library: asks first, then songs and screens that used it let go
  await prestreamer.updateScreen((await st()).screens.find((x) => x.kind === 'virtual').id, { look: { backgroundMedia: (await prestreamer.mediaList()).map((m) => ({ kind: m.kind, file: m.file }))[0] } }); await w(300)
  btn('Background', sections()[0]).click(); await w(500)
  q('.mtrash', modal()).click(); await w(300)
  r.askBeforeDelete = /Delete ".*"\?/.test(modal().textContent) && (await prestreamer.mediaList()).length === 1
  btn('Keep', modal()).click(); await w(200)
  r.keptStill = (await prestreamer.mediaList()).length === 1
  q('.mtrash', modal()).click(); await w(300)
  btn('Delete', modal()).click(); await w(900)
  song = await songNow()
  r.deleted = { library: (await prestreamer.mediaList()).length, songBackground: song.background === null, screen: (await streamLook()).backgroundMedia === null, none: /Nothing imported yet/.test(modal().textContent) }
  btn('Cancel', modal()).click(); await w(300)

  // plain pictures as a run-sheet item: shown whole as slides, and not in the backgrounds library
  const libBefore = (await prestreamer.mediaList()).length
  const itemsBefore = (await prestreamer.servicesList()).find((x) => x.id === 'sunday-sample').items.length
  q('#addtools button[title^="Add pictures"]').click(); await w(800)
  const items = (await prestreamer.servicesList()).find((x) => x.id === 'sunday-sample').items
  const pic = items[items.length - 1]
  r.pictureItem = { added: items.length - itemsBefore, kind: pic.kind, slides: pic.slides.length, library: (await prestreamer.mediaList()).length - libBefore }
  } catch (e) { r.error = String(e && e.stack || e).slice(0, 400) }
  return r
})()`

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_MEDIA_FILE: green, PRESTREAMER_PICTURE_FILES: green, PRESTREAMER_NO_AUTO_OPEN: '1', PRESTREAMER_SNAPSHOT: join(outDir, 'backgrounds.png'), PRESTREAMER_EVAL: scenario }, encoding: 'utf8', timeout: 180_000 })
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) { console.error('The backgrounds scenario did not report a result.', run.status, (run.stderr || '').slice(-500), (run.stdout || '').slice(-500)); process.exit(1) }
const r = JSON.parse(line[1])
if (r.error) console.log('SCENARIO ERROR', r.error)

// What the stream shows: the picture or video behind the text, top-left corner (away from the centred text)
function corner(name, file) {
  const out = join(outDir, `bg-${name}.mkv`)
  const ud = join(outDir, `userdata-bg-${name}-stream`)
  rmSync(ud, { recursive: true, force: true })
  spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_STREAMTEST: out, PRESTREAMER_SECONDS: '6', PRESTREAMER_NO_SOURCE: '1', PRESTREAMER_LOOK_BG: file, PRESTREAMER_USER_DATA: ud }, encoding: 'utf8', timeout: 120_000 })
  const f = spawnSync(ffmpeg, ['-v', 'error', '-ss', '3', '-i', out, '-frames:v', '1', '-vf', 'crop=64:36:0:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout
  let R = 0, G = 0, B = 0
  for (let i = 0; i < f.length; i += 3) { R += f[i]; G += f[i + 1]; B += f[i + 2] }
  const n = f.length / 3 || 1
  return { r: Math.round(R / n), g: Math.round(G / n), b: Math.round(B / n), size: f.length }
}
const onPicture = corner('picture', green)
const onVideo = corner('video', blue)
const mediaFiles = readdirSync(join(userData, 'media')).filter((f) => f.endsWith('.png')).length

const checks = [
  ['the picker starts empty and says so; importing a picture picks it and returns to the screen settings with a thumbnail', r.emptyPicker && r.imported.kind === 'image' && r.imported.back && r.imported.thumb, JSON.stringify([r.emptyPicker, r.imported])],
  ["the screen's card in the Present tab shows the picture", r.cardShows === true, ''],
  ['the imported picture is in the library', r.library1 === 1, `${r.library1}`],
  ['Remove takes the picture off the screen', r.removed === true, ''],
  ['the picker lists the library, and choosing from it does not import it again', r.pickerCards === 1 && r.reused.same && r.reused.library === 1 && mediaFiles === 1, JSON.stringify([r.pickerCards, r.reused, mediaFiles])],
  ['"No picture or video" clears the screen background', r.cleared === true, ''],
  ['the song editor uses the same picker; the chosen picture shows in its label and preview', r.songPicker === 1 && r.songBg.label && r.songBg.preview, JSON.stringify([r.songPicker, r.songBg])],
  ['one slide can have its own picture; the song\'s other slides keep theirs; the slide shows it on air', r.slidePicker === true && r.oneSlide.saved === 'image' && r.oneSlide.others && JSON.stringify(r.oneSlide.thumbs) === JSON.stringify([false, true, false, false, false]) && r.oneSlideOnAir === true, JSON.stringify([r.slidePicker, r.oneSlide, r.oneSlideOnAir])],
  ['"Background" in a song\'s title sets one picture for all its slides at once (resetting single-slide ones), and only that song', r.allPicker && r.allSlides.background === 'image' && r.allSlides.reset && r.allSlides.thumbs && r.allSlides.otherSongUntouched, JSON.stringify([r.allPicker, r.allSlides])],
  ['a slide can go back to the song\'s background', r.slideReset === true, ''],
  ['deleting from the library asks first, can be cancelled, then removes it and lets songs and screens go', r.askBeforeDelete && r.keptStill && r.deleted.library === 0 && r.deleted.songBackground && r.deleted.screen && r.deleted.none, JSON.stringify([r.askBeforeDelete, r.keptStill, r.deleted])],
  ['pictures can be added to the run sheet as slides, without joining the backgrounds library', r.pictureItem.added === 1 && r.pictureItem.kind === 'presentation' && r.pictureItem.slides === 1 && r.pictureItem.library === 0, JSON.stringify(r.pictureItem)],
  ['the stream shows a picture behind the text (a green picture)', onPicture.size > 0 && onPicture.g > 140 && onPicture.r < 60 && onPicture.b < 60, JSON.stringify(onPicture)],
  ['the stream shows a looping video behind the text (a blue video)', onVideo.size > 0 && onVideo.b > 140 && onVideo.r < 60 && onVideo.g < 60, JSON.stringify(onVideo)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} background checks passed`)
process.exit(failed ? 1 : 0)

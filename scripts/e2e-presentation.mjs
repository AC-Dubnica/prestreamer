// End-to-end check of presentations: a PDF (made by the app's own printer) is imported with the real "add a presentation"
// button, every page becomes a slide, the arrow keys step through them one at a time, the deck survives a restart, and the
// STREAM shows the slide over the camera (and camera-only takes it away again). Needs ffmpeg and a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const pdf = join(outDir, 'deck.pdf')
const userData = join(outDir, 'userdata-presentation')
rmSync(userData, { recursive: true, force: true })

spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: join(outDir, 'userdata-makepdf'), PRESTREAMER_MAKEPDF: pdf }, timeout: 60_000 })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const st = async () => await prestreamer.getState()
  const key = async (k) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await w(400) }
  const r = {}
  await w(600)
  const before = (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items.length
  q('#addtools button[title^="Add a presentation"]').click()
  const count = async () => (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items.length
  for (let i = 0; i < 100 && (await count()) === before; i++) await w(300)
  await w(300)
  r.status = q('#videostatus').textContent
  await w(400)
  const items = (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items
  const deck = items[items.length - 1]
  r.saved = { added: items.length - before, kind: deck.kind, slides: deck.slides.length, title: deck.title }
  const rows = qa('#schedule .srow')
  r.rowIcon = !!q('.kind svg rect', rows[rows.length - 1])
  const sec = qa('#center section.slist').pop()
  r.cards = qa('.card', sec).length
  r.thumbs = qa('.card img', sec).length

  await key('Escape')
  rows[rows.length - 1].click(); await w(400)
  await key('ArrowRight')
  const labels = [(await st()).slide?.label]
  await key('ArrowRight'); labels.push((await st()).slide?.label)
  await key('ArrowRight'); labels.push((await st()).slide?.label)
  r.labels = labels
  r.liveCards = qa('.card.live', qa('#center section.slist').pop()).length
  r.files = new Set(items[items.length - 1].slides).size

  // the picture is shown (not text) on a screen, and the stage monitor shows the label instead
  const s = await st()
  r.pictureOnAir = !!s.slide?.picture?.file && s.slide.text === ''
  r.reload = (await prestreamer.servicesList()).find((x) => x.id === 'sunday-sample').items.some((i) => i.kind === 'presentation' && i.slides.length === 3)
  return r
})()`

const run = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_PRESENTATION_FILE: pdf, PRESTREAMER_NO_AUTO_OPEN: '1', PRESTREAMER_SNAPSHOT: join(outDir, 'presentation.png'), PRESTREAMER_EVAL: scenario }, encoding: 'utf8', timeout: 180_000 })
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) { console.error('The presentation scenario did not report a result.', run.status, (run.stderr || '').slice(-500), (run.stdout || '').slice(-500)); process.exit(1) }
const r = JSON.parse(line[1])

// A real PowerPoint file (.pptx): read by PreStreamer itself, with no PowerPoint involved.
const pptx = join(process.cwd(), 'tests/fixtures/sample.pptx')
const powerPointRunning = () => spawnSync('pgrep', ['-x', 'Microsoft PowerPoint']).status === 0
const ppWasRunning = powerPointRunning()
const pptxData = join(outDir, 'userdata-pptx')
rmSync(pptxData, { recursive: true, force: true })
const pptxScenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const statuses = new Set()
  const t0 = Date.now()
  const before = (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items.length
  q('#addtools button[title^="Add a presentation"]').click()
  for (let i = 0; i < 150; i++) { statuses.add(q('#videostatus').textContent); const n = (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items.length; if (n > before) break; await w(50) }
  await w(300)
  const items = (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items
  const deck = items[items.length - 1]
  return { status: q('#videostatus').textContent, seen: [...statuses], seconds: (Date.now() - t0) / 1000, kind: deck.kind, title: deck.title, slides: deck.slides }
})()`
const pr = spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: pptxData, PRESTREAMER_PRESENTATION_FILE: pptx, PRESTREAMER_DEBUG_PPTX: '1', PRESTREAMER_NO_AUTO_OPEN: '1', PRESTREAMER_SNAPSHOT: join(outDir, 'presentation-pptx.png'), PRESTREAMER_EVAL: pptxScenario }, encoding: 'utf8', timeout: 180_000 })
for (const l of (pr.stdout ?? '').split('\n')) if (l.startsWith('PPTXDBG')) console.log(l) // what the slide pictures looked like when captured (for failures on other machines)
const pline = /^EVAL (.*)$/m.exec(pr.stdout ?? '')
const p = pline ? JSON.parse(pline[1]) : { slides: [], seen: [], status: 'no result' }
const px = (file, x, y) => {
  const out = spawnSync(ffmpeg, ['-v', 'error', '-i', join(pptxData, 'media', file), '-vf', `crop=1:1:${x}:${y}`, '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 16 }).stdout
  return [...out]
}
const near = (c, want, tol = 40) => c.length === 3 && c.every((v, i) => Math.abs(v - want[i]) <= tol)
const red = p.slides[2] ? px(p.slides[2], 300, 200) : []
const navy = p.slides[2] ? px(p.slides[2], 1000, 900) : []
const picture = p.slides[2] ? px(p.slides[2], 1500, 300) : []
const white = p.slides[1] ? px(p.slides[1], 1500, 900) : []
const ppStarted = !ppWasRunning && powerPointRunning()
if (ppStarted) spawnSync('osascript', ['-e', 'tell application "Microsoft PowerPoint" to quit'])

// What the stream shows: the red first page over the test pattern; with camera only the pattern alone.
function streamFrame(name, env) {
  const file = join(outDir, `pres-${name}.mkv`)
  spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_STREAMTEST: file, PRESTREAMER_SECONDS: '6', PRESTREAMER_PICTURE_PDF: pdf, PRESTREAMER_USER_DATA: join(outDir, `userdata-pres-${name}-stream`), ...env }, encoding: 'utf8', timeout: 120_000 })
  const f = spawnSync(ffmpeg, ['-v', 'error', '-ss', '3', '-i', file, '-frames:v', '1', '-vf', 'scale=64:36', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 }).stdout
  let R = 0, G = 0, B = 0
  for (let i = 0; i < f.length; i += 3) { R += f[i]; G += f[i + 1]; B += f[i + 2] }
  const n = f.length / 3 || 1
  return { r: R / n, g: G / n, b: B / n, size: f.length }
}
for (const d of ['pres-normal-stream', 'pres-camera-stream']) rmSync(join(outDir, `userdata-${d}`), { recursive: true, force: true })
const normal = streamFrame('normal', {})
const camera = streamFrame('camera', { PRESTREAMER_CAMERA_ONLY: '1' })

const checks = [
  ['the import button adds the deck: 3 pages, 3 slides, and leaves no message behind', r.saved.added === 1 && r.saved.kind === 'presentation' && r.saved.slides === 3 && r.status === '', `${r.status} ${JSON.stringify(r.saved)}`],
  ['the run sheet shows it with a presentation icon', r.rowIcon === true, ''],
  ['the slide view lists its 3 slides as pictures', r.cards === 3 && r.thumbs === 3, `${r.cards} cards, ${r.thumbs} pictures`],
  ['every slide has its own picture file', r.files === 3, `${r.files}`],
  ['a click on the deck and the arrow keys step through the slides one by one', JSON.stringify(r.labels) === JSON.stringify(['Slide 1 / 3', 'Slide 2 / 3', 'Slide 3 / 3']), JSON.stringify(r.labels)],
  ['only one slide card is live at a time', r.liveCards === 1, `${r.liveCards}`],
  ['a slide on air is a picture, with no text', r.pictureOnAir === true, ''],
  ['the deck is saved with the service', r.reload === true, ''],
  ['a .pptx file is imported by PreStreamer itself: 3 slides, fast, and PowerPoint is never started', p.kind === 'presentation' && p.slides.length === 3 && p.title === 'sample' && !ppStarted && !p.seen.some((m) => /PowerPoint|Keynote/.test(m)) && p.status === '', `status "${p.status}" in ${p.seconds}s ${JSON.stringify(p.seen.slice(-3))}`],
  ['the slides are drawn as the deck has them: red box, dark blue background, the picture, white page', near(red, [0xe0, 0x30, 0x30]) && near(navy, [0x12, 0x24, 0x4a]) && near(picture, [30, 160, 220]) && near(white, [255, 255, 255], 12), JSON.stringify({ red, navy, picture, white })],
  ['the stream shows the slide over the camera picture (the first page is red)', normal.size > 0 && normal.r > 150 && normal.g < 90 && normal.b < 90, JSON.stringify(normal)],
  ['with camera only the slide is not on the stream: the camera picture shows', camera.size > 0 && !(camera.r > 150 && camera.g < 90 && camera.b < 90), JSON.stringify(camera)],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} presentation checks passed`)
process.exit(failed ? 1 : 0)

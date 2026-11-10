// Retakes the screenshots in docs/screenshots that the README shows: one launch of the real app per picture, on a scratch data
// folder with the sample songs and service, a pair of generated backgrounds, an invented-looking-but-public-domain Bible
// (King James, John 3) and a made-up band in the mixer. Needs a display and ffmpeg (to draw the backgrounds); windows open briefly.
//   node scripts/screenshots.mjs            all of them
//   node scripts/screenshots.mjs mixer      only the named ones
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-screenshots')
const target = new URL('../docs/screenshots/', import.meta.url).pathname
mkdirSync(outDir, { recursive: true })

// Two soft gradients to put behind songs and readings, so the slides look like a real service rather than flat colour.
const songBg = join(outDir, 'song-background.png')
const readingBg = join(outDir, 'reading-background.png')
const gradient = (file, c0, c1) => spawnSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `gradients=s=1280x720:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=1280:y1=720:duration=1:rate=1`, '-frames:v', '1', file])
gradient(songBg, '0x10264a', '0x4c1d6b')
gradient(readingBg, '0x064e3b', '0x0c4a6e')

// King James Version, John 3:16-20 (public domain), as the Zefania XML the Bible tab imports.
const kjv = join(outDir, 'kjv.xml')
writeFileSync(kjv, `<?xml version="1.0" encoding="utf-8"?>
<XMLBIBLE biblename="King James Version" type="x-bible">
  <BIBLEBOOK bnumber="43" bname="John" bsname="Jn"><CHAPTER cnumber="3">
    <VERS vnumber="16">For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.</VERS>
    <VERS vnumber="17">For God sent not his Son into the world to condemn the world; but that the world through him might be saved.</VERS>
    <VERS vnumber="18">He that believeth on him is not condemned: but he that believeth not is condemned already, because he hath not believed in the name of the only begotten Son of God.</VERS>
    <VERS vnumber="19">And this is the condemnation, that light is come into the world, and men loved darkness rather than light, because their deeds were evil.</VERS>
    <VERS vnumber="20">For every one that doeth evil hateth the light, neither cometh to the light, lest his deeds should be reproved.</VERS>
  </CHAPTER></BIBLEBOOK>
</XMLBIBLE>`)

// A small band on the test tones, each with its own chain, for the mixer picture. Written as the mixer file the app loads at start.
const tones = { deviceId: 'test:tones', label: 'Test tones (4 channels)' }
const band = {
  strips: [
    { channel: 0, source: tones, name: 'Pastor', faderDb: -3, pan: 0, chain: [{ type: 'hpf', freq: 100 }, { type: 'gate', thresholdDb: -45, rangeDb: 30 }, { type: 'eq', midFreq: 3000, midGainDb: 2, midQ: 0.8 }, { type: 'comp', thresholdDb: -30, ratio: 4, makeupDb: 3 }, { type: 'deesser' }] },
    { channel: 1, source: tones, name: 'Vocal 1', faderDb: -6, pan: -0.2, chain: [{ type: 'hpf', freq: 100 }, { type: 'eq', midFreq: 300, midGainDb: -2, highGainDb: 2 }, { type: 'comp', thresholdDb: -28, ratio: 3, makeupDb: 3 }, { type: 'deesser' }, { type: 'reverb', mix: 0.12 }] },
    { channel: 2, source: tones, name: 'Guitar', faderDb: -9, pan: 0.3, chain: [{ type: 'hpf', freq: 60 }, { type: 'comp', thresholdDb: -26, ratio: 2, makeupDb: 2 }, { type: 'delay', mix: 0.1 }] },
    { channel: 3, source: tones, name: 'Keys', faderDb: -7, pan: 0.5, chain: [{ type: 'hpf', freq: 60 }] },
  ],
  masterDb: 0,
  masterChain: [{ type: 'comp', thresholdDb: -22, ratio: 2, attackMs: 30, releaseMs: 300, kneeDb: 10, makeupDb: 3 }, { type: 'limiter', ceilingDb: -1 }],
}

// Four lights and four scenes for the DMX pictures, written as the settings file the app loads at start.
const dmx = {
  enabled: true,
  fadeSec: 1.5,
  fixtures: [
    { id: 'left', name: 'Stage wash left', kind: 'rgb', address: 1 },
    { id: 'right', name: 'Stage wash right', kind: 'rgb', address: 4 },
    { id: 'pulpit', name: 'Pulpit spot', kind: 'dimmer', address: 7 },
    { id: 'hall', name: 'Hall lights', kind: 'dimmer', address: 8 },
  ],
  scenes: [
    { id: 'welcome', name: 'Welcome', fadeSec: 3, values: { left: [255, 200, 120], right: [255, 200, 120], pulpit: [120], hall: [255] } },
    { id: 'worship', name: 'Worship', fadeSec: null, values: { left: [200, 20, 120], right: [60, 40, 220], pulpit: [0], hall: [40] } },
    { id: 'sermon', name: 'Sermon', fadeSec: 2, values: { left: [255, 235, 200], right: [255, 235, 200], pulpit: [255], hall: [180] } },
    { id: 'prayer', name: 'Prayer', fadeSec: 4, values: { left: [90, 60, 20], right: [90, 60, 20], pulpit: [0], hall: [20] } },
  ],
}
const dmxSetup = (dir) => writeFileSync(join(dir, 'dmx.json'), JSON.stringify(dmx))
// The real sender runs into a file, so the panel shows a connected interface.
const dmxEnv = (dir) => ({ PRESTREAMER_DMX_FAKE: join(dir, 'dmx-frame.bin') })

/** Shared by every scenario: wait, small helpers, the sample service, the app-wide backgrounds. */
const prelude = `
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const key = async (k) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); await w(450) }
  const backgrounds = async () => {
    const bg = await prestreamer.mediaImport('image')
    await prestreamer.appearanceSet({ songBackground: bg, scriptureBackground: bg, logo: null })
    await w(400)
  }
  // Numbered circles over parts of the window, for the guide's tour pictures: mark(element, number)
  const mark = (el, n, dx = 4, dy = 4) => {
    if (!el) throw new Error('nothing to mark for ' + n)
    const r = el.getBoundingClientRect(), d = document.createElement('div')
    d.textContent = n
    d.style.cssText = 'position:fixed;z-index:99999;width:24px;height:24px;border-radius:50%;background:#f59e0b;color:#111;font:700 14px system-ui,sans-serif;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px #111;pointer-events:none;left:' + Math.max(2, r.left + dx) + 'px;top:' + Math.max(2, r.top + dy) + 'px'
    document.body.append(d)
  }
  const btnText = (t, root = document) => qa('button', root).find((b) => b.textContent.trim() === t)
  const service = async () => { const s = q('#servicesel'); s.value = 'sunday-sample'; s.dispatchEvent(new Event('change', { bubbles: true })); await w(500) }
  await w(800)
`

const shots = {
  present: {
    media: songBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      qa('#schedule .srow')[0].click(); await w(500)
      await key('ArrowRight'); await key('ArrowRight')
      await w(600)`,
  },
  monitor: {
    media: songBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      const stage = await prestreamer.addDisplayScreen('Stage monitor 1', { stage: true }); await w(500)
      const st = await prestreamer.getState()
      await prestreamer.setLive(st.screens.find((s) => s.look.layout === 'stage').id, true)
      qa('#schedule .srow')[0].click(); await w(500)
      await key('ArrowRight'); await key('ArrowRight')
      tab('Monitor').click(); await w(600)
      qa('#view-monitor .seg button').find((b) => b.textContent.trim() === 'All screens').click(); await w(1200)`,
  },
  songs: {
    media: songBg,
    scenario: `${prelude}
      await backgrounds()
      tab('Songs').click(); await w(1200)
      await w(300)`,
  },
  bible: {
    media: readingBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      await prestreamer.bibleImportPaths([${JSON.stringify(kjv)}])
      tab('Bible').click(); await w(800)
      const f = q('#view-bible .bbar input[type=text]'); f.value = 'john 3,16-20'; f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await w(900)`,
  },
  mixer: {
    userData: (dir) => writeFileSync(join(dir, 'mixer.json'), JSON.stringify(band)),
    scenario: `${prelude}
      tab('Mixer').click(); await w(3000)
      q('#view-mixer .strip:not(.master):not(.monitor):not(.audience)').click(); await w(1500)`,
  },
  // Settings shows the Stream page: the Screens category lists the machine's own display names, which do not belong in a README.
  settings: {
    media: songBg,
    scenario: `${prelude}
      await backgrounds()
      tab('Settings').click(); await w(600)
      qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'Stream').click(); await w(900)`,
  },
  // Settings → Stream set to YouTube (no key is saved: the field is empty), for the streaming chapter of the guide.
  'settings-youtube': {
    media: songBg,
    userData: (dir) => writeFileSync(join(dir, 'stream-settings.json'), JSON.stringify({ mode: 'youtube' })),
    scenario: `${prelude}
      await backgrounds()
      tab('Settings').click(); await w(600)
      qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'Stream').click(); await w(900)`,
  },
  // The dialog for adding a screen, on the NDI type (it shows no display names, unlike the list of screens behind it).
  'ndi-screen': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds()
      tab('Settings').click(); await w(600)
      qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'Screens').click(); await w(700)
      qa('#view-settings button').find((b) => b.textContent.includes('Add screen')).click(); await w(600)
      qa('.kindcard').find((b) => b.textContent.includes('NDI screen')).click(); await w(500)
      const n = q('.sd input[type=text]'); n.value = 'Hall display'; n.dispatchEvent(new Event('input', { bubbles: true })); await w(400)`,
  },
  // The lighting panel of the Present tab, with the faders open (the Stream and Screens sections folded away so it fits).
  'dmx-present': {
    media: songBg,
    userData: dmxSetup,
    env: dmxEnv,
    scenario: `${prelude}
      await backgrounds(); await service()
      qa('#schedule .srow')[0].click(); await w(500)
      qa('#dmx .atembtn').find((b) => b.textContent === 'Worship').click(); await w(1500)
      q('#dmx details').open = true
      const fold = (id) => { const h = q('#' + id).previousElementSibling; if (h && !h.classList.contains('closed')) h.click() }
      fold('stream'); await w(300)
      q('#dmxsec').scrollIntoView({ block: 'start' }); await w(500)`,
  },
  'dmx-settings': {
    media: songBg,
    userData: dmxSetup,
    env: dmxEnv,
    scenario: `${prelude}
      await backgrounds()
      tab('Settings').click(); await w(600)
      qa('#view-settings .setnav button').find((b) => b.textContent.trim() === 'DMX').click(); await w(900)`,
  },
  // The Present tab with numbered markers, for "A tour of the window" in the guide.
  'tour-present': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      qa('#schedule .srow')[0].click(); await w(500)
      await key('ArrowRight'); await key('ArrowRight'); await w(600)
      const markers = [
        [q('#tabs'), 1], [q('#servicesel'), 2, q('#servicesel').getBoundingClientRect().width - 50], [q('#addtools'), 3], [q('#schedule'), 4], [q('#center section'), 5, -14, -2],
        [q('#screens'), 6], [q('#stream').previousElementSibling, 7], [q('.announcebtn'), 8], [q('.openall'), 9], [btnText('Clear slide'), 10],
      ]
      for (const [el, n, dx, dy] of markers) mark(el, n, dx, dy)
      await w(300)`,
  },
  // The song editor: one card per slide, the picture buttons, the details.
  'song-editor': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds()
      tab('Songs').click(); await w(900)
      q('#songeditor details')?.querySelector('summary')?.click(); await w(500)
      const ed = q('#songeditor')
      for (const [el, n, dx, dy] of [[q('input[type=text]', ed), 1, -12, -12], [q('textarea', ed), 2, -12, -2], [btnText('Picture or video…', ed), 3], [q('.cardbg', ed), 4, -8, -8], [q('details summary', ed), 5, -12, -2]]) mark(el, n, dx, dy)
      await w(300)`,
  },
  // The window of a screen's look (the gear on its card in the Present tab).
  'screen-look': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      qa('#schedule .srow')[0].click(); await w(500)
      await key('ArrowRight'); await w(500)
      q('button[title^="Settings for"]').click(); await w(700)`,
  },
  // Settings → Visuals: the app-wide backgrounds and the logo.
  'settings-visuals': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds()
      tab('Settings').click(); await w(600)
      btnText('Visuals', q('#view-settings .setnav')).click(); await w(900)`,
  },
  'settings-atem': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds()
      tab('Settings').click(); await w(600)
      btnText('ATEM', q('#view-settings .setnav')).click(); await w(900)`,
  },
  // A presentation (here a PDF) in the run sheet, one picture per slide.
  presentation: {
    media: songBg,
    env: () => ({ PRESTREAMER_PRESENTATION_FILE: deckPdf }),
    scenario: `${prelude}
      await backgrounds(); await service()
      const count = async () => (await prestreamer.servicesList()).find((s) => s.id === 'sunday-sample').items.length
      const before = await count()
      q('#addtools button[title^="Add a presentation"]').click()
      for (let i = 0; i < 100 && (await count()) === before; i++) await w(300)
      await w(800)
      const rows = qa('#schedule .srow'); rows[rows.length - 1].click(); await w(500)
      await key('ArrowRight'); await key('ArrowRight'); await w(900)`,
  },
  // The announcement window (the A key): quick messages, style, colour, which screens.
  'announce-popup': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      qa('#schedule .srow')[0].click(); await w(500)
      await key('ArrowRight'); await key('a'); await w(700)`,
  },
  'announce-live': {
    media: songBg,
    scenario: `${prelude}
      await backgrounds(); await service()
      qa('#schedule .srow')[0].click(); await w(500)
      await key('ArrowRight')
      await prestreamer.announceShow({ text: 'Welcome! Please silence your phones. Children\\'s church starts after the second song.', style: 'banner-bottom', tone: 'notice', screens: null, autoHideSec: null }); await w(900)`,
  },
}

// A three-page PDF for the presentation picture, made by the app itself (the same hook the end-to-end test uses).
const deckPdf = join(outDir, 'deck.pdf')
const wantsDeck = process.argv.slice(2).length === 0 || process.argv.includes('presentation')
if (wantsDeck) spawnSync(electronPath, ['.'], { env: { ...process.env, PRESTREAMER_USER_DATA: join(outDir, 'userdata-makepdf'), PRESTREAMER_MAKEPDF: deckPdf }, timeout: 60_000 })

const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : Object.keys(shots)
let failed = 0
for (const name of names) {
  const shot = shots[name]
  if (!shot) { console.error(`unknown screenshot "${name}" (have: ${Object.keys(shots).join(', ')})`); failed++; continue }
  const userData = join(outDir, `userdata-${name}`)
  rmSync(userData, { recursive: true, force: true })
  mkdirSync(userData, { recursive: true })
  // Record to a file: the Stream panel then shows a normal "Start recording" instead of the "no stream key yet" notice.
  writeFileSync(join(userData, 'stream-settings.json'), JSON.stringify({ mode: 'file' }))
  shot.userData?.(userData)
  const png = join(outDir, `${name}.png`)
  rmSync(png, { force: true })
  const run = spawnSync(electronPath, ['.'], {
    env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: png, PRESTREAMER_EVAL: `(async () => { ${shot.scenario}\n return 'ok' })()`, ...(shot.media ? { PRESTREAMER_MEDIA_FILE: shot.media } : {}), ...(shot.env ? shot.env(userData) : {}) },
    encoding: 'utf8',
    timeout: 120_000,
  })
  const reported = /^EVAL (.*)$/m.exec(run.stdout ?? '')
  try {
    copyFileSync(png, join(target, `${name}.png`))
    console.log(`ok    ${name}.png${reported ? '' : '  (the scenario reported nothing)'}`)
  } catch {
    console.error(`FAIL  ${name}: no picture taken`, (run.stderr || '').slice(-300), (run.stdout || '').slice(-300))
    failed++
  }
}
process.exit(failed ? 1 : 0)

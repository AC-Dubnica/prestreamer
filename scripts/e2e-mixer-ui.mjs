// End-to-end check of the mixer's interface: strips can be reordered by drag and drop (and with the keyboard), the order is
// saved, and EQ / gate / compressor / limiter are knobs, switches and graphs that edit the saved settings.
// Drives the real operator window with synthetic pointer and drag events. Needs a display.
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureElectron } from './electron-path.mjs'

const electronPath = await ensureElectron()
const outDir = process.env.E2E_OUT_DIR || join(tmpdir(), 'prestreamer-e2e')
mkdirSync(outDir, { recursive: true })
const userData = join(outDir, 'userdata-mixer-ui')
rmSync(userData, { recursive: true, force: true })

const scenario = `(async () => {
  const w = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel, root = document) => root.querySelector(sel)
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)]
  const tab = (name) => qa('#tabs button').find((b) => b.textContent.trim() === name)
  const strips = () => qa('#view-mixer .strip:not(.master)')
  const order = () => strips().map((s) => s.dataset.key)
  const saved = async () => (await prestreamer.audioMixerGet())
  const savedOrder = async () => (await saved()).strips.map((s) => s.source.deviceId + '#' + s.channel)
  const card = (title) => qa('#view-mixer .mcard').find((c) => q('.chead span', c)?.textContent === title)
  const knobOf = (cardTitle, label) => qa('.knob', card(cardTitle)).find((k) => q('.klbl', k).textContent === label)
  const pointer = (el, type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerId: 1 }))
  const r = {}

  tab('Mixer').click(); await w(800)
  r.initialOrder = await savedOrder()
  // Add the stereo test beep: a third strip
  const sel = qa('#view-mixer .mxadd select')[0]; sel.value = 'test:beep'; sel.dispatchEvent(new Event('change', { bubbles: true })); await w(400)
  qa('#view-mixer button').find((b) => b.textContent.trim() === 'Add channel').click(); await w(1200)
  r.afterAdd = await savedOrder()
  r.gripsPresent = qa('#view-mixer .strip:not(.master) .grip').length === strips().length

  // Drag the beep strip (last) onto the left half of the first strip
  const beep = strips()[2], first = strips()[0]
  const dt = new DataTransfer()
  pointer(q('.grip', beep), 'pointerdown', 0, 0)
  r.gripMakesDraggable = beep.draggable
  beep.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  const fr = first.getBoundingClientRect()
  first.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: fr.left + 5, clientY: fr.top + 20, dataTransfer: dt }))
  r.dropMarkerShown = first.classList.contains('dropbefore')
  first.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: fr.left + 5, clientY: fr.top + 20, dataTransfer: dt }))
  await w(400)
  r.afterDrag = await savedOrder()
  r.uiMatchesSaved = JSON.stringify(order()) === JSON.stringify(['test:beep#0', 'app:video#0', 'app:video#1'])

  // A drag that starts anywhere but the grip does nothing
  const other = strips()[1]
  const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
  other.dispatchEvent(ev)
  r.dragWithoutGripCancelled = ev.defaultPrevented

  // Keyboard: Right arrow on the first strip's grip moves it one place right
  q('.grip', strips()[0]).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await w(400)
  r.afterKey = await savedOrder()

  // --- knobs, switches and graphs on the beep strip
  strips().find((s) => s.dataset.key === 'test:beep#0').click(); await w(300)
  r.cards = qa('#view-mixer .mcard .chead span').map((s) => s.textContent)
  r.slidersInDetail = qa('#view-mixer .detail input[type=range]').length
  const ratio = knobOf('Compressor', 'Ratio')
  r.ratioStart = q('.kval', ratio).textContent
  const rect = ratio.getBoundingClientRect(), cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
  pointer(ratio, 'pointerdown', cx, cy); pointer(ratio, 'pointermove', cx, cy - 80); pointer(ratio, 'pointerup', cx, cy - 80); await w(300)
  r.ratioAfterDrag = q('.kval', ratio).textContent
  r.ratioSavedAfterDrag = (await saved()).strips.find((s) => s.source.deviceId === 'test:beep').comp.ratio
  ratio.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await w(300)
  r.ratioAfterReset = q('.kval', ratio).textContent
  ratio.focus(); ratio.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await w(300)
  r.ratioAfterKey = q('.kval', ratio).textContent
  ratio.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })); await w(300)
  r.ratioAfterWheel = Number(q('.kval', ratio).textContent.replace(/[^0-9.]/g, ''))

  const gateSwitch = q('input.switch', card('Gate'))
  gateSwitch.click(); await w(300)
  r.gateSaved = (await saved()).strips.find((s) => s.source.deviceId === 'test:beep').gate.on
  r.gateBodyDimmedWhenOff = (() => { gateSwitch.click(); return q('.cbody', card('Gate')).classList.contains('off') })()
  gateSwitch.click(); await w(200)

  // EQ graph: drag the mid dot from 1 kHz / 0 dB to about 2 kHz / +6 dB, and the knobs follow
  const g = q('canvas.mxgraph', card('EQ'))
  const pixels = () => { const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n }
  r.eqGraphDrawn = pixels() > 200
  const gr = g.getBoundingClientRect(), sx = gr.width / 300, sy = gr.height / 120
  const at = (x, y) => [gr.left + x * sx, gr.top + y * sy]
  const [x0, y0] = at(169.9, 60), [x1, y1] = at(200, 40)
  pointer(g, 'pointerdown', x0, y0); pointer(g, 'pointermove', x1, y1); pointer(g, 'pointerup', x1, y1); await w(400)
  const eq = (await saved()).strips.find((s) => s.source.deviceId === 'test:beep').eq
  r.eqSaved = { freq: eq.midFreq, gain: eq.midGainDb }
  r.eqKnobsFollow = [q('.kval', knobOf('EQ', 'Mid')).textContent, q('.kval', qa('.knob', card('EQ')).filter((k) => q('.klbl', k).textContent === 'Freq')[1]).textContent]
  // Compressor graph draws a curve
  const cg = q('canvas.mxgraph', card('Compressor'))
  const cd = cg.getContext('2d').getImageData(0, 0, cg.width, cg.height).data; let cn = 0; for (let i = 3; i < cd.length; i += 4) if (cd[i] > 0) cn++
  r.compGraphDrawn = cn > 200
  r.compAfterThreshold = await (async () => { const t = knobOf('Compressor', 'Threshold'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, shiftKey: true })); await w(300); return (await saved()).strips.find((s) => s.source.deviceId === 'test:beep').comp.thresholdDb })()
  return r
})()`

const run = spawnSync(electronPath, ['.'], {
  env: { ...process.env, PRESTREAMER_USER_DATA: userData, PRESTREAMER_SNAPSHOT: join(outDir, 'mixer-ui.png'), PRESTREAMER_EVAL: scenario },
  encoding: 'utf8',
  timeout: 120_000,
})
const line = /^EVAL (.*)$/m.exec(run.stdout ?? '')
if (!line) {
  console.error('The mixer UI scenario did not report a result.', run.status, (run.stderr || '').slice(-600), (run.stdout || '').slice(-600))
  process.exit(1)
}
const r = JSON.parse(line[1])
const V = ['app:video#0', 'app:video#1']
const j = JSON.stringify
const checks = [
  ['a new mixer starts with the video pair', j(r.initialOrder) === j(V), j(r.initialOrder)],
  ['every strip has a drag handle', r.gripsPresent === true, ''],
  ['pressing the handle (only) makes the strip draggable', r.gripMakesDraggable === true && r.dragWithoutGripCancelled === true, ''],
  ['dragging over a strip shows where it will land', r.dropMarkerShown === true, ''],
  ['dropping a strip before another reorders the mix, on screen and in the saved mixer', j(r.afterDrag) === j(['test:beep#0', ...V]) && r.uiMatchesSaved === true, j(r.afterDrag)],
  ['the arrow keys on the handle move a strip too', j(r.afterKey) === j([V[0], 'test:beep#0', V[1]]), j(r.afterKey)],
  ['the strip settings are cards: input, high-pass, EQ, gate, compressor, limiter', j(r.cards) === j(['Input', 'High-pass', 'EQ', 'Gate', 'Compressor', 'Limiter']), j(r.cards)],
  ['no plain sliders are left in the strip settings', r.slidersInDetail === 0, `${r.slidersInDetail}`],
  ['dragging a knob up changes the value and saves it', r.ratioStart === '3.0:1' && r.ratioAfterDrag === '12.5:1' && r.ratioSavedAfterDrag === 12.5, `${r.ratioStart} -> ${r.ratioAfterDrag} (saved ${r.ratioSavedAfterDrag})`],
  ['double-click resets a knob', r.ratioAfterReset === '3.0:1', r.ratioAfterReset],
  ['arrow keys and the mouse wheel turn a knob', r.ratioAfterKey === '3.5:1' && r.ratioAfterWheel > 3.5, `${r.ratioAfterKey}, ${r.ratioAfterWheel}`],
  ['a module switch turns it on and dims it when off', r.gateSaved === true && r.gateBodyDimmedWhenOff === true, ''],
  ['the EQ draws its response curve', r.eqGraphDrawn === true, ''],
  ['dragging the mid dot sets frequency and gain (about 2 kHz, +6 dB), saved', Math.abs(r.eqSaved.freq - 2000) < 120 && r.eqSaved.gain === 6, j(r.eqSaved)],
  ['the EQ knobs follow the dot', /^6\.0 dB$/.test(r.eqKnobsFollow[0]) && /^(1\.9|2\.0|2\.1)\d? k Hz$/.test(r.eqKnobsFollow[1]), j(r.eqKnobsFollow)],
  ['the compressor draws its input/output curve', r.compGraphDrawn === true, ''],
  ['Shift+arrow moves a knob in big steps', r.compAfterThreshold === -14, `${r.compAfterThreshold}`],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} mixer UI checks passed`)
process.exit(failed ? 1 : 0)

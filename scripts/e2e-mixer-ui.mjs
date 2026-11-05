// End-to-end check of the mixer's interface: strips can be reordered by drag and drop (and with the keyboard), the order is
// saved, and every strip and the master has a chain of effects: effects are added from a menu, moved along the chain by
// dragging, switched off, removed or replaced by a preset, and their knobs, switches and graphs edit the saved settings.
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
  const card = (title) => qa('#view-mixer .fxcard').find((c) => q('.ctitle', c)?.textContent === title)
  const cardTitles = () => qa('#view-mixer .fxcard .ctitle').map((t) => t.textContent)
  const modal = () => q('#modal:not([hidden]) .dialog')
  const btn = (text, root = document) => qa('button', root).find((b) => b.textContent.trim() === text)
  const addFx = async (label) => { btn('Add effect', q('#view-mixer')).click(); await w(300); qa('.fxopt', modal()).find((b) => q('strong', b).textContent === label).click(); await w(500) }
  const beepChain = async () => (await saved()).strips.find((s) => s.source.deviceId === 'test:beep').chain
  const types = (chain) => chain.map((e) => e.type)
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

  // --- the chain of the beep strip: starts empty, effects are added from a menu
  strips().find((s) => s.dataset.key === 'test:beep#0').click(); await w(300)
  r.emptyChain = { effects: cardTitles(), nodes: qa('#view-mixer .fxnode .ctitle').map((t) => t.textContent), hasAdd: !!btn('Add effect', q('#view-mixer')), chips: q('.strip[data-key="test:beep#0"] .chips').textContent }
  btn('Add effect', q('#view-mixer')).click(); await w(300)
  r.menu = qa('.fxopt strong', modal()).map((b) => b.textContent)
  r.menuHasBlurbs = qa('.fxopt .dim', modal()).every((d) => d.textContent.length > 20)
  btn('Cancel', modal()).click(); await w(200)
  await addFx('Compressor'); await addFx('EQ'); await addFx('Gate'); await addFx('Limiter')
  r.built = { onScreen: cardTitles(), saved: types(await beepChain()), allOn: (await beepChain()).every((e) => e.on) }
  r.chips = qa('.chip', q('.strip[data-key="test:beep#0"]')).map((c) => c.textContent)
  r.slidersInDetail = qa('#view-mixer .detail input[type=range]').length
  const ratio = knobOf('Compressor', 'Ratio')
  r.ratioStart = q('.kval', ratio).textContent
  const rect = ratio.getBoundingClientRect(), cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2
  pointer(ratio, 'pointerdown', cx, cy); pointer(ratio, 'pointermove', cx, cy - 80); pointer(ratio, 'pointerup', cx, cy - 80); await w(300)
  r.ratioAfterDrag = q('.kval', ratio).textContent
  r.ratioSavedAfterDrag = (await beepChain()).find((e) => e.type === 'comp').ratio
  ratio.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await w(300)
  r.ratioAfterReset = q('.kval', ratio).textContent
  ratio.focus(); ratio.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await w(300)
  r.ratioAfterKey = q('.kval', ratio).textContent
  ratio.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })); await w(300)
  r.ratioAfterWheel = Number(q('.kval', ratio).textContent.replace(/[^0-9.]/g, ''))

  const gateSwitch = q('input.switch', card('Gate'))
  gateSwitch.click(); await w(300)
  r.gateSavedOff = (await beepChain()).find((e) => e.type === 'gate').on === false
  r.gateBodyDimmedWhenOff = q('.cbody', card('Gate')).classList.contains('off') && card('Gate').classList.contains('bypassed')
  r.gateChipDimmed = qa('.chip', q('.strip[data-key="test:beep#0"]')).find((c) => c.textContent === 'Gate').classList.contains('off')
  gateSwitch.click(); await w(300)
  r.gateBackOn = (await beepChain()).find((e) => e.type === 'gate').on === true

  // EQ graph: drag the mid dot from 1 kHz / 0 dB to about 2 kHz / +6 dB, and the knobs follow
  const g = q('canvas.mxgraph', card('EQ'))
  const pixels = () => { const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n }
  r.eqGraphDrawn = pixels() > 200
  const gr = g.getBoundingClientRect(), sx = gr.width / 300, sy = gr.height / 120
  const at = (x, y) => [gr.left + x * sx, gr.top + y * sy]
  const [x0, y0] = at(169.9, 60), [x1, y1] = at(200, 40)
  pointer(g, 'pointerdown', x0, y0); pointer(g, 'pointermove', x1, y1); pointer(g, 'pointerup', x1, y1); await w(400)
  const eq = (await beepChain()).find((e) => e.type === 'eq')
  r.eqSaved = { freq: eq.midFreq, gain: eq.midGainDb }
  r.eqKnobsFollow = [q('.kval', knobOf('EQ', 'Mid')).textContent, q('.kval', qa('.knob', card('EQ')).filter((k) => q('.klbl', k).textContent === 'Freq')[1]).textContent]
  // Compressor graph draws a curve
  const cg = q('canvas.mxgraph', card('Compressor'))
  const cd = cg.getContext('2d').getImageData(0, 0, cg.width, cg.height).data; let cn = 0; for (let i = 3; i < cd.length; i += 4) if (cd[i] > 0) cn++
  r.compGraphDrawn = cn > 200
  r.compAfterThreshold = await (async () => { const t = knobOf('Compressor', 'Threshold'); t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, shiftKey: true })); await w(300); return (await beepChain()).find((e) => e.type === 'comp').thresholdDb })()

  // --- moving effects along the chain: drag a card by its grip onto another; the arrow keys on the grip move it too
  const chainTypes = async () => types(await beepChain())
  const dragFx = async (fromTitle, toTitle, rightHalf) => {
    const dt = new DataTransfer(), from = card(fromTitle), to = card(toTitle)
    pointer(q('.grip', from), 'pointerdown', 0, 0)
    r.fxGripMakesDraggable = (r.fxGripMakesDraggable ?? true) && from.draggable
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
    const b = to.getBoundingClientRect()
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: rightHalf ? b.right - 5 : b.left + 5, clientY: b.top + 20, dataTransfer: dt }))
    r.fxMarker = to.classList.contains(rightHalf ? 'dropafter' : 'dropbefore')
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }))
    await w(500)
  }
  await dragFx('Gate', 'Compressor', false)
  r.afterFxDrag = { onScreen: cardTitles(), saved: await chainTypes() }
  const noGrip = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() })
  card('EQ').dispatchEvent(noGrip)
  r.fxDragWithoutGripCancelled = noGrip.defaultPrevented
  q('.grip', card('Gate')).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await w(500)
  r.afterFxKey = await chainTypes()
  // the moved chain still has its settings (ids and values stay with the effects)
  r.settingsStayWithEffects = (await beepChain()).find((e) => e.type === 'eq').midGainDb === 6

  // --- remove an effect, and a preset replaces the chain (asking first when there is something to lose)
  q('button[aria-label="Remove Limiter from the chain"]', card('Limiter')).click(); await w(500)
  r.afterRemove = await chainTypes()
  btn('Start from…', q('#view-mixer')).click(); await w(300)
  r.presetMenu = qa('.fxopt strong', modal()).map((b) => b.textContent)
  qa('.fxopt', modal()).find((b) => q('strong', b).textContent === 'Worship vocal').click(); await w(500)
  r.askedBeforeReplacing = !!modal() && /Replace the effects/.test(modal().textContent)
  btn('Keep', modal())?.click?.(); btn('Cancel', modal())?.click?.(); await w(300)
  r.afterCancel = await chainTypes()
  btn('Start from…', q('#view-mixer')).click(); await w(300)
  qa('.fxopt', modal()).find((b) => q('strong', b).textContent === 'Worship vocal').click(); await w(500)
  btn('Replace', modal()).click(); await w(600)
  r.afterPreset = { saved: await chainTypes(), onScreen: cardTitles() }

  // --- the master has its own chain: select it, it starts with the limiter, and effects can be added there
  q('#view-mixer .strip.master').click(); await w(400)
  r.master = { cards: cardTitles(), nodes: qa('#view-mixer .fxnode .ctitle').map((t) => t.textContent), selected: q('#view-mixer .strip.master').classList.contains('sel'), chips: q('#view-mixer .strip.master .chips').textContent, noOldLimiterSection: !q('#view-mixer .strip.master .sect') }
  await addFx('Compressor')
  r.masterSaved = types((await saved()).masterChain)
  const m = card('Compressor')
  await w(700) // the change above is finished: it is one step of the history
  q('input.switch', m).click(); await w(300)
  r.masterBypassSaved = (await saved()).masterChain.find((e) => e.type === 'comp').on === false

  // --- undo and redo: Cmd/Ctrl+Z steps back through the changes made above, Cmd/Ctrl+Shift+Z forward again
  await w(700)
  const press = async (k, shiftKey = false, extra = {}) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, metaKey: true, shiftKey, bubbles: true, cancelable: true, ...extra })); await w(500) }
  const undoBtn = () => q('#view-mixer .mxbar button[aria-label^="Undo"]'), redoBtn = () => q('#view-mixer .mxbar button[aria-label^="Redo"]')
  r.historyButtons = { undoEnabled: !undoBtn().disabled, redoDisabled: redoBtn().disabled }
  const masterComp = async () => (await saved()).masterChain.find((e) => e.type === 'comp')
  await press('z'); r.undo1 = (await masterComp())?.on
  await press('z'); r.undo2 = types((await saved()).masterChain)
  r.redoEnabledAfterUndo = !redoBtn().disabled
  await press('z', true); r.redo1 = types((await saved()).masterChain)
  await press('z', true); r.redo2 = (await masterComp())?.on
  // a new change after an undo ends the redo trail
  await press('z'); await w(300)
  q('input.switch', card('Compressor')).click(); await w(800)
  r.redoGoneAfterNewChange = redoBtn().disabled
  // the button does the same as the key; typing in a text box keeps its own undo (the app leaves the key alone there)
  undoBtn().click(); await w(500)
  r.buttonUndo = (await masterComp())?.on
  const nameBox = q('#view-mixer .strip input[type=text]')
  const ev = new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true, cancelable: true })
  nameBox.dispatchEvent(ev)
  r.textBoxKeepsOwnUndo = ev.defaultPrevented === false
  // Ctrl+Y redoes too
  await press('y', false, { metaKey: false, ctrlKey: true })
  r.ctrlY = (await masterComp())?.on
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
  ['a strip starts with an empty chain: Input and Fader nodes, an Add effect button, "no effects" on the strip', j(r.emptyChain.nodes) === j(['Input', 'Fader']) && r.emptyChain.effects.length === 0 && r.emptyChain.hasAdd && /no effects/.test(r.emptyChain.chips), j(r.emptyChain)],
  ['the Add effect menu lists the eight effects, each with a description', j(r.menu) === j(['High-pass', 'EQ', 'Gate', 'Compressor', 'Limiter', 'De-esser', 'Reverb', 'Delay']) && r.menuHasBlurbs, j(r.menu)],
  ['effects are added to the end of the chain, on, and saved in that order', j(r.built.onScreen) === j(['Compressor', 'EQ', 'Gate', 'Limiter']) && j(r.built.saved) === j(['comp', 'eq', 'gate', 'limiter']) && r.built.allOn, j(r.built)],
  ['the strip shows its chain at a glance', j(r.chips) === j(['Comp', 'EQ', 'Gate', 'Limit']), j(r.chips)],
  ['no plain sliders are left in the strip settings', r.slidersInDetail === 0, `${r.slidersInDetail}`],
  ['dragging a knob up changes the value and saves it', r.ratioStart === '3.0:1' && r.ratioAfterDrag === '12.5:1' && r.ratioSavedAfterDrag === 12.5, `${r.ratioStart} -> ${r.ratioAfterDrag} (saved ${r.ratioSavedAfterDrag})`],
  ['double-click resets a knob', r.ratioAfterReset === '3.0:1', r.ratioAfterReset],
  ['arrow keys and the mouse wheel turn a knob', r.ratioAfterKey === '3.5:1' && r.ratioAfterWheel > 3.5, `${r.ratioAfterKey}, ${r.ratioAfterWheel}`],
  ['an effect\'s switch bypasses it: saved as off, the card is dimmed with a dashed edge, its chip is crossed out, and it comes back on', r.gateSavedOff && r.gateBodyDimmedWhenOff && r.gateChipDimmed && r.gateBackOn, ''],
  ['the EQ draws its response curve', r.eqGraphDrawn === true, ''],
  ['dragging the mid dot sets frequency and gain (about 2 kHz, +6 dB), saved', Math.abs(r.eqSaved.freq - 2000) < 120 && r.eqSaved.gain === 6, j(r.eqSaved)],
  ['the EQ knobs follow the dot', /^6\.0 dB$/.test(r.eqKnobsFollow[0]) && /^(1\.9|2\.0|2\.1)\d? k Hz$/.test(r.eqKnobsFollow[1]), j(r.eqKnobsFollow)],
  ['the compressor draws its input/output curve', r.compGraphDrawn === true, ''],
  ['Shift+arrow moves a knob in big steps', r.compAfterThreshold === -14, `${r.compAfterThreshold}`],
  ['dragging an effect by its grip onto another moves it along the chain (the drop marker shows), on screen and saved', r.fxGripMakesDraggable && r.fxMarker && j(r.afterFxDrag.onScreen) === j(['Gate', 'Compressor', 'EQ', 'Limiter']) && j(r.afterFxDrag.saved) === j(['gate', 'comp', 'eq', 'limiter']), j(r.afterFxDrag)],
  ['a drag that does not start on the grip does nothing, and the arrow keys on the grip move an effect too', r.fxDragWithoutGripCancelled === true && j(r.afterFxKey) === j(['comp', 'gate', 'eq', 'limiter']), j(r.afterFxKey)],
  ['a moved effect keeps its settings', r.settingsStayWithEffects === true, ''],
  ['removing an effect takes it out of the chain', j(r.afterRemove) === j(['comp', 'gate', 'eq']), j(r.afterRemove)],
  ['"Start from…" offers ready-made chains, and asks before replacing a chain that has effects in it (Cancel keeps it)', r.presetMenu.includes('Worship vocal') && r.presetMenu.includes('Speaker / preacher') && r.askedBeforeReplacing && j(r.afterCancel) === j(['comp', 'gate', 'eq']), j([r.presetMenu, r.askedBeforeReplacing, r.afterCancel])],
  ['confirming replaces the chain with the preset (high-pass, EQ, compressor, de-esser, reverb)', j(r.afterPreset.saved) === j(['hpf', 'eq', 'comp', 'deesser', 'reverb']) && j(r.afterPreset.onScreen) === j(['High-pass', 'EQ', 'Compressor', 'De-esser', 'Reverb']), j(r.afterPreset)],
  ['selecting the master shows its own chain, which starts with the limiter (no separate limiter section on the master strip)', j(r.master.cards) === j(['Limiter']) && j(r.master.nodes) === j(['Mix', 'Master']) && r.master.selected && /Limit/.test(r.master.chips) && r.master.noOldLimiterSection, j(r.master)],
  ['effects can be added to the master chain and switched off there, saved with the mixer', j(r.masterSaved) === j(['limiter', 'comp']) && r.masterBypassSaved === true, j(r.masterSaved)],
  ['the mixer has Undo and Redo buttons: Undo is available after changes, Redo is not', r.historyButtons.undoEnabled && r.historyButtons.redoDisabled, j(r.historyButtons)],
  ['Cmd/Ctrl+Z undoes the last change (the bypass), and again the one before (the added effect); Redo becomes available', r.undo1 === true && j(r.undo2) === j(['limiter']) && r.redoEnabledAfterUndo === true, j([r.undo1, r.undo2, r.redoEnabledAfterUndo])],
  ['Cmd/Ctrl+Shift+Z brings the changes back, in order', j(r.redo1) === j(['limiter', 'comp']) && r.redo2 === false, j([r.redo1, r.redo2])],
  ['a new change after an undo ends the redo trail', r.redoGoneAfterNewChange === true, ''],
  ['the Undo button and Ctrl+Y work too, and a text box keeps its own undo', r.buttonUndo === true && r.textBoxKeepsOwnUndo === true && r.ctrlY === false, j([r.buttonUndo, r.textBoxKeepsOwnUndo, r.ctrlY])],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
console.log(`\n${checks.length - failed}/${checks.length} mixer UI checks passed`)
process.exit(failed ? 1 : 0)

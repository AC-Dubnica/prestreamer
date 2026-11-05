import type { PrestreamerApi } from '../preload'
import { MAX_CHANNELS, RANGES, TEST_SOURCES, VIDEO_SOURCE, videoStrips, defaultMixer, defaultStrip, shortDeviceName, stripKey, type MixerConfig, type Strip, type StripSource } from '../shared/mixer'
import type { AudioStatus, Meters } from '../shared/types'
import { moveBefore } from '../shared/curves'
import { iconButton, iconSvg } from './icons'
import { knob } from './knob'
import { compCurve, eqGraph, gateCurve } from './mixer-graphs'

type Range = readonly [number, number]

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

/** -60 dBFS (silence) … 0 dBFS (clip) mapped to 0-100 % of a meter's height. */
const meterPct = (db: number): number => Math.min(100, Math.max(0, ((db + 60) / 60) * 100))
const levelClass = (db: number): string => (db > -3 ? 'hot' : db > -18 ? 'mid' : 'ok')
const fmtDb = (db: number): string => (db <= -99 ? '-∞' : `${db > 0 ? '+' : ''}${db.toFixed(1)}`)

/** Fader positions at or below this are "off" (-∞): the slider's bottom stop. */
const FADER_FLOOR = -60

interface MeterEls { fill: HTMLElement; peak: HTMLElement; gr: HTMLElement }

/**
 * The mixing console tab: one strip per USB channel feeding the stereo stream mix.
 * Changes are applied live (debounced) in the audio window and saved by the main process.
 */
export interface MixerDeps {
  /** Every audio input on the machine (kept current by the operator). */
  getDevices(): { deviceId: string; label: string }[]
  /** How many channels a device offers, found by opening it briefly. */
  probeChannels(deviceId: string): Promise<number>
  /** (Re)starts the mixer's audio engine. It starts by itself; this is for trying again after an error. */
  startAudio(): Promise<void>
}

export function createMixerView(root: HTMLElement, api: PrestreamerApi, deps: MixerDeps) {
  let mixer: MixerConfig = defaultMixer()
  let selected: string | null = null // a strip's key: device and channel
  let addSource = ''
  let addChannel = 0
  const probed = new Map<string, number | 'failed'>()
  let status: AudioStatus = { state: 'idle', message: 'Silence', channelCount: 0 }
  const meters = new Map<string, MeterEls>()
  let masterMeters: MeterEls[] = []
  let commitTimer: ReturnType<typeof setTimeout> | null = null

  function commit(): void {
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = setTimeout(() => void api.audioMixerSet(mixer), 40)
  }

  const stripOf = (key: string): Strip | undefined => mixer.strips.find((s) => stripKey(s) === key)

  /** A labelled slider that updates the config in place (no re-render, so dragging stays smooth). */
  function slider(label: string, value: number, range: Range, step: number, unit: string, onInput: (v: number) => void, disabled = false): HTMLElement {
    const out = el('span', { className: 'val' })
    const show = (v: number) => { out.textContent = `${Number.isInteger(step) ? v.toFixed(0) : v.toFixed(step < 0.1 ? 2 : 1)}${unit}` }
    const input = el<HTMLInputElement>('input', { type: 'range', min: String(range[0]), max: String(range[1]), step: String(step), value: String(value), disabled })
    show(value)
    input.oninput = () => { const v = Number(input.value); show(v); onInput(v); commit() }
    input.ondblclick = () => { input.value = String(value); input.dispatchEvent(new Event('input')) }
    return el('label', { className: 'prm' }, el('span', { className: 'lbl', textContent: label }), input, out)
  }

  function section(title: string, on: boolean, setOn: (v: boolean) => void, ...rows: HTMLElement[]): HTMLElement {
    const toggle = el<HTMLInputElement>('input', { type: 'checkbox', checked: on })
    const body = el('div', { className: `sbody ${on ? '' : 'off'}` }, ...rows)
    toggle.onchange = () => { setOn(toggle.checked); body.classList.toggle('off', !toggle.checked); commit() }
    return el('div', { className: 'sect' }, el('label', { className: 'shead' }, toggle, el('span', { textContent: title })), body)
  }

  function renderStrip(s: Strip): HTMLElement {
    const fill = el('div', { className: 'fill' })
    const peak = el('div', { className: 'peak' })
    const gr = el('div', { className: 'gr' })
    meters.set(stripKey(s), { fill, peak, gr })

    const readout = el('div', { className: 'db' })
    const fader = el<HTMLInputElement>('input', { type: 'range', className: 'vfader', min: String(FADER_FLOOR - 1), max: String(RANGES.faderDb[1]), step: '0.5', value: String(s.faderDb <= FADER_FLOOR ? FADER_FLOOR - 1 : s.faderDb) })
    const showFader = () => { readout.textContent = fmtDb(s.faderDb) }
    showFader()
    fader.oninput = () => { const v = Number(fader.value); s.faderDb = v <= FADER_FLOOR ? -100 : v; showFader(); commit() }
    fader.ondblclick = () => { s.faderDb = 0; fader.value = '0'; showFader(); commit() } // double-click = unity

    const mute = el('button', { className: `ms ${s.mute ? 'on mute' : ''}`, textContent: 'M', title: 'Mute' })
    mute.onclick = () => { s.mute = !s.mute; mute.classList.toggle('on', s.mute); mute.classList.toggle('mute', s.mute); commit() }
    const solo = el('button', { className: `ms ${s.solo ? 'on solo' : ''}`, textContent: 'S', title: 'Solo (silences every strip that is not soloed)' })
    solo.onclick = () => { s.solo = !s.solo; solo.classList.toggle('on', s.solo); solo.classList.toggle('solo', s.solo); commit() }

    const name = el<HTMLInputElement>('input', { type: 'text', value: s.name, maxLength: 24, title: 'Rename' })
    name.onchange = () => { s.name = name.value.trim() || defaultStrip(s.channel, undefined, s.source).name; commit() }
    name.onclick = (e) => e.stopPropagation()

    const pan = el<HTMLInputElement>('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: String(s.pan), title: 'Pan (double-click to centre)' })
    pan.oninput = () => { s.pan = Number(pan.value); commit() }
    pan.ondblclick = () => { s.pan = 0; pan.value = '0'; commit() }

    const remove = iconButton('x', 'Remove this channel from the mix', (e) => {
      e.stopPropagation()
      mixer.strips = mixer.strips.filter((x) => stripKey(x) !== stripKey(s))
      if (selected === stripKey(s)) selected = mixer.strips[0] ? stripKey(mixer.strips[0]) : null
      commit()
      render()
    }, { size: 12 })

    // Strips are reordered by dragging the grip (or with the arrow keys while it has focus): only the grip starts a drag,
    // so the faders and sliders in the strip keep working.
    const key = stripKey(s)
    const grip = el('button', { className: 'grip', title: 'Drag to change the order (or press ← → on this handle)', textContent: '⠿' })
    grip.setAttribute('aria-label', `Move ${s.name}`)
    grip.onclick = (e) => e.stopPropagation()
    grip.onkeydown = (e) => {
      const i = mixer.strips.findIndex((x) => stripKey(x) === key)
      const target = mixer.strips[i + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)]
      if (!target || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
      e.preventDefault()
      reorder(key, stripKey(target), e.key === 'ArrowRight')
      document.querySelector<HTMLElement>(`.strip[data-key="${CSS.escape(key)}"] .grip`)?.focus()
    }
    const deviceName = s.source ? shortDeviceName(s.source.label) : 'Default source'
    const strip = el('div', { className: `strip ${selected === stripKey(s) ? 'sel' : ''}`, onclick: () => { selected = stripKey(s); render() } },
      el('div', { className: 'top' }, grip, el('span', { className: 'ch', textContent: String(s.channel + 1), title: `Channel ${s.channel + 1}` }), remove),
      el('div', { className: 'dev', textContent: deviceName, title: s.source?.label ?? 'The default source chosen in the Audio panel' }),
      name,
      el('div', { className: 'mf' }, el('div', { className: 'meter' }, fill, peak, gr), fader),
      readout,
      el('div', { className: 'btns2' }, mute, solo),
      pan,
    )
    strip.dataset.key = key
    grip.onpointerdown = () => { strip.draggable = true }
    grip.onpointerup = () => { strip.draggable = false }
    strip.ondragstart = (e) => {
      if (!strip.draggable) return e.preventDefault()
      e.dataTransfer?.setData('text/plain', key)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
      dragging = key
      strip.classList.add('dragging')
    }
    strip.ondragend = () => { strip.draggable = false; dragging = null; strip.classList.remove('dragging'); clearDropMarks() }
    strip.ondragover = (e) => {
      if (!dragging || dragging === key) return
      e.preventDefault()
      const r = strip.getBoundingClientRect()
      const after = e.clientX > r.left + r.width / 2
      clearDropMarks()
      strip.classList.add(after ? 'dropafter' : 'dropbefore')
    }
    strip.ondragleave = () => strip.classList.remove('dropbefore', 'dropafter')
    strip.ondrop = (e) => {
      e.preventDefault()
      const from = dragging
      const after = strip.classList.contains('dropafter')
      dragging = null
      clearDropMarks()
      if (from) reorder(from, key, after)
    }
    return strip
  }

  let dragging: string | null = null
  const clearDropMarks = () => document.querySelectorAll('.strip.dropbefore, .strip.dropafter').forEach((n) => n.classList.remove('dropbefore', 'dropafter'))
  function reorder(from: string, to: string, after: boolean): void {
    const next = moveBefore(mixer.strips, stripKey, from, to, after)
    if (next === mixer.strips) return
    mixer.strips = next
    commit()
    render()
  }

  /** A module card: title with an on/off switch, an optional graph, and a grid of knobs. Everything edits the strip in place. */
  function card(title: string, on: boolean, setOn: (v: boolean) => void, graph: HTMLElement | null, knobs: HTMLElement[], onToggle?: () => void): HTMLElement {
    const toggle = el<HTMLInputElement>('input', { type: 'checkbox', checked: on, className: 'switch', title: `${title} on/off` })
    const body = el('div', { className: `cbody ${on ? '' : 'off'}` }, ...(graph ? [graph] : []), el('div', { className: 'knobs' }, ...knobs))
    toggle.onchange = () => { setOn(toggle.checked); body.classList.toggle('off', !toggle.checked); onToggle?.(); commit() }
    return el('div', { className: 'mcard' }, el('label', { className: 'chead' }, el('span', { textContent: title }), toggle), body)
  }

  /** A knob that edits one value and redraws the graph it belongs to. */
  function k(label: string, value: number, range: Range, step: number, unit: string, def: number, set: (v: number) => void, after?: () => void, log = false) {
    return knob({ label, value, range, step, unit, def, log, onChange: (v) => { set(v); after?.(); commit() } })
  }

  function renderDetail(s: Strip): HTMLElement {
    const trim = k('Trim', s.trimDb, RANGES.trimDb, 0.5, ' dB', 0, (v) => { s.trimDb = v })
    const hpf = k('Freq', s.hpf.freq, RANGES.hpfFreq, 1, ' Hz', 80, (v) => { s.hpf.freq = v }, undefined, true)
    const input = el('div', { className: 'mcard' }, el('div', { className: 'chead' }, el('span', { textContent: 'Input' })), el('div', { className: 'knobs' }, trim.el))
    const hpfCard = card('High-pass', s.hpf.on, (v) => { s.hpf.on = v }, null, [hpf.el])

    // EQ: the graph and the knobs show the same numbers, so editing either updates the other.
    const knobsEq: Record<string, ReturnType<typeof knob>> = {}
    const graph = eqGraph(s.eq, () => {
      knobsEq.lowFreq.set(s.eq.lowFreq); knobsEq.lowGain.set(s.eq.lowGainDb)
      knobsEq.midFreq.set(s.eq.midFreq); knobsEq.midGain.set(s.eq.midGainDb); knobsEq.midQ.set(s.eq.midQ)
      knobsEq.highFreq.set(s.eq.highFreq); knobsEq.highGain.set(s.eq.highGainDb)
      commit()
    })
    const e = s.eq
    const re = () => graph.redraw()
    knobsEq.lowGain = k('Low', e.lowGainDb, RANGES.eqGainDb, 0.5, ' dB', 0, (v) => { e.lowGainDb = v }, re)
    knobsEq.lowFreq = k('Freq', e.lowFreq, RANGES.eqFreq, 1, ' Hz', 100, (v) => { e.lowFreq = v }, re, true)
    knobsEq.midGain = k('Mid', e.midGainDb, RANGES.eqGainDb, 0.5, ' dB', 0, (v) => { e.midGainDb = v }, re)
    knobsEq.midFreq = k('Freq', e.midFreq, RANGES.eqFreq, 1, ' Hz', 1000, (v) => { e.midFreq = v }, re, true)
    knobsEq.midQ = k('Q', e.midQ, RANGES.eqQ, 0.1, '', 1, (v) => { e.midQ = v }, re)
    knobsEq.highGain = k('High', e.highGainDb, RANGES.eqGainDb, 0.5, ' dB', 0, (v) => { e.highGainDb = v }, re)
    knobsEq.highFreq = k('Freq', e.highFreq, RANGES.eqFreq, 1, ' Hz', 8000, (v) => { e.highFreq = v }, re, true)
    const eqCard = card('EQ', e.on, (v) => { e.on = v }, graph.el, Object.values(knobsEq).map((x) => x.el), re)

    const gt = s.gate
    const gateG = gateCurve(gt)
    const gr = () => gateG.redraw()
    const gateCard = card('Gate', gt.on, (v) => { gt.on = v }, gateG.el, [
      k('Threshold', gt.thresholdDb, RANGES.gateThresholdDb, 1, ' dB', -50, (v) => { gt.thresholdDb = v }, gr).el,
      k('Range', gt.rangeDb, RANGES.gateRangeDb, 1, ' dB', 40, (v) => { gt.rangeDb = v }, gr).el,
      k('Attack', gt.attackMs, RANGES.gateAttackMs, 0.1, ' ms', 5, (v) => { gt.attackMs = v }).el,
      k('Hold', gt.holdMs, RANGES.gateHoldMs, 1, ' ms', 50, (v) => { gt.holdMs = v }).el,
      k('Release', gt.releaseMs, RANGES.gateReleaseMs, 1, ' ms', 200, (v) => { gt.releaseMs = v }).el,
    ])

    const c = s.comp
    const compG = compCurve(c)
    const cr = () => compG.redraw()
    const compCard = card('Compressor', c.on, (v) => { c.on = v }, compG.el, [
      k('Threshold', c.thresholdDb, RANGES.compThresholdDb, 1, ' dB', -24, (v) => { c.thresholdDb = v }, cr).el,
      k('Ratio', c.ratio, RANGES.compRatio, 0.5, ':1', 3, (v) => { c.ratio = v }, cr).el,
      k('Attack', c.attackMs, RANGES.compAttackMs, 1, ' ms', 10, (v) => { c.attackMs = v }).el,
      k('Release', c.releaseMs, RANGES.compReleaseMs, 5, ' ms', 150, (v) => { c.releaseMs = v }).el,
      k('Knee', c.kneeDb, RANGES.compKneeDb, 1, ' dB', 6, (v) => { c.kneeDb = v }, cr).el,
      k('Make-up', c.makeupDb, RANGES.compMakeupDb, 0.5, ' dB', 0, (v) => { c.makeupDb = v }, cr).el,
    ])

    const lim = s.limiter
    const limCard = card('Limiter', lim.on, (v) => { lim.on = v }, null, [k('Ceiling', lim.ceilingDb, RANGES.limiterCeilingDb, 0.5, ' dB', -1, (v) => { lim.ceilingDb = v }).el])
    return el('div', { className: 'detail' }, el('h3', { textContent: `${s.name} · ${s.source?.label ?? 'default source'}, channel ${s.channel + 1}` }), el('div', { className: 'cards' }, input, hpfCard, eqCard, gateCard, compCard, limCard))
  }

  function renderMaster(): HTMLElement {
    const mk = (): MeterEls => ({ fill: el('div', { className: 'fill' }), peak: el('div', { className: 'peak' }), gr: el('div', { className: 'gr' }) })
    masterMeters = [mk(), mk()]
    const readout = el('div', { className: 'db' })
    const show = () => { readout.textContent = fmtDb(mixer.masterDb) }
    show()
    const fader = el<HTMLInputElement>('input', { type: 'range', className: 'vfader', min: String(FADER_FLOOR - 1), max: String(RANGES.masterDb[1]), step: '0.5', value: String(mixer.masterDb <= FADER_FLOOR ? FADER_FLOOR - 1 : mixer.masterDb) })
    fader.oninput = () => { const v = Number(fader.value); mixer.masterDb = v <= FADER_FLOOR ? -100 : v; show(); commit() }
    fader.ondblclick = () => { mixer.masterDb = 0; fader.value = '0'; show(); commit() }
    const delay = el<HTMLInputElement>('input', { type: 'number', min: String(RANGES.delayMs[0]), max: String(RANGES.delayMs[1]), step: '10', value: String(mixer.delayMs) })
    delay.oninput = () => { mixer.delayMs = Math.min(RANGES.delayMs[1], Math.max(RANGES.delayMs[0], Number(delay.value) || 0)); commit() }
    const delayRow = el('label', { className: 'mdelay', title: 'Delays the whole mix so the sound lines up with the picture (camera and encoding delay the picture)' }, el('span', { textContent: 'Delay' }), delay, el('span', { textContent: 'ms' }))
    const lim = section('Limiter', mixer.masterLimiter.on, (v) => { mixer.masterLimiter.on = v }, slider('Ceiling', mixer.masterLimiter.ceilingDb, RANGES.limiterCeilingDb, 0.5, ' dB', (v) => { mixer.masterLimiter.ceilingDb = v }))
    return el('div', { className: 'strip master' },
      el('div', { className: 'top' }, el('span', { className: 'ch', textContent: 'MASTER' })),
      el('div', { className: 'mf' }, el('div', { className: 'meter' }, masterMeters[0].fill, masterMeters[0].peak), el('div', { className: 'meter' }, masterMeters[1].fill, masterMeters[1].peak), fader),
      readout,
      delayRow,
      lim,
    )
  }

  /** Every input the user can add a channel from: the machine's devices, then the test sources. */
  function sourceChoices(): { value: string; text: string; channels: number | null }[] {
    return [
      { value: VIDEO_SOURCE.deviceId, text: VIDEO_SOURCE.label, channels: 2 },
      ...deps.getDevices().map((d) => ({ value: d.deviceId, text: d.label, channels: null })),
      ...TEST_SOURCES.map((t) => ({ value: t.deviceId, text: t.label, channels: t.channels })),
    ]
  }

  /** How many channels the chosen source offers: known for test sources and open devices, otherwise found by probing. */
  function channelsOf(deviceId: string): number | 'failed' | 'checking' {
    const test = TEST_SOURCES.find((t) => t.deviceId === deviceId)
    if (test) return test.channels
    const open = status.devices?.find((d) => d.id === deviceId && !d.error)
    if (open) return open.channels
    const known = probed.get(deviceId)
    if (known !== undefined) return known
    probed.set(deviceId, 'failed') // placeholder so a redraw does not start a second probe
    void deps.probeChannels(deviceId).then((n) => { probed.set(deviceId, n > 0 ? n : 'failed'); render() }).catch(() => { probed.set(deviceId, 'failed'); render() })
    return 'checking'
  }

  function render(): void {
    meters.clear()
    const choices = sourceChoices()
    if (!choices.some((c) => c.value === addSource)) addSource = choices[0]?.value ?? ''
    const sourceSel = el<HTMLSelectElement>('select', { title: 'Which input to take a channel from' })
    sourceSel.append(...choices.map((c) => el<HTMLOptionElement>('option', { value: c.value, textContent: c.text, selected: c.value === addSource })))
    sourceSel.onchange = () => { addSource = sourceSel.value; addChannel = 0; render() }

    const available = addSource ? channelsOf(addSource) : 0
    const isVideo = addSource === VIDEO_SOURCE.deviceId
    const channelSel = el<HTMLSelectElement>('select', { title: 'Which channel of that input', disabled: typeof available !== 'number' || isVideo })
    if (isVideo) {
      channelSel.append(el<HTMLOptionElement>('option', { textContent: 'Left + right (stereo pair)' }))
    } else if (typeof available === 'number') {
      for (let ch = 0; ch < Math.min(available, MAX_CHANNELS); ch++) {
        const taken = mixer.strips.some((x) => stripKey(x) === stripKey({ channel: ch, source: pickedSource() }))
        channelSel.append(el<HTMLOptionElement>('option', { value: String(ch), textContent: `Channel ${ch + 1}${taken ? ' (in the mix)' : ''}`, selected: ch === addChannel }))
      }
    } else {
      channelSel.append(el<HTMLOptionElement>('option', { textContent: available === 'checking' ? 'Checking the device…' : 'Cannot open this input' }))
    }
    channelSel.onchange = () => { addChannel = Number(channelSel.value) }

    function pickedSource(): StripSource | undefined {
      const c = choices.find((x) => x.value === addSource)
      return c ? { deviceId: c.value, label: c.text } : undefined
    }
    const add = iconButton('plus', 'Add this channel to the mix', async () => {
      if (isVideo) {
        // The video's sound is a stereo pair: add whichever of left and right is missing.
        const missing = videoStrips().filter((v) => !mixer.strips.some((x) => stripKey(x) === stripKey(v)))
        selected = stripKey(missing[0] ?? videoStrips()[0])
        if (missing.length) { mixer.strips.push(...missing); commit() }
        render()
        if (missing.length && status.state !== 'running') await deps.startAudio()
        return
      }
      const source = pickedSource()
      if (!source || typeof available !== 'number') return
      const strip = defaultStrip(addChannel, undefined, source)
      if (mixer.strips.some((x) => stripKey(x) === stripKey(strip))) { selected = stripKey(strip); return render() } // already in the mix: just select it
      mixer.strips.push(strip)
      selected = stripKey(strip)
      commit()
      render()
      if (status.state !== 'running') await deps.startAudio() // a first channel starts the mixer, so it can be heard at once
    }, { label: 'Add channel', disabled: typeof available !== 'number' })
    const reset = iconButton('x', 'Remove every channel and start again with the default', () => { mixer = defaultMixer(); selected = stripKey(mixer.strips[0]); commit(); render() }, { label: 'Reset' })

    // The mixer runs by itself and follows every change at once. Only when it could not start does it offer to try again.
    const failed = status.state === 'error'
    const dev = status.state === 'running' ? status.message : failed ? `Audio error: ${status.message}` : 'Starting…'
    const retry = failed ? el('button', { className: 'primary', textContent: 'Try again', title: 'Open the inputs again', onclick: () => void deps.startAudio() }) : null
    const bar = el('div', { className: 'mxbar' }, el('h2', { textContent: 'Stream mix' }), ...(retry ? [retry] : []), el('span', { className: `mxstatus ${status.state}`, textContent: dev }))
    const addRow = el('div', { className: 'mxadd' }, el('span', { className: 'dlabel', textContent: 'Add a channel from' }), sourceSel, channelSel, add, el('span', { className: 'grow' }), reset)

    const hasVideo = mixer.strips.some((x) => x.source?.deviceId === VIDEO_SOURCE.deviceId)
    const note = hasVideo ? el('div', { className: 'dim mxnote', textContent: 'Video L and R are the sound of the video playing in the service; they reach the stream through the master. If your room mixer also receives the video\'s sound and sends it back to this computer, mute them here to avoid hearing it twice.' }) : el('span')
    const strips = el('div', { className: 'strips' }, ...mixer.strips.map(renderStrip), renderMaster())
    const sel = selected !== null ? stripOf(selected) : undefined
    root.replaceChildren(bar, addRow, note, strips, sel ? renderDetail(sel) : el('div', { className: 'row', textContent: mixer.strips.length ? 'Select a strip to edit its EQ, gate, compressor and limiter.' : 'No channels in the mix. Add one above.' }))
  }

  function update(m: Meters): void {
    mixer.strips.forEach((s, i) => {
      const els = meters.get(stripKey(s))
      const r = m.strips[i]
      if (!els || !r) return
      els.fill.style.height = `${meterPct(r.rmsDb)}%`
      els.fill.className = `fill ${levelClass(r.peakDb)}`
      els.peak.style.bottom = `${meterPct(r.peakDb)}%`
      els.gr.style.height = `${Math.min(100, (-r.reductionDb / 30) * 100)}%` // gain reduction, up to 30 dB, drawn from the top
    })
    m.masterPeakDb.forEach((db, i) => {
      const e = masterMeters[i]
      if (!e) return
      e.fill.style.height = `${meterPct(db)}%`
      e.fill.className = `fill ${levelClass(db)}`
      e.peak.style.bottom = `${meterPct(db)}%`
    })
  }

  void api.audioMixerGet().then((m) => { mixer = m; selected = m.strips[0] ? stripKey(m.strips[0]) : null; render() })
  api.onMeters(update)
  root.innerHTML = iconSvg('sliders', 1) // placeholder until first render

  return {
    show: render,
    setStatus(s: AudioStatus): void {
      status = s
      if (root.classList.contains('active')) render()
    },
  }
}

import type { PrestreamerApi } from '../preload'
import { MAX_CHANNELS, RANGES, defaultMixer, defaultStrip, type MixerConfig, type Strip } from '../shared/mixer'
import type { AudioStatus, Meters } from '../shared/types'
import { iconButton, iconSvg } from './icons'

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
export function createMixerView(root: HTMLElement, api: PrestreamerApi) {
  let mixer: MixerConfig = defaultMixer()
  let selected: number | null = null
  let status: AudioStatus = { state: 'idle', message: 'Silence', channelCount: 0 }
  const meters = new Map<number, MeterEls>()
  let masterMeters: MeterEls[] = []
  let commitTimer: ReturnType<typeof setTimeout> | null = null

  function commit(): void {
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = setTimeout(() => void api.audioMixerSet(mixer), 40)
  }

  const stripOf = (channel: number): Strip | undefined => mixer.strips.find((s) => s.channel === channel)

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
    meters.set(s.channel, { fill, peak, gr })

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
    name.onchange = () => { s.name = name.value.trim() || `USB ${s.channel + 1}`; commit() }
    name.onclick = (e) => e.stopPropagation()

    const pan = el<HTMLInputElement>('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: String(s.pan), title: 'Pan (double-click to centre)' })
    pan.oninput = () => { s.pan = Number(pan.value); commit() }
    pan.ondblclick = () => { s.pan = 0; pan.value = '0'; commit() }

    const remove = iconButton('x', 'Remove this channel from the mix', (e) => {
      e.stopPropagation()
      mixer.strips = mixer.strips.filter((x) => x.channel !== s.channel)
      if (selected === s.channel) selected = mixer.strips[0]?.channel ?? null
      commit()
      render()
    }, { size: 12 })

    const strip = el('div', { className: `strip ${selected === s.channel ? 'sel' : ''}`, onclick: () => { selected = s.channel; render() } },
      el('div', { className: 'top' }, el('span', { className: 'ch', textContent: String(s.channel + 1) }), remove),
      name,
      el('div', { className: 'mf' }, el('div', { className: 'meter' }, fill, peak, gr), fader),
      readout,
      el('div', { className: 'btns2' }, mute, solo),
      pan,
    )
    return strip
  }

  function renderDetail(s: Strip): HTMLElement {
    const inputs = el('div', { className: 'col' },
      el('div', { className: 'shead plain', textContent: 'Input' }),
      slider('Trim', s.trimDb, RANGES.trimDb, 0.5, ' dB', (v) => { s.trimDb = v }),
      section('High-pass', s.hpf.on, (v) => { s.hpf.on = v }, slider('Freq', s.hpf.freq, RANGES.hpfFreq, 1, ' Hz', (v) => { s.hpf.freq = v })),
    )
    const eq = section('EQ', s.eq.on, (v) => { s.eq.on = v },
      slider('Low gain', s.eq.lowGainDb, RANGES.eqGainDb, 0.5, ' dB', (v) => { s.eq.lowGainDb = v }),
      slider('Low freq', s.eq.lowFreq, RANGES.eqFreq, 1, ' Hz', (v) => { s.eq.lowFreq = v }),
      slider('Mid gain', s.eq.midGainDb, RANGES.eqGainDb, 0.5, ' dB', (v) => { s.eq.midGainDb = v }),
      slider('Mid freq', s.eq.midFreq, RANGES.eqFreq, 1, ' Hz', (v) => { s.eq.midFreq = v }),
      slider('Mid Q', s.eq.midQ, RANGES.eqQ, 0.1, '', (v) => { s.eq.midQ = v }),
      slider('High gain', s.eq.highGainDb, RANGES.eqGainDb, 0.5, ' dB', (v) => { s.eq.highGainDb = v }),
      slider('High freq', s.eq.highFreq, RANGES.eqFreq, 1, ' Hz', (v) => { s.eq.highFreq = v }),
    )
    const gate = section('Gate', s.gate.on, (v) => { s.gate.on = v },
      slider('Threshold', s.gate.thresholdDb, RANGES.gateThresholdDb, 1, ' dB', (v) => { s.gate.thresholdDb = v }),
      slider('Range', s.gate.rangeDb, RANGES.gateRangeDb, 1, ' dB', (v) => { s.gate.rangeDb = v }),
      slider('Attack', s.gate.attackMs, RANGES.gateAttackMs, 0.1, ' ms', (v) => { s.gate.attackMs = v }),
      slider('Hold', s.gate.holdMs, RANGES.gateHoldMs, 1, ' ms', (v) => { s.gate.holdMs = v }),
      slider('Release', s.gate.releaseMs, RANGES.gateReleaseMs, 1, ' ms', (v) => { s.gate.releaseMs = v }),
    )
    const comp = section('Compressor', s.comp.on, (v) => { s.comp.on = v },
      slider('Threshold', s.comp.thresholdDb, RANGES.compThresholdDb, 1, ' dB', (v) => { s.comp.thresholdDb = v }),
      slider('Ratio', s.comp.ratio, RANGES.compRatio, 0.5, ':1', (v) => { s.comp.ratio = v }),
      slider('Attack', s.comp.attackMs, RANGES.compAttackMs, 1, ' ms', (v) => { s.comp.attackMs = v }),
      slider('Release', s.comp.releaseMs, RANGES.compReleaseMs, 5, ' ms', (v) => { s.comp.releaseMs = v }),
      slider('Knee', s.comp.kneeDb, RANGES.compKneeDb, 1, ' dB', (v) => { s.comp.kneeDb = v }),
      slider('Make-up', s.comp.makeupDb, RANGES.compMakeupDb, 0.5, ' dB', (v) => { s.comp.makeupDb = v }),
    )
    const limiter = section('Limiter', s.limiter.on, (v) => { s.limiter.on = v }, slider('Ceiling', s.limiter.ceilingDb, RANGES.limiterCeilingDb, 0.5, ' dB', (v) => { s.limiter.ceilingDb = v }))
    return el('div', { className: 'detail' }, el('h3', { textContent: s.name === `USB ${s.channel + 1}` ? s.name : `${s.name} · USB ${s.channel + 1}` }), el('div', { className: 'sections' }, inputs, eq, gate, comp, limiter))
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
    const lim = section('Limiter', mixer.masterLimiter.on, (v) => { mixer.masterLimiter.on = v }, slider('Ceiling', mixer.masterLimiter.ceilingDb, RANGES.limiterCeilingDb, 0.5, ' dB', (v) => { mixer.masterLimiter.ceilingDb = v }))
    return el('div', { className: 'strip master' },
      el('div', { className: 'top' }, el('span', { className: 'ch', textContent: 'MASTER' })),
      el('div', { className: 'mf' }, el('div', { className: 'meter' }, masterMeters[0].fill, masterMeters[0].peak), el('div', { className: 'meter' }, masterMeters[1].fill, masterMeters[1].peak), fader),
      readout,
      lim,
    )
  }

  function render(): void {
    meters.clear()
    const used = new Set(mixer.strips.map((s) => s.channel))
    const choices = el<HTMLSelectElement>('select')
    const limit = Math.max(MAX_CHANNELS, status.channelCount)
    for (let ch = 0; ch < Math.min(limit, MAX_CHANNELS); ch++) if (!used.has(ch)) choices.append(el<HTMLOptionElement>('option', { value: String(ch), textContent: `USB ${ch + 1}` }))
    const add = iconButton('plus', 'Add this channel to the mix', () => {
      if (!choices.value) return
      const strip = defaultStrip(Number(choices.value))
      mixer.strips.push(strip)
      mixer.strips.sort((a, b) => a.channel - b.channel)
      selected = strip.channel
      commit()
      render()
    }, { label: 'Add channel' })
    const reset = iconButton('undo', 'Reset the console to a stereo pair on USB 1-2', () => { mixer = defaultMixer(); selected = 0; commit(); render() }, { label: 'Reset' })

    const dev = status.state === 'running' ? `${status.message}` : status.state === 'error' ? `Audio error: ${status.message}` : 'No audio source running. Choose one in the Audio panel (Present tab) and press Apply.'
    const bar = el('div', { className: 'mxbar' }, el('h2', { textContent: 'Stream mix' }), el('span', { className: `mxstatus ${status.state}`, textContent: dev }), el('span', { className: 'grow' }), choices, add, reset)

    const strips = el('div', { className: 'strips' }, ...mixer.strips.map(renderStrip), renderMaster())
    const sel = selected !== null ? stripOf(selected) : undefined
    root.replaceChildren(bar, strips, sel ? renderDetail(sel) : el('div', { className: 'row', textContent: mixer.strips.length ? 'Select a strip to edit its EQ, gate, compressor and limiter.' : 'No channels in the mix. Add one above.' }))
  }

  function update(m: Meters): void {
    mixer.strips.forEach((s, i) => {
      const els = meters.get(s.channel)
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

  void api.audioMixerGet().then((m) => { mixer = m; selected = m.strips[0]?.channel ?? null; render() })
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

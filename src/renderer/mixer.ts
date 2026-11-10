import type { PrestreamerApi } from '../preload'
import { EFFECT_TYPES, MASTER_PRESETS, MAX_CHANNELS, MAX_EFFECTS, RANGES, STRIP_PRESETS, TEST_SOURCES, VIDEO_SOURCE, videoStrips, defaultEffect, defaultMixer, defaultStrip, shortDeviceName, stripKey, type ChainPreset, type Effect, type EffectType, type MixerConfig, type Strip, type StripSource } from '../shared/mixer'
import type { AudioStatus, FxLive, Look, Meters, ScreenConfig } from '../shared/types'
import { moveBefore } from '../shared/curves'
import { nativeKey, type NativeInput } from '../shared/native-audio'
import { History } from '../shared/history'
import { t, type MessageKey } from '../shared/i18n'
import { confirmDialog, showModal } from './dialogs'
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
/** The audience level can only be turned down: from -60 dB to full level. */
const RANGES_AUDIENCE = [-60, 0] as const
/** Selecting the master shows its chain, like selecting a strip shows the strip's. */
const MASTER_KEY = '__master__'
/** Short names for the chain overview on a strip. */
const shortName = (type: EffectType): string => t(`mixer.short.${type}` as MessageKey)
/** An effect's name and what it is for, in the language of the interface (shared/mixer.ts keeps the English text). */
const effectLabel = (type: EffectType): string => t(`mixer.effect.${type}.label` as MessageKey)
const effectBlurb = (type: EffectType): string => t(`mixer.effect.${type}.blurb` as MessageKey)
const presetLabel = (p: ChainPreset): string => t(`mixer.preset.${p.id}.label` as MessageKey)
const presetBlurb = (p: ChainPreset): string => t(`mixer.preset.${p.id}.blurb` as MessageKey)

interface MeterEls { fill: HTMLElement; peak: HTMLElement; gr: HTMLElement }

/**
 * The mixing console tab: one strip per USB channel feeding the stereo stream mix.
 * Changes are applied live (debounced) in the audio window and saved by the main process.
 */
export interface MixerDeps {
  /** Every audio input on the machine (kept current by the operator). */
  getDevices(): { deviceId: string; label: string }[]
  /** Interfaces with more channels than the browser can open, read natively (see shared/native-audio.ts). */
  getNativeInputs(): NativeInput[]
  /** How many channels a device offers, found by opening it briefly. */
  probeChannels(deviceId: string): Promise<number>
  /** Every audio output on the machine (for the monitor and the audience). */
  getOutputs(): { deviceId: string; label: string }[]
  /** The screens, in order: the sound of the videos for the room plays from one of them. */
  getScreens(): ScreenConfig[]
  /** (Re)starts the mixer's audio engine. It starts by itself; this is for trying again after an error. */
  startAudio(): Promise<void>
}

export function createMixerView(root: HTMLElement, api: PrestreamerApi, deps: MixerDeps) {
  let mixer: MixerConfig = defaultMixer()
  let selected: string | null = null // a strip's key (device and channel), or MASTER_KEY
  let addSource = ''
  let addChannel = 0
  const probed = new Map<string, number | 'failed'>()
  let status: AudioStatus = { state: 'idle', message: t('mixer.status.silence'), channelCount: 0 }
  const meters = new Map<string, MeterEls>()
  /** Gain-reduction bars of the effect cards that are on screen, by effect id (filled from the meter updates). */
  const grBars = new Map<string, HTMLElement>()
  /** Graphs that show the sound going through their effect, by effect id; they are fed by every meter update. */
  const liveGraphs = new Map<string, (live: FxLive | undefined, reductionDb: number) => void>()
  let masterMeters: MeterEls[] = []
  let commitTimer: ReturnType<typeof setTimeout> | null = null

  // Undo and redo. A change (a whole knob drag, an effect added or moved) counts as finished when nothing more changes for
  // half a second; the mixer as it was before it is then kept, so Cmd/Ctrl+Z can bring it back.
  const history = new History(JSON.stringify(mixer))
  let settleTimer: ReturnType<typeof setTimeout> | null = null
  let undoBtn: HTMLButtonElement | null = null
  let redoBtn: HTMLButtonElement | null = null
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'
  function syncHistoryButtons(): void {
    if (undoBtn) { undoBtn.disabled = !history.canUndo; undoBtn.title = history.canUndo ? t('mixer.undo.available', { mod, n: history.undoSteps }) : t('mixer.undo.none') }
    if (redoBtn) { redoBtn.disabled = !history.canRedo; redoBtn.title = history.canRedo ? t('mixer.redo.available', { mod }) : t('mixer.redo.none') }
    undoBtn?.setAttribute('aria-label', undoBtn.title)
    redoBtn?.setAttribute('aria-label', redoBtn?.title ?? '')
  }
  function settle(): void {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
    history.record(JSON.stringify(mixer))
    syncHistoryButtons()
  }

  function commit(): void {
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = setTimeout(() => void api.audioMixerSet(mixer), 40)
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(settle, 500)
  }

  /** Goes back (or forward) to the mixer as it was, and applies it at once. */
  function travel(direction: 'undo' | 'redo'): void {
    settle() // a change made a moment ago is part of the history too
    const snapshot = direction === 'undo' ? history.undo() : history.redo()
    if (snapshot === null) return syncHistoryButtons()
    mixer = JSON.parse(snapshot) as MixerConfig
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = null
    void api.audioMixerSet(mixer)
    if (selected !== MASTER_KEY && !(selected !== null && stripOf(selected))) selected = mixer.strips[0] ? stripKey(mixer.strips[0]) : null
    render()
  }

  // Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Ctrl+Y) on the Mixer tab. Typing in a text box keeps its own undo.
  document.addEventListener('keydown', (e) => {
    if (!root.classList.contains('active') || !(e.metaKey || e.ctrlKey) || e.altKey || !document.getElementById('modal')!.hidden) return
    if ((e.target as HTMLElement | null)?.matches?.('textarea, input[type=text], input[type=number]')) return
    const key = e.key.toLowerCase()
    if (key === 'z' && !e.shiftKey) travel('undo')
    else if ((key === 'z' && e.shiftKey) || (key === 'y' && !e.metaKey)) travel('redo')
    else return
    e.preventDefault()
  })

  const stripOf = (key: string): Strip | undefined => mixer.strips.find((s) => stripKey(s) === key)

  function renderStrip(s: Strip): HTMLElement {
    const fill = el('div', { className: 'fill' })
    const peak = el('div', { className: 'peak' })
    const gr = el('div', { className: 'gr' })
    meters.set(stripKey(s), { fill, peak, gr })

    const readout = el('div', { className: 'db' })
    const fader = el<HTMLInputElement>('input', { type: 'range', className: 'vfader', min: String(FADER_FLOOR - 1), max: String(RANGES.faderDb[1]), step: '0.5', value: String(s.faderDb <= FADER_FLOOR ? FADER_FLOOR - 1 : s.faderDb) })
    const showFader = () => { readout.textContent = fmtDb(s.faderDb) }
    showFader()
    fader.oninput = () => { const v = Number(fader.value); s.faderDb = v <= FADER_FLOOR ? -100 : v; showFader(); refreshOut(); commit() }
    fader.ondblclick = () => { s.faderDb = 0; fader.value = '0'; showFader(); refreshOut(); commit() } // double-click = unity

    const mute = el('button', { className: `ms ${s.mute ? 'on mute' : ''}`, textContent: 'M', title: t('mixer.strip.mute') })
    mute.onclick = () => { s.mute = !s.mute; mute.classList.toggle('on', s.mute); mute.classList.toggle('mute', s.mute); commit() }
    const solo = el('button', { className: `ms ${s.solo ? 'on solo' : ''}`, textContent: 'S', title: t('mixer.strip.solo') })
    solo.onclick = () => { s.solo = !s.solo; solo.classList.toggle('on', s.solo); solo.classList.toggle('solo', s.solo); commit() }

    const name = el<HTMLInputElement>('input', { type: 'text', value: s.name, maxLength: 24, title: t('mixer.strip.rename') })
    name.onchange = () => { s.name = name.value.trim() || defaultStrip(s.channel, undefined, s.source).name; commit() }
    name.onclick = (e) => e.stopPropagation()

    const pan = el<HTMLInputElement>('input', { type: 'range', min: '-1', max: '1', step: '0.05', value: String(s.pan), title: t('mixer.strip.pan') })
    pan.oninput = () => { s.pan = Number(pan.value); commit() }
    pan.ondblclick = () => { s.pan = 0; pan.value = '0'; commit() }

    const remove = iconButton('x', t('mixer.strip.remove'), (e) => {
      e.stopPropagation()
      mixer.strips = mixer.strips.filter((x) => stripKey(x) !== stripKey(s))
      if (selected === stripKey(s)) selected = mixer.strips[0] ? stripKey(mixer.strips[0]) : null
      commit()
      render()
    }, { size: 12 })

    // Strips are reordered by dragging the grip (or with the arrow keys while it has focus): only the grip starts a drag,
    // so the faders and sliders in the strip keep working.
    const key = stripKey(s)
    const grip = el('button', { className: 'grip', title: t('mixer.strip.grip'), textContent: '⠿' })
    grip.setAttribute('aria-label', t('mixer.strip.gripAria', { name: s.name }))
    grip.onclick = (e) => e.stopPropagation()
    grip.onkeydown = (e) => {
      const i = mixer.strips.findIndex((x) => stripKey(x) === key)
      const target = mixer.strips[i + (e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0)]
      if (!target || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return
      e.preventDefault()
      reorder(key, stripKey(target), e.key === 'ArrowRight')
      document.querySelector<HTMLElement>(`.strip[data-key="${CSS.escape(key)}"] .grip`)?.focus()
    }
    const deviceName = s.source ? shortDeviceName(s.source.label) : t('mixer.strip.defaultSource')
    const strip = el('div', { className: `strip ${selected === stripKey(s) ? 'sel' : ''}`, onclick: () => { selected = stripKey(s); render() } },
      el('div', { className: 'top' }, grip, el('span', { className: 'ch', textContent: String(s.channel + 1), title: t('mixer.strip.channel', { n: s.channel + 1 }) }), remove),
      el('div', { className: 'dev', textContent: deviceName, title: s.source?.label ?? t('mixer.strip.defaultSourceTitle') }),
      name,
      el('div', { className: 'mf' }, el('div', { className: 'meter' }, fill, peak, gr), fader, chainChips(s.chain)),
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

  /** A strip's chain at a glance: the names of its effects in order, dimmed while an effect is switched off. */
  function chainChips(chain: Effect[]): HTMLElement {
    return el('div', { className: 'chips', title: chain.length ? chain.map((e) => `${effectLabel(e.type)}${e.on ? '' : t('mixer.chain.off')}`).join(' → ') : t('mixer.chain.empty') },
      ...(chain.length ? chain.map((e) => el('span', { className: `chip ${e.on ? '' : 'off'}`, textContent: shortName(e.type) })) : [el('span', { className: 'chip none', textContent: t('mixer.chain.noFx') })]))
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

  /** A knob that edits one value and redraws the graph it belongs to. */
  function k(label: string, value: number, range: Range, step: number, unit: string, def: number, set: (v: number) => void, after?: () => void, log = false) {
    return knob({ label, value, range, step, unit, def, log, onChange: (v) => { set(v); after?.(); commit() } })
  }
  /** A knob for a 0-1 setting shown as a percentage. */
  const kPct = (label: string, value: number, range: Range, def: number, set: (v: number) => void) =>
    k(label, Math.round(value * 100), [range[0] * 100, range[1] * 100], 1, ' %', Math.round(def * 100), (v) => set(v / 100))

  /** The graph (if the effect has one) and the knobs of one effect. Everything edits the effect in place. */
  function effectBody(e: Effect): { graph: HTMLElement | null; knobs: HTMLElement[] } {
    switch (e.type) {
      case 'hpf':
        return { graph: null, knobs: [k(t('mixer.knob.freq'), e.freq, RANGES.hpfFreq, 1, ' Hz', 80, (v) => { e.freq = v }, undefined, true).el] }
      case 'eq': {
        // The graph and the knobs show the same numbers, so editing either updates the other.
        const knobsEq: Record<string, ReturnType<typeof knob>> = {}
        const graph = eqGraph(e, () => {
          knobsEq.lowFreq.set(e.lowFreq); knobsEq.lowGain.set(e.lowGainDb)
          knobsEq.midFreq.set(e.midFreq); knobsEq.midGain.set(e.midGainDb); knobsEq.midQ.set(e.midQ)
          knobsEq.highFreq.set(e.highFreq); knobsEq.highGain.set(e.highGainDb)
          commit()
        })
        liveGraphs.set(e.id, (l) => graph.setLive(l?.post ? { pre: l.pre, post: l.post } : null))
        const re = () => graph.redraw()
        knobsEq.lowGain = k(t('mixer.knob.low'), e.lowGainDb, RANGES.eqGainDb, 0.5, ' dB', 0, (v) => { e.lowGainDb = v }, re)
        knobsEq.lowFreq = k(t('mixer.knob.freq'), e.lowFreq, RANGES.eqFreq, 1, ' Hz', 100, (v) => { e.lowFreq = v }, re, true)
        knobsEq.midGain = k(t('mixer.knob.mid'), e.midGainDb, RANGES.eqGainDb, 0.5, ' dB', 0, (v) => { e.midGainDb = v }, re)
        knobsEq.midFreq = k(t('mixer.knob.freq'), e.midFreq, RANGES.eqFreq, 1, ' Hz', 1000, (v) => { e.midFreq = v }, re, true)
        knobsEq.midQ = k(t('mixer.knob.q'), e.midQ, RANGES.eqQ, 0.1, '', 1, (v) => { e.midQ = v }, re)
        knobsEq.highGain = k(t('mixer.knob.high'), e.highGainDb, RANGES.eqGainDb, 0.5, ' dB', 0, (v) => { e.highGainDb = v }, re)
        knobsEq.highFreq = k(t('mixer.knob.freq'), e.highFreq, RANGES.eqFreq, 1, ' Hz', 8000, (v) => { e.highFreq = v }, re, true)
        return { graph: graph.el, knobs: Object.values(knobsEq).map((x) => x.el) }
      }
      case 'gate': {
        const g = gateCurve(e)
        liveGraphs.set(e.id, (l, gr) => g.setLive(l?.inDb ?? null, gr))
        const gr = () => g.redraw()
        return { graph: g.el, knobs: [
          k(t('mixer.knob.threshold'), e.thresholdDb, RANGES.gateThresholdDb, 1, ' dB', -50, (v) => { e.thresholdDb = v }, gr).el,
          k(t('mixer.knob.range'), e.rangeDb, RANGES.gateRangeDb, 1, ' dB', 40, (v) => { e.rangeDb = v }, gr).el,
          k(t('mixer.knob.attack'), e.attackMs, RANGES.gateAttackMs, 0.1, ' ms', 5, (v) => { e.attackMs = v }).el,
          k(t('mixer.knob.hold'), e.holdMs, RANGES.gateHoldMs, 1, ' ms', 50, (v) => { e.holdMs = v }).el,
          k(t('mixer.knob.release'), e.releaseMs, RANGES.gateReleaseMs, 1, ' ms', 200, (v) => { e.releaseMs = v }).el,
        ] }
      }
      case 'comp': {
        const g = compCurve(e)
        liveGraphs.set(e.id, (l, gr) => g.setLive(l?.inDb ?? null, gr))
        const cr = () => g.redraw()
        return { graph: g.el, knobs: [
          k(t('mixer.knob.threshold'), e.thresholdDb, RANGES.compThresholdDb, 1, ' dB', -24, (v) => { e.thresholdDb = v }, cr).el,
          k(t('mixer.knob.ratio'), e.ratio, RANGES.compRatio, 0.5, ':1', 3, (v) => { e.ratio = v }, cr).el,
          k(t('mixer.knob.attack'), e.attackMs, RANGES.compAttackMs, 1, ' ms', 10, (v) => { e.attackMs = v }).el,
          k(t('mixer.knob.release'), e.releaseMs, RANGES.compReleaseMs, 5, ' ms', 150, (v) => { e.releaseMs = v }).el,
          k(t('mixer.knob.knee'), e.kneeDb, RANGES.compKneeDb, 1, ' dB', 6, (v) => { e.kneeDb = v }, cr).el,
          k(t('mixer.knob.makeup'), e.makeupDb, RANGES.compMakeupDb, 0.5, ' dB', 0, (v) => { e.makeupDb = v }, cr).el,
        ] }
      }
      case 'limiter':
        return { graph: null, knobs: [k(t('mixer.knob.ceiling'), e.ceilingDb, RANGES.limiterCeilingDb, 0.5, ' dB', -1, (v) => { e.ceilingDb = v }).el] }
      case 'deesser':
        return { graph: null, knobs: [
          k(t('mixer.knob.freq'), e.freq, RANGES.deesserFreq, 10, ' Hz', 6500, (v) => { e.freq = v }, undefined, true).el,
          k(t('mixer.knob.threshold'), e.thresholdDb, RANGES.deesserThresholdDb, 1, ' dB', -30, (v) => { e.thresholdDb = v }).el,
          k(t('mixer.knob.amount'), e.reductionDb, RANGES.deesserReductionDb, 0.5, ' dB', 8, (v) => { e.reductionDb = v }).el,
        ] }
      case 'reverb':
        return { graph: null, knobs: [
          k(t('mixer.knob.decay'), e.decaySec, RANGES.reverbDecaySec, 0.1, ' s', 1.4, (v) => { e.decaySec = v }).el,
          k(t('mixer.knob.damping'), e.dampingHz, RANGES.reverbDampingHz, 100, ' Hz', 6000, (v) => { e.dampingHz = v }, undefined, true).el,
          k(t('mixer.knob.preDelay'), e.preDelayMs, RANGES.reverbPreDelayMs, 1, ' ms', 20, (v) => { e.preDelayMs = v }).el,
          kPct(t('mixer.knob.mix'), e.mix, RANGES.reverbMix, 0.15, (v) => { e.mix = v }).el,
        ] }
      case 'syncdelay':
        return { graph: null, knobs: [k(t('mixer.knob.time'), e.timeMs, RANGES.syncDelayMs, 1, ' ms', 0, (v) => { e.timeMs = v }).el] }
      case 'delay':
        return { graph: null, knobs: [
          k(t('mixer.knob.time'), e.timeMs, RANGES.delayTimeMs, 1, ' ms', 350, (v) => { e.timeMs = v }).el,
          kPct(t('mixer.knob.feedback'), e.feedback, RANGES.delayFeedback, 0.3, (v) => { e.feedback = v }).el,
          k(t('mixer.knob.tone'), e.toneHz, RANGES.delayToneHz, 100, ' Hz', 3500, (v) => { e.toneHz = v }, undefined, true).el,
          kPct(t('mixer.knob.mix'), e.mix, RANGES.delayMix, 0.15, (v) => { e.mix = v }).el,
        ] }
    }
  }

  /** What the open detail edits: one strip's chain, or the master's. */
  interface Target { name: string; chain: Effect[]; setChain(chain: Effect[]): void; presets: ChainPreset[]; input: HTMLElement; output: HTMLElement }

  /** An effect in the chain: grip to move it, name, how much it is taking off right now, a switch, a remove button, and its controls. */
  function effectCard(tg: Target, e: Effect): HTMLElement {
    const { graph, knobs } = effectBody(e)
    const toggle = el<HTMLInputElement>('input', { type: 'checkbox', checked: e.on, className: 'switch', title: t('mixer.fx.toggle', { label: effectLabel(e.type) }) })
    const body = el('div', { className: `cbody ${e.on ? '' : 'off'}` }, ...(graph ? [graph] : []), el('div', { className: 'knobs' }, ...knobs))
    toggle.onchange = () => { e.on = toggle.checked; body.classList.toggle('off', !e.on); card.classList.toggle('bypassed', !e.on); commit(); renderChips() }
    const grip = el('button', { className: 'grip', title: t('mixer.fx.grip'), textContent: '⠿' })
    grip.setAttribute('aria-label', t('mixer.fx.gripAria', { label: effectLabel(e.type) }))
    grip.onclick = (ev) => ev.stopPropagation()
    grip.onkeydown = (ev) => {
      const i = tg.chain.findIndex((x) => x.id === e.id)
      const other = tg.chain[i + (ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0)]
      if (!other || (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft')) return
      ev.preventDefault()
      reorderEffect(tg, e.id, other.id, ev.key === 'ArrowRight')
      document.querySelector<HTMLElement>(`.fxcard[data-id="${CSS.escape(e.id)}"] .grip`)?.focus()
    }
    const remove = iconButton('x', t('mixer.fx.remove', { label: effectLabel(e.type) }), () => { tg.setChain(tg.chain.filter((x) => x.id !== e.id)); commit(); render() }, { size: 12 })
    const reduces = e.type === 'gate' || e.type === 'comp' || e.type === 'limiter' || e.type === 'deesser'
    const fill = el('div', { className: 'grfill' })
    if (reduces) grBars.set(e.id, fill)
    const head = el('div', { className: 'chead', title: effectBlurb(e.type) }, grip, el('span', { className: 'ctitle', textContent: effectLabel(e.type) }),
      ...(reduces ? [el('div', { className: 'grbar', title: t('mixer.fx.reduction') }, fill)] : [el('span', { className: 'grow' })]), toggle, remove)
    const card: HTMLElement = el('div', { className: `fxcard ${e.on ? '' : 'bypassed'}` }, head, body)
    card.dataset.id = e.id
    grip.onpointerdown = () => { card.draggable = true }
    grip.onpointerup = () => { card.draggable = false }
    card.ondragstart = (ev) => {
      if (!card.draggable) return ev.preventDefault()
      ev.dataTransfer?.setData('text/plain', e.id)
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
      fxDragging = e.id
      card.classList.add('dragging')
    }
    card.ondragend = () => { card.draggable = false; fxDragging = null; card.classList.remove('dragging'); clearFxMarks() }
    card.ondragover = (ev) => {
      if (!fxDragging || fxDragging === e.id) return
      ev.preventDefault()
      const r = card.getBoundingClientRect()
      clearFxMarks()
      card.classList.add(ev.clientX > r.left + r.width / 2 ? 'dropafter' : 'dropbefore')
    }
    card.ondragleave = (ev) => { if (!card.contains(ev.relatedTarget as Node | null)) card.classList.remove('dropbefore', 'dropafter') }
    card.ondrop = (ev) => {
      ev.preventDefault()
      const from = fxDragging
      const after = card.classList.contains('dropafter')
      fxDragging = null
      clearFxMarks()
      if (from) reorderEffect(tg, from, e.id, after)
    }
    return card
  }

  let fxDragging: string | null = null
  const clearFxMarks = () => document.querySelectorAll('.fxcard.dropbefore, .fxcard.dropafter').forEach((n) => n.classList.remove('dropbefore', 'dropafter'))
  function reorderEffect(tg: Target, from: string, to: string, after: boolean): void {
    const next = moveBefore(tg.chain, (x) => x.id, from, to, after)
    if (next === tg.chain) return
    tg.setChain(next)
    commit()
    render()
  }

  /** The chain overview on the strips follows switches in the open detail without redrawing everything. */
  function renderChips(): void {
    document.querySelectorAll<HTMLElement>('.strip').forEach((node) => {
      const chips = node.querySelector('.chips')
      const strip = node.classList.contains('master') ? null : stripOf(node.dataset.key ?? '')
      const chain = strip ? strip.chain : mixer.masterChain
      if (chips) chips.replaceWith(chainChips(chain))
    })
  }

  /** Lists every kind of effect with what it is for; choosing one adds it at the end of the chain. */
  function addEffectDialog(tg: Target): void {
    showModal((close) => el('div', { className: 'dialog pad fxmenu', role: 'dialog' },
      el('h3', { className: 'dhead', textContent: t('mixer.dialog.addTitle', { name: tg.name }) }),
      el('div', { className: 'fxopts' }, ...EFFECT_TYPES.map((type) =>
        el('button', { className: 'fxopt', onclick: () => { close(); tg.setChain([...tg.chain, defaultEffect(type)]); commit(); render() } },
          el('strong', { textContent: effectLabel(type) }), el('span', { className: 'dim', textContent: effectBlurb(type) })))),
      el('div', { className: 'btns end' }, el('button', { textContent: t('mixer.dialog.cancel'), onclick: () => close() }))))
  }

  /** Replaces the chain with a ready-made one (asking first when there is something to lose). */
  function presetDialog(tg: Target): void {
    showModal((close) => el('div', { className: 'dialog pad fxmenu', role: 'dialog' },
      el('h3', { className: 'dhead', textContent: t('mixer.dialog.presetTitle', { name: tg.name }) }),
      el('div', { className: 'dim', textContent: t('mixer.dialog.presetHint') }),
      el('div', { className: 'fxopts' }, ...tg.presets.map((p) =>
        el('button', { className: 'fxopt', onclick: async () => {
          close()
          if (tg.chain.length && !(await confirmDialog({ title: t('mixer.dialog.replaceTitle', { name: tg.name }), message: t('mixer.dialog.replaceMessage', { n: tg.chain.length, label: presetLabel(p) }), confirm: t('mixer.dialog.replace'), danger: true }))) return
          tg.setChain(p.build()); commit(); render()
        } }, el('strong', { textContent: presetLabel(p) }), el('span', { className: 'dim', textContent: presetBlurb(p) })))),
      el('div', { className: 'btns end' }, el('button', { textContent: t('mixer.dialog.cancel'), onclick: () => close() }))))
  }

  /** Input → effects → output, drawn as a signal chain: the signal flows left to right through the cards. */
  function renderChain(tg: Target): HTMLElement {
    const link = () => { const l = el('div', { className: 'fxlink' }); l.setAttribute('aria-hidden', 'true'); return l }
    const add = el('div', { className: 'fxadd' },
      iconButton('plus', tg.chain.length >= MAX_EFFECTS ? t('mixer.chain.max', { n: MAX_EFFECTS }) : t('mixer.chain.add'), () => addEffectDialog(tg), { label: t('mixer.chain.addLabel'), disabled: tg.chain.length >= MAX_EFFECTS }),
      el('button', { textContent: t('mixer.chain.startFrom'), title: t('mixer.chain.startFromTitle'), onclick: () => presetDialog(tg) }))
    const nodes: Node[] = [tg.input, link()]
    for (const e of tg.chain) nodes.push(effectCard(tg, e), link())
    nodes.push(add, link(), tg.output)
    return el('div', { className: 'fxrow' }, ...nodes)
  }

  function renderDetail(s: Strip): HTMLElement {
    const trim = k(t('mixer.knob.trim'), s.trimDb, RANGES.trimDb, 0.5, ' dB', 0, (v) => { s.trimDb = v })
    const input = el('div', { className: 'fxnode' }, el('div', { className: 'chead' }, el('span', { className: 'ctitle', textContent: t('mixer.detail.input') })), el('div', { className: 'knobs' }, trim.el), el('div', { className: 'dim', textContent: s.source ? shortDeviceName(s.source.label) : t('mixer.detail.defaultSource') }))
    const output = el('div', { className: 'fxnode' }, el('div', { className: 'chead' }, el('span', { className: 'ctitle', textContent: t('mixer.detail.fader') })), el('div', { className: 'fxout', textContent: `${fmtDb(s.faderDb)} dB` }), el('div', { className: 'dim', textContent: t('mixer.detail.faderNext') }))
    detailOut = { el: output.querySelector('.fxout')!, text: () => `${fmtDb(s.faderDb)} dB` }
    const tg: Target = { name: s.name, chain: s.chain, setChain: (c) => { s.chain = c }, presets: STRIP_PRESETS, input, output }
    return el('div', { className: 'detail' }, el('h3', { textContent: t('mixer.detail.stripTitle', { name: s.name, source: s.source?.label ?? t('mixer.detail.defaultSource'), n: s.channel + 1 }) }), renderChain(tg))
  }

  function renderMasterDetail(): HTMLElement {
    const input = el('div', { className: 'fxnode' }, el('div', { className: 'chead' }, el('span', { className: 'ctitle', textContent: t('mixer.detail.mix') })), el('div', { className: 'dim', textContent: t('mixer.detail.mixHint') }))
    const output = el('div', { className: 'fxnode' }, el('div', { className: 'chead' }, el('span', { className: 'ctitle', textContent: t('mixer.detail.master') })), el('div', { className: 'fxout', textContent: `${fmtDb(mixer.masterDb)} dB` }), el('div', { className: 'dim', textContent: t('mixer.detail.masterNext') }))
    detailOut = { el: output.querySelector('.fxout')!, text: () => `${fmtDb(mixer.masterDb)} dB` }
    const tg: Target = { name: t('mixer.target.master'), chain: mixer.masterChain, setChain: (c) => { mixer.masterChain = c }, presets: MASTER_PRESETS, input, output }
    return el('div', { className: 'detail' }, el('h3', { textContent: t('mixer.detail.masterTitle') }), renderChain(tg))
  }
  /** The fader readout at the end of the open chain, kept in step with the fader. */
  let detailOut: { el: HTMLElement; text(): string } | null = null
  const refreshOut = () => { if (detailOut) detailOut.el.textContent = detailOut.text() }

  function renderMaster(): HTMLElement {
    const mk = (): MeterEls => ({ fill: el('div', { className: 'fill' }), peak: el('div', { className: 'peak' }), gr: el('div', { className: 'gr' }) })
    masterMeters = [mk(), mk()]
    const readout = el('div', { className: 'db' })
    const show = () => { readout.textContent = fmtDb(mixer.masterDb) }
    show()
    const fader = el<HTMLInputElement>('input', { type: 'range', className: 'vfader', min: String(FADER_FLOOR - 1), max: String(RANGES.masterDb[1]), step: '0.5', value: String(mixer.masterDb <= FADER_FLOOR ? FADER_FLOOR - 1 : mixer.masterDb) })
    fader.oninput = () => { const v = Number(fader.value); mixer.masterDb = v <= FADER_FLOOR ? -100 : v; show(); refreshOut(); commit() }
    fader.ondblclick = () => { mixer.masterDb = 0; fader.value = '0'; show(); refreshOut(); commit() }
    // The same layout as a channel strip: its top row (move, number, remove) is there but hidden, so everything lines up, then the
    // name, the meters with the fader and the chain overview beside them, and the level. A master has no mute, solo or pan.
    const ghost = ghostTop()
    const name = el<HTMLInputElement>('input', { type: 'text', value: t('mixer.master.name'), readOnly: true, title: t('mixer.master.nameTitle') })
    const master = el('div', { className: `strip master ${selected === MASTER_KEY ? 'sel' : ''}`, title: t('mixer.master.select'), onclick: () => { selected = MASTER_KEY; render() } },
      ghost,
      el('div', { className: 'dev', textContent: t('mixer.master.streamMix') }),
      name,
      el('div', { className: 'mf' }, el('div', { className: 'meter' }, masterMeters[0].fill, masterMeters[0].peak), el('div', { className: 'meter' }, masterMeters[1].fill, masterMeters[1].peak), fader, chainChips(mixer.masterChain)),
      readout,
    )
    return master
  }

  /** A panel of the mixer page: a title, then its strips and the controls that go with them side by side. */
  const panel = (title: string, cls: string, ...parts: HTMLElement[]): HTMLElement =>
    el('div', { className: `mxpanel ${cls}` }, el('div', { className: 'ptitle' }, el('span', { className: 'ch', textContent: title })), el('div', { className: 'pbody' }, ...parts))

  /** A strip that is not a channel: its move/number/remove row is there but hidden, so it lines up with the channels. */
  const ghostTop = (): HTMLElement => el('div', { className: 'top ghost' }, el('span', { className: 'grip', textContent: '⠿' }), el('span', { className: 'ch', textContent: '0' }), iconButton('x', '', () => {}, { size: 12 }))

  /**
   * Listening to the stream mix on an output of your own (headphones, a monitor speaker), apart from what plays to the room.
   * It sits beside the master, in the Stream panel. Everything is saved with the mixer and applied at once.
   */
  function renderMonitorSide(): HTMLElement {
    const m = mixer.monitor
    const outputs = deps.getOutputs()
    const toggle = el<HTMLInputElement>('input', { type: 'checkbox', checked: m.on, className: 'switch', title: t('mixer.monitor.toggle') })
    const select = el<HTMLSelectElement>('select', { title: t('mixer.monitor.output') })
    select.append(el<HTMLOptionElement>('option', { value: '', textContent: t('mixer.monitor.defaultOutput'), selected: m.deviceId === '' }))
    outputs.forEach((o) => select.append(el<HTMLOptionElement>('option', { value: o.deviceId, textContent: o.label, selected: o.deviceId === m.deviceId })))
    if (m.deviceId && !outputs.some((o) => o.deviceId === m.deviceId)) select.append(el<HTMLOptionElement>('option', { value: m.deviceId, textContent: t('mixer.monitor.notConnected', { label: m.label || t('mixer.monitor.output.fallback') }), selected: true }))
    select.onchange = () => { m.deviceId = select.value; m.label = outputs.find((o) => o.deviceId === select.value)?.label ?? ''; commit(); render() }
    const body = el('div', { className: `monbody ${m.on ? '' : 'off'}` })
    toggle.onchange = () => { m.on = toggle.checked; body.classList.toggle('off', !m.on); commit() }
    const level = k(t('mixer.knob.level'), m.gainDb, RANGES.monitorDb, 0.5, ' dB', -6, (v) => { m.gainDb = v })
    const warn = status.monitorError ? el('div', { className: 'monerr', textContent: status.monitorError }) : el('span')
    body.append(
      select,
      el('div', { className: 'monrow' }, level.el, el('div', { className: 'dim monhint', textContent: t('mixer.monitor.hint1') })),
      el('div', { className: 'dim monhint', textContent: t('mixer.monitor.hint2') }),
    )
    return el('div', { className: 'mxside monitor' }, el('div', { className: 'sidehead' }, el('span', { className: 'ch', textContent: t('mixer.panel.monitor') }), toggle), body, warn)
  }

  /**
   * The Audience panel: the sound of the videos for the room, laid out like the stream's master (a strip with its meter, fader and
   * mute, and the controls beside it): which screen plays it, on which output device, how loud, and the level going out. It plays
   * from that screen's own window (so it stays in step with the picture), which is why these are settings of the screen.
   */
  let audienceView: { meter: MeterEls; db: number } | null = null
  const screenPatch = (id: string, look: Partial<Look>): void => { void api.updateScreen(id, { look: look as Look }) }
  let audienceTimer: ReturnType<typeof setTimeout> | null = null
  function renderAudience(): HTMLElement {
    const screens = deps.getScreens().filter((s) => s.kind === 'display' && !s.mirrorOf)
    const outputs = deps.getOutputs()
    const current = deps.getScreens().find((s) => s.look.videoAudio) // the one that plays it
    const select = el<HTMLSelectElement>('select', { title: t('mixer.audience.screen') })
    select.append(el<HTMLOptionElement>('option', { value: '', textContent: t('mixer.audience.nobody'), selected: !current }))
    screens.forEach((s) => select.append(el<HTMLOptionElement>('option', { value: s.id, textContent: s.name, selected: s.id === current?.id })))
    if (current && !screens.some((s) => s.id === current.id)) select.append(el<HTMLOptionElement>('option', { value: current.id, textContent: current.name, selected: true }))
    select.onchange = () => { // exactly one screen plays it
      for (const s of deps.getScreens()) if (s.look.videoAudio !== (s.id === select.value)) screenPatch(s.id, { videoAudio: s.id === select.value })
    }
    const device = el<HTMLSelectElement>('select', { title: t('mixer.audience.device'), disabled: !current })
    device.append(el<HTMLOptionElement>('option', { value: '', textContent: t('mixer.monitor.defaultOutput'), selected: !current?.look.audioOutput }))
    outputs.forEach((o) => device.append(el<HTMLOptionElement>('option', { value: o.deviceId, textContent: o.label, selected: o.deviceId === current?.look.audioOutput })))
    if (current?.look.audioOutput && !outputs.some((o) => o.deviceId === current.look.audioOutput)) device.append(el<HTMLOptionElement>('option', { value: current.look.audioOutput, textContent: t('mixer.audience.savedNotConnected'), selected: true }))
    device.onchange = () => { if (current) screenPatch(current.id, { audioOutput: device.value }) }

    const muted = !!current?.look.videoMuted
    const levelDb = current?.look.videoVolumeDb ?? 0
    const fill = el('div', { className: 'fill' })
    const peak = el('div', { className: 'peak' })
    audienceView = { meter: { fill, peak, gr: el('div') }, db: muted ? -100 : levelDb }
    const readout = el('div', { className: 'db', textContent: fmtDb(levelDb) })
    const fader = el<HTMLInputElement>('input', { type: 'range', className: 'vfader', min: String(RANGES_AUDIENCE[0]), max: String(RANGES_AUDIENCE[1]), step: '0.5', value: String(levelDb), disabled: !current, title: t('mixer.audience.fader') })
    fader.oninput = () => {
      const v = Number(fader.value)
      readout.textContent = fmtDb(v)
      if (!current) return
      current.look.videoVolumeDb = v
      if (audienceView) audienceView.db = current.look.videoMuted ? -100 : v
      if (audienceTimer) clearTimeout(audienceTimer)
      audienceTimer = setTimeout(() => screenPatch(current.id, { videoVolumeDb: v }), 60)
    }
    fader.ondblclick = () => { fader.value = '0'; fader.dispatchEvent(new Event('input')) }
    const mute = el<HTMLButtonElement>('button', { className: `ms ${muted ? 'on mute' : ''}`, textContent: 'M', title: t('mixer.audience.mute'), disabled: !current })
    mute.onclick = () => { if (current) screenPatch(current.id, { videoMuted: !current.look.videoMuted }) }
    const dev = current?.look.audioOutput ? (outputs.find((o) => o.deviceId === current.look.audioOutput)?.label ?? t('mixer.audience.savedOutput')) : t('mixer.audience.defaultOutput')
    const name = el<HTMLInputElement>('input', { type: 'text', value: t('mixer.audience.name'), readOnly: true, title: t('mixer.audience.nameTitle') })
    const strip = el('div', { className: `strip audience ${current ? '' : 'idle'}` },
      ghostTop(),
      el('div', { className: 'dev', textContent: current ? shortDeviceName(dev) : t('mixer.audience.noSound'), title: dev }),
      name,
      el('div', { className: 'mf' }, el('div', { className: 'meter', title: t('mixer.audience.meter') }, fill, peak), fader),
      readout,
      el('div', { className: 'btns2' }, mute),
    )
    const side = el('div', { className: `mxside ${current ? '' : 'off'}` },
      el('label', { className: 'dim', textContent: t('mixer.audience.playsFrom') }), select,
      el('label', { className: 'dim', textContent: t('mixer.audience.output') }), device,
      el('div', { className: 'dim monhint', textContent: t('mixer.audience.hint') }),
    )
    return panel(t('mixer.panel.audience'), 'audience', strip, side)
  }

  /** Every input the user can add a channel from: the machine's devices, then the test sources. */
  function sourceChoices(): { value: string; text: string; channels: number | null }[] {
    const native = deps.getNativeInputs()
    return [
      { value: VIDEO_SOURCE.deviceId, text: VIDEO_SOURCE.label, channels: 2 },
      ...native.map((n) => ({ value: nativeKey(n.name), text: t('mixer.add.allChannels', { name: n.name, n: n.channels }), channels: n.channels })),
      ...deps.getDevices().filter((d) => !native.some((n) => d.label.startsWith(n.name))).map((d) => ({ value: d.deviceId, text: d.label, channels: null })), // the browser's two-channel view of a natively read interface would only confuse
      ...TEST_SOURCES.map((t) => ({ value: t.deviceId, text: t.label, channels: t.channels })),
    ]
  }

  /** How many channels the chosen source offers: known for test sources and open devices, otherwise found by probing. */
  function channelsOf(deviceId: string): number | 'failed' | 'checking' {
    const fixed = sourceChoices().find((c) => c.value === deviceId)?.channels
    if (fixed != null) return fixed
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
    grBars.clear()
    liveGraphs.clear()
    detailOut = null
    const choices = sourceChoices()
    if (!choices.some((c) => c.value === addSource)) addSource = choices[0]?.value ?? ''
    const sourceSel = el<HTMLSelectElement>('select', { title: t('mixer.add.source') })
    sourceSel.append(...choices.map((c) => el<HTMLOptionElement>('option', { value: c.value, textContent: c.text, selected: c.value === addSource })))
    sourceSel.onchange = () => { addSource = sourceSel.value; addChannel = 0; render() }

    const available = addSource ? channelsOf(addSource) : 0
    const isVideo = addSource === VIDEO_SOURCE.deviceId
    const channelSel = el<HTMLSelectElement>('select', { title: t('mixer.add.channelOf'), disabled: typeof available !== 'number' || isVideo })
    if (isVideo) {
      channelSel.append(el<HTMLOptionElement>('option', { textContent: t('mixer.add.stereoPair') }))
    } else if (typeof available === 'number') {
      for (let ch = 0; ch < Math.min(available, MAX_CHANNELS); ch++) {
        const taken = mixer.strips.some((x) => stripKey(x) === stripKey({ channel: ch, source: pickedSource() }))
        channelSel.append(el<HTMLOptionElement>('option', { value: String(ch), textContent: t(taken ? 'mixer.add.channelTaken' : 'mixer.add.channel', { n: ch + 1 }), selected: ch === addChannel }))
      }
    } else {
      channelSel.append(el<HTMLOptionElement>('option', { textContent: available === 'checking' ? t('mixer.add.checking') : t('mixer.add.cannotOpen') }))
    }
    channelSel.onchange = () => { addChannel = Number(channelSel.value) }

    function pickedSource(): StripSource | undefined {
      const c = choices.find((x) => x.value === addSource)
      return c ? { deviceId: c.value, label: c.text } : undefined
    }
    const add = iconButton('plus', t('mixer.add.title'), async () => {
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
    }, { label: t('mixer.add.label'), disabled: typeof available !== 'number' })
    const reset = iconButton('x', t('mixer.reset.title'), () => { mixer = defaultMixer(); selected = stripKey(mixer.strips[0]); commit(); render() }, { label: t('mixer.reset.label') })

    // The mixer runs by itself and follows every change at once. Only when it could not start does it offer to try again.
    const failed = status.state === 'error'
    const dev = status.state === 'running' ? status.message : failed ? t('mixer.status.error', { message: status.message }) : t('mixer.status.starting')
    const retry = failed ? el('button', { className: 'primary', textContent: t('mixer.try.again'), title: t('mixer.try.again.title'), onclick: () => void deps.startAudio() }) : null
    undoBtn = iconButton('undo', '', () => travel('undo'), { size: 15 })
    redoBtn = iconButton('redo', '', () => travel('redo'), { size: 15 })
    syncHistoryButtons()
    const bar = el('div', { className: 'mxbar' }, ...(retry ? [retry] : []), el('span', { className: `mxstatus ${status.state}`, textContent: dev }))
    const addRow = el('div', { className: 'mxadd' }, el('span', { className: 'dlabel', textContent: t('mixer.add.from') }), sourceSel, channelSel, add, el('span', { className: 'grow' }), undoBtn, redoBtn, reset)

    const hasVideo = mixer.strips.some((x) => x.source?.deviceId === VIDEO_SOURCE.deviceId)
    const note = hasVideo ? el('div', { className: 'dim mxnote', textContent: t('mixer.note.video') }) : el('span')
    const strips = el('div', { className: 'strips' }, ...mixer.strips.map(renderStrip))
    // Two panels: the stream (every channel, then the master with the monitor beside it) and, apart from it, the audience.
    const streamPanel = panel(t('mixer.panel.stream'), 'stream', strips, el('div', { className: 'mxmaster' }, renderMaster(), renderMonitorSide()))
    const row = el('div', { className: 'mxrow' }, streamPanel, renderAudience())
    const sel = selected !== null && selected !== MASTER_KEY ? stripOf(selected) : undefined
    const detail = selected === MASTER_KEY ? renderMasterDetail() : sel ? renderDetail(sel) : el('div', { className: 'row', textContent: mixer.strips.length ? t('mixer.detail.selectHint') : t('mixer.detail.noChannels') })
    root.replaceChildren(bar, addRow, note, row, detail)
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
    if (audienceView) { // the video's sound with the audience level applied (it can only be turned down)
      const shift = audienceView.db <= -60 ? -100 : audienceView.db
      const rms = m.audience ? m.audience.rmsDb + shift : -100
      const pk = m.audience ? m.audience.peakDb + shift : -100
      audienceView.meter.fill.style.height = `${meterPct(rms)}%`
      audienceView.meter.fill.className = `fill ${levelClass(pk)}`
      audienceView.meter.peak.style.bottom = `${meterPct(pk)}%`
    }
    for (const [id, feed] of liveGraphs) feed(m.live?.[id], m.reductions?.[id] ?? 0)
    for (const [id, bar] of grBars) bar.style.width = `${Math.min(100, (-(m.reductions?.[id] ?? 0) / 20) * 100)}%` // each effect's gain reduction, up to 20 dB
    m.masterPeakDb.forEach((db, i) => {
      const e = masterMeters[i]
      if (!e) return
      e.fill.style.height = `${meterPct(db)}%`
      e.fill.className = `fill ${levelClass(db)}`
      e.peak.style.bottom = `${meterPct(db)}%`
    })
  }

  let lastScreensSignature = ''
  void api.audioMixerGet().then((m) => { mixer = m; history.reset(JSON.stringify(m)); selected = m.strips[0] ? stripKey(m.strips[0]) : null; render() })
  api.onMeters(update)
  root.innerHTML = iconSvg('sliders', 1) // placeholder until first render

  return {
    show: render,
    /** The screens changed (a name, which one plays video sound, its device or level): the Audience box follows when the tab is open. */
    screensChanged(): void {
      const sig = JSON.stringify(deps.getScreens().map((s) => [s.id, s.name, s.kind, s.mirrorOf, s.look.videoAudio, s.look.audioOutput, s.look.videoVolumeDb, s.look.videoMuted]))
      if (sig === lastScreensSignature) return
      lastScreensSignature = sig
      if (root.classList.contains('active')) render()
    },
    setStatus(s: AudioStatus): void {
      status = s
      if (root.classList.contains('active')) render()
    },
  }
}

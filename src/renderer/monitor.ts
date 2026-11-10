import type { PrestreamerApi } from '../preload'
import { appliesTo } from '../shared/announce'
import { createAtemPanel } from './atem-panel'
import { makeSplitter } from './splitter'
import { bestGrid } from '../shared/layout'
import { isBlank } from '../shared/screens'
import type { PlaybackState, ScreenConfig, ScreenState } from '../shared/types'
import { t } from '../shared/i18n'
import { iconButton } from './icons'
import { scaledPreview, type ScaledPreview } from './slideview'

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

export interface MonitorDeps {
  api: PrestreamerApi
  getState: () => ScreenState
  getPlayback: () => PlaybackState
  getSelected: () => string | null
  select: (id: string) => void
  screenSize: (sc: ScreenConfig) => [number, number]
  step: (delta: number) => void
  toggleScreen: (id: string) => void
  openAnnounce: () => void
}

type Mode = 'one' | 'all'
const MODE_KEY = 'prestreamer.monitorMode'
const recallMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === 'all' ? 'all' : 'one' } catch { return 'one' } }

/** A preview that fills the room it is given (as large as its shape allows) with an OFF cover for closed screens. */
interface Shown { box: HTMLElement; pv: ScaledPreview; off: HTMLElement; clear: HTMLButtonElement; toggle: HTMLButtonElement }
function shown(): Shown {
  const pv = scaledPreview()
  const off = el('div', { className: 'off', textContent: t('devices.monitor.off') })
  // Controls for this one screen, on its picture. They must not also select the cell they are in.
  const clear = el<HTMLButtonElement>('button', { className: 'mtool' })
  const toggle = el<HTMLButtonElement>('button', { className: 'mtool' })
  const tools = el('div', { className: 'mtools' }, clear, toggle)
  tools.onclick = (e) => e.stopPropagation()
  tools.ondblclick = (e) => e.stopPropagation()
  return { box: el('div', { className: 'mbig pv' }, pv.box, off, tools), pv, off, clear, toggle }
}

/**
 * The Monitor tab: either one screen as large as the room allows, with a strip of the others to pick from ("One screen"), or
 * every screen at once in a grid ("All screens", like a multiviewer). The controls you reach for while watching sit below.
 * Previews exist only while the tab is open, so a camera shown in them is not held open in the background.
 */
export function createMonitorView(root: HTMLElement, deps: MonitorDeps) {
  const { api } = deps
  let open = false
  let mode: Mode = recallMode()
  let big: Shown | null = null
  const thumbs = new Map<string, { root: HTMLElement; pv: ScaledPreview; off: HTMLElement; name: HTMLElement }>()
  const cells = new Map<string, { root: HTMLElement; shown: Shown; name: HTMLElement }>()

  const title = el('div', { className: 'mtitle' })
  const modeButtons = (['one', 'all'] as const).map((m) => {
    const b = el<HTMLButtonElement>('button', { textContent: m === 'one' ? t('devices.monitor.oneScreen') : t('devices.monitor.allScreens'), title: m === 'one' ? t('devices.monitor.oneScreenHint') : t('devices.monitor.allScreensHint') })
    b.onclick = () => setMode(m)
    return b
  })
  const modeSwitch = el('div', { className: 'seg' }, ...modeButtons)
  const focusArea = el('div', { className: 'mfit' })
  const grid = el('div', { className: 'mgrid' })
  const content = el('div', { className: 'mcontent' })
  const now = el('div', { className: 'mnow' })
  const next = el('div', { className: 'mnext' })
  const bar = el('div', { className: 'mbar' })
  const strip = el('div', { className: 'mstrip' })
  // The controls and the mode switch share one row above both columns, so they stay where they are in either mode.
  // The switcher sits under the picture, so a camera change never needs another tab.
  const atemBody = el('div')
  const atem = el('div', { className: 'matem', hidden: true }, el('div', { className: 'head2' }, 'ATEM'), atemBody) // only while a switcher is connected
  createAtemPanel(atemBody, api, atem)
  // One screen: the big picture on the left (a panel of its own) and, on the right, a resizable panel with the screens, what is on
  // air and the switcher. All screens: one column; what is on air and the switcher then go under the grid.
  const extra = el('div', { className: 'mextra' }, now, next, atem)
  const main = el('div', { className: 'mmain' }, content, title)
  const side = el('div', { className: 'mside' }, strip, extra)
  const splitter = el('div')
  root.replaceChildren(bar, main, splitter, side)
  makeSplitter(splitter, { host: root, variable: '--side', side: 'right', min: 220, max: 640, initial: 340, key: 'prestreamer.monitor.side', panel: () => side })

  const previous = iconButton('up', t('devices.monitor.prevHint'), () => deps.step(-1), { label: t('devices.monitor.prev'), className: 'step' })
  const forward = iconButton('down', t('devices.monitor.nextHint'), () => deps.step(1), { label: t('devices.monitor.next'), className: 'primary step' })
  const playPause = iconButton('play', t('devices.monitor.playPauseHint'), () => void api.playbackCommand({ type: deps.getPlayback().playing ? 'pause' : 'play' }))
  const camera = iconButton('camera', t('devices.monitor.cameraHint'), () => void api.setCameraOnly(!deps.getState().cameraOnly), { label: t('devices.monitor.camera') })
  const announce = iconButton('bell', t('devices.monitor.announceHint'), () => deps.openAnnounce(), { label: t('devices.monitor.announce') })
  // One row: the slide controls and Announce together on the left, the stream's Camera only alone on the right.
  bar.append(previous, forward, playPause, announce, el('span', { className: 'grow' }), camera, modeSwitch)

  const look = (sc: ScreenConfig, state: ScreenState) => (sc.mirrorOf && state.screens.find((x) => x.id === sc.mirrorOf)) || sc
  function paint(pv: ScaledPreview, sc: ScreenConfig, state: ScreenState): void {
    const shownOn = look(sc, state)
    const [w, h] = deps.screenSize(sc)
    pv.update(shownOn.look, isBlank(state.screens, state.blank, sc.id) ? null : state.slide, w, h, true, state.cameraOnly && shownOn.kind === 'virtual')
    pv.setNext(state.next)
    pv.setPlayback(deps.getPlayback())
    pv.setAnnouncement(appliesTo(state.announcement, shownOn.id) ? state.announcement : null)
  }
  /** The Clear and Open/Close buttons on a screen's own picture. */
  function tools(s: Shown, sc: ScreenConfig, state: ScreenState): void {
    const live = state.live.includes(sc.id)
    const blank = isBlank(state.screens, state.blank, sc.id)
    s.clear.textContent = blank ? t('devices.monitor.show') : t('devices.monitor.clear')
    s.clear.title = blank ? t('devices.monitor.showHint', { name: sc.name }) : t('devices.monitor.clearHint', { name: sc.name })
    s.clear.disabled = !live || (!blank && !state.slide)
    s.clear.onclick = () => void api.clearScreen(sc.id, !blank)
    s.toggle.textContent = live ? t('devices.monitor.closeBtn') : t('devices.monitor.openBtn')
    s.toggle.title = live ? t('devices.monitor.closeHint', { name: sc.name }) : t('devices.monitor.openHint', { name: sc.name })
    s.toggle.classList.toggle('danger', live)
    s.toggle.onclick = () => deps.toggleScreen(sc.id)
  }

  /** A picture is sized by its shape: --ar lets the stylesheet fit it into whatever room its box has. */
  const setShape = (box: HTMLElement, sc: ScreenConfig) => { const [w, h] = deps.screenSize(sc); box.style.setProperty('--ar', String(w / h)) }

  function setMode(next: Mode): void {
    if (next === mode) return
    mode = next
    try { localStorage.setItem(MODE_KEY, mode) } catch { /* only a convenience */ }
    disposePreviews()
    render()
  }

  /** Columns for the grid: as large as possible for the room the grid has now, and again whenever the room changes. */
  function layoutGrid(): void {
    const count = cells.size
    if (!count || !grid.clientWidth || !grid.clientHeight) return
    const { cols, rows } = bestGrid(count, grid.clientWidth, grid.clientHeight)
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`
    grid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`
  }
  const resizer = new ResizeObserver(layoutGrid)

  function renderOne(state: ScreenState, selected: ScreenConfig): void {
    if (content.firstChild !== focusArea) { resizer.disconnect(); content.replaceChildren(focusArea) }
    const live = state.live.includes(selected.id)
    const [w, h] = deps.screenSize(selected)
    if (!big) { big = shown(); focusArea.replaceChildren(big.box) }
    setShape(big.box, selected)
    paint(big.pv, selected, state)
    big.off.style.display = live ? 'none' : 'flex'
    tools(big, selected, state)
    title.textContent = t(live ? 'devices.monitor.titleOpen' : 'devices.monitor.titleClosed', { name: selected.name, w, h })

    // The strip: every screen, the selected one marked.
    const ids = new Set(state.screens.map((s) => s.id))
    for (const [id, t] of thumbs) if (!ids.has(id)) { t.pv.dispose(); t.root.remove(); thumbs.delete(id) }
    for (const sc of state.screens) {
      let th = thumbs.get(sc.id)
      if (!th) {
        const pv = scaledPreview()
        const tOff = el('div', { className: 'off', textContent: t('devices.monitor.off') })
        const name = el('div', { className: 'monname' })
        const card = el('div', { className: 'monthumb' }, el('div', { className: 'pv' }, pv.box, tOff), name)
        card.onclick = () => deps.select(sc.id)
        th = { root: card, pv, off: tOff, name }
        thumbs.set(sc.id, th)
      }
      paint(th.pv, sc, state)
      th.off.style.display = state.live.includes(sc.id) ? 'none' : 'flex'
      th.name.textContent = sc.name
      th.root.classList.toggle('sel', sc.id === selected.id)
      th.root.dataset.id = sc.id
    }
    const wanted = state.screens.map((s) => thumbs.get(s.id)!.root)
    if (wanted.some((n, i) => strip.children[i] !== n)) strip.append(...wanted)
  }

  function renderAll(state: ScreenState, selected: ScreenConfig): void {
    if (content.firstChild !== grid) { content.replaceChildren(grid); resizer.observe(grid) }
    title.textContent = t('devices.monitor.allTitle', { n: state.screens.length })
    const ids = new Set(state.screens.map((s) => s.id))
    for (const [id, c] of cells) if (!ids.has(id)) { c.shown.pv.dispose(); c.root.remove(); cells.delete(id) }
    for (const sc of state.screens) {
      let c = cells.get(sc.id)
      if (!c) {
        const s = shown()
        const name = el('div', { className: 'monname' })
        const fit = el('div', { className: 'mfit' }, s.box)
        const cell = el('div', { className: 'moncell', title: t('devices.monitor.cellHint') }, fit, name)
        cell.onclick = () => deps.select(sc.id)
        cell.ondblclick = () => { deps.select(sc.id); setMode('one') }
        c = { root: cell, shown: s, name }
        cells.set(sc.id, c)
      }
      const live = state.live.includes(sc.id)
      const [w, h] = deps.screenSize(sc)
      setShape(c.shown.box, sc)
      paint(c.shown.pv, sc, state)
      c.shown.off.style.display = live ? 'none' : 'flex'
      tools(c.shown, sc, state)
      c.name.textContent = t(live ? 'devices.monitor.titleOpen' : 'devices.monitor.titleClosed', { name: sc.name, w, h })
      c.root.classList.toggle('sel', sc.id === selected.id)
      c.root.dataset.id = sc.id
    }
    const wanted = state.screens.map((s) => cells.get(s.id)!.root)
    if (wanted.some((n, i) => grid.children[i] !== n)) grid.append(...wanted)
    layoutGrid()
  }

  function render(): void {
    if (!open) return
    const state = deps.getState()
    const selected = state.screens.find((s) => s.id === deps.getSelected()) ?? state.screens[0]
    root.classList.toggle('empty', !selected)
    root.classList.toggle('multi', mode === 'all')
    modeButtons.forEach((b, i) => { const on = (i === 0) === (mode === 'one'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)) })
    if (!selected) return
    const home = mode === 'one' ? side : main
    if (extra.parentElement !== home) home.append(extra)
    if (mode === 'one') renderOne(state, selected)
    else renderAll(state, selected)

    const slide = state.slide
    now.textContent = slide ? (slide.video ? t('devices.monitor.onAirVideo', { title: slide.video.title }) : slide.picture ? t('devices.monitor.onAirLabel', { label: slide.label }) : t('devices.monitor.onAirSlide', { label: slide.label, text: slide.text.split('\n')[0] })) : t('devices.monitor.nothing')
    next.textContent = state.next ? state.next.text ? t('devices.monitor.nextSlide', { label: state.next.label, text: state.next.text.split('\n')[0] }) : t('devices.monitor.nextLabel', { label: state.next.label }) : ''

    const playing = deps.getPlayback()
    playPause.hidden = !slide?.video
    playPause.title = playing.playing ? t('devices.monitor.pauseVideo') : t('devices.monitor.playVideo')
    camera.hidden = selected.kind !== 'virtual'
    camera.classList.toggle('primary', state.cameraOnly)
    camera.setAttribute('aria-pressed', String(state.cameraOnly))
  }

  function disposePreviews(): void {
    big?.pv.dispose()
    big = null
    for (const t of thumbs.values()) t.pv.dispose()
    thumbs.clear()
    for (const c of cells.values()) c.shown.pv.dispose()
    cells.clear()
    resizer.disconnect()
    strip.replaceChildren()
    focusArea.replaceChildren()
    grid.replaceChildren()
    content.replaceChildren()
  }

  return {
    show(): void { open = true; render() },
    hide(): void { open = false; disposePreviews() },
    render,
    /** The screen being watched large, while the Monitor tab shows one screen (null in the multiview or another tab). */
    single(): string | null {
      if (!open || mode !== 'one') return null
      const st = deps.getState()
      return (st.screens.find((s) => s.id === deps.getSelected()) ?? st.screens[0])?.id ?? null
    },
  }
}

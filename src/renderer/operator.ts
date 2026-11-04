import type { PrestreamerApi } from '../preload'
import { parseSong } from '../shared/songs'
import { defaultAudio, defaultLook, idleAudio, idlePlayback, idleStream, type PlaybackState, type AudioConfig, type Service, type ServiceItem, type AudioSource, type AudioStatus, type Background, type ScreenConfig, type ScreenState, type Slide, type Song, type StreamStatus, type VideoSource } from '../shared/types'
import { iconButton, iconSvg, type IconName } from './icons'
import { createMixerView } from './mixer'
import { scaledPreview, type ScaledPreview } from './slideview'

declare const prestreamer: PrestreamerApi

const $ = (id: string) => document.getElementById(id)!

function el<T extends HTMLElement = HTMLElement>(tag: string, props: Partial<T> = {}, ...kids: (Node | string)[]): T {
  const e = Object.assign(document.createElement(tag) as T, props)
  e.append(...kids)
  return e
}

const BACKGROUNDS = [
  'linear-gradient(135deg,#1b2a49,#0b1020)',
  'linear-gradient(135deg,#3b0764,#0f172a)',
  'linear-gradient(135deg,#7c2d12,#1c0a05)',
  'linear-gradient(135deg,#064e3b,#022c22)',
  'linear-gradient(135deg,#0c4a6e,#082f49)',
  '#000000',
  '#00b140', // chroma green, e.g. for keying in ATEM
]

const SECTION_COLORS: Record<string, string> = { verse: '#2563eb', chorus: '#dc2626', bridge: '#7c3aed' }
const sectionColor = (label: string) => SECTION_COLORS[label.split(' ')[0].toLowerCase()] ?? '#475569'

let state: ScreenState = { screens: [], displays: [], live: [], slide: null }
let songs: Song[] = []
let songId = ''
type View = 'present' | 'songs' | 'mixer'
let view: View = 'present'
let songFilter = ''
let services: Service[] = []
let playback: PlaybackState = idlePlayback
let audioOutputs: { deviceId: string; label: string }[] = []
let serviceId = ''
/** Selected schedule item (null = browsing the library). */
let selectedItemId: string | null = null
/** Draft of the song being edited (null = not editing). */
let editing: { song: Song; isNew: boolean } | null = null
let keySaved = false
let audioDevices: { deviceId: string; label: string }[] = []
let audioStatus: AudioStatus = idleAudio
let audioCfg: AudioConfig = structuredClone(defaultAudio)
let selectedScreenId: string | null = null
let cameras: { deviceId: string; label: string }[] = []
let streamStatus: StreamStatus = idleStream

const currentService = (): Service | undefined => services.find((x) => x.id === serviceId) ?? services[0]
const selectedItem = (): ServiceItem | undefined => currentService()?.items.find((i) => i.id === selectedItemId)
const songById = (id: string) => songs.find((x) => x.id === id)
const songOfItem = (it: ServiceItem): Song | undefined => (it.kind === 'song' ? songById(it.songId) : undefined)
const videoCue = (it: Extract<ServiceItem, { kind: 'video' }>): Slide => ({ label: 'Video', text: it.title, itemId: it.id, video: { file: it.file, title: it.title, durationSec: it.durationSec } })
const currentSong = (): Song | undefined => {
  const it = selectedItem()
  if (it) return songOfItem(it)
  return songById(songId) || songs[0]
}
const withItem = (slides: Slide[], itemId?: string): Slide[] => slides.map((sl) => ({ ...sl, itemId }))
const currentSlides = (): Slide[] => {
  const c = currentSong()
  return c ? withItem(parseSong(c), selectedItemId ?? undefined) : []
}
/** Every slide of the service in order: lets the arrow keys run on from one item into the next. */
const serviceSlides = (): Slide[] =>
  (currentService()?.items ?? []).flatMap((it) => {
    if (it.kind === 'video') return [videoCue(it)]
    const song = songOfItem(it)
    return song ? withItem(parseSong(song), it.id) : []
  })
const sameSlide = (a: Slide | null, b: Slide) => !!a && a.label === b.label && a.text === b.text && a.itemId === b.itemId

/** Physical screens use their bound display's size; otherwise the configured one. */
function screenSize(sc: ScreenConfig): [number, number] {
  const d = sc.kind === 'display' ? state.displays.find((x) => x.id === sc.displayId) : undefined
  return d ? [d.width, d.height] : [sc.width, sc.height]
}

/** Applies a change to a copy of the current service and saves it. */
async function mutateService(fn: (svc: Service) => void): Promise<void> {
  const svc = currentService()
  if (!svc) return
  const draft = structuredClone(svc)
  fn(draft)
  services = await prestreamer.servicesSave(draft)
  renderAll()
}

function renderSchedule(): void {
  const svc = currentService()
  const sel = $('servicesel') as HTMLSelectElement
  sel.replaceChildren(...services.map((x) => el<HTMLOptionElement>('option', { value: x.id, textContent: x.name, selected: x.id === svc?.id })))
  ;($('servicename') as HTMLInputElement).value = svc?.name ?? ''
  if (!svc) return $('schedule').replaceChildren(el('div', { className: 'row', textContent: 'No service yet. Use the + icon above to create one.' }))

  const liveItem = state.slide?.itemId
  const rows = svc.items.map((it, idx) => {
    const kind: IconName = it.kind === 'video' ? 'film' : 'music'
    const title = it.kind === 'video' ? it.title : (songOfItem(it)?.title ?? '(deleted song)')
    const swap = (a: number, b: number) => void mutateService((d) => { [d.items[a], d.items[b]] = [d.items[b], d.items[a]] })
    const tool = (name: IconName, tip: string, fn: () => void, disabled = false) => iconButton(name, tip, (e) => { e.stopPropagation(); fn() }, { size: 14, disabled })
    const kindIcon = el('span', { className: 'kind' })
    kindIcon.innerHTML = iconSvg(kind, 15)
    return el('div', { className: `srow ${it.id === selectedItemId ? 'sel' : ''}`, onclick: () => { selectedItemId = it.id; renderAll() } },
      el('span', { className: `n ${it.id === liveItem ? 'livemark' : ''}`, textContent: it.id === liveItem ? '●' : String(idx + 1) }),
      kindIcon,
      el('span', { className: 't', textContent: title }),
      tool('up', 'Move up', () => swap(idx - 1, idx), idx === 0),
      tool('down', 'Move down', () => swap(idx, idx + 1), idx === svc.items.length - 1),
      tool('x', 'Remove from service', () => { if (selectedItemId === it.id) selectedItemId = null; void mutateService((d) => { d.items.splice(idx, 1) }) }),
    )
  })
  $('schedule').replaceChildren(...(rows.length ? rows : [el('div', { className: 'row', textContent: 'Empty. Use the song or video icon above to add items.' })]))
}

function renderLibrary(): void {
  const q = songFilter.trim().toLowerCase()
  const shown = songs.filter((x) => !q || x.title.toLowerCase().includes(q))
  const editingId = editing?.song.id
  $('library').replaceChildren(
    ...(shown.length ? shown.map((x) =>
      el('div', { className: `item ${x.id === editingId ? 'sel' : ''}`, onclick: () => startEdit(x) },
        el('span', { className: 't', textContent: x.title }),
        iconButton('plus', 'Add to the current service', (e) => { e.stopPropagation(); addSongToService(x.id) }, { size: 14, badge: false }),
      )) : [el('div', { className: 'row', textContent: songs.length ? 'No match.' : 'No songs yet.' })]),
  )
}

function addSongToService(id: string): void {
  void mutateService((svc) => { svc.items.push({ id: crypto.randomUUID(), kind: 'song', songId: id }) })
}

/** Opens a song in the editor of the Songs view (always a copy: nothing changes until Save). */
function startEdit(song: Song, isNew = false): void {
  editing = { song: structuredClone(song), isNew }
  view = 'songs'
  renderAll()
  showEditor()
}

/** Searchable picker so a song can be added to the run sheet without leaving the Present view. */
function openSongPicker(): void {
  const modal = $('modal')
  const input = el<HTMLInputElement>('input', { type: 'text', placeholder: 'Add which song?' })
  const list = el('div', { className: 'list' })
  const close = () => { modal.hidden = true; modal.replaceChildren() }
  const fill = () => {
    const q = input.value.trim().toLowerCase()
    const shown = songs.filter((x) => !q || x.title.toLowerCase().includes(q))
    list.replaceChildren(...(shown.length ? shown.map((x) => el('div', { className: 'item', textContent: x.title, onclick: () => { addSongToService(x.id); close() } })) : [el('div', { className: 'row', textContent: 'No match.' })]))
  }
  input.oninput = fill
  input.onkeydown = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'Enter') (list.firstElementChild as HTMLElement | null)?.click() }
  modal.onclick = (e) => { if (e.target === modal) close() }
  modal.replaceChildren(el('div', { className: 'dialog' }, el('div', { className: 'svc pad' }, input), list))
  modal.hidden = false
  fill()
  input.focus()
}

async function addVideoToService(): Promise<void> {
  const status = $('videostatus')
  if (!currentService()) { status.textContent = 'Create a service first'; return }
  status.className = 'status'
  status.textContent = 'Choosing…'
  try {
    const v = await prestreamer.videoImport()
    if (v) await mutateService((svc) => { svc.items.push({ id: crypto.randomUUID(), kind: 'video', ...v }) })
    status.textContent = v ? `Added ${v.title}` : ''
  } catch (err) {
    status.className = 'status error'
    status.textContent = `Import failed: ${(err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`
  }
}

function renderCenter(): void {
  const song = currentSong()
  const ref = state.screens.find((s) => s.id === selectedScreenId) ?? state.screens[0]
  const root = $('center')
  transport = null
  const sel = selectedItem()
  if (sel?.kind === 'video') return renderVideoPanel(root, sel, ref)
  if (!song) return root.replaceChildren(el('div', { className: 'row', textContent: 'Select an item in the run sheet, or add songs in the Songs tab.' }))
  root.replaceChildren(
    el('h1', {}, song.title, iconButton('pencil', 'Edit this song', () => startEdit(song), { className: 'ml' })),
  )

  // Group consecutive slides by label like ProPresenter's groups.
  const groups: { label: string; slides: Slide[] }[] = []
  for (const sl of currentSlides()) {
    const g = groups[groups.length - 1]
    if (g && g.label === sl.label) g.slides.push(sl)
    else groups.push({ label: sl.label, slides: [sl] })
  }
  for (const g of groups) {
    const grid = el('div', { className: 'grid' })
    for (const sl of g.slides) {
      const pv = scaledPreview()
      if (ref) pv.update(ref.look, sl, 1920, 1080, false) // thumbnails stay static
      const card = el('div', { className: `card ${sameSlide(state.slide, sl) ? 'live' : ''}`, onclick: () => prestreamer.showSlide(sl) })
      const tag = el('div', { className: 'tag', textContent: sl.label })
      tag.style.background = sectionColor(sl.label)
      card.append(tag, pv.box)
      grid.append(card)
    }
    root.append(grid)
  }
}

// --- Video cues -------------------------------------------------------------------------------

const fmtTime = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`
const playbackPosition = (): number =>
  playback.playing ? Math.min(playback.durationSec, playback.positionSec + (Date.now() - playback.atMs) / 1000) : playback.positionSec

/** Transport controls of the video panel that is on screen (null when another panel is shown). */
let transport: { toggle: HTMLButtonElement; seek: HTMLInputElement; time: HTMLElement; file: string; dragging: boolean } | null = null

function updateTransport(): void {
  const t = transport
  if (!t) return
  const mine = playback.file === t.file
  const playingNow = mine && playback.playing
  t.toggle.innerHTML = `${iconSvg(playingNow ? 'pause' : 'play', 14)}<span>${playingNow ? 'Pause' : 'Play'}</span>`
  const pos = mine ? playbackPosition() : 0
  if (!t.dragging) t.seek.value = String(pos)
  t.time.textContent = `${fmtTime(pos)} / ${fmtTime(Number(t.seek.max))}`
}
setInterval(updateTransport, 250)

function renderVideoPanel(root: HTMLElement, it: Extract<ServiceItem, { kind: 'video' }>, ref: ScreenConfig | undefined): void {
  const cue = videoCue(it)
  const isLive = () => playback.file === it.file && sameSlide(state.slide, cue)

  const pv = scaledPreview()
  if (ref) pv.update(ref.look, cue, 1920, 1080, false)
  const tag = el('div', { className: 'tag', textContent: `Video · ${fmtTime(it.durationSec)}` })
  tag.style.background = '#0f766e'
  const card = el('div', { className: `card vcard ${isLive() ? 'live' : ''}`, onclick: () => prestreamer.showSlide(cue) }, tag, pv.box)

  const toggle = el<HTMLButtonElement>('button', { className: 'primary ib' })
  toggle.onclick = async () => {
    if (!isLive()) await prestreamer.showSlide(cue) // first press brings the video up on the screens
    await prestreamer.playbackCommand({ type: playback.file === it.file && playback.playing ? 'pause' : 'play' })
  }
  const stop = iconButton('stop', 'Stop and rewind', async () => { if (isLive()) await prestreamer.playbackCommand({ type: 'stop' }) }, { size: 14, label: 'Stop' })
  const show = el('button', { textContent: 'Show on screens', onclick: () => prestreamer.showSlide(cue) })
  const seek = el<HTMLInputElement>('input', { type: 'range', min: '0', max: String(it.durationSec), step: '0.1', value: '0' })
  const time = el('span', { className: 'time' })
  const t = { toggle, seek, time, file: it.file, dragging: false }
  let lastSeek = 0
  seek.onpointerdown = () => { t.dragging = true }
  seek.onpointerup = () => { t.dragging = false }
  seek.oninput = async () => {
    if (Date.now() - lastSeek < 80) return // throttle while scrubbing
    lastSeek = Date.now()
    if (!isLive()) await prestreamer.showSlide(cue)
    await prestreamer.playbackCommand({ type: 'seek', sec: Number(seek.value) })
  }
  transport = t

  root.replaceChildren(
    el('h1', {}, `🎬 ${it.title}`),
    el('div', { className: 'vpanel' }, card, el('div', { className: 'vt' }, toggle, stop, show, seek, time)),
    el('div', { className: 'row', textContent: 'Space plays or pauses a video that is on screen. → moves on to the next item and stops it. Sound plays from the screen with "Play video sound" on.' }),
  )
  updateTransport()
}

/** Renders the editor into the Songs view. Not part of renderAll: it holds unsaved text. */
function showEditor(): void {
  const ref = state.screens.find((x) => x.id === selectedScreenId) ?? state.screens[0]
  if (editing) renderEditor($('songeditor'), ref)
  else $('songeditor').replaceChildren(el('div', { className: 'row', textContent: 'Select a song, or create a new one with the + icon.' }))
}

/** Song editor: title, background (gradient / imported image / imported video), text, live preview. */
function renderEditor(root: HTMLElement, ref: ScreenConfig | undefined): void {
  const draft = editing!.song
  const title = el<HTMLInputElement>('input', { type: 'text', value: draft.title })
  title.oninput = () => { draft.title = title.value }

  const body = el<HTMLTextAreaElement>('textarea', { value: draft.body, rows: 16, spellcheck: false })
  body.oninput = () => updatePreview()

  const pv = scaledPreview()
  const updatePreview = () => {
    draft.body = body.value
    const first = parseSong(draft)[0] ?? { label: 'Preview', text: 'Type some text', background: draft.background }
    const look = { ...(ref?.look ?? defaultLook), showMedia: true, source: { type: 'none' } as VideoSource }
    pv.update(look, { ...first, background: draft.background }, 1920, 1080, true)
  }

  const setBackground = (bg: Background | null) => { draft.background = bg; updatePreview(); renderBgLabel() }
  const bgLabel = el('span', { className: 'meta' })
  const renderBgLabel = () => {
    const b = draft.background
    bgLabel.textContent = !b ? 'none' : b.kind === 'css' ? 'gradient / colour' : `${b.kind}: ${b.file.slice(0, 8)}…`
  }
  const swatches = el('div', { className: 'sw nopad' })
  for (const css of BACKGROUNDS) {
    const b = el('button', { title: css, onclick: () => setBackground({ kind: 'css', css }) })
    b.style.background = css
    swatches.append(b)
  }
  const importBtn = (kind: 'image' | 'video') =>
    iconButton(kind === 'image' ? 'screen' : 'film', kind === 'image' ? 'Import a background image' : 'Import a background video', async () => {
      const bg = await prestreamer.mediaImport(kind)
      if (bg) setBackground(bg)
    }, { badge: true, label: kind === 'image' ? 'Image' : 'Video' })

  const del = iconButton('trash', 'Delete song (click twice)', async () => {
    if (!armed) { armed = true; del.className = 'ib danger'; setTimeout(() => { armed = false; del.className = 'ib' }, 3000); return }
    songs = await prestreamer.songsDelete(draft.id)
    songId = songs[0]?.id ?? ''
    editing = songs[0] ? { song: structuredClone(songs[0]), isNew: false } : null
    renderAll()
    showEditor()
  }, { label: 'Delete' })
  let armed = false
  const save = iconButton('save', 'Save song', async () => {
    draft.body = body.value
    draft.title = title.value.trim() || 'Untitled'
    songs = await prestreamer.songsSave(draft)
    songId = draft.id
    editing = { song: structuredClone(draft), isNew: false }
    renderAll()
    showEditor()
  }, { className: 'primary', label: 'Save' })
  const revert = iconButton('undo', 'Discard unsaved changes', () => {
    const saved = songs.find((x) => x.id === draft.id)
    editing = saved ? { song: structuredClone(saved), isNew: false } : null
    renderAll()
    showEditor()
  }, { label: 'Revert' })
  const addToService = iconButton('plus', 'Add this song to the current service', () => addSongToService(draft.id), { label: 'Add to service', disabled: editing!.isNew })

  const form = el('div', { className: 'editor' })
  form.append(
    el('div', { className: 'field' }, el('label', { textContent: 'Title' }), title),
    el('div', { className: 'field' }, el('label', { textContent: 'Background' }), bgLabel, swatches,
      el('div', { className: 'btns' }, el('button', { textContent: 'None', onclick: () => setBackground(null) }), importBtn('image'), importBtn('video'))),
    el('div', { className: 'field' }, el('label', { textContent: 'Text — [Label] starts a section, a blank line starts a new slide' }), body),
    el('div', { className: 'btns' }, save, revert, addToService, el('span', { className: 'grow' }), ...(editing!.isNew ? [] : [del])),
  )
  root.replaceChildren(el('h1', { textContent: editing!.isNew ? 'New song' : draft.title }), el('div', { className: 'editorwrap' }, form, el('div', { className: 'editorprev' }, el('label', { textContent: 'Preview' }), pv.box)))
  renderBgLabel()
  updatePreview()
}

/**
 * Screen cards persist across renders: moving a <video> in the DOM pauses it, and
 * recreating previews would reopen cameras on every state change.
 */
interface Card { root: HTMLElement; bar: HTMLElement; off: HTMLElement; pv: ScaledPreview }
const cards = new Map<string, Card>()

function createCard(): Card {
  const pv = scaledPreview()
  const off = el('div', { className: 'off', textContent: 'OFF' })
  const bar = el('div', { className: 'bar' })
  const root = el('div', { className: 'screen' }, bar, el('div', { className: 'pv' }, pv.box, off))
  return { root, bar, off, pv }
}

function renderScreens(): void {
  if (!selectedScreenId && state.screens.length) selectedScreenId = state.screens[0].id
  const container = $('screens')
  const ids = new Set(state.screens.map((s) => s.id))
  for (const [id, c] of cards) {
    if (ids.has(id)) continue
    c.pv.dispose()
    c.root.remove()
    cards.delete(id)
  }

  for (const sc of state.screens) {
    let c = cards.get(sc.id)
    if (!c) {
      c = createCard()
      cards.set(sc.id, c)
      container.append(c.root)
    }
    const live = state.live.includes(sc.id)
    const [w, h] = screenSize(sc)
    c.pv.update(sc.look, state.slide, w, h, true)
    c.pv.setPlayback(playback)
    c.off.style.display = live ? 'none' : 'flex'
    c.root.className = `screen ${sc.id === selectedScreenId ? 'sel' : ''}`

    const bar = c.bar
    bar.replaceChildren(
      el('span', { className: `dot ${live ? 'on' : ''}` }),
      el('span', { className: 'name', textContent: sc.name, onclick: () => { selectedScreenId = sc.id; renderAll() } }),
      el('span', { className: 'meta', textContent: sc.kind === 'virtual' ? `virtual ${w}×${h}` : `${w}×${h}` }),
    )
    if (sc.kind === 'display') {
      const sel = el<HTMLSelectElement>('select')
      sel.append(el<HTMLOptionElement>('option', { value: '', textContent: 'window' }))
      for (const d of state.displays) {
        sel.append(el<HTMLOptionElement>('option', { value: String(d.id), textContent: d.label, selected: sc.displayId === d.id }))
      }
      sel.onchange = () => prestreamer.updateScreen(sc.id, { displayId: sel.value ? Number(sel.value) : null })
      bar.append(sel)
    }
    bar.append(
      el('button', { className: live ? 'danger' : 'primary', textContent: live ? 'Stop' : 'Live', onclick: () => prestreamer.setLive(sc.id, !live) }),
      el('button', { textContent: '✕', title: 'Remove', onclick: () => prestreamer.removeScreen(sc.id) }),
    )
  }
}

function sourceValue(s: VideoSource): string {
  return s.type === 'camera' ? `camera:${s.deviceId}` : s.type
}

function renderLook(): void {
  const sc = state.screens.find((s) => s.id === selectedScreenId)
  $('lookname').textContent = sc?.name ?? ''
  if (!sc) return $('look').replaceChildren()

  const swatches = el('div', { className: 'sw' })
  for (const bg of BACKGROUNDS) {
    const b = el('button', { title: bg, onclick: () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, background: bg } }) })
    b.style.background = bg
    swatches.append(b)
  }
  const size = el<HTMLInputElement>('input', { type: 'number', value: String(sc.look.fontSize), min: '16', max: '200' })
  size.onchange = () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, fontSize: Number(size.value) } })
  const color = el<HTMLInputElement>('input', { type: 'color', value: sc.look.textColor })
  color.onchange = () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, textColor: color.value } })
  const media = el<HTMLInputElement>('input', { type: 'checkbox', checked: sc.look.showMedia })
  media.onchange = () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, showMedia: media.checked } })
  const vsound = el<HTMLInputElement>('input', { type: 'checkbox', checked: sc.look.videoAudio })
  vsound.onchange = () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, videoAudio: vsound.checked } })
  const outSel = el<HTMLSelectElement>('select')
  outSel.append(el<HTMLOptionElement>('option', { value: '', textContent: 'System default', selected: !sc.look.audioOutput }))
  for (const d of audioOutputs) outSel.append(el<HTMLOptionElement>('option', { value: d.deviceId, textContent: d.label || d.deviceId, selected: d.deviceId === sc.look.audioOutput }))
  outSel.onchange = () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, audioOutput: outSel.value } })
  const label = el<HTMLInputElement>('input', { type: 'checkbox', checked: sc.look.showLabel })
  label.onchange = () => prestreamer.updateScreen(sc.id, { look: { ...sc.look, showLabel: label.checked } })

  // Video source: none, simulated pattern, or any camera (an ATEM Mini appears here when attached).
  const options: { value: string; text: string; source: VideoSource }[] = [
    { value: 'none', text: 'None', source: { type: 'none' } },
    { value: 'testpattern', text: 'Test pattern (simulated camera)', source: { type: 'testpattern' } },
    ...cameras.map((c) => ({ value: `camera:${c.deviceId}`, text: c.label || c.deviceId, source: { type: 'camera', ...c } as VideoSource })),
  ]
  const cur = sc.look.source
  if (cur.type === 'camera' && !options.some((o) => o.value === sourceValue(cur))) {
    options.push({ value: sourceValue(cur), text: `${cur.label} (not detected)`, source: cur })
  }
  const source = el<HTMLSelectElement>('select')
  for (const o of options) source.append(el<HTMLOptionElement>('option', { value: o.value, textContent: o.text, selected: o.value === sourceValue(cur) }))
  source.onchange = () => {
    const picked = options.find((o) => o.value === source.value)
    if (picked) prestreamer.updateScreen(sc.id, { look: { ...sc.look, source: picked.source } })
  }
  const detect = el('button', { textContent: 'Detect cameras', onclick: detectCameras })

  const form = el('div', { className: 'form' })
  form.append(
    el('span', { textContent: 'Video source' }), source,
    el('span'), detect,
    el('span', { textContent: 'Font size' }), size,
    el('span', { textContent: 'Text color' }), color,
    el('span', { textContent: 'Section label' }), label,
    el('span', { textContent: 'Show backgrounds' }), media,
    el('span', { textContent: 'Play video sound' }), vsound,
    el('span', { textContent: 'Sound output' }), outSel,
  )
  $('look').replaceChildren(swatches, form)
}

/** Labels are only exposed after camera permission is granted, so open and close one stream first. */
async function detectCameras(): Promise<void> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ video: true })
    probe.getTracks().forEach((t) => t.stop())
  } catch (err) {
    streamStatus = { ...streamStatus, message: `Camera access failed: ${(err as Error).message}` }
    renderStream()
    return
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  cameras = devices.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label }))
  renderLook()
}

// --- Stream panel ---------------------------------------------------------------------------

const streamUi = {
  screen: el<HTMLSelectElement>('select'),
  mode: el<HTMLSelectElement>('select'),
  key: el<HTMLInputElement>('input', { type: 'password', placeholder: 'YouTube stream key' }),
  forget: el<HTMLButtonElement>('button', { textContent: 'Forget saved key' }),
  hint: el('div', { className: 'status' }),
  button: el<HTMLButtonElement>('button'),
  status: el('div', { className: 'status' }),
}

function buildStream(): void {
  streamUi.mode.append(
    el<HTMLOptionElement>('option', { value: 'file', textContent: 'Local test file' }),
    el<HTMLOptionElement>('option', { value: 'youtube', textContent: 'YouTube (RTMP)' }),
  )
  streamUi.mode.onchange = renderStream
  streamUi.forget.onclick = async () => { await prestreamer.streamKeyForget(); keySaved = false; renderStream() }
  streamUi.button.onclick = async () => {
    const active = streamStatus.state === 'running' || streamStatus.state === 'starting'
    try {
      if (active) await prestreamer.streamStop()
      else {
        await prestreamer.streamStart({ screenId: streamUi.screen.value, mode: streamUi.mode.value as 'file' | 'youtube', streamKey: streamUi.key.value.trim() || undefined })
        streamUi.key.value = ''
        keySaved = await prestreamer.streamKeySaved()
        renderStream()
      }
    } catch (err) {
      streamStatus = { ...streamStatus, state: 'error', message: (err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') }
      renderStream()
    }
  }
  const form = el('div', { className: 'form' })
  form.append(el('span', { textContent: 'Screen' }), streamUi.screen, el('span', { textContent: 'Target' }), streamUi.mode, el('span', { textContent: 'Stream key' }), streamUi.key)
  $('stream').replaceChildren(form, el('div', { className: 'form' }, el('span'), streamUi.button, el('span'), streamUi.forget), streamUi.status, streamUi.hint)
}

function renderStream(): void {
  $('onair').hidden = streamStatus.state !== 'running'
  const keep = streamUi.screen.value
  streamUi.screen.replaceChildren(
    ...state.screens.filter((s) => s.kind === 'virtual').map((s) => el<HTMLOptionElement>('option', { value: s.id, textContent: s.name, selected: s.id === keep })),
  )
  const active = streamStatus.state === 'running' || streamStatus.state === 'starting'
  const youtube = streamUi.mode.value === 'youtube'
  streamUi.key.disabled = !youtube || active
  streamUi.key.placeholder = keySaved ? 'Saved — leave empty to use it' : 'YouTube stream key (saved once)'
  streamUi.forget.style.display = youtube && keySaved && !active ? '' : 'none'
  streamUi.hint.textContent = youtube
    ? 'The key is stored encrypted by the OS. In YouTube Studio, enable auto-start on the broadcast bound to this key (or schedule one), otherwise the stream connects but does not go live.'
    : ''
  streamUi.mode.disabled = streamUi.screen.disabled = active
  streamUi.button.textContent = active ? 'Stop streaming' : 'Start streaming'
  streamUi.button.className = active ? 'danger' : 'primary'
  streamUi.status.className = `status ${streamStatus.state}`
  const secs = streamStatus.startedAt ? Math.floor((Date.now() - streamStatus.startedAt) / 1000) : 0
  streamUi.status.textContent =
    streamStatus.state === 'running'
      ? `● LIVE → ${streamStatus.target}\n${secs}s · ${streamStatus.frames} frames · ${streamStatus.dropped} dropped`
      : streamStatus.state === 'starting'
        ? 'Starting…'
        : streamStatus.message
}

// --- Audio panel ----------------------------------------------------------------------------
// A Behringer Wing's USB interface shows up as one multichannel input device (48 channels at 48 kHz).
// Route the STREAM bus to USB outputs 1-2 on the console, or pick any other channel pair here.

const audioUi = {
  source: el<HTMLSelectElement>('select'),
  delay: el<HTMLInputElement>('input', { type: 'number', value: '0', step: '10', min: '0', max: '2000' }),
  detect: el<HTMLButtonElement>('button', { textContent: 'Detect audio devices' }),
  apply: el<HTMLButtonElement>('button', { className: 'primary', textContent: 'Apply' }),
  status: el('div', { className: 'status' }),
}

const audioSourceValue = (s: AudioSource) => (s.type === 'device' ? `device:${s.deviceId}` : s.type)

function buildAudio(): void {
  audioUi.detect.onclick = detectAudio
  audioUi.apply.onclick = async () => {
    const value = audioUi.source.value
    const device = audioDevices.find((d) => `device:${d.deviceId}` === value)
    const source: AudioSource = device ? { type: 'device', ...device } : value === 'test' ? { type: 'test' } : value === 'multitest' ? { type: 'multitest' } : { type: 'silence' }
    audioCfg = { source, delayMs: Number(audioUi.delay.value) }
    audioStatus = { ...audioStatus, state: 'idle', message: 'Applying…' }
    renderAudio()
    try {
      audioStatus = await prestreamer.audioConfigure(audioCfg)
    } catch (err) {
      audioStatus = { state: 'error', message: (err as Error).message, channelCount: 0 }
    }
    renderAudio()
  }
  const form = el('div', { className: 'form' })
  form.append(
    el('span', { textContent: 'Source' }), audioUi.source,
    el('span'), audioUi.detect,
    el('span', { textContent: 'A/V delay (ms)' }), audioUi.delay,
    el('span'), audioUi.apply,
  )
  $('audio').replaceChildren(form, audioUi.status)
}

async function detectAudio(): Promise<void> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
    probe.getTracks().forEach((t) => t.stop())
  } catch (err) {
    audioStatus = { state: 'error', message: `Microphone access failed: ${(err as Error).message}`, channelCount: 0 }
    return renderAudio()
  }
  const devices = await navigator.mediaDevices.enumerateDevices()
  audioOutputs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ deviceId: d.deviceId, label: d.label }))
  audioDevices = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ deviceId: d.deviceId, label: d.label }))
  renderAudio()
}

function renderAudio(): void {
  mixerView.setStatus(audioStatus)
  const keep = audioUi.source.value || audioSourceValue(audioCfg.source)
  const options = [
    { value: 'silence', text: 'Silence' },
    { value: 'test', text: 'Test beep (A/V sync check)' },
    { value: 'multitest', text: 'Multichannel test tones (mixer check)' },
    ...audioDevices.map((d) => ({ value: `device:${d.deviceId}`, text: d.label || d.deviceId })),
  ]
  audioUi.source.replaceChildren(...options.map((o) => el<HTMLOptionElement>('option', { value: o.value, textContent: o.text, selected: o.value === keep })))
  audioUi.status.className = `status ${audioStatus.state === 'running' ? 'running' : audioStatus.state}`
  audioUi.status.textContent = audioStatus.message + (audioStatus.state === 'running' && audioCfg.source.type === 'device' ? '\n(Switching between silence and a live source takes effect on the next stream start.)' : '')
}

function renderDisplays(): void {
  $('displays').replaceChildren(
    ...state.displays.map((d) => el('div', { className: 'row', textContent: `${d.label} — ${d.width}×${d.height}${d.primary ? ' (primary)' : ''}` })),
  )
}

function renderAll(): void {
  renderTabs()
  applyView()
  renderSchedule()
  renderLibrary()
  renderCenter()
  renderScreens()
  renderLook()
  renderStream()
  renderAudio()
  renderDisplays()
}

function step(delta: number): void {
  // Inside a service, keep going across items; otherwise stay within the browsed song.
  const list = selectedItemId ? serviceSlides() : currentSlides()
  if (!list.length) return
  let i = list.findIndex((s) => sameSlide(state.slide, s))
  if (i < 0) i = delta > 0 ? -1 : list.length
  const next = list[Math.min(list.length - 1, Math.max(0, i + delta))]
  if (next.itemId) selectedItemId = next.itemId // the schedule highlight follows the live slide
  void prestreamer.showSlide(next)
}

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select, textarea')) return
  if (view !== 'present' || !$('modal').hidden) return
  if (e.key === ' ' && state.slide?.video) { e.preventDefault(); void prestreamer.playbackCommand({ type: playback.playing ? 'pause' : 'play' }) }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); step(1) }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
  else if (e.key === 'Escape') prestreamer.showSlide(null)
})

const mixerView = createMixerView($('view-mixer'), prestreamer)

// --- Tabs, toolbars and global handlers ----------------------------------------------------------

const TABS: { view: View; icon: IconName; label: string }[] = [
  { view: 'present', icon: 'present', label: 'Present' },
  { view: 'songs', icon: 'songs', label: 'Songs' },
  { view: 'mixer', icon: 'sliders', label: 'Mixer' },
]

function renderTabs(): void {
  $('tabs').replaceChildren(...TABS.map((t) => iconButton(t.icon, t.label, () => setView(t.view), { label: t.label, className: view === t.view ? 'on' : '' })))
}

function applyView(): void {
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view))
}

function setView(next: View): void {
  view = next
  if (next === 'songs' && !editing) {
    const first = songById(songId) ?? songs[0]
    if (first) editing = { song: structuredClone(first), isNew: false }
  }
  renderAll()
  if (next === 'songs') showEditor()
  if (next === 'mixer') mixerView.show()
}

$('servicesel').onchange = (e) => { serviceId = (e.target as HTMLSelectElement).value; selectedItemId = null; renderAll() }
$('servicename').onchange = (e) => { const name = (e.target as HTMLInputElement).value.trim(); if (name) void mutateService((d) => { d.name = name }) }
$('songfilter').oninput = (e) => { songFilter = (e.target as HTMLInputElement).value; renderLibrary() }

async function newService(): Promise<void> {
  const svc: Service = { id: crypto.randomUUID(), name: `Service ${new Date().toISOString().slice(0, 10)}`, items: [] }
  services = await prestreamer.servicesSave(svc)
  serviceId = svc.id
  selectedItemId = null
  renderAll()
}

let delArmed = false
const delService = iconButton('trash', 'Delete this service (click twice)', async () => {
  const svc = currentService()
  if (!svc) return
  if (!delArmed) { delArmed = true; delService.className = 'ib danger'; setTimeout(() => { delArmed = false; delService.className = 'ib' }, 3000); return }
  delArmed = false
  delService.className = 'ib'
  services = await prestreamer.servicesDelete(svc.id)
  serviceId = services[0]?.id ?? ''
  selectedItemId = null
  renderAll()
})

$('svctools').append(iconButton('plus', 'New service', () => void newService()), delService)
$('addtools').append(iconButton('music', 'Add a song to the run sheet', openSongPicker, { badge: true }), iconButton('film', 'Add a video to the run sheet', () => void addVideoToService(), { badge: true }))
$('screentools').append(iconButton('screen', 'Add a virtual screen', () => void prestreamer.addVirtual(`Virtual ${state.screens.length + 1}`, 1920, 1080), { badge: true }))
$('songtools').append(iconButton('plus', 'New song', () => startEdit({ id: crypto.randomUUID(), title: 'New song', body: '[Verse 1]\n\n', background: { kind: 'css', css: BACKGROUNDS[0] } }, true)))
$('headbtns').append(
  iconButton('x', 'Clear all screens (Esc)', () => void prestreamer.showSlide(null), { label: 'Clear' }),
  iconButton('stop', 'Turn all screens off', () => state.live.forEach((id) => void prestreamer.setLive(id, false)), { label: 'All off' }),
)

prestreamer.onVideoProgress((pct) => { $('videostatus').className = 'status'; $('videostatus').textContent = `Converting… ${pct}%` })
prestreamer.onPlayback((st) => { playback = st; cards.forEach((c) => c.pv.setPlayback(st)); updateTransport(); renderSchedule() })
prestreamer.playbackGet().then((st) => { playback = st })
void navigator.mediaDevices.enumerateDevices().then((d) => { audioOutputs = d.filter((x) => x.kind === 'audiooutput' && x.deviceId !== 'default' && x.deviceId !== 'communications').map((x) => ({ deviceId: x.deviceId, label: x.label })) })
buildStream()
buildAudio()
prestreamer.onAudio((s) => { audioStatus = s; renderAudio() })
prestreamer.audioGetStatus().then((s) => { audioStatus = s; renderAudio() })
prestreamer.onState((s) => { state = s; renderAll() })
prestreamer.onStream((s) => { streamStatus = s; renderStream() })
prestreamer.servicesList().then((l) => { services = l; serviceId = l[0]?.id ?? ''; renderAll() })
prestreamer.songsList().then((l) => { songs = l; songId = l[0]?.id ?? ''; renderAll() })
prestreamer.streamKeySaved().then((v) => { keySaved = v; renderStream() })
prestreamer.getState().then((s) => { state = s; renderAll() })
prestreamer.streamGetStatus().then((s) => { streamStatus = s; renderStream() })

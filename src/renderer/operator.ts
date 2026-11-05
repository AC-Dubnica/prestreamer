import type { PrestreamerApi } from '../preload'
import { appliesTo, type QuickMessage } from '../shared/announce'
import { mediaThumb, pickBackground } from './background-picker'
import { applyDefaultBackground, defaultAppearance, isLogoSlide, logoSlide, type Appearance } from '../shared/appearance'
import { presentationSlides } from '../shared/presentation'
import { SONG_DETAIL_FIELDS, parseSong, readingSlides, trimSlideBackgrounds, withSlideBackground } from '../shared/songs'
import { defaultAudio, defaultLook, idleAudio, idlePlayback, idleStream, type PlaybackState, type AudioConfig, type Service, type ServiceItem, type AudioSource, type AudioStatus, type Background, type ScreenConfig, type ScreenState, type Slide, type Song, type StreamStatus, type VideoSource } from '../shared/types'
import { iconButton, iconSvg, type IconName } from './icons'
import { openAnnounceDialog } from './announce-dialog'
import { createBibleView } from './bible'
import { createAtemPanel } from './atem-panel'
import { askText, confirmDialog } from './dialogs'
import { createMixerView, type MixerDeps } from './mixer'
import { createMonitorView } from './monitor'
import { openScreenDialog } from './screen-dialog'
import { createSettingsView } from './settings'
import { openStreamSettings } from './stream-dialog'
import { ENCODER_CHOICES, defaultStreamSettings, type StreamSettings } from '../shared/stream-settings'
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

let state: ScreenState = { screens: [], displays: [], live: [], slide: null, announcement: null, cameraOnly: false, next: null }
let quickMessages: QuickMessage[] = []
let streamSettings: StreamSettings = defaultStreamSettings
let songs: Song[] = []
let songId = ''
type View = 'present' | 'monitor' | 'songs' | 'bible' | 'mixer' | 'settings'
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
// What the operator left selected last time (the tab, the service, the screen whose look the thumbnails use).
const MEMORY_KEYS = { view: 'prestreamer.view', service: 'prestreamer.service', screen: 'prestreamer.screen' } as const
const recallText = (key: string): string => { try { return localStorage.getItem(key) ?? '' } catch { return '' } }
const rememberText = (key: string, value: string) => { try { localStorage.setItem(key, value) } catch { /* only a convenience */ } }
const VIEWS: readonly string[] = ['present', 'monitor', 'songs', 'bible', 'mixer', 'settings']
const savedView = recallText(MEMORY_KEYS.view)
const savedService = recallText(MEMORY_KEYS.service)
let selectedScreenId: string | null = recallText(MEMORY_KEYS.screen) || null
function rememberSelection(): void {
  rememberText(MEMORY_KEYS.view, view)
  if (serviceId) rememberText(MEMORY_KEYS.service, serviceId)
  if (selectedScreenId) rememberText(MEMORY_KEYS.screen, selectedScreenId)
}
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
/** App-wide backgrounds from Settings: used for songs and readings that bring no picture or video of their own. */
let appearance: Appearance = defaultAppearance
const songSlides = (song: Song, itemId?: string): Slide[] => withItem(applyDefaultBackground(parseSong(song), appearance.songBackground), itemId)
const readingOf = (it: Extract<ServiceItem, { kind: 'scripture' }>): Slide[] => withItem(applyDefaultBackground(readingSlides(it.slides, it.background, it.slideBackgrounds), appearance.scriptureBackground), it.id)
const currentSlides = (): Slide[] => {
  const it = selectedItem()
  if (it?.kind === 'scripture') return readingOf(it)
  const c = currentSong()
  return c ? songSlides(c, selectedItemId ?? undefined) : []
}
/** Every slide of the service in order: lets the arrow keys run on from one item into the next. */
const serviceSlides = (): Slide[] =>
  (currentService()?.items ?? []).flatMap((it) => {
    if (it.kind === 'video') return [videoCue(it)]
    if (it.kind === 'scripture') return readingOf(it)
    if (it.kind === 'presentation') return presentationSlides(it)
    const song = songOfItem(it)
    return song ? songSlides(song, it.id) : []
  })
const sameSlide = (a: Slide | null, b: Slide) => !!a && a.label === b.label && a.text === b.text && a.itemId === b.itemId && a.picture?.file === b.picture?.file

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
  sel.replaceChildren(...services.map((x) => el<HTMLOptionElement>('option', { value: x.id, textContent: `${x.name} · ${x.items.length} item${x.items.length === 1 ? '' : 's'}`, selected: x.id === svc?.id })))
  sel.disabled = !svc
  for (const b of serviceButtons.needsService) b.disabled = !svc
  if (!svc) {
    return $('schedule').replaceChildren(
      el('div', { className: 'emptystate' }, el('p', { textContent: 'No service yet.' }), el('button', { className: 'primary', textContent: 'Create a service', onclick: () => void newService() })),
    )
  }

  const liveItem = state.slide?.itemId
  const rows = svc.items.map((it, idx) => {
    const kind: IconName = it.kind === 'video' ? 'film' : it.kind === 'scripture' ? 'book' : it.kind === 'presentation' ? 'presentation' : 'music'
    const title = it.kind === 'song' ? (songOfItem(it)?.title ?? '(deleted song)') : it.title
    const swap = (a: number, b: number) => void mutateService((d) => { [d.items[a], d.items[b]] = [d.items[b], d.items[a]] })
    const tool = (name: IconName, tip: string, fn: () => void, disabled = false) => iconButton(name, tip, (e) => { e.stopPropagation(); fn() }, { size: 14, disabled })
    const kindIcon = el('span', { className: 'kind' })
    kindIcon.innerHTML = iconSvg(kind, 15)
    return el('div', { className: `srow ${it.id === selectedItemId ? 'sel' : ''}`, title: idx < 9 ? `Jump to this item: ${MOD_KEY}${idx + 1}. Then → or Space starts it.` : 'Jump to this item', onclick: () => jumpToItem(it.id) },
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
    status.textContent = ''
  } catch (err) {
    status.className = 'status error'
    status.textContent = `Import failed: ${(err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`
  }
}

/** A picture or video was deleted from the library: songs and readings that used it go back to the plain background. */
async function forgetMedia(file: string): Promise<void> {
  const uses = (b?: Background | null): boolean => !!b && b.kind !== 'css' && b.file === file
  const drop = (b: Background | null | undefined): Background | null | undefined => (uses(b) ? null : b)
  for (const s of songs) {
    if (uses(s.background) || s.slideBackgrounds?.some(uses)) songs = await prestreamer.songsSave({ ...s, background: drop(s.background) ?? null, slideBackgrounds: s.slideBackgrounds?.map((b) => drop(b) ?? null) })
  }
  for (const svc of services) {
    const touches = svc.items.some((i) => i.kind === 'scripture' && (uses(i.background) || i.slideBackgrounds?.some(uses)))
    if (!touches) continue
    const draft = structuredClone(svc)
    for (const i of draft.items) if (i.kind === 'scripture') { i.background = drop(i.background); i.slideBackgrounds = i.slideBackgrounds?.map((b) => drop(b) ?? null) }
    services = await prestreamer.servicesSave(draft)
  }
  if (editing?.song && uses(editing.song.background)) editing.song.background = null
  if (editing?.song.slideBackgrounds?.some(uses)) editing.song.slideBackgrounds = editing.song.slideBackgrounds.map((b) => drop(b) ?? null)
  renderAll()
}

/** Adds one or more pictures, each shown whole as a slide, like a presentation. */
async function addPicturesToService(): Promise<void> {
  const status = $('videostatus')
  if (!currentService()) { status.textContent = 'Create a service first'; return }
  status.className = 'status'
  try {
    const pics = await prestreamer.picturesImport()
    if (pics) await mutateService((svc) => { svc.items.push({ id: crypto.randomUUID(), kind: 'presentation', title: pics.title, slides: pics.slides }) })
    status.textContent = ''
  } catch (err) {
    status.className = 'status error'
    status.textContent = `Import failed: ${(err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`
  }
}

/** Adds a PowerPoint / Keynote / PDF deck: each slide becomes a picture, shown whole on every screen. */
async function addPresentationToService(): Promise<void> {
  const status = $('videostatus')
  if (!currentService()) { status.textContent = 'Create a service first'; return }
  status.className = 'status'
  status.textContent = 'Choosing…'
  try {
    const deck = await prestreamer.presentationImport()
    if (deck) await mutateService((svc) => { svc.items.push({ id: crypto.randomUUID(), kind: 'presentation', title: deck.title, slides: deck.slides }) })
    status.textContent = '' // the new item in the run sheet is the confirmation
  } catch (err) {
    status.className = 'status error'
    status.textContent = `Import failed: ${(err as Error).message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')}`
  }
}

/** The slides the arrow keys walk through: the whole service in order, or the browsed song when the service is empty. */
const navSlides = (): Slide[] => ((currentService()?.items.length ?? 0) > 0 ? serviceSlides() : currentSlides())

/** Item that was just clicked in the run sheet: the slide view scrolls to it and its title pins to the top. */
let jumpTo: string | null = null
/** After a jump, the next arrow key starts that item (its first slide) instead of carrying on from where the show was. */
let pendingStart: string | null = null
const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

/** Selects a run-sheet item, scrolls the slide view to it, and arms it to start with the next arrow key. */
function jumpToItem(id: string): void {
  selectedItemId = id
  jumpTo = id
  pendingStart = id
  if (view !== 'present') setView('present')
  else renderAll()
}
let lastLiveKey = ''

/**
 * The slide view shows the whole service as one list: each item's title (it stays pinned at the top while you scroll
 * through that item) and all its slides in one grid that uses the full width. The next song is right below, so the
 * arrow keys flow from one into the next without changing the view.
 */
function renderCenter(): void {
  const ref = state.screens.find((s) => s.id === selectedScreenId) ?? state.screens[0]
  const root = $('center')
  transport = null
  const top = root.scrollTop
  const items = currentService()?.items ?? []

  /** What can be changed about the pictures behind a song's or reading's slides. */
  interface BgEdit { name: string; ownOf(index: number): Background | null; forSlide(index: number): void; forAll(): void }
  const slideGrid = (slides: Slide[], edit?: BgEdit): HTMLElement => {
    const grid = el('div', { className: 'grid' })
    slides.forEach((sl, i) => {
      const pv = scaledPreview()
      if (ref) pv.update(ref.look, sl, 1920, 1080, false) // thumbnails stay static
      const card = el('div', { className: `card ${sameSlide(state.slide, sl) ? 'live' : ''}`, onclick: () => prestreamer.showSlide(sl) })
      const tag = el('div', { className: 'tag', textContent: sl.label })
      tag.style.background = sectionColor(sl.label)
      card.append(tag, pv.box)
      if (edit) {
        const own = !!edit.ownOf(i)
        card.append(iconButton('image', own ? 'This slide has its own picture or video. Click to change or remove it.' : 'A picture or video behind this slide only', (e) => { e.stopPropagation(); edit.forSlide(i) }, { size: 13, className: `cardbg ${own ? 'on' : ''}` }))
      }
      grid.append(card)
    })
    return grid
  }
  /** The button in a section's title that sets one picture or video for all its slides at once. */
  const allSlidesButton = (edit: BgEdit): HTMLElement => iconButton('image', `A picture or video behind all slides of ${edit.name}`, edit.forAll, { size: 14, label: 'Background' })

  const songEdit = (song: Song): BgEdit => ({
    name: song.title,
    ownOf: (i) => song.slideBackgrounds?.[i] ?? null,
    forSlide: async (i) => {
      const bg = await pickBackground(prestreamer, song.slideBackgrounds?.[i] && song.slideBackgrounds[i]!.kind !== 'css' ? song.slideBackgrounds[i] : null, { title: `Background for slide ${i + 1} only`, noneLabel: "Use the song's background", noneHint: 'This slide goes back to the background of the whole song', onDeleted: (f) => void forgetMedia(f) })
      if (bg === undefined) return
      const slideBackgrounds = withSlideBackground(song.slideBackgrounds, i, bg)
      songs = await prestreamer.songsSave({ ...song, slideBackgrounds })
      if (editing?.song.id === song.id) editing.song.slideBackgrounds = slideBackgrounds // an open editor must not overwrite it later
      renderAll()
    },
    forAll: async () => {
      const bg = await pickBackground(prestreamer, song.background && song.background.kind !== 'css' ? song.background : null, { title: `Background for all slides of ${song.title}`, onDeleted: (f) => void forgetMedia(f) })
      if (bg === undefined) return
      songs = await prestreamer.songsSave({ ...song, background: bg, slideBackgrounds: [] }) // one picture for every slide: the single-slide ones are reset
      if (editing?.song.id === song.id) { editing.song.background = bg; editing.song.slideBackgrounds = [] }
      renderAll()
    },
  })
  const readingEdit = (it: Extract<ServiceItem, { kind: 'scripture' }>): BgEdit => ({
    name: it.title,
    ownOf: (i) => it.slideBackgrounds?.[i] ?? null,
    forSlide: async (i) => {
      const bg = await pickBackground(prestreamer, it.slideBackgrounds?.[i] && it.slideBackgrounds[i]!.kind !== 'css' ? it.slideBackgrounds[i] : null, { title: `Background for slide ${i + 1} only`, noneLabel: "Use the reading's background", onDeleted: (f) => void forgetMedia(f) })
      if (bg === undefined) return
      void mutateService((svc) => { const x = svc.items.find((n) => n.id === it.id); if (x?.kind === 'scripture') x.slideBackgrounds = withSlideBackground(x.slideBackgrounds, i, bg) })
    },
    forAll: async () => {
      const bg = await pickBackground(prestreamer, it.background && it.background.kind !== 'css' ? it.background : null, { title: `Background for all slides of ${it.title}`, onDeleted: (f) => void forgetMedia(f) })
      if (bg === undefined) return
      void mutateService((svc) => { const x = svc.items.find((n) => n.id === it.id); if (x?.kind === 'scripture') { x.background = bg; x.slideBackgrounds = [] } })
    },
  })
  const section = (id: string | null, title: (Node | string)[], body: HTMLElement[]): HTMLElement => {
    const sec = el('section', { className: `slist ${id !== null && id === selectedItemId ? 'sel' : ''}` }, el('h1', {}, ...title), ...body)
    if (id) sec.dataset.item = id
    return sec
  }

  const sections: HTMLElement[] = []
  if (!items.length) {
    // No service items yet: show the song being browsed, so there is always something to look at.
    const song = currentSong()
    if (!song) return root.replaceChildren(el('div', { className: 'row', textContent: 'Select an item in the run sheet, or add songs in the Songs tab.' }))
    sections.push(section(null, [song.title, iconButton('pencil', 'Edit this song', () => startEdit(song), { className: 'ml' })], [slideGrid(songSlides(song))]))
  }
  for (const it of items) {
    if (it.kind === 'video') {
      sections.push(section(it.id, [`🎬 ${it.title}`], [renderVideoPanel(it, ref, it.id === selectedItemId)]))
    } else if (it.kind === 'presentation') {
      sections.push(section(it.id, [it.title], [slideGrid(presentationSlides(it))]))
    } else if (it.kind === 'scripture') {
      const edit = readingEdit(it)
      sections.push(section(it.id, [it.title, allSlidesButton(edit)], [slideGrid(readingOf(it), edit)]))
    } else {
      const song = songOfItem(it)
      if (!song) continue
      const edit = songEdit(song)
      sections.push(section(it.id, [song.title, iconButton('pencil', 'Edit this song', () => startEdit(song), { className: 'ml' }), allSlidesButton(edit)], [slideGrid(songSlides(song, it.id), edit)]))
    }
  }
  // Room after the last item, so that item too can be scrolled up to the top.
  root.replaceChildren(...sections, el('div', { className: 'slistend' }))
  root.scrollTop = top

  const target = jumpTo ? sections.find((x) => x.dataset.item === jumpTo) : undefined
  jumpTo = null
  if (target) {
    root.scrollTop = target.offsetTop - root.offsetTop
  } else {
    // The live slide changed (arrow keys, a click elsewhere): bring it into view if it is not.
    const live = root.querySelector<HTMLElement>('.card.live:not(.vcard)')
    const key = state.slide ? `${state.slide.itemId ?? ''}|${state.slide.label}|${state.slide.text}` : ''
    if (live && key !== lastLiveKey) live.scrollIntoView({ block: 'nearest' })
    lastLiveKey = key
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

/** One video item's card and transport controls. Only the selected video's controls follow the playback position. */
function renderVideoPanel(it: Extract<ServiceItem, { kind: 'video' }>, ref: ScreenConfig | undefined, selected: boolean): HTMLElement {
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
  if (selected || !transport) transport = t
  const panel = el('div', {}, el('div', { className: 'vpanel' }, card, el('div', { className: 'vt' }, toggle, stop, show, seek, time)), el('div', { className: 'row', textContent: 'Space plays or pauses a video that is on screen. → moves on to the next item and stops it. Sound plays from the screen with "Play video sound" on.' }))
  updateTransport()
  return panel
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
  title.oninput = () => { draft.title = title.value; markDirty() }

  const body = el<HTMLTextAreaElement>('textarea', { value: draft.body, rows: 16, spellcheck: false })
  body.oninput = () => { updatePreview(); renderStripSoon(); markDirty() }

  // What a song carries is saved with it by Save: its text, pictures and videos (for the whole song and for single slides) and details.
  const snapshot = (x: Song): string => JSON.stringify([x.title.trim() || 'Untitled', x.body, x.background ?? null, trimSlideBackgrounds(x.slideBackgrounds, parseSong(x).length), SONG_DETAIL_FIELDS.map((f) => x[f.key] ?? '')])
  const dirtyNote = el('span', { className: 'dim dirty' })
  const markDirty = () => {
    const saved = songs.find((x) => x.id === draft.id)
    dirtyNote.textContent = editing!.isNew || !saved || snapshot(saved) !== snapshot({ ...draft, body: body.value }) ? 'Unsaved changes' : ''
  }

  const pv = scaledPreview()
  let selSlide = 0
  /** The slide as it will look: its own picture, else the song's, else the app-wide one for songs. */
  const withDefaults = (sl: Slide): Slide => applyDefaultBackground([sl], appearance.songBackground)[0]
  const previewLook = () => ({ ...(ref?.look ?? defaultLook), showMedia: true, source: { type: 'none' } as VideoSource })
  const updatePreview = () => {
    draft.body = body.value
    const list = parseSong(draft)
    selSlide = Math.min(selSlide, Math.max(0, list.length - 1))
    const cur = list[selSlide] ?? { label: 'Preview', text: 'Type some text', background: draft.background }
    pv.update(previewLook(), withDefaults(cur), 1920, 1080, true)
  }

  // Every slide of the song as a small card: click to preview it, the picture button gives that slide its own picture or video.
  const strip = el('div', { className: 'sstrip' })
  let stripPreviews: ScaledPreview[] = []
  let stripTimer: ReturnType<typeof setTimeout> | null = null
  const renderStrip = () => {
    stripPreviews.forEach((p) => p.dispose())
    stripPreviews = []
    draft.body = body.value
    const list = parseSong(draft)
    strip.replaceChildren(...list.map((sl, i) => {
      const small = scaledPreview()
      stripPreviews.push(small)
      small.update(previewLook(), withDefaults(sl), 1920, 1080, false)
      const own = !!draft.slideBackgrounds?.[i]
      const tag = el('div', { className: 'tag', textContent: sl.label })
      tag.style.background = sectionColor(sl.label)
      const card = el('div', { className: `card ${i === selSlide ? 'pick' : ''}`, onclick: () => { selSlide = i; updatePreview(); renderStrip() } }, tag, small.box)
      card.append(iconButton('image', own ? 'This slide has its own picture or video, saved with the song. Click to change or remove it.' : 'A picture or video behind this slide only, saved with the song', async (e) => {
        e.stopPropagation()
        const bg = await pickBackground(prestreamer, draft.slideBackgrounds?.[i] && draft.slideBackgrounds[i]!.kind !== 'css' ? draft.slideBackgrounds[i] : null, { title: `Background for slide ${i + 1} only`, noneLabel: "Use the song's background", onDeleted: (f) => void forgetMedia(f) })
        if (bg === undefined) return
        draft.slideBackgrounds = withSlideBackground(draft.slideBackgrounds, i, bg)
        selSlide = i
        updatePreview(); renderStrip(); markDirty()
      }, { size: 13, className: `cardbg ${own ? 'on' : ''}` }))
      return card
    }))
    if (!list.length) strip.replaceChildren(el('div', { className: 'dim', textContent: 'Slides appear here as you type.' }))
  }
  const renderStripSoon = () => { if (stripTimer) clearTimeout(stripTimer); stripTimer = setTimeout(renderStrip, 300) }

  const setBackground = (bg: Background | null) => { draft.background = bg; updatePreview(); renderStrip(); renderBgLabel(); markDirty() }
  const bgLabel = el('span', { className: 'meta bgcur' })
  let mediaNames = new Map<string, string>()
  void prestreamer.mediaList().then((list) => { mediaNames = new Map(list.map((m) => [m.file, m.name])); renderBgLabel() })
  const renderBgLabel = () => {
    const b = draft.background
    if (b && b.kind !== 'css') bgLabel.replaceChildren(mediaThumb(b), el('span', { textContent: `${b.kind === 'image' ? 'Picture' : 'Video'}: ${mediaNames.get(b.file) ?? b.file.slice(0, 8)}` }))
    else bgLabel.replaceChildren(el('span', { textContent: !b ? 'none' : 'gradient / colour' }))
  }
  const swatches = el('div', { className: 'sw nopad' })
  for (const css of BACKGROUNDS) {
    const b = el('button', { title: css, onclick: () => setBackground({ kind: 'css', css }) })
    b.style.background = css
    swatches.append(b)
  }
  const chooseBtn = iconButton('screen', 'Choose a picture or a looping video from your library, or import a new one', async () => {
    const bg = await pickBackground(prestreamer, draft.background && draft.background.kind !== 'css' ? draft.background : null, { title: 'Background for all slides of this song', onDeleted: (f) => void forgetMedia(f) })
    if (bg !== undefined) { setBackground(bg); void prestreamer.mediaList().then((list) => { mediaNames = new Map(list.map((m) => [m.file, m.name])); renderBgLabel() }) }
  }, { badge: true, label: 'Picture or video…' })

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
    draft.slideBackgrounds = trimSlideBackgrounds(draft.slideBackgrounds, parseSong(draft).length)
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
  const addToService = iconButton('music', 'Add this song to the current service', () => addSongToService(draft.id), { badge: true, label: 'Add to service', className: 'primary', disabled: editing!.isNew })

  // The same details Quelea keeps with a song (author, copyright, CCLI, ...), so nothing is lost when songs come over from Quelea.
  const details = el<HTMLDetailsElement>('details', { className: 'sdetails' }, el('summary', { textContent: 'Song details: author, copyright, CCLI, key, capo, notes' }),
    el('div', { className: 'sdgrid' }, ...SONG_DETAIL_FIELDS.flatMap((f) => {
      const input = el<HTMLInputElement>('input', { type: 'text', value: draft[f.key] ?? '', maxLength: 200 })
      input.oninput = () => { if (input.value) draft[f.key] = input.value; else delete draft[f.key]; markDirty() }
      return [el('label', { textContent: f.label }), input]
    })))
  details.open = SONG_DETAIL_FIELDS.some((f) => !!draft[f.key])

  const form = el('div', { className: 'editor' })
  form.append(
    el('div', { className: 'field' }, el('label', { textContent: 'Title' }), title),
    el('div', { className: 'field' }, el('label', { textContent: 'Background' }), bgLabel, swatches,
      el('div', { className: 'btns' }, el('button', { textContent: 'None', onclick: () => setBackground(null) }), chooseBtn)),
    el('div', { className: 'field' }, el('label', { textContent: 'Text — [Label] starts a section, a blank line starts a new slide' }), body),
    details,
    el('div', { className: 'btns' }, save, revert, ...(editing!.isNew ? [] : [del]), dirtyNote, el('span', { className: 'grow' }), addToService),
  )
  root.replaceChildren(el('h1', { textContent: editing!.isNew ? 'New song' : draft.title }), el('div', { className: 'editorwrap' }, form, el('div', { className: 'editorprev' }, el('label', { textContent: 'Preview' }), pv.box, el('label', { textContent: 'Slides — the picture button sets a picture or video for one slide' }), strip, el('div', { className: 'dim', textContent: 'Pictures and videos are saved with the song, by slide position: adding or removing a slide above one shifts them.' }))))
  renderBgLabel()
  updatePreview()
  renderStrip()
  markDirty()
}

/**
 * Screen cards persist across renders: moving a <video> in the DOM pauses it, and
 * recreating previews would reopen cameras on every state change.
 */
interface Card { root: HTMLElement; bar: HTMLElement; off: HTMLElement; pv: ScaledPreview; grip: HTMLButtonElement }
const cards = new Map<string, Card>()

function createCard(): Card {
  const pv = scaledPreview()
  const off = el('div', { className: 'off', textContent: 'OFF' })
  const bar = el('div', { className: 'bar' })
  const root = el('div', { className: 'screen' }, bar, el('div', { className: 'pv' }, pv.box, off))
  const grip = el<HTMLButtonElement>('button', { className: 'grip', textContent: '⠿' })
  grip.onclick = (e) => e.stopPropagation()
  // Only the grip starts a drag, so the buttons and the preview keep working; ↑ ↓ on the grip move the card too.
  const id = () => root.dataset.id ?? ''
  grip.onpointerdown = () => { root.draggable = true }
  grip.onpointerup = () => { root.draggable = false }
  grip.onkeydown = (e) => {
    const i = state.screens.findIndex((s) => s.id === id())
    const other = state.screens[i + (e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0)]
    if (!other || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
    e.preventDefault()
    void prestreamer.reorderScreen(id(), other.id, e.key === 'ArrowDown').then(() => document.querySelector<HTMLElement>(`.screen[data-id="${CSS.escape(id())}"] .grip`)?.focus())
  }
  root.ondragstart = (e) => {
    if (!root.draggable) return e.preventDefault()
    e.dataTransfer?.setData('text/plain', id())
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    draggingScreen = id()
    root.classList.add('dragging')
  }
  root.ondragend = () => { root.draggable = false; draggingScreen = null; root.classList.remove('dragging'); clearScreenDropMarks() }
  root.ondragover = (e) => {
    if (!draggingScreen || draggingScreen === id()) return
    e.preventDefault()
    const r = root.getBoundingClientRect()
    clearScreenDropMarks()
    root.classList.add(e.clientY > r.top + r.height / 2 ? 'dropafter' : 'dropbefore')
  }
  root.ondragleave = (e) => { if (!root.contains(e.relatedTarget as Node | null)) root.classList.remove('dropbefore', 'dropafter') }
  root.ondrop = (e) => {
    e.preventDefault()
    const from = draggingScreen
    const after = root.classList.contains('dropafter')
    draggingScreen = null
    clearScreenDropMarks()
    if (from && from !== id()) void prestreamer.reorderScreen(from, id(), after)
  }
  return { root, bar, off, pv, grip }
}
let draggingScreen: string | null = null
const clearScreenDropMarks = () => document.querySelectorAll('.screen.dropbefore, .screen.dropafter').forEach((n) => n.classList.remove('dropbefore', 'dropafter'))

let screenDialog: ReturnType<typeof openScreenDialog> | null = null

/** Opens the settings popup of one specific screen. */
function configureScreen(id: string): void {
  screenDialog?.close()
  screenDialog = openScreenDialog(id, {
    api: prestreamer,
    getState: () => state,
    getPlayback: () => playback,
    getCameras: () => cameras,
    getOutputs: () => audioOutputs,
    detectCameras,
    screenSize,
    backgrounds: BACKGROUNDS,
    openSettings: () => setView('settings'),
    reopen: () => configureScreen(id),
    onMediaDeleted: (file) => void forgetMedia(file),
    onClose: () => { screenDialog = null },
  })
}

/** Screens whose preview is folded away (the card keeps its title bar and buttons). Remembered per screen. */
const SCREENS_FOLDED_KEY = 'prestreamer.screensCollapsed'
const foldedScreens = new Set<string>((() => { try { const v = JSON.parse(localStorage.getItem(SCREENS_FOLDED_KEY) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [] } catch { return [] } })())
function toggleFolded(id: string): void {
  if (!foldedScreens.delete(id)) foldedScreens.add(id)
  try { localStorage.setItem(SCREENS_FOLDED_KEY, JSON.stringify([...foldedScreens])) } catch { /* only a convenience */ }
  renderScreens()
}

function renderScreens(): void {
  if ((!selectedScreenId || !state.screens.some((s) => s.id === selectedScreenId)) && state.screens.length) selectedScreenId = state.screens[0].id
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
    // A mirror looks like the screen it follows (its own display only decides the size and where it opens).
    const shown = (sc.mirrorOf && state.screens.find((x) => x.id === sc.mirrorOf)) || sc
    const folded = foldedScreens.has(sc.id)
    if (!folded) { // a folded preview is not drawn at all; it is brought up to date when unfolded
      c.pv.update(shown.look, state.slide, w, h, true, state.cameraOnly && shown.kind === 'virtual') // the stream's card shows what the stream shows
      c.pv.setNext(state.next)
      c.pv.setPlayback(playback)
      c.pv.setAnnouncement(appliesTo(state.announcement, shown.id) ? state.announcement : null) // the operator sees what each screen shows
    }
    c.off.style.display = live ? 'none' : 'flex'
    c.root.dataset.id = sc.id
    c.root.className = `screen ${sc.id === selectedScreenId ? 'sel' : ''}${draggingScreen === sc.id ? ' dragging' : ''}${folded ? ' folded' : ''}`
    // Clicking anywhere on the card selects it (its look is used for the slide thumbnails); the buttons do their own thing.
    c.root.onclick = (e) => {
      if ((e.target as HTMLElement).closest('button')) return
      if (selectedScreenId !== sc.id) { selectedScreenId = sc.id; renderAll() }
    }

    const target = shown !== sc ? `mirrors ${shown.name}` : sc.kind === 'virtual' ? `virtual ${w}×${h}` : sc.displayId === null ? 'window' : (state.displays.find((d) => d.id === sc.displayId)?.label ?? sc.displayLabel ?? 'display')
    c.grip.title = `Drag to change the order of the screens (or press ↑ ↓ on this handle). The order is the same in Settings.`
    c.grip.setAttribute('aria-label', `Move ${sc.name}`)
    c.bar.replaceChildren(
      c.grip,
      iconButton(folded ? 'chevronDown' : 'chevronUp', folded ? `Show the preview of ${sc.name}` : `Fold the preview of ${sc.name} away`, () => toggleFolded(sc.id), { size: 15, className: 'fold' }),
      el('span', { className: `dot ${live ? 'on' : ''}` }),
      el('span', { className: 'name', textContent: sc.name }),
      el('span', { className: 'meta', textContent: target, title: `${w}×${h}` }),
      iconButton('gear', shown !== sc ? `${sc.name} mirrors ${shown.name}: opens the settings of ${shown.name}` : `Settings for ${sc.name}: background, text, video, sound`, () => configureScreen(shown.id), { size: 15 }),
      el('button', { className: live ? 'danger' : 'primary', textContent: live ? 'Close' : 'Open', title: live ? `Close ${sc.name}` : `Open ${sc.name} on its display (or in a window)`, onclick: () => void toggleScreen(sc.id) }),
    )
  }

  // Cards follow the order set in Settings. Only move them when it actually changed, so previews are not disturbed.
  const wanted = state.screens.map((sc) => cards.get(sc.id)!.root)
  if (wanted.some((root, i) => container.children[i] !== root)) container.append(...wanted)
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
  screenDialog?.refresh()
}

// --- Stream panel ---------------------------------------------------------------------------

const streamUi = {
  screen: el<HTMLSelectElement>('select'),
  mode: el<HTMLSelectElement>('select'),
  key: el<HTMLInputElement>('input', { type: 'password', placeholder: 'YouTube stream key' }),
  forget: el<HTMLButtonElement>('button', { textContent: 'Forget saved key' }),
  hint: el('div', { className: 'status' }),
  sound: el<HTMLSelectElement>('select', { title: 'What the stream carries as sound' }),
  audio: el('div', { className: 'status' }),
  button: el<HTMLButtonElement>('button'),
  status: el('div', { className: 'status' }),
  cameraNote: el('div', { className: 'status' }),
}

// --- Stream health (what OBS calls the Stats dock) -------------------------------------------------------------------

const cell = (label: string) => {
  const value = el('div', { className: 'hv', textContent: '—' })
  const sub = el('div', { className: 'hs' })
  return { root: el('div', { className: 'hcell' }, el('div', { className: 'hl', textContent: label }), value, sub), value, sub }
}
const healthUi = {
  dot: el('span', { className: 'hdot' }),
  label: el('b', { textContent: 'Not streaming' }),
  sub: el('span', { className: 'hsub' }),
  bitrate: cell('Bitrate'),
  fps: cell('Frame rate'),
  dropped: cell('Dropped frames'),
  speed: cell('Encoding speed'),
  data: cell('Sent'),
  canvas: el<HTMLCanvasElement>('canvas', { className: 'spark', title: 'Bitrate over the last two minutes; the dashed line is the target' }),
  advice: el('div', { className: 'hadvice' }),
}

/** Camera only: the stream shows nothing but the live camera (no text, slide media, videos or announcements). */
const cameraButton = iconButton('camera', 'Camera only: stream just the live camera, without text, slide backgrounds, videos or announcements. The room screens are not affected. Click again to bring them back.', () => void prestreamer.setCameraOnly(!state.cameraOnly), { size: 15 })

const COLLAPSE_KEY = 'prestreamer.streamCollapsed'
const STATS_KEY = 'prestreamer.statsCollapsed'
const ATEM_KEY = 'prestreamer.atemCollapsed'
const recall = (key: string): boolean => { try { return localStorage.getItem(key) === '1' } catch { return false } }
let streamCollapsed = recall(COLLAPSE_KEY)
let statsCollapsed = recall(STATS_KEY)
let atemCollapsed = recall(ATEM_KEY)
const remember = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? '1' : '0') } catch { /* only a convenience */ } }
/** Makes a title act as a disclosure control: click or Enter/Space toggles it; buttons inside it keep their own job. */
function disclosure(titleEl: HTMLElement, toggle: () => void): void {
  titleEl.classList.add('disclosure')
  titleEl.tabIndex = 0
  titleEl.setAttribute('role', 'button')
  titleEl.addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('button')) toggle() })
  titleEl.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === titleEl) { e.preventDefault(); toggle() } })
}
const toggleSection = () => { streamCollapsed = !streamCollapsed; remember(COLLAPSE_KEY, streamCollapsed); applyCollapse() }
const toggleStats = () => { statsCollapsed = !statsCollapsed; remember(STATS_KEY, statsCollapsed); applyCollapse() }
const toggleAtem = () => { atemCollapsed = !atemCollapsed; remember(ATEM_KEY, atemCollapsed); applyCollapse() }
/** Stream, Stream health and ATEM are sections of the same level, each collapsing on its own. */
function setSection(head: HTMLElement, body: HTMLElement, collapsed: boolean, name: string): void {
  body.classList.toggle('collapsed', collapsed)
  head.classList.toggle('closed', collapsed)
  head.setAttribute('aria-expanded', String(!collapsed))
  head.title = collapsed ? `Click to show the ${name} section` : `Click to collapse the ${name} section`
}
function applyCollapse(): void {
  setSection($('streamtools').parentElement!, $('stream'), streamCollapsed, 'Stream')
  setSection(healthHead, $('healthsec'), statsCollapsed, 'Stream health')
  healthHead.title = statsCollapsed ? 'Click to show the full statistics' : 'Click to collapse the statistics'
  setSection($('atemtools').parentElement!, $('atem'), atemCollapsed, 'ATEM')
}

// The title sits above the panel like "Stream" does; the rating (dot and word) is on its right.
const healthHead = el('div', { className: 'head', id: 'healthtitle' }, el('span', { textContent: 'Stream health' }), el('span', { className: 'tools hrating' }, healthUi.dot, healthUi.label))
const healthRoot = el('div', { className: 'health' },
  el('div', { className: 'hhead' }, healthUi.sub),
  el('div', { className: 'hgrid' }, healthUi.bitrate.root, healthUi.fps.root, healthUi.dropped.root, healthUi.speed.root, healthUi.data.root),
  healthUi.canvas,
  healthUi.advice,
)

const fmt = (n: number) => n.toLocaleString('en-US')
const clock = (sec: number) => [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60].map((n) => String(n).padStart(2, '0')).join(':')

function drawSpark(history: number[], target: number): void {
  const canvas = healthUi.canvas
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth || 300
  const h = canvas.clientHeight || 46
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)
  const max = Math.max(target * 1.25, ...history, 1)
  const y = (v: number) => h - 3 - (v / max) * (h - 6)
  ctx.setLineDash([4, 4])
  ctx.strokeStyle = '#475569'
  ctx.beginPath(); ctx.moveTo(0, y(target)); ctx.lineTo(w, y(target)); ctx.stroke()
  ctx.setLineDash([])
  if (history.length < 2) return
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  history.forEach((v, i) => { const x = w - (history.length - 1 - i) * (w / 120); if (i === 0) ctx.moveTo(x, y(v)); else ctx.lineTo(x, y(v)) })
  ctx.stroke()
}

/** Health rating, then the numbers behind it: bitrate against target, frame rate, dropped frames, encoder speed. */
function renderHealth(): void {
  const st = streamStatus.stats
  const s = streamSettings
  const encoderLabel = ENCODER_CHOICES.find((e) => e.value === s.encoder)?.label ?? s.encoder
  const bad = (cellEl: { root: HTMLElement }, isBad: boolean) => cellEl.root.classList.toggle('bad', isBad)
  if (streamStatus.state !== 'running' || !st) {
    healthUi.dot.className = 'hdot'
    healthUi.label.textContent = 'Not streaming'
    healthUi.sub.textContent = `${s.height}p${s.fps} · ${fmt(s.videoKbps)} kb/s video + ${s.audioKbps} kb/s audio · ${encoderLabel}`
    for (const c of [healthUi.bitrate, healthUi.fps, healthUi.dropped, healthUi.speed, healthUi.data]) { c.value.textContent = '—'; c.sub.textContent = ''; bad(c, false) }
    healthUi.bitrate.sub.textContent = `target ${fmt(s.videoKbps + s.audioKbps)} kb/s`
    healthUi.advice.textContent = ''
    drawSpark([], s.videoKbps + s.audioKbps)
    return
  }
  healthUi.dot.className = `hdot ${st.health}`
  healthUi.label.textContent = { good: 'Good', warn: 'Unstable', poor: 'Poor', idle: 'Not streaming' }[st.health]
  healthUi.sub.textContent = `LIVE ${clock(st.uptimeSec)} · ${st.encoder} · ${st.width}×${st.height} @ ${st.targetFps}`
  healthUi.bitrate.value.textContent = `${fmt(st.bitrateKbps)} kb/s`
  healthUi.bitrate.sub.textContent = `target ${fmt(st.targetKbps)} kb/s`
  healthUi.fps.value.textContent = `${st.fps.toFixed(1)} fps`
  healthUi.fps.sub.textContent = `target ${st.targetFps}`
  healthUi.dropped.value.textContent = fmt(st.droppedFrames)
  healthUi.dropped.sub.textContent = `${st.recentDropPercent}% in 30 s · ${st.dropPercent60}% in 60 s`
  healthUi.speed.value.textContent = st.speed === null ? '—' : `${st.speed.toFixed(2)}×`
  healthUi.speed.sub.textContent = '1.00× is real time'
  healthUi.data.value.textContent = `${(st.sizeBytes / 1e6).toFixed(1)} MB`
  bad(healthUi.dropped, st.recentDropPercent > 1)
  bad(healthUi.speed, st.speed !== null && st.speed < 0.98)
  healthUi.advice.textContent =
    st.health === 'good' ? ''
    : st.speed !== null && st.speed < 0.98 ? 'The encoder is falling behind. In Stream settings, lower the resolution, frame rate or bitrate, or choose hardware encoding.'
    : 'Frames are being dropped, so the connection may be too slow for this bitrate. In Stream settings, lower the bitrate.'
  drawSpark(st.history, st.targetKbps)
}

const SOUND_KEY = 'prestreamer.streamSound'
function recallSound(): 'mixer' | 'none' {
  try { return localStorage.getItem(SOUND_KEY) === 'none' ? 'none' : 'mixer' } catch { return 'mixer' }
}

function buildStream(): void {
  streamUi.sound.append(
    el<HTMLOptionElement>('option', { value: 'mixer', textContent: 'Mixer master' }),
    el<HTMLOptionElement>('option', { value: 'none', textContent: 'No sound' }),
  )
  streamUi.sound.value = recallSound()
  streamUi.sound.onchange = () => { try { localStorage.setItem(SOUND_KEY, streamUi.sound.value) } catch { /* only a convenience */ } renderStream() }
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
        if (streamUi.sound.value === 'mixer' && audioStatus.state !== 'running') await setMixerRunning(true) // start the mixer first if it has something to run
        await prestreamer.streamStart({ screenId: streamUi.screen.value, mode: streamUi.mode.value as 'file' | 'youtube', streamKey: streamUi.key.value.trim() || undefined, audio: streamUi.sound.value as 'mixer' | 'none' })
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
  form.append(el('span', { textContent: 'Screen' }), streamUi.screen, el('span', { textContent: 'Target' }), streamUi.mode, el('span', { textContent: 'Stream key' }), streamUi.key, el('span', { textContent: 'Sound' }), streamUi.sound)
  // The controls sit in a panel that looks like the health panel below it.
  const panel = el('div', { className: 'panelbox' }, form, el('div', { className: 'form' }, el('span'), streamUi.button, el('span'), streamUi.forget), streamUi.audio, streamUi.cameraNote, streamUi.status, streamUi.hint)
  $('stream').replaceChildren(panel)
  $('healthsec').replaceChildren(healthHead, healthRoot)
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
  streamUi.mode.disabled = streamUi.screen.disabled = streamUi.sound.disabled = active
  streamUi.button.textContent = active ? 'Stop streaming' : 'Start streaming'
  streamUi.button.className = active ? 'danger' : 'primary'
  // Say plainly what the stream carries right now.
  const mixer = streamUi.sound.value === 'mixer'
  // Only said when something is wrong or unusual: normally the mixer's master simply is the stream's sound.
  const audioOk = mixer && audioStatus.state === 'running'
  streamUi.audio.hidden = audioOk
  streamUi.audio.className = 'status warn'
  streamUi.audio.textContent = !mixer ? 'The stream will have no sound.' : 'The mixer has not started, so the stream is silent. Open the Mixer tab to see why.'
  cameraButton.classList.toggle('primary', state.cameraOnly)
  cameraButton.setAttribute('aria-pressed', String(state.cameraOnly))
  const target = state.screens.find((s) => s.id === streamUi.screen.value)
  const noCamera = target && target.look.source.type === 'none'
  streamUi.cameraNote.className = `status ${state.cameraOnly && noCamera ? 'warn' : ''}`
  streamUi.cameraNote.textContent = state.cameraOnly
    ? noCamera ? `Camera only is ON, but "${target.name}" has no live source, so the stream is black. Pick a camera in its screen settings.` : 'Camera only is ON: the stream shows just the camera. Text, videos and announcements still show in the room.'
    : ''
  renderHealth()
  streamUi.status.className = `status ${streamStatus.state}`
  const secs = streamStatus.startedAt ? Math.floor((Date.now() - streamStatus.startedAt) / 1000) : 0
  streamUi.status.textContent =
    streamStatus.state === 'running'
      ? `● LIVE → ${streamStatus.target}\n${secs}s · ${streamStatus.frames} frames · ${streamStatus.dropped} dropped`
      : streamStatus.state === 'starting'
        ? 'Starting…'
        : streamStatus.message
}

// --- Audio -------------------------------------------------------------------------------------
// Inputs, levels and the delay live on the Mixer tab. The Stream panel only chooses what the stream carries.

/**
 * Reads every audio input on the machine. Names stay hidden until microphone permission is given, so when asked to
 * (opening the Mixer tab, pressing Detect) this requests it once; otherwise it only reads what is already visible.
 */
async function refreshAudioDevices(requestPermission: boolean): Promise<void> {
  let devices = await navigator.mediaDevices.enumerateDevices()
  if (requestPermission && devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
      probe.getTracks().forEach((t) => t.stop())
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch (err) {
      audioStatus = { state: 'error', message: `Microphone access failed: ${(err as Error).message}`, channelCount: 0 }
      return renderAudio()
    }
  }
  const usable = (kind: MediaDeviceKind) => devices.filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d) => ({ deviceId: d.deviceId, label: d.label || d.deviceId }))
  audioOutputs = usable('audiooutput')
  audioDevices = usable('audioinput') // every input, not only USB ones
  renderAudio()
}
// Plug something in (or out) and the lists follow by themselves. On the Mixer tab the first unnamed device also asks for the
// microphone permission that makes names visible, so no button is needed.
navigator.mediaDevices.addEventListener('devicechange', () => void refreshAudioDevices(view === 'mixer'))

/** How many channels an input offers, found by opening it briefly. 0 if it cannot be opened. */
async function probeChannels(deviceId: string): Promise<number> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId }, channelCount: { ideal: 48 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
  const n = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 0
  stream.getTracks().forEach((t) => t.stop())
  return n
}

/** Starts or stops the mixer: it captures the inputs of its strips. (The engine's old "default source" is no longer used by the interface.) */
async function setMixerRunning(on: boolean): Promise<void> {
  audioCfg = { source: { type: 'silence' }, mixerSources: on }
  try {
    audioStatus = await prestreamer.audioConfigure(audioCfg)
  } catch (err) {
    audioStatus = { state: 'error', message: (err as Error).message, channelCount: 0 }
  }
  renderAudio()
}

function renderAudio(): void {
  mixerView.setStatus(audioStatus)
  renderStream()
}

/** Tells the main process which slide follows the live one, so stage monitors can show it. */
function syncNextSlide(): void {
  const list = navSlides()
  const i = state.slide ? list.findIndex((s) => sameSlide(state.slide, s)) : -1
  const next = i >= 0 ? list[i + 1] ?? null : null
  if (JSON.stringify(next) !== JSON.stringify(state.next)) void prestreamer.setNextSlide(next)
}

function renderAll(): void {
  rememberSelection()
  syncNextSlide()
  renderTabs()
  applyView()
  settingsView.render(state)
  monitorView.render()
  renderSchedule()
  renderLibrary()
  renderCenter()
  renderScreens()
  renderAnnounceIndicator()
  screenDialog?.refresh()
  renderStream()
  renderAudio()
}

function step(delta: number): void {
  // Inside a service, keep going across items; otherwise stay within the browsed song.
  const list = navSlides()
  if (!list.length) return
  if (pendingStart) {
    const start = list.find((s) => s.itemId === pendingStart)
    const armed = state.slide?.itemId !== pendingStart
    pendingStart = null
    if (start && armed) { void prestreamer.showSlide(start); return }
  }
  let i = list.findIndex((s) => sameSlide(state.slide, s))
  if (i < 0) i = delta > 0 ? -1 : list.length
  const next = list[Math.min(list.length - 1, Math.max(0, i + delta))]
  if (next.itemId) selectedItemId = next.itemId // the schedule highlight follows the live slide
  void prestreamer.showSlide(next)
}

// Cmd+1…9 (Ctrl+1…9 on Windows) jump to the Nth item of the run sheet, from any tab.
window.addEventListener('keydown', (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key) || !$('modal').hidden) return
  const item = currentService()?.items[Number(e.key) - 1]
  if (!item) return
  e.preventDefault()
  jumpToItem(item.id)
})

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).matches('input, select, textarea')) return
  if (!$('modal').hidden) return
  // A is always one key away, on every tab: urgent information must not wait for the right screen to be open.
  if (e.key.toLowerCase() === 'a' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openAnnounce(); return }
  if (view !== 'present' && view !== 'monitor') return
  if (e.key.toLowerCase() === 'l' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); toggleLogo(); return }
  if (e.key === ' ' && state.slide?.video) { e.preventDefault(); void prestreamer.playbackCommand({ type: playback.playing ? 'pause' : 'play' }) }
  else if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ') { e.preventDefault(); step(1) }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); step(-1) }
  else if (e.key === 'Escape') prestreamer.showSlide(null)
})

const mixerDeps: MixerDeps = {
  getDevices: () => audioDevices,
  probeChannels,
  startAudio: () => setMixerRunning(true),
}
const mixerView = createMixerView($('view-mixer'), prestreamer, mixerDeps)
const monitorView = createMonitorView($('view-monitor'), {
  api: prestreamer,
  getState: () => state,
  getPlayback: () => playback,
  getSelected: () => selectedScreenId,
  select: (id) => { selectedScreenId = id; renderAll() },
  screenSize,
  step,
  toggleScreen: (id) => void toggleScreen(id),
  openAnnounce: () => openAnnounce(),
})
const settingsView = createSettingsView($('view-settings'), prestreamer, (id) => void toggleScreen(id))
const bibleView = createBibleView($('view-bible'), {
  api: prestreamer,
  getLook: () => (state.screens.find((x) => x.id === selectedScreenId) ?? state.screens[0])?.look ?? defaultLook,
  present: (slide) => void prestreamer.showSlide(applyDefaultBackground([slide], appearance.scriptureBackground)[0]),
  background: () => appearance.scriptureBackground,
  addReading: async (title, slides) => {
    const svc = currentService()
    if (!svc) return null
    await mutateService((d) => { d.items.push({ id: crypto.randomUUID(), kind: 'scripture', title, slides }) })
    return svc.name
  },
})

// --- Tabs, toolbars and global handlers ----------------------------------------------------------

const TABS: { view: View; icon: IconName; label: string }[] = [
  { view: 'present', icon: 'present', label: 'Present' },
  { view: 'monitor', icon: 'screen', label: 'Monitor' },
  { view: 'songs', icon: 'songs', label: 'Songs' },
  { view: 'bible', icon: 'book', label: 'Bible' },
  { view: 'mixer', icon: 'sliders', label: 'Mixer' },
  { view: 'settings', icon: 'gear', label: 'Settings' },
]

function renderTabs(): void {
  $('tabs').replaceChildren(...TABS.map((t) => iconButton(t.icon, t.label, () => setView(t.view), { label: t.label, className: view === t.view ? 'on' : '' })))
}

function applyView(): void {
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === view))
}

function setView(next: View): void {
  view = next
  if (next !== 'monitor') monitorView.hide()
  if (next === 'songs' && !editing) {
    const first = songById(songId) ?? songs[0]
    if (first) editing = { song: structuredClone(first), isNew: false }
  }
  if (next === 'monitor') monitorView.show()
  renderAll()
  if (next === 'songs') showEditor()
  if (next === 'mixer') { mixerView.show(); void refreshAudioDevices(true).then(() => mixerView.show()) }
  if (next === 'settings') settingsView.render(state, true)
  if (next === 'bible') void bibleView.show()
}

$('servicesel').onchange = (e) => { serviceId = (e.target as HTMLSelectElement).value; selectedItemId = null; renderAll() }
$('songfilter').oninput = (e) => { songFilter = (e.target as HTMLInputElement).value; renderLibrary() }

const today = () => new Date().toISOString().slice(0, 10)

/** Adds (or replaces) a service, makes it the current one, and refreshes the UI. */
async function saveAndSelect(svc: Service): Promise<void> {
  services = await prestreamer.servicesSave(svc)
  serviceId = svc.id
  selectedItemId = null
  renderAll()
}

async function newService(): Promise<void> {
  const name = await askText({ title: 'New service', label: 'Name of the service', value: `Sunday ${today()}`, confirm: 'Create' })
  if (name) await saveAndSelect({ id: crypto.randomUUID(), name, items: [] })
}

async function renameService(): Promise<void> {
  const svc = currentService()
  if (!svc) return
  const name = await askText({ title: 'Rename service', label: 'Name of the service', value: svc.name, confirm: 'Rename' })
  if (name && name !== svc.name) await mutateService((d) => { d.name = name })
}

/** A copy of the current service (new item ids), e.g. to start next Sunday from last Sunday's run sheet. */
async function duplicateService(): Promise<void> {
  const svc = currentService()
  if (!svc) return
  const name = await askText({ title: 'Duplicate service', label: 'Name for the copy', value: `${svc.name} (copy)`, confirm: 'Duplicate' })
  if (name) await saveAndSelect({ id: crypto.randomUUID(), name, items: svc.items.map((it) => ({ ...it, id: crypto.randomUUID() })) })
}

async function deleteService(): Promise<void> {
  const svc = currentService()
  if (!svc) return
  const n = svc.items.length
  const ok = await confirmDialog({
    title: `Delete "${svc.name}"?`,
    message: `This removes the service and its run sheet (${n} item${n === 1 ? '' : 's'}). The songs and videos themselves stay in your library.`,
    confirm: 'Delete service',
    danger: true,
  })
  if (!ok) return
  services = await prestreamer.servicesDelete(svc.id)
  serviceId = services[0]?.id ?? ''
  selectedItemId = null
  renderAll()
}

const serviceButtons = {
  needsService: [] as HTMLButtonElement[],
}
{
  const rename = iconButton('pencil', 'Rename this service', () => void renameService())
  const duplicate = iconButton('copy', 'Duplicate this service (start from a copy)', () => void duplicateService())
  const remove = iconButton('trash', 'Delete this service', () => void deleteService())
  serviceButtons.needsService.push(rename, duplicate, remove)
  $('svctools').append(iconButton('plus', 'New service', () => void newService()), rename, duplicate, remove)
}
$('addtools').append(iconButton('music', 'Add a song to the run sheet', openSongPicker, { badge: true }), iconButton('film', 'Add a video to the run sheet', () => void addVideoToService(), { badge: true }), iconButton('presentation', 'Add a presentation (PowerPoint, Keynote or PDF) to the run sheet', () => void addPresentationToService(), { badge: true }), iconButton('image', 'Add pictures to the run sheet: each is shown whole, as a slide', () => void addPicturesToService(), { badge: true }))
$('songtools').append(iconButton('plus', 'New song', () => startEdit({ id: crypto.randomUUID(), title: 'New song', body: '[Verse 1]\n\n', background: { kind: 'css', css: BACKGROUNDS[0] } }, true)))
/** Opens the live announcement popup. */
function openAnnounce(): void {
  openAnnounceDialog({ api: prestreamer, getState: () => state, getQuick: () => quickMessages, setQuick: (list) => { quickMessages = list } })
}

/** Opening or closing one screen. Closing the screen a stream is being made from would cut the picture, so that asks first. */
async function toggleScreen(id: string): Promise<void> {
  const sc = state.screens.find((s) => s.id === id)
  if (!sc) return
  if (!state.live.includes(id)) return void prestreamer.setLive(id, true)
  const streaming = streamStatus.state === 'running' || streamStatus.state === 'starting'
  if (streaming && sc.kind === 'virtual' && streamUi.screen.value === id) {
    const ok = await confirmDialog({ title: `Close ${sc.name}?`, message: 'The stream is being made from this screen. Closing it stops the picture going out. Stop the stream first unless you mean it.', confirm: `Close ${sc.name}`, danger: true })
    if (!ok) return
  }
  void prestreamer.setLive(id, false)
}

/** One click opens every screen that is closed. A screen on the display this window is on would hide the controls, so that asks first. */
async function openAllScreens(): Promise<void> {
  const closed = state.screens.filter((s) => !state.live.includes(s.id))
  if (!closed.length) return
  const mainDisplay = state.displays.find((d) => d.primary)
  const covering = closed.filter((s) => s.kind === 'display' && s.displayId !== null && s.displayId === mainDisplay?.id)
  if (covering.length) {
    const ok = await confirmDialog({
      title: 'Open all screens?',
      message: `${covering.map((s) => s.name).join(', ')} is set to your main display, which is where this window is. Once open, it covers these controls. Change its display in Settings first, or continue.`,
      confirm: 'Open them all',
    })
    if (!ok) return
  }
  for (const s of closed) await prestreamer.setLive(s.id, true)
}

/** Closing every screen also closes the stream's screen, so it asks first and says what will happen. */
async function closeAllScreens(): Promise<void> {
  const open = state.screens.filter((s) => state.live.includes(s.id))
  if (!open.length) return
  const streaming = streamStatus.state === 'running' || streamStatus.state === 'starting'
  const ok = await confirmDialog({
    title: 'Close all screens?',
    message: `This closes ${open.map((s) => s.name).join(', ')}. The audience loses the picture.${streaming ? '\n\nYou are streaming right now: closing the stream screen stops the picture going out. Stop the stream first unless you mean it.' : ''}`,
    confirm: 'Close all screens',
    danger: true,
  })
  if (ok) for (const s of open) await prestreamer.setLive(s.id, false)
}
const openAllButton = iconButton('screen', 'Open every screen that is closed: audience displays and the stream screen', () => void openAllScreens(), { label: 'Open all screens', className: 'openall' })
const closeAllButton = iconButton('stop', 'Close every open screen, including the stream screen. Asks first.', () => void closeAllScreens(), { label: 'Close all screens', className: 'closeall' })

/** The Logo button: puts the logo chosen in Settings on every screen, or takes it off again. */
function toggleLogo(): void {
  const logo = logoSlide(appearance)
  if (!logo) return
  void prestreamer.showSlide(isLogoSlide(state.slide, appearance) ? null : logo)
}
const logoButton = iconButton('image', '', toggleLogo, { label: 'Logo', className: 'logobtn' })
function renderLogoButton(): void {
  const on = isLogoSlide(state.slide, appearance)
  logoButton.disabled = !appearance.logo
  logoButton.classList.toggle('primary', on)
  logoButton.title = !appearance.logo ? 'Choose a logo in Settings first' : on ? 'Take the logo off the screens (L)' : 'Show the logo on every screen (L)'
  logoButton.setAttribute('aria-label', logoButton.title)
  logoButton.setAttribute('aria-pressed', String(on))
}

/** The red "announcement live" button stays in the header, on every tab, for as long as one is on air. */
function renderAnnounceIndicator(): void {
  closeAllButton.disabled = state.live.length === 0 // nothing to close
  renderLogoButton()
  openAllButton.disabled = state.screens.every((s) => state.live.includes(s.id)) // everything is already open
  const btn = $('announcelive')
  const a = state.announcement
  btn.hidden = !a
  if (!a) return
  btn.textContent = `● ANNOUNCEMENT LIVE · Clear`
  btn.title = `On air: ${a.text}`
}
$('announcelive').onclick = () => void prestreamer.announceClear()

$('headbtns').append(
  iconButton('bell', 'Live announcement (A)', openAnnounce, { label: 'Announce', className: 'announcebtn' }),
  logoButton,
  iconButton('x', 'Take the current slide off every screen. The screens stay open. (Esc)', () => void prestreamer.showSlide(null), { label: 'Clear slide' }),
  openAllButton,
  closeAllButton,
)

prestreamer.onPresentationStatus((message) => { $('videostatus').className = 'status'; $('videostatus').textContent = message })
prestreamer.onVideoProgress((pct) => { $('videostatus').className = 'status'; $('videostatus').textContent = `Converting… ${pct}%` })
prestreamer.onPlayback((st) => { playback = st; cards.forEach((c) => c.pv.setPlayback(st)); updateTransport(); renderSchedule() })
prestreamer.playbackGet().then((st) => { playback = st })
void refreshAudioDevices(false)
void setMixerRunning(true) // the mixer always runs: changes in the Mixer tab are heard at once, and the stream can use it any time
$('streamtools').append(cameraButton, iconButton('gear', 'Stream settings: resolution, frame rate, bitrate, encoder', () => openStreamSettings({
  api: prestreamer,
  getSettings: () => streamSettings,
  setSettings: (next) => { streamSettings = next; renderStream() },
  isStreaming: () => streamStatus.state === 'running' || streamStatus.state === 'starting',
}), { size: 15 }))
disclosure($('streamtools').parentElement!, toggleSection)
disclosure(healthHead, toggleStats)
disclosure($('atemtools').parentElement!, toggleAtem)
applyCollapse()
void prestreamer.streamSettingsGet().then((next) => { streamSettings = next; renderStream() })
buildStream()
createAtemPanel($('atemtools'), $('atem'), prestreamer)
prestreamer.onAppearance((a) => { appearance = a; settingsView.setAppearance(a); renderAll() })
prestreamer.appearanceGet().then((a) => { appearance = a; settingsView.setAppearance(a); renderAll() })
prestreamer.onAudio((s) => { audioStatus = s; renderAudio() })
prestreamer.audioGetStatus().then((s) => { audioStatus = s; renderAudio() })
prestreamer.onState((s) => { state = s; renderAll() })
prestreamer.onStream((s) => { streamStatus = s; renderStream() })
prestreamer.announceQuickList().then((l) => { quickMessages = l })
prestreamer.servicesList().then((l) => { services = l; serviceId = l.find((x) => x.id === savedService)?.id ?? l[0]?.id ?? ''; renderAll() })
prestreamer.songsList().then((l) => { songs = l; songId = l[0]?.id ?? ''; renderAll(); if (VIEWS.includes(savedView) && savedView !== 'present') setView(savedView as View) })
prestreamer.streamKeySaved().then((v) => { keySaved = v; renderStream() })
prestreamer.getState().then((s) => { state = s; renderAll() })
prestreamer.streamGetStatus().then((s) => { streamStatus = s; renderStream() })

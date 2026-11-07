import { BrowserWindow, screen as electronScreen, type Display } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { randomUUID as uuid } from 'node:crypto'
import type { Announcement, AnnounceRequest } from '../shared/announce'
import { moveBefore } from '../shared/curves'
import { NDI_FPS } from '../shared/ndi'
import { STAGE_LOOK, clampSize, hasRoles, isBlank, isOffscreen, moveById, sanitizeScreens } from '../shared/screens'
import type { NdiOutputs } from './ndi'
import type { ListStore } from './store'
import {
  IPC,
  defaultLook,
  idlePlayback,
  type PlaybackState,
  type DisplayInfo,
  type NdiStatus,
  type OutputPayload,
  type ScreenConfig,
  type ScreenState,
  type Slide,
} from '../shared/types'

/**
 * Owns the logical screens and the window that renders each live one.
 *
 * - 'display' screens render into a borderless fullscreen window on a physical display.
 * - 'virtual' screens render offscreen at a fixed size; frames are emitted via `onFrame`
 *   and pulled by the streamer (ffmpeg) through `lastFrame`.
 * - 'ndi' screens render offscreen like virtual ones, take the same roles as a display (own slides, stage monitor, mirror),
 *   and their frames are sent over the network by `NdiOutputs` while the screen is live.
 */
export class ScreenManager {
  private screens = new Map<string, ScreenConfig>()
  private windows = new Map<string, BrowserWindow>()
  private slide: Slide | null = null
  private lastFrames = new Map<string, Electron.NativeImage>()
  private playback: PlaybackState = { ...idlePlayback }
  private positions = new Map<string, number>()
  private announcement: Announcement | null = null
  private streamLive = false
  private cameraOnly = false
  private next: Slide | null = null
  /** Paint rate of virtual screens: the stream's frame rate. */
  private virtualFps = 30
  private announceTimer: NodeJS.Timeout | null = null
  /** Screens cleared on their own; any slide shown on all screens ends that. */
  private blank = new Set<string>()
  private reconcileTimer: NodeJS.Timeout | null = null
  /** The display each open display-screen window was placed on (null: the windowed stand-in). */
  private placedOn = new Map<string, number | null>()
  /** The NDI output of each live 'ndi' screen: whether it is sending, or why not. */
  private ndiStatus = new Map<string, NdiStatus>()
  private ndi: NdiOutputs | null = null

  constructor(
    private readonly onChange: (state: ScreenState) => void,
    private readonly onFrame: (screenId: string, frame: Electron.NativeImage) => void,
    private readonly store: ListStore<ScreenConfig>,
  ) {
    for (const cfg of sanitizeScreens(store.load())) this.screens.set(cfg.id, cfg)
    this.rebindDisplays()
    // macOS reports metrics changes in bursts (and again whenever a window changes the menu bar or Dock), so settle first.
    const settle = () => {
      if (this.reconcileTimer) clearTimeout(this.reconcileTimer)
      this.reconcileTimer = setTimeout(() => { this.reconcileTimer = null; this.reconcile() }, 400)
    }
    electronScreen.on('display-added', settle)
    electronScreen.on('display-removed', settle)
    electronScreen.on('display-metrics-changed', settle)
  }

  getState(): ScreenState {
    return {
      screens: [...this.screens.values()],
      ndi: Object.fromEntries(this.ndiStatus),
      displays: electronScreen.getAllDisplays().map(toDisplayInfo),
      live: [...this.windows.keys()],
      slide: this.slide,
      blank: [...this.blank],
      announcement: this.announcement,
      cameraOnly: this.cameraOnly,
      next: this.next,
    }
  }

  addVirtual(name: string, width = 1920, height = 1080): ScreenConfig {
    const cfg: ScreenConfig = {
      id: randomUUID(),
      name,
      kind: 'virtual',
      displayId: null,
      ...clampSize(width, height),
      look: { ...defaultLook },
    }
    this.screens.set(cfg.id, cfg)
    this.persist()
    this.emit()
    return cfg
  }

  /** A screen sent over the network as an NDI source, with the role of a display screen. */
  addNdiScreen(name: string, opts: { width?: number; height?: number; stage?: boolean; mirrorOf?: string } = {}): ScreenConfig {
    const mirror = opts.mirrorOf && this.canMirror(opts.mirrorOf) ? opts.mirrorOf : undefined
    const cfg: ScreenConfig = {
      id: randomUUID(),
      name,
      kind: 'ndi',
      displayId: null,
      ndiSound: 'stream',
      ...clampSize(opts.width ?? 1920, opts.height ?? 1080),
      ...(mirror ? { mirrorOf: mirror } : {}),
      look: opts.stage ? { ...defaultLook, ...STAGE_LOOK } : { ...defaultLook },
    }
    this.screens.set(cfg.id, cfg)
    this.persist()
    this.emit()
    return cfg
  }

  /** Gives the screens the NDI sender they use while live. */
  setNdiOutputs(ndi: NdiOutputs): void {
    this.ndi = ndi
  }

  /** The sender reports how an output is doing (null: it ended on purpose). */
  setNdiStatus(id: string, status: NdiStatus | null): void {
    if (status) this.ndiStatus.set(id, status)
    else this.ndiStatus.delete(id)
    this.emit()
  }

  addDisplayScreen(name: string, displayId: number | null, opts: { stage?: boolean; mirrorOf?: string } = {}): ScreenConfig {
    const stage = opts.stage === true
    const mirror = opts.mirrorOf && this.canMirror(opts.mirrorOf) ? opts.mirrorOf : undefined
    const cfg: ScreenConfig = {
      id: randomUUID(),
      name,
      kind: 'display',
      displayId,
      width: 1920,
      height: 1080,
      ...(mirror ? { mirrorOf: mirror } : {}),
      look: stage ? { ...defaultLook, ...STAGE_LOOK } : { ...defaultLook },
    }
    this.screens.set(cfg.id, cfg)
    this.persist()
    this.emit()
    return cfg
  }

  /** A picture or video was deleted: screens that had it behind their text go back to plain colour. */
  forgetBackgroundMedia(file: string): void {
    let changed = false
    for (const cfg of this.screens.values()) {
      if (cfg.look.backgroundMedia?.file === file) { cfg.look = { ...cfg.look, backgroundMedia: null }; changed = true }
    }
    if (!changed) return
    this.persist()
    for (const id of this.windows.keys()) this.push(id)
    this.emit()
  }

  /** A screen can be mirrored if it exists and is not itself a mirror. */
  private canMirror(targetId: string, selfId?: string): boolean {
    const t = this.screens.get(targetId)
    return !!t && t.id !== selfId && !t.mirrorOf
  }

  update(id: string, patch: Partial<Omit<ScreenConfig, 'id' | 'kind'>>): void {
    const cur = this.screens.get(id)
    if (!cur) return
    const next: ScreenConfig = { ...cur, ...patch, look: { ...cur.look, ...patch.look } }
    if ('width' in patch || 'height' in patch) Object.assign(next, clampSize(next.width, next.height))
    if ('mirrorOf' in patch) {
      // '' or undefined stops mirroring. Only a display or NDI screen can mirror, and only a screen that is not a mirror itself,
      // and a screen that others mirror cannot become a mirror.
      const wanted = patch.mirrorOf
      const followed = [...this.screens.values()].some((s) => s.mirrorOf === id)
      if (wanted && hasRoles(cur.kind) && !followed && this.canMirror(wanted, id)) next.mirrorOf = wanted
      else delete next.mirrorOf
    }
    if (next.kind === 'display' && next.displayId !== cur.displayId) {
      // Remember the display's name so the binding can be restored if its id changes later.
      const bound = this.resolveDisplay(next.displayId)
      next.displayLabel = bound ? displayName(bound) : undefined
    }
    this.screens.set(id, next)
    this.persist()
    if (this.windows.has(id)) {
      // Geometry or binding changed: reopen. Look-only changes just re-render.
      const geometryChanged =
        next.displayId !== cur.displayId || next.width !== cur.width || next.height !== cur.height || (next.kind === 'ndi' && (next.name !== cur.name || next.ndiSound !== cur.ndiSound))
      if (geometryChanged) {
        this.close(id)
        this.open(id)
      } else {
        this.push(id)
      }
    }
    // Screens that mirror this one follow its look at once; a screen whose own mirror target changed re-renders too.
    for (const [mid, cfg] of this.screens) if ((cfg.mirrorOf === id || mid === id) && this.windows.has(mid)) this.push(mid)
    this.emit()
  }

  /** Virtual screens paint at the stream's frame rate (offscreen windows only produce frames at the rate they are told to). */
  setVirtualFrameRate(fps: number): void {
    this.virtualFps = fps
    for (const [id, win] of this.windows) if (this.screens.get(id)?.kind === 'virtual' && !win.isDestroyed()) win.webContents.setFrameRate(fps)
  }

  /** Moves a screen up or down the list. The order is the priority: it is the order shown in the Present tab. */
  move(id: string, delta: -1 | 1): void {
    const next = moveById([...this.screens.values()], id, delta)
    if (!next) return
    this.screens = new Map(next.map((s) => [s.id, s]))
    this.persist()
    this.emit()
  }

  /** Puts a screen right before (or after) another one, as dragging it in the Present tab does. Settings follows: it is the same list. */
  reorder(id: string, target: string, after: boolean): void {
    const list = [...this.screens.values()]
    const next = moveBefore(list, (s) => s.id, id, target, after)
    if (next === list) return
    this.screens = new Map(next.map((s) => [s.id, s]))
    this.persist()
    this.emit()
  }

  /** Takes the slide off one screen (or lets it come back) without touching the others. */
  setBlank(id: string, blank: boolean): void {
    if (!this.screens.has(id) || this.blank.has(id) === blank) return
    if (blank) this.blank.add(id)
    else this.blank.delete(id)
    for (const wid of this.windows.keys()) this.push(wid) // mirrors of it change too
    this.emit()
  }

  remove(id: string): void {
    this.close(id)
    this.blank.delete(id)
    this.screens.delete(id)
    // Whatever mirrored it becomes an ordinary screen again.
    for (const cfg of this.screens.values()) if (cfg.mirrorOf === id) delete cfg.mirrorOf
    this.persist()
    this.emit()
  }

  setLive(id: string, live: boolean): void {
    if (live) this.open(id)
    else this.close(id)
    this.emit()
  }

  showSlide(slide: Slide | null): void {
    this.slide = slide
    this.blank.clear()
    for (const id of this.windows.keys()) this.push(id)
    this.emit()
  }

  /** Most recent painted frame of a live virtual screen, for the streamer. */
  lastFrame(id: string): Electron.NativeImage | null {
    return this.lastFrames.get(id) ?? null
  }

  /**
   * Puts an announcement on air at once. It is state of its own: the slide and the video underneath are not touched,
   * so clearing it brings the service back exactly where it was.
   */
  showAnnouncement(req: AnnounceRequest): Announcement {
    const announcement: Announcement = { ...req, id: uuid() }
    this.setAnnouncement(announcement)
    if (req.autoHideSec) {
      this.announceTimer = setTimeout(() => { if (this.announcement?.id === announcement.id) this.clearAnnouncement() }, req.autoHideSec * 1000)
    }
    return announcement
  }

  clearAnnouncement(): void {
    this.setAnnouncement(null)
  }

  private setAnnouncement(a: Announcement | null): void {
    if (this.announceTimer) clearTimeout(this.announceTimer)
    this.announceTimer = null
    this.announcement = a
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send(IPC.announceState, a)
    this.emit()
  }

  /** Pushes the shared video clock to every output window (they extrapolate the position locally). */
  setPlayback(state: PlaybackState): void {
    this.playback = state
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.webContents.send(IPC.playbackState, state)
  }

  /** Output windows report their video position so drift between screens can be observed. */
  report(id: string, positionSec: number): void {
    this.positions.set(id, positionSec)
  }

  getPositions(): Record<string, number> {
    return Object.fromEntries(this.positions)
  }

  closeAll(): void {
    for (const id of [...this.windows.keys()]) this.close(id)
  }

  /** Output window init payload; called by the output renderer on load. */
  payloadFor(id: string): OutputPayload | null {
    const own = this.screens.get(id)
    // A mirror gets the look, size and announcement targeting of the screen it follows, but never plays that screen's sound twice.
    const source = own?.mirrorOf ? this.screens.get(own.mirrorOf) : undefined
    const screen = source ? { ...source, look: { ...source.look, videoAudio: false } } : own
    return screen ? { screen, slide: isBlank([...this.screens.values()], [...this.blank], id) ? null : this.slide, playback: this.playback, announcement: this.announcement, streamLive: this.streamLive, cameraOnly: this.cameraOnly && screen.kind === 'virtual', next: this.next } : null
  }

  private open(id: string): void {
    const cfg = this.screens.get(id)
    if (!cfg || this.windows.has(id)) return

    const webPreferences: Electron.WebPreferences = {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required', // output windows have no user gesture, and may play video sound
    }

    let win: BrowserWindow
    if (isOffscreen(cfg.kind)) {
      win = new BrowserWindow({
        width: cfg.width,
        height: cfg.height,
        show: false,
        frame: false,
        webPreferences: { ...webPreferences, offscreen: true },
      })
      win.webContents.setFrameRate(cfg.kind === 'ndi' ? NDI_FPS : this.virtualFps)
      win.webContents.on('paint', (_e, _dirty, image) => {
        this.lastFrames.set(id, image)
        this.onFrame(id, image)
      })
    } else {
      const display = this.resolveDisplay(cfg.displayId)
      // No physical display bound/available: show a windowed stand-in so the screen
      // is still testable on a single-monitor machine (like ProPresenter's "preview").
      const bounds = display?.bounds
      win = new BrowserWindow({
        ...(bounds
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fullscreen: false, frame: false, enableLargerThanScreen: true }
          : { width: 960, height: 540, frame: true, title: `${cfg.name} (no display bound)` }),
        backgroundColor: '#000000',
        // A frameless window on macOS has rounded corners and a shadow, which show as dark notches on a full-screen output.
        ...(display ? { roundedCorners: false, hasShadow: false } : {}),
        webPreferences,
      })
      // 'screen-saver' is above the menu bar and Dock, so the picture covers the whole display (primary one too).
      if (display) win.setAlwaysOnTop(true, 'screen-saver')
      this.placedOn.set(id, display?.id ?? null)
    }

    win.on('closed', () => {
      this.windows.delete(id)
      this.emit()
    })
    win.loadFile(join(__dirname, '../renderer/output.html'), { query: { screenId: id } })
    this.windows.set(id, win)
    if (cfg.kind === 'ndi') this.ndi?.start(id, cfg.name, cfg.width, cfg.height, cfg.ndiSound ?? 'stream', () => this.lastFrames.get(id) ?? null)
  }

  private close(id: string): void {
    const win = this.windows.get(id)
    this.windows.delete(id)
    this.placedOn.delete(id)
    this.lastFrames.delete(id)
    this.ndi?.stop(id)
    this.ndiStatus.delete(id)
    if (win && !win.isDestroyed()) win.destroy()
  }

  /** The slide after the current one (stage monitors show it). Sent by the operator, which owns the slide lists. */
  setNextSlide(slide: Slide | null): void {
    if (JSON.stringify(slide) === JSON.stringify(this.next)) return
    this.next = slide
    for (const id of this.windows.keys()) this.push(id)
    this.emit()
  }

  /** Stream screens show only the live camera (no text, media, cues or announcements). Display screens are not affected. */
  setCameraOnly(on: boolean): void {
    if (on === this.cameraOnly) return
    this.cameraOnly = on
    for (const [id, cfg] of this.screens) if (cfg.kind === 'virtual') this.push(id)
    this.emit()
  }

  /** Tells every output whether the stream is on air, so screens with the LIVE badge switched on can show it. */
  setStreamLive(live: boolean): void {
    if (live === this.streamLive) return
    this.streamLive = live
    for (const id of this.windows.keys()) this.push(id)
  }

  private push(id: string): void {
    const win = this.windows.get(id)
    const payload = this.payloadFor(id)
    if (win && !win.isDestroyed() && payload) win.webContents.send(IPC.outputUpdate, payload)
  }

  /** Saves the screens (live state is not saved: nothing opens by itself at startup). */
  private persist(): void {
    this.store.replaceAll([...this.screens.values()])
  }

  /** A screen bound to a display id that no longer exists is moved to the display with the same name, if any. */
  private rebindDisplays(): void {
    const displays = electronScreen.getAllDisplays()
    let changed = false
    for (const cfg of this.screens.values()) {
      if (cfg.kind !== 'display' || cfg.displayId === null || displays.some((d) => d.id === cfg.displayId)) continue
      const match = cfg.displayLabel ? displays.find((d) => displayName(d) === cfg.displayLabel) : undefined
      if (match) {
        cfg.displayId = match.id
        changed = true
      }
    }
    if (changed) this.persist()
  }

  /** Flashes a big number on every physical display for three seconds so you can tell which is which. */
  identifyDisplays(): void {
    electronScreen.getAllDisplays().forEach((d, i) => {
      const win = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, transparent: true, show: false, focusable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true,
        webPreferences: { sandbox: true, contextIsolation: true },
      })
      win.setIgnoreMouseEvents(true)
      win.setAlwaysOnTop(true, 'screen-saver')
      const page = `<body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:rgba(15,23,42,.82);color:#fff;font-family:system-ui,sans-serif">
        <div style="font-size:22vh;font-weight:800;line-height:1">${i + 1}</div>
        <div style="font-size:4vh;margin-top:2vh">${escapeHtml(displayName(d))}</div>
        <div style="font-size:3vh;opacity:.7">${d.size.width}×${d.size.height}${d.id === electronScreen.getPrimaryDisplay().id ? ' · primary' : ''}</div></body>`
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`).then(() => win.showInactive())
      setTimeout(() => { if (!win.isDestroyed()) win.destroy() }, 3000)
    })
  }

  /** Displays come and go (cable plugged in): re-bind live display screens. */
  private reconcile(): void {
    this.rebindDisplays()
    for (const cfg of this.screens.values()) {
      const win = this.windows.get(cfg.id)
      if (cfg.kind !== 'display' || !win || win.isDestroyed()) continue
      const display = this.resolveDisplay(cfg.displayId)
      if ((display?.id ?? null) !== this.placedOn.get(cfg.id)) {
        // It moved to another display, or its display came or went: start over there.
        this.close(cfg.id)
        this.open(cfg.id)
      } else if (display) {
        // Same display: only fix the size if it really changed; recreating the window would make it flicker.
        const b = win.getBounds()
        const d = display.bounds
        if (b.x !== d.x || b.y !== d.y || b.width !== d.width || b.height !== d.height) win.setBounds(d)
      }
    }
    this.emit()
  }

  private resolveDisplay(displayId: number | null): Display | undefined {
    if (displayId == null) return undefined
    return electronScreen.getAllDisplays().find((d) => d.id === displayId)
  }

  private emit(): void {
    this.onChange(this.getState())
  }
}

const displayName = (d: Display): string => d.label || `Display ${d.id}`

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function toDisplayInfo(d: Display): DisplayInfo {
  return {
    id: d.id,
    label: displayName(d),
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === electronScreen.getPrimaryDisplay().id,
  }
}

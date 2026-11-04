import { BrowserWindow, screen as electronScreen, type Display } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  defaultLook,
  idlePlayback,
  type PlaybackState,
  type DisplayInfo,
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
 *   so they can later feed the streamer (ffmpeg) or NDI, and are also a preview source.
 */
export class ScreenManager {
  private screens = new Map<string, ScreenConfig>()
  private windows = new Map<string, BrowserWindow>()
  private slide: Slide | null = null
  private lastFrames = new Map<string, Electron.NativeImage>()
  private playback: PlaybackState = { ...idlePlayback }
  private positions = new Map<string, number>()

  constructor(
    private readonly onChange: (state: ScreenState) => void,
    private readonly onFrame: (screenId: string, frame: Electron.NativeImage) => void,
  ) {
    electronScreen.on('display-added', () => this.reconcile())
    electronScreen.on('display-removed', () => this.reconcile())
    electronScreen.on('display-metrics-changed', () => this.reconcile())
  }

  getState(): ScreenState {
    return {
      screens: [...this.screens.values()],
      displays: electronScreen.getAllDisplays().map(toDisplayInfo),
      live: [...this.windows.keys()],
      slide: this.slide,
    }
  }

  addVirtual(name: string, width = 1920, height = 1080): ScreenConfig {
    const cfg: ScreenConfig = {
      id: randomUUID(),
      name,
      kind: 'virtual',
      displayId: null,
      width,
      height,
      look: { ...defaultLook },
    }
    this.screens.set(cfg.id, cfg)
    this.emit()
    return cfg
  }

  addDisplayScreen(name: string, displayId: number | null): ScreenConfig {
    const cfg: ScreenConfig = {
      id: randomUUID(),
      name,
      kind: 'display',
      displayId,
      width: 1920,
      height: 1080,
      look: { ...defaultLook },
    }
    this.screens.set(cfg.id, cfg)
    this.emit()
    return cfg
  }

  update(id: string, patch: Partial<Omit<ScreenConfig, 'id' | 'kind'>>): void {
    const cur = this.screens.get(id)
    if (!cur) return
    const next = { ...cur, ...patch, look: { ...cur.look, ...patch.look } }
    this.screens.set(id, next)
    if (this.windows.has(id)) {
      // Geometry or binding changed: reopen. Look-only changes just re-render.
      const geometryChanged =
        next.displayId !== cur.displayId || next.width !== cur.width || next.height !== cur.height
      if (geometryChanged) {
        this.close(id)
        this.open(id)
      } else {
        this.push(id)
      }
    }
    this.emit()
  }

  remove(id: string): void {
    this.close(id)
    this.screens.delete(id)
    this.emit()
  }

  setLive(id: string, live: boolean): void {
    if (live) this.open(id)
    else this.close(id)
    this.emit()
  }

  showSlide(slide: Slide | null): void {
    this.slide = slide
    for (const id of this.windows.keys()) this.push(id)
    this.emit()
  }

  /** Most recent painted frame of a live virtual screen, for the streamer. */
  lastFrame(id: string): Electron.NativeImage | null {
    return this.lastFrames.get(id) ?? null
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
    const screen = this.screens.get(id)
    return screen ? { screen, slide: this.slide, playback: this.playback } : null
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
    if (cfg.kind === 'virtual') {
      win = new BrowserWindow({
        width: cfg.width,
        height: cfg.height,
        show: false,
        frame: false,
        webPreferences: { ...webPreferences, offscreen: true },
      })
      win.webContents.setFrameRate(30)
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
          ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, fullscreen: false, frame: false }
          : { width: 960, height: 540, frame: true, title: `${cfg.name} (no display bound)` }),
        backgroundColor: '#000000',
        webPreferences,
      })
      if (display && display.id !== electronScreen.getPrimaryDisplay().id) {
        win.setAlwaysOnTop(true, 'screen-saver')
      }
    }

    win.on('closed', () => {
      this.windows.delete(id)
      this.emit()
    })
    win.loadFile(join(__dirname, '../renderer/output.html'), { query: { screenId: id } })
    this.windows.set(id, win)
  }

  private close(id: string): void {
    const win = this.windows.get(id)
    this.windows.delete(id)
    this.lastFrames.delete(id)
    if (win && !win.isDestroyed()) win.destroy()
  }

  private push(id: string): void {
    const win = this.windows.get(id)
    const payload = this.payloadFor(id)
    if (win && !win.isDestroyed() && payload) win.webContents.send(IPC.outputUpdate, payload)
  }

  /** Displays come and go (cable plugged in): re-bind live display screens. */
  private reconcile(): void {
    for (const cfg of this.screens.values()) {
      if (cfg.kind === 'display' && this.windows.has(cfg.id)) {
        this.close(cfg.id)
        this.open(cfg.id)
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

function toDisplayInfo(d: Display): DisplayInfo {
  return {
    id: d.id,
    label: d.label || `Display ${d.id}`,
    width: d.size.width,
    height: d.size.height,
    primary: d.id === electronScreen.getPrimaryDisplay().id,
  }
}

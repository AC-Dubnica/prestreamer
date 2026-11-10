import {
  blendLevels, defaultDmxSettings, dmxNoInterface, fitLevels, idleDmx, renderUniverse, sanitizeDmxSettings, sceneFade,
  type DmxCommand, type DmxSettings, type DmxStatus, type Levels,
} from '../shared/dmx'

/** A running output: 512-slot blocks go in, it repeats the newest one at a steady rate. */
export interface DmxLink {
  write(slots: Uint8Array): void
  close(): void
}

export interface DmxLinkEvents {
  /** The interface is open and frames go out. */
  ready(): void
  /** The interface could not be opened or went away. */
  failed(message: string): void
}

/** How the controller reaches the hardware; tests give it a fake. */
export interface DmxDeps {
  /** Interfaces plugged in right now. */
  listPorts(): string[]
  open(port: string, events: DmxLinkEvents): DmxLink
  /** Why output cannot work here at all (an unsupported platform, a build without the helper), or null. */
  unavailable(): string | null
  now(): number
}

const TICK_MS = 25
const RETRY_MS = 5000

/**
 * The lights: settings (fixtures, scenes), what is on now and the output.
 * Nothing is opened or sent until the operator does something (or a start scene is set), so starting the app never changes the room.
 * Never throws at the caller: a missing interface is a status the panel shows.
 */
export class DmxController {
  private settings: DmxSettings
  private levels: Levels = {}
  private scene = ''
  private master = 100
  private blackout = false
  private state: DmxStatus['state']
  private message = ''
  private port = ''
  private ports: string[] = []
  private link: DmxLink | null = null
  /** A scene arriving over time. */
  private fade: { from: Levels; to: Levels; start: number; ms: number } | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  /** Something was asked for, so frames may go out. */
  private active = false
  private last = ''
  private lastStatus = ''

  constructor(
    private readonly onStatus: (s: DmxStatus) => void,
    private readonly deps: DmxDeps,
    private readonly saveSettings: (s: DmxSettings) => void,
    initial: DmxSettings = defaultDmxSettings,
  ) {
    this.settings = sanitizeDmxSettings(initial)
    this.levels = fitLevels(this.settings.fixtures, {})
    this.state = this.settings.enabled ? 'idle' : 'off'
    this.message = this.idleMessage()
  }

  getStatus(): DmxStatus {
    return {
      state: this.state,
      message: this.message,
      port: this.port,
      ports: this.ports,
      settings: this.settings,
      levels: this.fade ? this.fade.to : this.levels,
      scene: this.scene,
      master: this.master,
      blackout: this.blackout,
    }
  }

  /** Called once when the app is up: recalls the start scene, if there is one. */
  start(): void {
    this.ports = this.deps.listPorts()
    if (this.settings.enabled && this.settings.startScene) this.command({ type: 'scene', id: this.settings.startScene })
    else this.push()
  }

  /** Stops the output; darkness first if the operator wants that. Resolves when the helper has had time to send it. */
  async stop(): Promise<void> {
    this.clearTimers()
    if (this.link && this.settings.blackoutOnQuit) {
      this.link.write(new Uint8Array(512))
      await new Promise((r) => setTimeout(r, 120)) // a few frames of darkness before the helper goes
    }
    this.closeLink()
  }

  /** Replaces the settings (fixtures, scenes, port, ...). Levels of fixtures that are still there are kept. */
  setSettings(raw: unknown): DmxStatus {
    const next = sanitizeDmxSettings(raw)
    const before = this.settings
    const now = this.current()
    this.settings = next
    this.saveSettings(next)
    this.fade = null
    this.levels = fitLevels(next.fixtures, now)
    if (this.scene && !next.scenes.some((s) => s.id === this.scene)) this.scene = ''
    if (!next.enabled) {
      this.clearTimers()
      this.closeLink()
      this.active = false
      this.state = 'off'
      this.message = this.idleMessage()
    } else {
      if (!before.enabled) { this.state = 'idle'; this.message = this.idleMessage() }
      if (before.port !== next.port) this.closeLink()
      if (this.active) this.emit()
    }
    this.push()
    return this.getStatus()
  }

  command(cmd: DmxCommand): DmxStatus {
    if (!this.settings.enabled) return this.getStatus()
    if (cmd.type === 'rescan') {
      this.ports = this.deps.listPorts()
      if (this.state === 'error') this.closeLink()
      if (this.active) this.emit()
      else this.message = this.idleMessage()
    } else if (cmd.type === 'scene') {
      const sc = this.settings.scenes.find((s) => s.id === cmd.id)
      if (sc) {
        const to = fitLevels(this.settings.fixtures, sc.values)
        const ms = sceneFade(this.settings, sc) * 1000
        this.fade = ms > 0 ? { from: this.current(), to, start: this.deps.now(), ms } : null
        this.levels = ms > 0 ? this.levels : to
        this.scene = sc.id
        this.blackout = false
        this.touch()
      }
    } else if (cmd.type === 'level') {
      const row = this.current()[cmd.fixture]
      if (row && Number.isInteger(cmd.channel) && cmd.channel >= 0 && cmd.channel < row.length) {
        const levels = this.current()
        levels[cmd.fixture] = row.map((v, i) => (i === cmd.channel ? Math.min(255, Math.max(0, Math.round(cmd.value))) : v))
        this.levels = levels
        this.fade = null
        this.scene = ''
        this.touch()
      }
    } else if (cmd.type === 'master') {
      this.master = Math.min(100, Math.max(0, Math.round(Number.isFinite(cmd.value) ? cmd.value : 100)))
      this.touch()
    } else if (cmd.type === 'blackout') {
      this.blackout = cmd.on === true
      this.touch()
    }
    this.push()
    return this.getStatus()
  }

  // --- output ---------------------------------------------------------------------------------------------------------------

  /** The levels at this moment, part-way through a fade. */
  private current(): Levels {
    const f = this.fade
    if (!f) return structuredClone(this.levels)
    return blendLevels(f.from, f.to, (this.deps.now() - f.start) / f.ms)
  }

  /** Something the operator did: from now on frames go out. */
  private touch(): void {
    this.active = true
    this.emit()
  }

  /** Makes sure the output is open and sends what is on now; keeps ticking while a fade runs. */
  private emit(): void {
    const reason = this.deps.unavailable()
    if (reason) { this.state = 'error'; this.message = reason; return }
    if (!this.link) this.openLink()
    this.send()
    if (this.fade && !this.timer) this.timer = setInterval(() => { this.send(); this.push() }, TICK_MS)
  }

  private send(): void {
    const f = this.fade
    if (f && this.deps.now() - f.start >= f.ms) { this.levels = f.to; this.fade = null }
    if (!this.fade && this.timer) { clearInterval(this.timer); this.timer = null }
    if (!this.link) return
    const slots = renderUniverse(this.settings.fixtures, this.current(), this.master, this.blackout)
    const key = Buffer.from(slots).toString('latin1')
    if (key === this.last) return
    this.last = key
    this.link.write(slots)
  }

  private openLink(): void {
    this.ports = this.deps.listPorts()
    const port = this.settings.port || this.ports[0] || ''
    this.port = port
    if (!port) {
      this.state = 'error'
      this.message = dmxNoInterface()
      this.scheduleRetry()
      return
    }
    this.state = 'starting'
    this.message = `Opening ${port}…`
    this.last = ''
    const link = this.deps.open(port, {
      ready: () => {
        if (this.link !== link) return
        this.state = 'sending'
        this.message = `Sending DMX through ${port}`
        this.push()
      },
      failed: (message) => {
        if (this.link !== link) return
        this.link = null
        this.state = 'error'
        this.message = message
        this.scheduleRetry()
        this.push()
      },
    })
    this.link = link
  }

  /** An interface that was pulled out comes back by itself while something is on. */
  private scheduleRetry(): void {
    if (this.retry || !this.settings.enabled) return
    this.retry = setTimeout(() => {
      this.retry = null
      if (this.settings.enabled && this.active && !this.link) { this.emit(); this.push() }
    }, RETRY_MS)
  }

  private closeLink(): void {
    const l = this.link
    this.link = null
    this.last = ''
    try { l?.close() } catch { /* already gone */ }
  }

  private clearTimers(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.retry) clearTimeout(this.retry)
    this.timer = null
    this.retry = null
  }

  private idleMessage(): string {
    if (!this.settings.enabled) return idleDmx.message
    return this.settings.fixtures.length ? 'Ready. The lights are left alone until you recall a scene or move a fader.' : 'Add your lights in Settings → DMX.'
  }

  private push(): void {
    const s = this.getStatus()
    const key = JSON.stringify(s)
    if (key === this.lastStatus) return
    this.lastStatus = key
    this.onStatus(s)
  }
}

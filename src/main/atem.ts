import { atemAddress, canSend, idleAtem, sanitizeAtemSettings, switchableInputs, type AtemCommand, type AtemSettings, type AtemStatus } from '../shared/atem'

/** The few parts of atem-connection's `Atem` that are used, so a fake can stand in for it in tests. */
export interface AtemClient {
  connect(address: string): Promise<void>
  disconnect(): Promise<void>
  on(event: 'connected' | 'disconnected', cb: () => void): unknown
  on(event: 'stateChanged', cb: () => void): unknown
  on(event: 'error' | 'info', cb: (message: string) => void): unknown
  readonly state?: {
    info?: { productIdentifier?: string }
    inputs: Record<string, { inputId: number; shortName: string; longName: string; meAvailability: number } | undefined>
    video: { mixEffects: ({ programInput: number; previewInput: number; inTransition: boolean } | undefined)[] }
  }
  changeProgramInput(input: number): Promise<unknown>
  changePreviewInput(input: number): Promise<unknown>
  cut(): Promise<unknown>
  autoTransition(): Promise<unknown>
}

/** How long to wait for a switcher to answer before starting over (UDP gives no "refused"). */
const RETRY_MS = 8000

/**
 * Keeps a link to one ATEM over Ethernet, and offers the usual switching actions on its first mix effect.
 * Never throws at the caller: a missing switcher is just a status the UI shows as "disabled".
 */
export class AtemController {
  private client: AtemClient | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private status: AtemStatus = idleAtem
  private settings: AtemSettings
  private stopped = true

  constructor(
    private readonly onStatus: (s: AtemStatus) => void,
    private readonly makeClient: () => AtemClient,
    private readonly saveSettings: (s: AtemSettings) => void,
    initial: AtemSettings,
  ) {
    this.settings = sanitizeAtemSettings(initial)
    this.status = { ...idleAtem, address: atemAddress(this.settings), message: this.searching() }
  }

  getStatus(): AtemStatus { return this.status }
  getSettings(): AtemSettings { return this.settings }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.open()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearTimer()
    await this.close()
  }

  /** Changes the address (empty = factory default), remembers it and reconnects. */
  async setAddress(raw: unknown): Promise<AtemStatus> {
    const text = typeof raw === 'string' ? raw.trim() : ''
    const next = text === '' ? { address: '' } : sanitizeAtemSettings({ address: text })
    if (text !== '' && next.address === '') return this.update({ message: `"${text}" is not an IP address or host name` })
    this.settings = next
    this.saveSettings(next)
    this.clearTimer()
    await this.close()
    this.update({ ...idleAtem, address: atemAddress(next), message: this.searching() })
    if (!this.stopped) void this.open()
    return this.status
  }

  /** Runs a switching action. Resolves false when the switcher is not there or the action does not apply. */
  async send(cmd: AtemCommand): Promise<boolean> {
    const c = this.client
    if (!c || !canSend(this.status, cmd)) return false
    try {
      if (cmd.type === 'program') await c.changeProgramInput(cmd.input)
      else if (cmd.type === 'preview') await c.changePreviewInput(cmd.input)
      else if (cmd.type === 'cut') await c.cut()
      else await c.autoTransition()
      return true
    } catch (err) {
      this.update({ message: `ATEM command failed: ${(err as Error).message}` })
      return false
    }
  }

  private searching(): string {
    return `No ATEM found at ${atemAddress(this.settings)}`
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private async close(): Promise<void> {
    const c = this.client
    this.client = null
    if (!c) return
    try { await c.disconnect() } catch { /* already gone */ }
  }

  private async open(): Promise<void> {
    if (this.stopped || this.client) return
    let c: AtemClient
    try {
      c = this.makeClient()
    } catch (err) {
      // The library could not even be loaded: stay disabled instead of crashing the app.
      this.update({ state: 'searching', message: `ATEM control is unavailable: ${(err as Error).message}` })
      return
    }
    this.client = c
    c.on('connected', () => { if (this.client === c) { this.clearTimer(); this.refresh(c) } })
    c.on('disconnected', () => { if (this.client === c) { this.update({ ...idleAtem, address: atemAddress(this.settings), message: this.searching() }); this.scheduleRetry() } })
    c.on('stateChanged', () => { if (this.client === c) this.refresh(c) })
    c.on('error', () => { /* a silent switcher is just "not found"; the retry timer handles it */ })
    try {
      await c.connect(atemAddress(this.settings))
    } catch {
      /* unreachable address: retried below */
    }
    if (this.client === c && this.status.state !== 'connected') this.scheduleRetry()
  }

  private scheduleRetry(): void {
    this.clearTimer()
    if (this.stopped) return
    this.timer = setTimeout(async () => {
      this.timer = null
      if (this.stopped || this.status.state === 'connected') return
      await this.close()
      await this.open()
    }, RETRY_MS)
  }

  /** Copies what the switcher reports into the status. */
  private refresh(c: AtemClient): void {
    const st = c.state
    if (!st) return
    const me = st.video.mixEffects[0]
    this.update({
      state: 'connected',
      address: atemAddress(this.settings),
      model: st.info?.productIdentifier ?? 'ATEM',
      inputs: switchableInputs(Object.values(st.inputs).filter((i): i is NonNullable<typeof i> => !!i)),
      program: me?.programInput ?? 0,
      preview: me?.previewInput ?? 0,
      inTransition: me?.inTransition ?? false,
      message: `Connected to ${st.info?.productIdentifier ?? 'ATEM'} at ${atemAddress(this.settings)}`,
    })
  }

  private update(patch: Partial<AtemStatus>): AtemStatus {
    const next = { ...this.status, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(this.status)) {
      this.status = next
      this.onStatus(next)
    }
    return this.status
  }
}

/** The real library, loaded only when needed. Threading is off: the library's worker process cannot start from inside an asar archive. */
export function realAtemClient(): AtemClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Atem } = require('atem-connection') as typeof import('atem-connection')
  return new Atem({ disableMultithreaded: true }) as unknown as AtemClient
}

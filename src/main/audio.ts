import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { AUDIO_IPC, defaultAudio, idleAudio, type AudioConfig, type AudioStatus, type Meters } from '../shared/types'
import { defaultMixer, sanitizeMixer, type MixerConfig } from '../shared/mixer'
import { writeJsonAtomic } from './store'

const MAX_BACKLOG_BYTES = 1 << 20

/**
 * Captures and mixes audio in a hidden window (Web Audio works the same on macOS and Windows)
 * and exposes the stereo mix to ffmpeg as raw f32le PCM on a loopback TCP port.
 */
export class AudioBridge {
  private win: BrowserWindow | null = null
  private server: Server | null = null
  private socket: Socket | null = null
  private status: AudioStatus = { ...idleAudio }
  private config: AudioConfig = structuredClone(defaultAudio)
  private waiter: ((s: AudioStatus) => void) | null = null
  port = 0
  /** Test hook: receives every PCM chunk the mixer produces (f32le, 48 kHz, stereo interleaved). */
  pcmTap: ((chunk: Buffer) => void) | null = null
  /** Video start time to align the next ffmpeg connection against (see armSync). */
  private syncStart = 0

  private mixer: MixerConfig = defaultMixer()
  private saveTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly onStatus: (s: AudioStatus) => void,
    private readonly onMeters: (m: Meters) => void,
  ) {}

  private mixerPath = () => join(app.getPath('userData'), 'mixer.json')

  async init(): Promise<void> {
    try {
      this.mixer = sanitizeMixer(JSON.parse(readFileSync(this.mixerPath(), 'utf8')))
    } catch {
      this.mixer = defaultMixer()
    }
    ipcMain.on(AUDIO_IPC.metersIn, (_e, m: Meters) => this.onMeters(m))
    ipcMain.on(AUDIO_IPC.report, (_e, s: AudioStatus) => {
      this.status = s
      this.onStatus(s)
      this.waiter?.(s)
      this.waiter = null
    })
    ipcMain.on(AUDIO_IPC.pcm, (_e, buf: ArrayBuffer) => {
      this.pcmTap?.(Buffer.from(buf))
      const sock = this.socket
      if (!sock || sock.destroyed || sock.writableLength > MAX_BACKLOG_BYTES) return
      sock.write(Buffer.from(buf))
    })
    this.server = createServer((sock) => {
      this.socket?.destroy()
      this.socket = sock
      this.padToVideoStart(sock)
      sock.on('error', () => {})
      sock.on('close', () => { if (this.socket === sock) this.socket = null })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server.address() as { port: number }).port
  }

  /**
   * ffmpeg connects to the audio port a moment after the first video frame is written, and audio time 0
   * is the first byte it receives. Pad that gap with silence so audio and video share the same origin.
   */
  armSync(videoStartMs: number): void {
    this.syncStart = videoStartMs
  }

  private padToVideoStart(sock: Socket): void {
    if (!this.syncStart) return
    const frames = Math.max(0, Math.round(((Date.now() - this.syncStart) / 1000) * 48000))
    this.syncStart = 0
    if (frames) sock.write(Buffer.alloc(frames * 8)) // 2 channels × 4-byte float
  }

  getStatus(): AudioStatus {
    return this.status
  }

  getConfig(): AudioConfig {
    return this.config
  }

  getMixer(): MixerConfig {
    return this.mixer
  }

  /** Validates, applies live to the audio window, and persists (debounced: faders send many updates). */
  setMixer(raw: unknown): MixerConfig {
    this.mixer = sanitizeMixer(raw)
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(AUDIO_IPC.mixerPush, this.mixer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => writeJsonAtomic(this.mixerPath(), this.mixer), 500)
    return this.mixer
  }

  /** True when stream audio should come from the mix rather than generated silence. */
  get live(): boolean {
    return this.status.state === 'running' && this.config.source.type !== 'silence'
  }

  async configure(cfg: AudioConfig): Promise<AudioStatus> {
    this.config = cfg
    const win = await this.window()
    const result = new Promise<AudioStatus>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new Error('Audio device did not respond (permission?)')) }, 10000)
      this.waiter = (s) => { clearTimeout(timer); resolve(s) }
    })
    win.webContents.send(AUDIO_IPC.apply, { config: cfg, mixer: this.mixer })
    return result
  }

  close(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      writeJsonAtomic(this.mixerPath(), this.mixer) // flush a pending change
    }
    this.socket?.destroy()
    this.server?.close()
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
  }

  private async window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: join(__dirname, '../preload/audio.js'),
        contextIsolation: true,
        sandbox: true,
        backgroundThrottling: false, // a hidden window must keep capturing at full rate
      },
    })
    await win.loadFile(join(__dirname, '../renderer/audio.html'))
    this.win = win
    return win
  }
}

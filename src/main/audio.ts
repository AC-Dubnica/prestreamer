import { app, BrowserWindow, ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { AUDIO_IPC, defaultAudio, idleAudio, idlePlayback, type AudioConfig, type AudioStatus, type Meters, type PlaybackState } from '../shared/types'
import { defaultMixer, sanitizeMixer, type MixerConfig } from '../shared/mixer'
import { writeJsonAtomic } from './store'
import { NativeAudio } from './native-audio'

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
  private lastPcmAt = 0
  private playback: PlaybackState = { ...idlePlayback }
  /** Wall-clock time up to which the stream already has audio (real or filler). */
  private filledUntil = 0
  private silenceTimer: NodeJS.Timeout | null = null

  private readonly native = new NativeAudio()
  private pcmListeners: ((pcm: Buffer) => void)[] = []
  private videoPcmListeners: ((pcm: Buffer) => void)[] = []

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
    ipcMain.handle(AUDIO_IPC.nativeInputs, () => this.native.inputs())
    ipcMain.handle(AUDIO_IPC.nativeStart, async (_e, name: string) => {
      const send = (channel: string, ...args: unknown[]) => { if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, ...args) }
      try {
        return await this.native.start(String(name), (frames) => send(AUDIO_IPC.nativeData, name, frames), (message) => send(AUDIO_IPC.nativeEnded, name, message))
      } catch (err) {
        return { error: (err as Error).message }
      }
    })
    ipcMain.on(AUDIO_IPC.nativeStop, (_e, name: string, id: number) => this.native.stop(String(name), id))
    ipcMain.on(AUDIO_IPC.report, (_e, s: AudioStatus) => {
      this.status = s
      this.onStatus(s)
      this.waiter?.(s)
      this.waiter = null
    })
    ipcMain.on(AUDIO_IPC.videoPcm, (_e, buf: ArrayBuffer) => { const pcm = Buffer.from(buf); for (const listen of this.videoPcmListeners) listen(pcm) })
    ipcMain.on(AUDIO_IPC.pcm, (_e, buf: ArrayBuffer) => {
      const pcm = Buffer.from(buf)
      this.pcmTap?.(pcm)
      for (const listen of this.pcmListeners) listen(pcm)
      this.lastPcmAt = this.filledUntil = Date.now()
      const sock = this.socket
      if (!sock || sock.destroyed || sock.writableLength > MAX_BACKLOG_BYTES) return
      sock.write(pcm)
    })
    this.server = createServer((sock) => {
      this.socket?.destroy()
      this.socket = sock
      this.filledUntil = Date.now()
      this.padToVideoStart(sock)
      this.startSilenceFiller()
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

  /**
   * A stream must never stall waiting for audio. While the mixer is off (or being restarted) this feeds the stream real-time
   * silence, so the mixer can be started, stopped or changed at any moment during a live stream.
   */
  private startSilenceFiller(): void {
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    this.silenceTimer = setInterval(() => {
      const sock = this.socket
      if (!sock || sock.destroyed) {
        if (this.silenceTimer) clearInterval(this.silenceTimer)
        this.silenceTimer = null
        return
      }
      const now = Date.now()
      if (now - this.lastPcmAt < 100) { this.filledUntil = now; return } // the mixer is delivering
      const frames = Math.min(96000, Math.round(((now - this.filledUntil) / 1000) * 48000))
      this.filledUntil = now
      if (frames > 0 && sock.writableLength < MAX_BACKLOG_BYTES) sock.write(Buffer.alloc(frames * 8))
    }, 20)
  }

  private padToVideoStart(sock: Socket): void {
    if (!this.syncStart) return
    const frames = Math.max(0, Math.round(((Date.now() - this.syncStart) / 1000) * 48000))
    this.syncStart = 0
    if (frames) sock.write(Buffer.alloc(frames * 8)) // 2 channels × 4-byte float
  }

  /** The video clock, so the mixer's "Video playback" input can play the current video's soundtrack in sync. */
  sendPlayback(state: PlaybackState): void {
    this.playback = state
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(AUDIO_IPC.playback, state)
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

  /** Gets every block of the stream mix (interleaved stereo f32, 48 kHz) as it comes from the mixer, whether or not a stream is running. */
  onPcm(listener: (pcm: Buffer) => void): void {
    this.pcmListeners.push(listener)
  }

  /** Gets every block of the video cues' own sound (stereo f32, 48 kHz, before the mixer's strips): silence while no video plays. */
  onVideoPcm(listener: (pcm: Buffer) => void): void {
    this.videoPcmListeners.push(listener)
  }

  /** Validates, applies live to the audio window, and persists (debounced: faders send many updates). */
  setMixer(raw: unknown): MixerConfig {
    this.mixer = sanitizeMixer(raw)
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(AUDIO_IPC.mixerPush, this.mixer)
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => writeJsonAtomic(this.mixerPath(), this.mixer), 500)
    return this.mixer
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
    if (this.silenceTimer) clearInterval(this.silenceTimer)
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      writeJsonAtomic(this.mixerPath(), this.mixer) // flush a pending change
    }
    this.native.stopAll()
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
        autoplayPolicy: 'no-user-gesture-required', // it plays video soundtracks with nobody clicking
      },
    })
    await win.loadFile(join(__dirname, '../renderer/audio.html'))
    this.win = win
    win.on('closed', () => this.native.stopAll())
    win.webContents.send(AUDIO_IPC.playback, this.playback)
    return win
  }
}

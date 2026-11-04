import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { promisify } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import type { NativeImage } from 'electron'
import { idleStream, type StreamStatus } from '../shared/types'
import { ffmpegPath } from './tools'

const FPS = 30
const OUT_WIDTH = 1920
const OUT_HEIGHT = 1080
const MAX_CATCH_UP = 10
const YOUTUBE_INGEST = 'rtmp://a.rtmp.youtube.com/live2'

export interface StreamTarget {
  /** Where ffmpeg writes. May contain a secret (stream key): never log it. */
  url: string
  format: 'flv' | 'matroska'
  /** Safe to display. */
  label: string
}

export const youtubeTarget = (streamKey: string): StreamTarget => ({
  url: `${YOUTUBE_INGEST}/${streamKey}`,
  format: 'flv',
  label: 'YouTube (rtmp://a.rtmp.youtube.com)',
})

export const fileTarget = (path: string): StreamTarget => ({ url: path, format: 'matroska', label: path })

type Ffmpeg = ChildProcessByStdio<Writable, null, Readable>

const BITRATE = ['-b:v', '6000k', '-maxrate', '6000k', '-bufsize', '12000k']

/** Encoder-specific ffmpeg arguments. Software x264 is the universal fallback. */
const ENCODER_ARGS: Record<string, string[]> = {
  libx264: ['-c:v', 'libx264', '-preset', 'veryfast', ...BITRATE],
  h264_videotoolbox: ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high', ...BITRATE],
  h264_nvenc: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', ...BITRATE],
  h264_qsv: ['-c:v', 'h264_qsv', '-preset', 'veryfast', ...BITRATE],
  h264_amf: ['-c:v', 'h264_amf', '-usage', 'lowlatency', ...BITRATE],
}

/** Hardware encoders worth trying per platform, best first. */
const HARDWARE_CANDIDATES: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ['h264_videotoolbox'],
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  linux: ['h264_nvenc'],
}

export interface FfmpegArgsOptions {
  /** Size of the raw BGRA frames piped in. */
  width: number
  height: number
  /** Loopback port serving the stereo mix as raw PCM; 0 = generated silence. */
  audioPort: number
  encoder: string
  target: StreamTarget
  logLevel: string
}

/**
 * The ffmpeg command line for one stream: raw frames on stdin plus raw PCM from a loopback port (or silence),
 * scaled to 1080p30 and encoded to H.264/AAC.
 */
export function buildFfmpegArgs(o: FfmpegArgsOptions): string[] {
  const needsScale = o.width !== OUT_WIDTH || o.height !== OUT_HEIGHT
  // Timestamps come from frame/sample counts (not wall clock: ffmpeg does not apply wall-clock stamping to raw PCM,
  // which stalls the muxer); the pacing loop in Streamer keeps the frame count tied to real time.
  // Both raw inputs have a fully specified format, so probing is switched off. Measured: without these flags ffmpeg
  // sits at frame 0 for several seconds waiting for probe data that only arrives in real time.
  const noProbe = ['-probesize', '32', '-analyzeduration', '0', '-thread_queue_size', '512']
  const audioInput = o.audioPort
    ? [...noProbe, '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', `tcp://127.0.0.1:${o.audioPort}`]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'] // silence until a source is set
  return [
    '-hide_banner', '-loglevel', o.logLevel, '-y',
    ...noProbe, '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${o.width}x${o.height}`, '-framerate', String(FPS), '-i', 'pipe:0',
    ...audioInput,
    '-vf', `${needsScale ? `scale=${OUT_WIDTH}:${OUT_HEIGHT},` : ''}format=yuv420p`,
    ...(ENCODER_ARGS[o.encoder] ?? ENCODER_ARGS.libx264),
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2),
    '-c:a', 'aac', '-b:a', '128k', '-shortest',
    '-f', o.target.format, o.target.url,
  ]
}

let encoderChoice: Promise<string> | null = null

/** A tiny real encode: "listed by ffmpeg" does not mean "works on this machine" (no GPU, missing driver). */
async function encoderWorks(name: string): Promise<boolean> {
  try {
    await promisify(execFile)(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=640x360:r=30:d=0.5', '-frames:v', '5', '-pix_fmt', 'yuv420p', '-c:v', name, '-f', 'null', '-'], { timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

/**
 * Picks the video encoder once per run: PRESTREAMER_ENCODER overrides ("libx264" forces software), otherwise the
 * first working hardware encoder for this platform, else libx264. Hardware encoding keeps a busy machine
 * from starving the live stream.
 */
export function pickEncoder(): Promise<string> {
  encoderChoice ??= (async () => {
    const forced = process.env.PRESTREAMER_ENCODER
    if (forced && forced !== 'auto') return forced in ENCODER_ARGS ? forced : 'libx264'
    for (const name of HARDWARE_CANDIDATES[process.platform] ?? []) if (await encoderWorks(name)) return name
    return 'libx264'
  })()
  return encoderChoice
}

/**
 * Pulls frames of one virtual screen at a constant frame rate and pipes them to ffmpeg.
 * Offscreen windows only repaint when content changes, so the last frame is re-sent each tick
 * to keep the stream's timeline steady (a static lyric slide must still be a live stream).
 */
export class Streamer {
  private proc: Ffmpeg | null = null
  private timer: NodeJS.Timeout | null = null
  private status: StreamStatus = { ...idleStream }
  private stderrTail: string[] = []
  private secret = ''

  constructor(private readonly onStatus: (s: StreamStatus) => void) {}

  getStatus(): StreamStatus {
    return this.status
  }

  async start(
    getFrame: () => NativeImage | null,
    target: StreamTarget,
    secret = '',
    audioPort = 0,
    /** Called with the wall-clock time of the first video frame, so audio can be aligned to it. */
    onVideoStart?: (startMs: number) => void,
  ): Promise<void> {
    if (this.proc) throw new Error('Already streaming')
    this.secret = secret
    this.stderrTail = []
    this.set({ ...idleStream, state: 'starting', target: target.label })

    const first = await waitFor(getFrame, 3000)
    if (!first) return this.fail('Selected screen produced no frames. Is it live?')
    const { width, height } = first.getSize()

    const encoder = await pickEncoder()
    const args = buildFfmpegArgs({ width, height, audioPort, encoder, target, logLevel: process.env.PRESTREAMER_FFMPEG_LOG || 'warning' })

    const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'ignore', 'pipe'] }) as Ffmpeg
    this.proc = proc
    proc.stderr.on('data', (d: Buffer) => {
      const lines = this.redact(d.toString()).split('\n').filter(Boolean)
      if (process.env.PRESTREAMER_FFMPEG_LOG) for (const l of lines) console.log('[ffmpeg]', l)
      this.stderrTail = [...this.stderrTail, ...lines].slice(-8)
    })
    proc.stdin.on('error', () => {}) // EPIPE when ffmpeg dies; handled by 'close'
    proc.on('error', (e) => this.fail(e.message.includes('ENOENT') ? 'ffmpeg not found on PATH (set FFMPEG_PATH)' : e.message))
    proc.on('close', (code) => {
      this.clearTimer()
      this.proc = null
      // Already reported (stop() or fail() got there first): do not overwrite a more helpful message.
      if (this.status.state === 'idle' || this.status.state === 'error') return
      if (code === 0) this.set({ ...this.status, state: 'idle', message: 'Stopped' })
      else this.set({ ...this.status, state: 'error', message: this.stderrTail.join('\n') || `ffmpeg exited with code ${code}` })
    })

    this.set({ ...this.status, state: 'running', startedAt: Date.now(), message: `Encoder: ${encoder}` })

    let lastImage: NativeImage | null = null
    let lastBuf: Buffer | null = null
    const frameMs = 1000 / FPS
    const startMs = Date.now()
    onVideoStart?.(startMs)
    let sent = 0 // frames due so far, written or dropped
    const tick = () => {
      if (!this.proc) return
      const image = getFrame()
      if (image && image !== lastImage) {
        lastImage = image
        lastBuf = image.toBitmap() // BGRA on little-endian hosts (macOS, Windows)
      }
      // Frames owed by the wall clock. After a stall, repeat the last frame (up to a cap) so the video
      // timeline stays aligned with real time and with audio.
      const due = Math.floor((Date.now() - startMs) / frameMs) + 1
      const owed = Math.min(due - sent, MAX_CATCH_UP)
      if (due - sent > MAX_CATCH_UP) sent = due - owed
      for (let i = 0; i < owed && lastBuf; i++) {
        sent++
        if (proc.stdin.writableNeedDrain) {
          this.status.dropped++
          continue
        }
        proc.stdin.write(lastBuf)
        this.status.frames++
      }
      this.timer = setTimeout(tick, Math.max(1, startMs + sent * frameMs - Date.now()))
    }
    tick()
    // Push counters to the UI once per second rather than per frame.
    const ticker = setInterval(() => {
      if (!this.proc) return clearInterval(ticker)
      this.set({ ...this.status })
    }, 1000)
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.clearTimer()
    this.set({ ...this.status, state: 'idle', message: 'Stopping…' })
    const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()))
    proc.stdin.end() // lets ffmpeg flush and finalize the container
    const killer = setTimeout(() => proc.kill('SIGKILL'), 5000)
    await closed
    clearTimeout(killer)
    this.set({ ...this.status, state: 'idle', message: 'Stopped' })
  }

  private fail(message: string): void {
    this.clearTimer()
    this.proc?.kill('SIGKILL')
    this.proc = null
    this.set({ ...this.status, state: 'error', message })
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private redact(text: string): string {
    return this.secret ? text.split(this.secret).join('***') : text
  }

  private set(s: StreamStatus): void {
    this.status = s
    this.onStatus(s)
  }
}

async function waitFor<T>(get: () => T | null, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v) return v
    if (Date.now() > end) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}

import { execFile, spawn, type ChildProcessByStdio } from 'node:child_process'
import { promisify } from 'node:util'
import type { Readable, Writable } from 'node:stream'
import type { NativeImage } from 'electron'
import { defaultStreamSettings, type EncoderChoice, type StreamSettings } from '../shared/stream-settings'
import { RateMeter, assessHealth, dropPercent, parseProgress, parseSpeed, type StreamStats } from '../shared/stream-stats'
import { idleStream, type StreamStatus } from '../shared/types'
import { ffmpegPath } from './tools'
import { t } from '../shared/i18n'

const MAX_CATCH_UP = 10
const YOUTUBE_INGEST = 'rtmp://a.rtmp.youtube.com/live2'
const HISTORY_SECONDS = 120
const RECENT_WINDOW_SECONDS = 30
const LONG_WINDOW_SECONDS = 60

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

type Ffmpeg = ChildProcessByStdio<Writable, Readable, Readable>

/** Encoder-specific ffmpeg arguments for the chosen settings. Software x264 is the universal fallback. */
function encoderArgs(encoder: string, s: StreamSettings): string[] {
  const bitrate = ['-b:v', `${s.videoKbps}k`, '-maxrate', `${s.videoKbps}k`, '-bufsize', `${s.videoKbps * 2}k`]
  switch (encoder) {
    case 'h264_videotoolbox': return ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-profile:v', 'high', ...bitrate]
    case 'h264_nvenc': return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', ...bitrate]
    case 'h264_qsv': return ['-c:v', 'h264_qsv', '-preset', 'veryfast', ...bitrate]
    case 'h264_amf': return ['-c:v', 'h264_amf', '-usage', 'lowlatency', ...bitrate]
    default: return ['-c:v', 'libx264', '-preset', s.preset, '-sc_threshold', '0', ...bitrate] // no scene-cut keyframes: they would break the regular interval
  }
}

const KNOWN_ENCODERS = ['libx264', 'h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf']

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
  settings: StreamSettings
}

/**
 * The ffmpeg command line for one stream: raw frames on stdin plus raw PCM from a loopback port (or silence), scaled to
 * the output size and encoded to H.264/AAC with the chosen bitrate, frame rate and keyframe interval. `-progress` makes
 * ffmpeg report bitrate and speed once a second on stdout, which the health panel reads.
 */
export function buildFfmpegArgs(o: FfmpegArgsOptions): string[] {
  const s = o.settings
  const needsScale = o.width !== s.width || o.height !== s.height
  // Timestamps come from frame/sample counts (not wall clock: ffmpeg does not apply wall-clock stamping to raw PCM,
  // which stalls the muxer); the pacing loop in Streamer keeps the frame count tied to real time.
  // Both raw inputs have a fully specified format, so probing is switched off. Measured: without these flags ffmpeg
  // sits at frame 0 for several seconds waiting for probe data that only arrives in real time.
  const noProbe = ['-probesize', '32', '-analyzeduration', '0', '-thread_queue_size', '512']
  const audioInput = o.audioPort
    ? [...noProbe, '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', `tcp://127.0.0.1:${o.audioPort}`]
    : ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'] // silence until a source is set
  const gop = String(s.fps * s.keyframeSec)
  return [
    '-hide_banner', '-loglevel', o.logLevel, '-y', '-progress', 'pipe:1', '-stats_period', '1', '-nostats',
    ...noProbe, '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', `${o.width}x${o.height}`, '-framerate', String(s.fps), '-i', 'pipe:0',
    ...audioInput,
    '-vf', `${needsScale ? `scale=${s.width}:${s.height},` : ''}format=yuv420p`,
    '-r', String(s.fps),
    ...encoderArgs(o.encoder, s),
    '-g', gop, '-keyint_min', gop,
    '-c:a', 'aac', '-b:a', `${s.audioKbps}k`, '-shortest',
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
    if (forced && forced !== 'auto') return KNOWN_ENCODERS.includes(forced) ? forced : 'libx264'
    for (const name of HARDWARE_CANDIDATES[process.platform] ?? []) if (await encoderWorks(name)) return name
    return 'libx264'
  })()
  return encoderChoice
}

/** The encoder to use for the user's choice. A choice that does not work on this machine falls back, and says so. */
export async function resolveEncoder(choice: EncoderChoice): Promise<{ name: string; note?: string }> {
  if (choice === 'auto' || process.env.PRESTREAMER_ENCODER) return { name: await pickEncoder() }
  if (choice === 'libx264' || (await encoderWorks(choice))) return { name: choice }
  const name = await pickEncoder()
  return { name, note: `${choice} is not available on this computer; using ${name} instead.` }
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
  // health
  private meter = new RateMeter(5000)
  private history: number[] = []
  private snapshots: { t: number; sent: number; dropped: number }[] = []
  private carry = ''
  private progress = { speed: null as number | null, fps: 0, dup: 0, drop: 0, size: 0 }
  private settings: StreamSettings = defaultStreamSettings
  private encoderName = ''

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
    settings: StreamSettings = defaultStreamSettings,
  ): Promise<void> {
    if (this.proc) throw new Error(t('main.streamer.already'))
    this.secret = secret
    this.stderrTail = []
    this.settings = settings
    this.meter = new RateMeter(5000)
    this.history = []
    this.snapshots = []
    this.carry = ''
    this.progress = { speed: null, fps: 0, dup: 0, drop: 0, size: 0 }
    this.set({ ...idleStream, state: 'starting', target: target.label })

    const first = await waitFor(getFrame, 3000)
    if (!first) return this.fail(t('main.streamer.noFrames'))
    const { width, height } = first.getSize()

    const { name: encoder, note } = await resolveEncoder(settings.encoder)
    this.encoderName = encoder
    const args = buildFfmpegArgs({ width, height, audioPort, encoder, target, logLevel: process.env.PRESTREAMER_FFMPEG_LOG || 'warning', settings })

    const proc = spawn(ffmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] }) as Ffmpeg
    this.proc = proc
    proc.stdout.on('data', (d: Buffer) => this.onProgress(d.toString()))
    proc.stderr.on('data', (d: Buffer) => {
      const lines = this.redact(d.toString()).split('\n').filter(Boolean)
      if (process.env.PRESTREAMER_FFMPEG_LOG) for (const l of lines) console.log('[ffmpeg]', l)
      this.stderrTail = [...this.stderrTail, ...lines].slice(-8)
    })
    proc.stdin.on('error', () => {}) // EPIPE when ffmpeg dies; handled by 'close'
    proc.on('error', (e) => this.fail(e.message.includes('ENOENT') ? t('main.streamer.ffmpegMissing') : e.message))
    proc.on('close', (code) => {
      this.clearTimer()
      this.proc = null
      // Already reported (stop() or fail() got there first): do not overwrite a more helpful message.
      if (this.status.state === 'idle' || this.status.state === 'error') return
      if (code === 0) this.set({ ...this.status, state: 'idle', message: t('main.streamer.stopped') })
      else this.set({ ...this.status, state: 'error', message: this.stderrTail.join('\n') || t('main.ffmpeg.exited', { code: String(code) }) })
    })

    this.set({ ...this.status, state: 'running', startedAt: Date.now(), message: note ? t('main.streamer.encoderNote', { encoder, note }) : t('main.streamer.encoder', { encoder }) })

    let lastImage: NativeImage | null = null
    let lastBuf: Buffer | null = null
    const frameMs = 1000 / settings.fps
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
      this.set({ ...this.status, stats: this.computeStats() })
    }, 1000)
  }

  async stop(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    this.clearTimer()
    this.set({ ...this.status, state: 'idle', message: t('main.streamer.stopping') })
    const closed = new Promise<void>((resolve) => proc.once('close', () => resolve()))
    proc.stdin.end() // lets ffmpeg flush and finalize the container
    const killer = setTimeout(() => proc.kill('SIGKILL'), 5000)
    await closed
    clearTimeout(killer)
    this.set({ ...this.status, state: 'idle', message: t('main.streamer.stopped') })
  }

  private fail(message: string): void {
    this.clearTimer()
    this.proc?.kill('SIGKILL')
    this.proc = null
    this.set({ ...this.status, state: 'error', message })
  }

  /** Reads ffmpeg's -progress blocks: bytes written so far (for the bitrate), speed, and frames it had to repeat or drop. */
  private onProgress(text: string): void {
    const { blocks, rest } = parseProgress(text, this.carry)
    this.carry = rest
    for (const b of blocks) {
      const size = Number(b.total_size)
      if (Number.isFinite(size)) {
        this.progress.size = size
        this.meter.push(Date.now(), size)
      }
      this.progress.speed = parseSpeed(b.speed)
      this.progress.fps = Number(b.fps) || 0
      this.progress.dup = Number(b.dup_frames) || 0
      this.progress.drop = Number(b.drop_frames) || 0
    }
  }

  /** The numbers behind the health panel, once a second. */
  private computeStats(): StreamStats {
    const now = Date.now()
    const uptimeSec = this.status.startedAt ? Math.floor((now - this.status.startedAt) / 1000) : 0
    this.snapshots.push({ t: now, sent: this.status.frames, dropped: this.status.dropped })
    while (this.snapshots.length > 1 && now - this.snapshots[1].t > LONG_WINDOW_SECONDS * 1000) this.snapshots.shift()
    const latest = this.snapshots[this.snapshots.length - 1]
    const recentStart = this.snapshots.find((s) => now - s.t <= RECENT_WINDOW_SECONDS * 1000) ?? this.snapshots[0]
    const recentDropPercent = dropPercent(recentStart, latest)
    const dropPercent60 = dropPercent(this.snapshots[0], latest)
    const bitrateKbps = this.meter.kbps()
    this.history.push(bitrateKbps)
    if (this.history.length > HISTORY_SECONDS) this.history.shift()
    return {
      bitrateKbps,
      targetKbps: this.settings.videoKbps + this.settings.audioKbps,
      fps: this.progress.fps,
      targetFps: this.settings.fps,
      speed: this.progress.speed,
      sentFrames: this.status.frames,
      droppedFrames: this.status.dropped,
      recentDropPercent,
      dropPercent60,
      dupFrames: this.progress.dup,
      ffmpegDropped: this.progress.drop,
      sizeBytes: this.progress.size,
      uptimeSec,
      history: [...this.history],
      health: assessHealth({ speed: this.progress.speed, recentDropPercent, uptimeSec }),
      encoder: this.encoderName,
      width: this.settings.width,
      height: this.settings.height,
    }
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

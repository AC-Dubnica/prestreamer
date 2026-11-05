/** Stream health: parsing ffmpeg's progress output, measuring bitrate, and rating how the stream is doing. */

export type Health = 'idle' | 'good' | 'warn' | 'poor'

export interface StreamStats {
  /** Current bitrate in kbit/s (video + audio + container), averaged over the last few seconds. */
  bitrateKbps: number
  /** Bitrate the settings ask for (video + audio). */
  targetKbps: number
  /** Frames per second actually being encoded, and the target. */
  fps: number
  targetFps: number
  /** Encoding speed: 1.0 = real time. Below 1 the encoder cannot keep up. */
  speed: number | null
  /** Frames sent to the encoder. */
  sentFrames: number
  /** Frames dropped because the encoder or the network could not take them. */
  droppedFrames: number
  /** Share (0-100) of frames dropped over the last 30 seconds. */
  recentDropPercent: number
  /** The same over the last 60 seconds: a steadier figure for the compact view. */
  dropPercent60: number
  /** Frames ffmpeg itself duplicated or dropped to keep the frame rate steady. */
  dupFrames: number
  ffmpegDropped: number
  sizeBytes: number
  uptimeSec: number
  /** Bitrate once a second for the last two minutes, for the graph. */
  history: number[]
  health: Health
  encoder: string
  width: number
  height: number
}

/**
 * ffmpeg's `-progress` output is blocks of key=value lines, each ending with progress=continue|end. Feed it text as it
 * arrives; returns the finished blocks and the unfinished remainder to pass in next time.
 */
export function parseProgress(text: string, carry = ''): { blocks: Record<string, string>[]; rest: string } {
  const lines = (carry + text).split('\n')
  const rest = lines.pop() ?? '' // the last line may be incomplete
  const blocks: Record<string, string>[] = []
  let current: Record<string, string> = {}
  for (const raw of lines) {
    const line = raw.trim()
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq)
    current[key] = line.slice(eq + 1)
    if (key === 'progress') {
      blocks.push(current)
      current = {}
    }
  }
  // lines of an unfinished block stay for next time
  const pending = Object.entries(current).map(([k, v]) => `${k}=${v}`).join('\n')
  return { blocks, rest: pending ? `${pending}\n${rest}` : rest }
}

/** "1.02x" -> 1.02; "N/A" or junk -> null. */
export const parseSpeed = (s: string | undefined): number | null => {
  const m = /^\s*([\d.]+)x\s*$/.exec(s ?? '')
  return m ? Number(m[1]) : null
}

/** Bitrate over a sliding window, from cumulative byte counts. */
export class RateMeter {
  private samples: { t: number; bytes: number }[] = []
  constructor(private readonly windowMs = 5000) {}

  push(timeMs: number, totalBytes: number): void {
    this.samples.push({ t: timeMs, bytes: totalBytes })
    while (this.samples.length > 2 && timeMs - this.samples[1].t >= this.windowMs) this.samples.shift()
  }

  /** kbit/s over the window; 0 until there are two samples. */
  kbps(): number {
    if (this.samples.length < 2) return 0
    const a = this.samples[0]
    const b = this.samples[this.samples.length - 1]
    return b.t > a.t ? Math.max(0, Math.round(((b.bytes - a.bytes) * 8) / (b.t - a.t))) : 0
  }
}

/**
 * Good / unstable / poor, like the coloured indicator in OBS. The first seconds are never judged: start-up is not trouble.
 * Speed below 1 means the encoder is falling behind; dropped frames mean the encoder or the network cannot take the load.
 */
export function assessHealth(input: { speed: number | null; recentDropPercent: number; uptimeSec: number }): Health {
  if (input.uptimeSec < 8) return 'good'
  const speed = input.speed ?? 1
  if (speed < 0.9 || input.recentDropPercent > 5) return 'poor'
  if (speed < 0.98 || input.recentDropPercent > 1) return 'warn'
  return 'good'
}

/** Drop percentage between an older snapshot and now. */
export function dropPercent(older: { sent: number; dropped: number }, now: { sent: number; dropped: number }): number {
  const dropped = now.dropped - older.dropped
  const total = now.sent - older.sent + dropped
  return total > 0 ? Math.round((dropped / total) * 1000) / 10 : 0
}

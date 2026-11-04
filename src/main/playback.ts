import { idlePlayback, type PlaybackCommand, type PlaybackState } from '../shared/types'

/** Owns the single video clock. Windows only receive state changes; they extrapolate the position themselves. */
export class Playback {
  private state: PlaybackState = { ...idlePlayback }
  private endTimer: NodeJS.Timeout | null = null

  constructor(private readonly onChange: (s: PlaybackState) => void) {}

  get(): PlaybackState {
    return this.state
  }

  position(): number {
    const s = this.state
    return s.playing ? Math.min(s.durationSec, s.positionSec + (Date.now() - s.atMs) / 1000) : s.positionSec
  }

  /** A video cue went live (paused at the start), or null when something else is shown. */
  load(video: { file: string; durationSec: number } | null): void {
    this.set(video ? { file: video.file, playing: false, positionSec: 0, atMs: Date.now(), durationSec: video.durationSec } : { ...idlePlayback })
  }

  command(cmd: PlaybackCommand): void {
    const s = this.state
    if (!s.file) return
    const pos = this.position()
    switch (cmd.type) {
      case 'play':
        // Pressing play on a finished video restarts it.
        this.set({ ...s, playing: true, positionSec: pos >= s.durationSec - 0.05 ? 0 : pos, atMs: Date.now() })
        break
      case 'pause':
        this.set({ ...s, playing: false, positionSec: pos, atMs: Date.now() })
        break
      case 'stop':
        this.set({ ...s, playing: false, positionSec: 0, atMs: Date.now() })
        break
      case 'seek':
        this.set({ ...s, positionSec: Math.min(s.durationSec, Math.max(0, cmd.sec)), atMs: Date.now() })
        break
    }
  }

  private set(next: PlaybackState): void {
    this.state = next
    if (this.endTimer) clearTimeout(this.endTimer)
    this.endTimer = null
    if (next.playing) {
      const remainingMs = Math.max(0, (next.durationSec - next.positionSec) * 1000)
      this.endTimer = setTimeout(() => {
        // Ran to the end: hold on the last frame, paused.
        this.set({ ...this.state, playing: false, positionSec: this.state.durationSec, atMs: Date.now() })
      }, remainingMs)
    }
    this.onChange(next)
  }
}

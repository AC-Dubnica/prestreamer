/**
 * Multichannel capture outside the browser. Chromium opens a USB interface with two channels at most, however many it has, so on
 * macOS the main process reads such a device with ffmpeg (CoreAudio, all channels) and streams the samples to the mixer.
 */

/** A mixer input whose device id starts with this is read natively; the rest of the id is the device's name (indexes change, names do not). */
export const NATIVE_PREFIX = 'avf:'
/** The most channels the Web Audio graph carries in one node. */
export const NATIVE_MAX_CHANNELS = 32

export const nativeKey = (name: string): string => NATIVE_PREFIX + name
export const nativeName = (key: string): string | null => (key.startsWith(NATIVE_PREFIX) ? key.slice(NATIVE_PREFIX.length) : null)

export interface NativeInput { name: string; channels: number }

/** The inputs worth reading natively: those macOS says have more than the two channels Chromium can open (from `system_profiler SPAudioDataType -json`). */
export function parseNativeInputs(json: unknown): NativeInput[] {
  const found = new Map<string, number>()
  const groups = (json as { SPAudioDataType?: { _items?: Record<string, unknown>[] }[] } | null)?.SPAudioDataType ?? []
  for (const group of groups) {
    for (const item of group._items ?? []) {
      const channels = item.coreaudio_device_input
      if (typeof item._name === 'string' && typeof channels === 'number' && channels > 2) found.set(item._name, channels)
    }
  }
  return [...found].map(([name, channels]) => ({ name, channels }))
}

/** What ffmpeg says it will deliver, from its "Stream #0:0: Audio: pcm_f32le, 48000 Hz, 32 channels" line. */
export function parseFfmpegAudio(stderr: string): { channels: number; rate: number } | null {
  const m = /Stream #\d+:\d+.*?: Audio: .*?, (\d+) Hz, (\d+) channels/.exec(stderr)
  return m ? { rate: Number(m[1]), channels: Number(m[2]) } : null
}

/**
 * Turns the byte chunks of a pipe, which arrive in any size, into whole frames of interleaved f32 samples. A chunk that ends
 * inside a frame would shift every channel by one place from then on, so the odd bytes wait for the next chunk.
 */
export class FrameSplitter {
  private rest = new Uint8Array(0)

  constructor(private readonly channels: number) {}

  /** The whole frames now available (a copy, aligned for a Float32Array), or null if there is not a full frame yet. */
  push(chunk: Uint8Array): Float32Array | null {
    const frameBytes = this.channels * 4
    const total = this.rest.length + chunk.length
    const usable = total - (total % frameBytes)
    if (usable === 0) {
      const joined = new Uint8Array(total)
      joined.set(this.rest)
      joined.set(chunk, this.rest.length)
      this.rest = joined
      return null
    }
    const buf = new ArrayBuffer(usable)
    const bytes = new Uint8Array(buf)
    bytes.set(this.rest)
    bytes.set(chunk.subarray(0, usable - this.rest.length), this.rest.length)
    this.rest = chunk.slice(usable - this.rest.length)
    return new Float32Array(buf)
  }
}

/** ffmpeg's `pan` filter that keeps the first `keep` channels of a wider device. */
export const keepChannels = (keep: number): string => `pan=${keep}c|${Array.from({ length: keep }, (_, i) => `c${i}=c${i}`).join('|')}`

/**
 * Linux: the sound cards with more than two capture channels, from /proc/asound. `cards` is the text of /proc/asound/cards and
 * `streams` holds the text of each card's stream files (/proc/asound/card<N>/stream0 ...), keyed by card number. Only USB audio
 * cards have stream files, and those list the formats a device offers ("Channels: 32" under "Capture:"). The name is the card's
 * short id (what `hw:CARD=<id>` takes), which stays the same when the card's number changes.
 */
export function parseAlsaInputs(cards: string, streams: Record<string, string[]>): NativeInput[] {
  const out: NativeInput[] = []
  for (const line of cards.split('\n')) {
    const m = /^\s*(\d+)\s+\[([^\]]+?)\s*\]:/.exec(line)
    if (!m) continue
    let channels = 0
    for (const text of streams[m[1]] ?? []) {
      const capture = text.split(/^Capture:/m)[1]
      if (!capture) continue
      for (const c of capture.matchAll(/^\s*Channels:\s*(\d+)/gm)) channels = Math.max(channels, Number(c[1]))
    }
    if (channels > 2) out.push({ name: m[2], channels })
  }
  return out
}

/** Windows: the helper's `list` output, one capture endpoint per line as "name<TAB>channels". Only those with more than two channels are worth reading natively. */
export function parseWasapiList(stdout: string): NativeInput[] {
  const found = new Map<string, number>()
  for (const line of stdout.split(/\r?\n/)) {
    const [name, channels] = line.split('\t')
    const n = Number(channels)
    if (name && Number.isInteger(n) && n > 2) found.set(name, n)
  }
  return [...found].map(([name, channels]) => ({ name, channels }))
}

import { app, type NativeImage } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import type { Writable } from 'node:stream'
import { join } from 'node:path'
import { NDI_FPS, ndiMissing, ndiLibraryCandidates, ndiSourceName } from '../shared/ndi'
import type { NdiSound, NdiStatus } from '../shared/types'
import { t } from '../shared/i18n'

/** The sender program (src/native/ndisend.c, compiled by build.mjs). It sits unpacked next to the asar in an installed app. */
function helperPath(): string {
  return join(__dirname, '../native', process.platform === 'win32' ? 'ndisend.exe' : 'ndisend').replace('app.asar', 'app.asar.unpacked')
}

/** NDI's library: shipped with the app, or installed with NDI Tools / the NDI Runtime. Null if there is none. */
export function findNdiLibrary(): string | null {
  const candidates = ndiLibraryCandidates({
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    projectDir: app.isPackaged ? undefined : join(__dirname, '../..'),
  })
  return candidates.find((p) => existsSync(p)) ?? null
}

interface Output { proc: ChildProcess; timer: NodeJS.Timeout | null; stopped: boolean; /** Where the sound goes (the helper's fd 3), if this output has sound. */ audio: Writable | null; sound: NdiSound }

/**
 * Sends the frames of 'ndi' screens over the network, one helper process each. A crash inside NDI's library therefore ends
 * one output and never the app. Offscreen windows only paint when something changes, so the last frame is sent again at a steady rate.
 */
export class NdiOutputs {
  private outputs = new Map<string, Output>()

  constructor(private readonly onStatus: (id: string, status: NdiStatus | null) => void) {}

  /** `sound`: which of the sounds given to `audio()` goes along with the picture. */
  start(id: string, screenName: string, width: number, height: number, sound: NdiSound, getFrame: () => NativeImage | null): void {
    this.stop(id)
    const name = ndiSourceName(screenName)
    const library = findNdiLibrary()
    if (!library) return this.onStatus(id, { state: 'error', message: ndiMissing() })
    const helper = helperPath()
    if (!existsSync(helper)) return this.onStatus(id, { state: 'error', message: t('main.ndi.senderMissing') })

    this.onStatus(id, { state: 'starting', message: t('main.ndi.starting', { name }) })
    const proc = spawn(helper, ['send', library, name, String(width), String(height), String(NDI_FPS), ...(sound !== 'none' ? ['audio'] : [])], { stdio: ['pipe', 'ignore', 'pipe', ...(sound !== 'none' ? ['pipe' as const] : [])] })
    const audioPipe = sound !== 'none' ? (proc.stdio[3] as Writable) : null
    audioPipe?.on('error', () => {})
    const out: Output = { proc, timer: null, stopped: false, audio: audioPipe, sound }
    this.outputs.set(id, out)
    let log = ''
    proc.stdin!.on('error', () => {}) // the helper ending is handled by 'close'
    proc.stderr!.on('data', (d: Buffer) => {
      log = (log + d.toString()).slice(-1000)
      if (/^READY$/m.test(log) && !out.timer) {
        this.onStatus(id, { state: 'sending', message: t(sound === 'stream' ? 'main.ndi.sendingStream' : sound === 'video' ? 'main.ndi.sendingVideo' : 'main.ndi.sending', { name }) })
        out.timer = this.pace(proc, width, height, getFrame)
      }
    })
    proc.on('error', (err) => this.finish(id, out, `The NDI sender could not start: ${err.message}`))
    proc.on('close', (code) => this.finish(id, out, `The NDI sender stopped (${code}). ${log.trim().split('\n').pop() ?? ''}`.trim()))
  }

  /** Writes the newest frame at a steady rate; a frame is skipped rather than queued when the helper is behind, so the picture never lags. */
  private pace(proc: ChildProcess, width: number, height: number, getFrame: () => NativeImage | null): NodeJS.Timeout {
    let lastImage: NativeImage | null = null
    let lastBuf: Buffer | null = null
    return setInterval(() => {
      const image = getFrame()
      if (image && image !== lastImage) {
        lastImage = image
        const size = image.getSize()
        lastBuf = (size.width === width && size.height === height ? image : image.resize({ width, height })).toBitmap() // BGRA on little-endian hosts
      }
      if (lastBuf && !proc.stdin!.writableNeedDrain) proc.stdin!.write(lastBuf)
    }, 1000 / NDI_FPS)
  }

  /** A block of one sound (interleaved stereo f32, 48 kHz) goes to every output that wants that one. Dropped, not queued, if an output is behind: a late sound is worse than a gap. */
  audio(which: 'stream' | 'video', pcm: Buffer): void {
    for (const out of this.outputs.values()) {
      if (out.sound === which && out.timer && out.audio && !out.audio.writableNeedDrain) out.audio.write(pcm) // the timer is set once the helper is ready
    }
  }

  private finish(id: string, out: Output, message: string): void {
    if (out.timer) clearInterval(out.timer)
    out.timer = null
    if (this.outputs.get(id) !== out) return // replaced by a newer output of the same screen
    this.outputs.delete(id)
    if (!out.stopped) this.onStatus(id, { state: 'error', message })
  }

  stop(id: string): void {
    const out = this.outputs.get(id)
    if (!out) return
    out.stopped = true
    if (out.timer) clearInterval(out.timer)
    out.timer = null
    this.outputs.delete(id)
    out.proc.stdin?.end() // the helper ends with its input and tears the source down
    setTimeout(() => out.proc.kill('SIGKILL'), 2000).unref()
    this.onStatus(id, null)
  }

  stopAll(): void {
    for (const id of [...this.outputs.keys()]) this.stop(id)
  }
}

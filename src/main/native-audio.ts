import { systemPreferences } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { FrameSplitter, NATIVE_MAX_CHANNELS, parseAlsaInputs, parseFfmpegAudio, parseNativeInputs, parseWasapiList, type NativeInput } from '../shared/native-audio'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ffmpegPath } from './tools'

const START_TIMEOUT_MS = 10_000

/** The stand-in device of the tests (PRESTREAMER_NATIVE_TEST=1): 32 channels, channel n a sine of 300 + 100·n Hz at -12 dBFS. */
export const TEST_RIG: NativeInput = { name: 'TESTRIG', channels: 32 }
export const testRigHz = (channel: number): number => 300 + 100 * channel
const testRigSource = (): string => `aevalsrc=${Array.from({ length: TEST_RIG.channels }, (_, c) => `0.25*sin(2*PI*${testRigHz(c)}*t)`).join('|')}:s=48000`

/** The program that reads a multichannel device on this platform (built by build.mjs from src/native: CoreAudio on macOS, ALSA on Linux, WASAPI on Windows). */
const HELPERS: Record<string, { file: string; source: string }> = {
  darwin: { file: 'avcapture', source: 'avcapture.swift' },
  linux: { file: 'alsacapture', source: 'alsacapture.c' },
  win32: { file: 'wasapicapture.exe', source: 'wasapicapture.c' },
}
const supported = (): boolean => process.platform in HELPERS

function captureHelperPath(): string {
  const helper = HELPERS[process.platform]
  const path = join(__dirname, '../native', helper.file).replace('app.asar', 'app.asar.unpacked') // executables cannot run from inside the asar
  if (!existsSync(path)) throw new Error(`The audio reader is missing (it is built from src/native/${helper.source}${process.platform === 'darwin' ? ' with swiftc, which needs the Xcode command line tools' : ''})`)
  return path
}

/** Linux: the sound cards with more than two capture channels, read from /proc/asound (no program needed to ask). */
function alsaInputs(): NativeInput[] {
  const streams: Record<string, string[]> = {}
  let cards = ''
  try {
    cards = readFileSync('/proc/asound/cards', 'utf8')
    for (const dir of readdirSync('/proc/asound')) {
      const m = /^card(\d+)$/.exec(dir)
      if (!m) continue
      for (const file of readdirSync(`/proc/asound/${dir}`)) {
        if (/^stream\d+$/.test(file)) (streams[m[1]] ??= []).push(readFileSync(`/proc/asound/${dir}/${file}`, 'utf8'))
      }
    }
  } catch { /* no ALSA: the browser's own inputs still work */ }
  return parseAlsaInputs(cards, streams)
}

interface Capture { id: number; proc: ChildProcess; stopped: boolean }

/**
 * Reads audio interfaces that have more channels than Chromium can open (it stops at two), one ffmpeg per device, and hands the
 * samples on as interleaved f32 frames, with a small program per platform (CoreAudio, ALSA, WASAPI).
 */
export class NativeAudio {
  private captures = new Map<string, Capture>()
  private lastId = 0
  private cache: { at: number; inputs: NativeInput[] } | null = null

  /** The inputs with more than two channels. Asking is cheap (no device is opened), and the answer is kept for a few seconds. */
  async inputs(): Promise<NativeInput[]> {
    if (this.cache && Date.now() - this.cache.at < 5000) return this.cache.inputs
    let inputs: NativeInput[] = []
    if (process.platform === 'linux') inputs = alsaInputs()
    else if (process.platform === 'win32') {
      try {
        const { stdout } = await promisify(execFile)(captureHelperPath(), ['list'], { timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true })
        inputs = parseWasapiList(stdout)
      } catch { /* no list: the browser's own inputs still work */ }
    } else if (process.platform === 'darwin') {
      try {
        const { stdout } = await promisify(execFile)('system_profiler', ['SPAudioDataType', '-json'], { timeout: 10_000, maxBuffer: 8 << 20 })
        inputs = parseNativeInputs(JSON.parse(stdout))
      } catch { /* no list: the browser's own inputs still work */ }
    }
    if (process.env.PRESTREAMER_NATIVE_TEST) inputs.push(TEST_RIG)
    this.cache = { at: Date.now(), inputs }
    return inputs
  }

  /**
   * Starts reading a device. Resolves with the channel count once ffmpeg reports the stream; `onData` then gets whole frames,
   * and `onEnd` is called if ffmpeg stops by itself (device unplugged, permission withdrawn) but not after `stop`.
   */
  async start(name: string, onData: (frames: ArrayBuffer) => void, onEnd: (message: string) => void): Promise<{ channels: number; id: number }> {
    this.stop(name)
    const test = process.env.PRESTREAMER_NATIVE_TEST && name === TEST_RIG.name
    if (!test) {
      if (!supported()) throw new Error('Reading all channels of an interface is not available on this system')
      if (process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('microphone') !== 'granted' && !(await systemPreferences.askForMediaAccess('microphone'))) {
        throw new Error('Microphone access is off for PreStreamer (System Settings → Privacy & Security → Microphone)')
      }
    }
    let command: string
    let args: string[]
    if (test) {
      command = ffmpegPath()
      args = ['-hide_banner', '-loglevel', 'info', '-nostdin', '-re', '-f', 'lavfi', '-i', testRigSource(), '-ar', '48000', '-f', 'f32le', 'pipe:1']
    } else {
      command = captureHelperPath()
      args = process.platform === 'win32' ? ['capture', name, String(NATIVE_MAX_CHANNELS)] : [name, String(NATIVE_MAX_CHANNELS)]
    }

    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const capture: Capture = { id: ++this.lastId, proc, stopped: false }
    this.captures.set(name, capture)

    return new Promise((resolve, reject) => {
      let log = ''
      let splitter: FrameSplitter | null = null
      let settled = false
      const fail = (message: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.stop(name, capture.id) // only this capture: a newer one for the same device must go on
        reject(new Error(message))
      }
      const timer = setTimeout(() => fail(`${name} did not start reading`), START_TIMEOUT_MS)
      proc.stderr!.on('data', (d: Buffer) => {
        log = (log + d.toString()).slice(-4000)
        if (splitter) return
        const info = parseFfmpegAudio(log)
        if (!info) return
        splitter = new FrameSplitter(Math.min(info.channels, NATIVE_MAX_CHANNELS))
        settled = true
        clearTimeout(timer)
        resolve({ channels: Math.min(info.channels, NATIVE_MAX_CHANNELS), id: capture.id })
      })
      proc.stdout!.on('data', (d: Buffer) => {
        const frames = splitter?.push(d)
        if (frames && !capture.stopped) onData(frames.buffer as ArrayBuffer)
      })
      proc.on('error', (err) => fail(`ffmpeg could not start: ${err.message}`))
      proc.on('close', (code) => {
        if (this.captures.get(name) === capture) this.captures.delete(name)
        const reason = log.trim().split('\n').slice(-2).join(' ')
        if (!settled) return fail(`ffmpeg stopped (${code}): ${reason}`)
        if (!capture.stopped) onEnd(`${name} stopped delivering audio${reason ? ` (${reason})` : ''}`)
      })
    })
  }

  /** Stops the capture of a device; with an id, only that very capture (a newer one for the same device is left alone). */
  stop(name: string, id?: number): void {
    const capture = this.captures.get(name)
    if (!capture || (id !== undefined && capture.id !== id)) return
    capture.stopped = true
    this.captures.delete(name)
    capture.proc.kill('SIGTERM')
  }

  stopAll(): void {
    for (const name of [...this.captures.keys()]) this.stop(name)
  }
}

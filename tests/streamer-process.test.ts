import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import { Streamer, fileTarget, youtubeTarget } from '../src/main/streamer'
import { defaultStreamSettings } from '../src/shared/stream-settings'
import type { StreamStatus } from '../src/shared/types'

// A stand-in for ffmpeg: a shell wrapper around a tiny node script that counts what arrives on stdin.
// Windows cannot spawn a .cmd without a shell, so these process-level tests run on macOS and Linux only
// (the real-ffmpeg path is covered by the end-to-end scripts on every platform).
const posix = process.platform !== 'win32'
let fakeFfmpeg = ''

const SCRIPT = `
let bytes = 0
process.stdin.on('data', (d) => { bytes += d.length })
process.stdin.on('end', () => { console.error('received ' + bytes + ' bytes'); process.exit(0) })
// Like ffmpeg's -progress output: 12,500 bytes every 100 ms is a steady 1,000 kbit/s.
let size = 0
let frame = 0
if (process.env.FAKE_MODE !== 'die') setInterval(() => {
  size += 12500; frame += 3
  process.stdout.write('frame=' + frame + '\\nfps=30.00\\ntotal_size=' + size + '\\ndup_frames=2\\ndrop_frames=1\\nspeed=' + (process.env.FAKE_SPEED || '1.00') + 'x\\nprogress=continue\\n')
}, 100)
if (process.env.FAKE_MODE === 'die') {
  console.error('fatal: cannot open ' + (process.env.FAKE_SECRET || ''))
  setTimeout(() => process.exit(1), 80)
}
`

beforeAll(() => {
  if (!posix) return
  const dir = mkdtempSync(join(tmpdir(), 'prestreamer-fake-ffmpeg-'))
  const script = join(dir, 'fake.cjs')
  writeFileSync(script, SCRIPT)
  fakeFfmpeg = join(dir, 'ffmpeg')
  writeFileSync(fakeFfmpeg, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`)
  chmodSync(fakeFfmpeg, 0o755)
})

const frame = { getSize: () => ({ width: 4, height: 2 }), toBitmap: () => Buffer.alloc(4 * 2 * 4) } as unknown as NativeImage
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
const untilState = async (get: () => StreamStatus, state: StreamStatus['state'], ms = 3000) => {
  const end = Date.now() + ms
  while (get().state !== state && Date.now() < end) await wait(20)
  return get()
}

describe.skipIf(!posix)('Streamer with a fake ffmpeg', () => {
  afterEach(() => { delete process.env.FFMPEG_PATH; delete process.env.FAKE_MODE; delete process.env.FAKE_SECRET; delete process.env.PRESTREAMER_ENCODER })
  const setup = (mode?: string) => {
    process.env.FFMPEG_PATH = fakeFfmpeg
    process.env.PRESTREAMER_ENCODER = 'libx264' // do not probe hardware encoders with the fake
    if (mode) process.env.FAKE_MODE = mode
    const updates: StreamStatus[] = []
    return { updates, streamer: new Streamer((s) => updates.push(s)) }
  }

  it('starts, paces frames at about 30 per second, and stops cleanly', async () => {
    const { streamer, updates } = setup()
    await streamer.start(() => frame, fileTarget('/tmp/out.mkv'))
    expect(streamer.getStatus().state).toBe('running')
    expect(streamer.getStatus().message).toBe('Encoder: libx264')
    await wait(700)
    const frames = streamer.getStatus().frames
    expect(frames).toBeGreaterThanOrEqual(15)
    expect(frames).toBeLessThanOrEqual(30)
    await streamer.stop()
    expect(streamer.getStatus()).toMatchObject({ state: 'idle', message: 'Stopped' })
    expect(updates.map((u) => u.state)).toContain('running')
  })

  it('reads ffmpeg progress and reports bitrate, speed and health', async () => {
    const { streamer } = setup()
    await streamer.start(() => frame, fileTarget('/tmp/out.mkv'))
    await wait(2600)
    const stats = streamer.getStatus().stats
    expect(stats).toBeDefined()
    expect(stats!.bitrateKbps).toBeGreaterThan(800)
    expect(stats!.bitrateKbps).toBeLessThan(1200)
    expect(stats).toMatchObject({ speed: 1, targetFps: 30, targetKbps: 4628, width: 1920, height: 1080, encoder: 'libx264', dupFrames: 2, ffmpegDropped: 1, health: 'good' })
    expect(stats!.history.length).toBeGreaterThanOrEqual(2)
    expect(stats!.uptimeSec).toBeGreaterThanOrEqual(2)
    await streamer.stop()
  })

  it('uses the settings it was started with for the targets', async () => {
    const { streamer } = setup()
    await streamer.start(() => frame, fileTarget('/tmp/out.mkv'), '', 0, undefined, { ...defaultStreamSettings, fps: 60, videoKbps: 9000, audioKbps: 192, width: 1280, height: 720 })
    await wait(1500)
    expect(streamer.getStatus().stats).toMatchObject({ targetFps: 60, targetKbps: 9192, width: 1280, height: 720 })
    await streamer.stop()
  })

  it('refuses to start twice', async () => {
    const { streamer } = setup()
    await streamer.start(() => frame, fileTarget('/tmp/out.mkv'))
    await expect(streamer.start(() => frame, fileTarget('/tmp/out.mkv'))).rejects.toThrow('Already streaming')
    await streamer.stop()
  })

  it('reports ffmpeg failures with its output, with the stream key redacted', async () => {
    process.env.FAKE_SECRET = 'SUPER-SECRET-KEY'
    const { streamer } = setup('die')
    await streamer.start(() => frame, youtubeTarget('SUPER-SECRET-KEY'), 'SUPER-SECRET-KEY')
    const s = await untilState(() => streamer.getStatus(), 'error')
    expect(s.state).toBe('error')
    expect(s.message).toContain('fatal: cannot open ***')
    expect(s.message).not.toContain('SUPER-SECRET-KEY')
    expect(s.target).not.toContain('SUPER-SECRET-KEY')
  })

  it('explains when ffmpeg is not installed', async () => {
    const { streamer } = setup()
    process.env.FFMPEG_PATH = '/definitely/not/here/ffmpeg'
    await streamer.start(() => frame, fileTarget('/tmp/out.mkv'))
    const s = await untilState(() => streamer.getStatus(), 'error')
    expect(s.message).toContain('ffmpeg not found')
  })

  it('fails clearly when the screen produces no frames', async () => {
    vi.useFakeTimers()
    try {
      const { streamer } = setup()
      const started = streamer.start(() => null, fileTarget('/tmp/out.mkv'))
      await vi.advanceTimersByTimeAsync(3500)
      await started
      expect(streamer.getStatus()).toMatchObject({ state: 'error', message: 'Selected screen produced no frames. Is it live?' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop is a no-op when nothing is running', async () => {
    const { streamer } = setup()
    await expect(streamer.stop()).resolves.toBeUndefined()
  })
})

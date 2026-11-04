import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFfmpegArgs, fileTarget, youtubeTarget, type FfmpegArgsOptions } from '../src/main/streamer'

const opts = (over: Partial<FfmpegArgsOptions> = {}): FfmpegArgsOptions => ({
  width: 1920, height: 1080, audioPort: 0, encoder: 'libx264', target: fileTarget('/tmp/out.mkv'), logLevel: 'warning', ...over,
})
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('buildFfmpegArgs', () => {
  it('reads raw BGRA frames of the given size from stdin at 30 fps', () => {
    const a = buildFfmpegArgs(opts({ width: 1920, height: 1080 }))
    expect(after(a, '-pixel_format')).toBe('bgra')
    expect(after(a, '-video_size')).toBe('1920x1080')
    expect(after(a, '-framerate')).toBe('30')
    expect(a).toContain('pipe:0')
  })

  it('uses generated silence when there is no audio source', () => {
    const a = buildFfmpegArgs(opts())
    expect(a.some((x) => x.startsWith('anullsrc'))).toBe(true)
    expect(a.some((x) => x.startsWith('tcp://'))).toBe(false)
  })

  it('reads the stereo mix from the loopback port when there is one', () => {
    const a = buildFfmpegArgs(opts({ audioPort: 4321 }))
    expect(a).toContain('tcp://127.0.0.1:4321')
    expect(a.some((x) => x.startsWith('anullsrc'))).toBe(false)
    expect(after(a, '-ar')).toBe('48000')
  })

  it('switches probing off on both raw inputs (otherwise ffmpeg stalls at frame 0)', () => {
    const a = buildFfmpegArgs(opts({ audioPort: 4321 }))
    expect(a.filter((x) => x === '-probesize')).toHaveLength(2)
  })

  it('scales anything that is not 1080p, and leaves 1080p alone', () => {
    expect(after(buildFfmpegArgs(opts()), '-vf')).toBe('format=yuv420p')
    expect(after(buildFfmpegArgs(opts({ width: 1280, height: 720 })), '-vf')).toBe('scale=1920:1080,format=yuv420p')
    expect(after(buildFfmpegArgs(opts({ width: 3840, height: 2160 })), '-vf')).toContain('scale=1920:1080')
  })

  it('keeps keyframes two seconds apart (YouTube requires at most four)', () => {
    const a = buildFfmpegArgs(opts())
    expect(after(a, '-g')).toBe('60')
    expect(after(a, '-keyint_min')).toBe('60')
  })

  it('encodes AAC audio and ends with the container and destination', () => {
    const a = buildFfmpegArgs(opts({ target: youtubeTarget('KEY') }))
    expect(after(a, '-c:a')).toBe('aac')
    expect(a.slice(-3)).toEqual(['-f', 'flv', 'rtmp://a.rtmp.youtube.com/live2/KEY'])
  })

  it('selects encoder arguments and falls back to x264 for an unknown encoder', () => {
    expect(after(buildFfmpegArgs(opts({ encoder: 'h264_videotoolbox' })), '-c:v')).toBe('h264_videotoolbox')
    expect(buildFfmpegArgs(opts({ encoder: 'h264_videotoolbox' }))).toContain('-realtime')
    expect(after(buildFfmpegArgs(opts({ encoder: 'nonsense' })), '-c:v')).toBe('libx264')
  })
})

describe('targets', () => {
  it('never puts the stream key in the label that is shown in the UI', () => {
    const t = youtubeTarget('SECRET-KEY-123')
    expect(t.label).not.toContain('SECRET-KEY-123')
    expect(t.url.endsWith('/SECRET-KEY-123')).toBe(true)
    expect(t.format).toBe('flv')
  })
  it('writes files as Matroska, which survives an interrupted recording', () => {
    expect(fileTarget('/x.mkv')).toMatchObject({ format: 'matroska', url: '/x.mkv', label: '/x.mkv' })
  })
})

describe('pickEncoder', () => {
  afterEach(() => { vi.resetModules(); delete process.env.PRESTREAMER_ENCODER })
  const pick = async (env?: string) => {
    vi.resetModules()
    if (env) process.env.PRESTREAMER_ENCODER = env
    return (await import('../src/main/streamer')).pickEncoder()
  }
  it('honours an explicit software override without probing hardware', async () => expect(await pick('libx264')).toBe('libx264'))
  it('ignores an unknown override', async () => expect(await pick('bogus')).toBe('libx264'))
})

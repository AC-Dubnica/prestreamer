import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildFfmpegArgs, fileTarget, youtubeTarget, type FfmpegArgsOptions } from '../src/main/streamer'
import { defaultStreamSettings } from '../src/shared/stream-settings'

const opts = (over: Partial<FfmpegArgsOptions> = {}): FfmpegArgsOptions => ({
  width: 1920, height: 1080, audioPort: 0, encoder: 'libx264', target: fileTarget('/tmp/out.mkv'), logLevel: 'warning', settings: defaultStreamSettings, ...over,
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

describe('buildFfmpegArgs with stream settings', () => {
  const custom = { ...defaultStreamSettings, width: 1280, height: 720, fps: 25, videoKbps: 3000, audioKbps: 192, keyframeSec: 3, preset: 'fast' as const }

  it('applies resolution, frame rate, bitrates, keyframe interval and preset', () => {
    const a = buildFfmpegArgs(opts({ settings: custom }))
    expect(after(a, '-vf')).toBe('scale=1280:720,format=yuv420p')
    expect(after(a, '-framerate')).toBe('25')
    expect(after(a, '-r')).toBe('25')
    expect(after(a, '-b:v')).toBe('3000k')
    expect(after(a, '-maxrate')).toBe('3000k')
    expect(after(a, '-bufsize')).toBe('6000k')
    expect(after(a, '-g')).toBe('75') // 25 fps * 3 s
    expect(after(a, '-keyint_min')).toBe('75')
    expect(after(a, '-b:a')).toBe('192k')
    expect(after(a, '-preset')).toBe('fast')
  })
  it('does not scale when the screen already has the output size', () => {
    expect(after(buildFfmpegArgs(opts({ width: 1280, height: 720, settings: custom })), '-vf')).toBe('format=yuv420p')
  })
  it('keeps x264 from adding scene-cut keyframes, so the keyframe interval stays regular', () => {
    const a = buildFfmpegArgs(opts())
    expect(after(a, '-sc_threshold')).toBe('0')
  })
  it('gives hardware encoders their own options, not the x264 preset', () => {
    const a = buildFfmpegArgs(opts({ encoder: 'h264_nvenc', settings: custom }))
    expect(after(a, '-c:v')).toBe('h264_nvenc')
    expect(a).not.toContain('fast')
    expect(after(a, '-b:v')).toBe('3000k')
  })
  it('asks ffmpeg to report progress once a second on stdout (the health panel reads it)', () => {
    const a = buildFfmpegArgs(opts())
    expect(after(a, '-progress')).toBe('pipe:1')
    expect(after(a, '-stats_period')).toBe('1')
    expect(a).toContain('-nostats')
  })
  it('puts every global option before the first input', () => {
    const a = buildFfmpegArgs(opts())
    expect(a.indexOf('-progress')).toBeLessThan(a.indexOf('-i'))
  })
})

describe('resolveEncoder', () => {
  afterEach(() => { vi.resetModules(); delete process.env.FFMPEG_PATH; delete process.env.PRESTREAMER_ENCODER })

  it('uses software x264 when asked, without probing', async () => {
    vi.resetModules()
    const { resolveEncoder } = await import('../src/main/streamer')
    expect(await resolveEncoder('libx264')).toEqual({ name: 'libx264' })
  })
  it('falls back, and says so, when the chosen hardware encoder cannot be used here', async () => {
    vi.resetModules()
    process.env.FFMPEG_PATH = '/definitely/not/here/ffmpeg' // no probe can succeed
    const { resolveEncoder } = await import('../src/main/streamer')
    const r = await resolveEncoder('h264_amf')
    expect(r.name).toBe('libx264')
    expect(r.note).toMatch(/not available on this computer; using libx264/)
  })
  it('lets the environment override the choice (tests and support)', async () => {
    vi.resetModules()
    process.env.PRESTREAMER_ENCODER = 'libx264'
    const { resolveEncoder } = await import('../src/main/streamer')
    expect((await resolveEncoder('h264_nvenc')).name).toBe('libx264')
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

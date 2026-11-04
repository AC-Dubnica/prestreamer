import { afterEach, describe, expect, it } from 'vitest'
import { ffmpegPath, ffprobePath, setBundledToolsEnabled } from '../src/main/tools'

describe('tool lookup', () => {
  afterEach(() => { delete process.env.FFMPEG_PATH; delete process.env.FFPROBE_PATH; setBundledToolsEnabled(false) })

  it('falls back to PATH in development', () => {
    expect(ffmpegPath()).toBe('ffmpeg')
    expect(ffprobePath()).toBe('ffprobe')
  })
  it('lets an environment variable override everything', () => {
    process.env.FFMPEG_PATH = '/custom/ffmpeg'
    setBundledToolsEnabled(true)
    expect(ffmpegPath()).toBe('/custom/ffmpeg')
  })
  it('uses the bundled binary when enabled and present (it is installed as a dependency)', () => {
    setBundledToolsEnabled(true)
    expect(ffmpegPath()).toContain('ffmpeg-static')
    expect(ffprobePath()).toContain('ffprobe-static')
  })
})

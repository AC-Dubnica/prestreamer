import { describe, expect, it } from 'vitest'
import { FPS_CHOICES, RESOLUTIONS, dataPerHourMB, defaultStreamSettings, recommendedKbps, sanitizeStreamSettings, settingsWarnings, youtubeRange } from '../src/shared/stream-settings'

describe('sanitizeStreamSettings', () => {
  it('returns the defaults for anything that is not settings', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}]) expect(sanitizeStreamSettings(bad)).toEqual(defaultStreamSettings)
  })
  it('keeps valid settings', () => {
    const s = { width: 1280, height: 720, fps: 60, videoKbps: 5000, audioKbps: 192, keyframeSec: 3, encoder: 'libx264', preset: 'fast' }
    expect(sanitizeStreamSettings(s)).toEqual(s)
  })
  it('only accepts known picture sizes (width and height together)', () => {
    expect(sanitizeStreamSettings({ width: 1280, height: 1080 })).toMatchObject({ width: 1920, height: 1080 })
    expect(sanitizeStreamSettings({ width: 854, height: 480 })).toMatchObject({ width: 854, height: 480 })
  })
  it('only accepts listed frame rates and audio bitrates', () => {
    expect(sanitizeStreamSettings({ fps: 29 }).fps).toBe(30)
    for (const fps of FPS_CHOICES) expect(sanitizeStreamSettings({ fps }).fps).toBe(fps)
    expect(sanitizeStreamSettings({ audioKbps: 77 }).audioKbps).toBe(128)
  })
  it('clamps the video bitrate and rounds it', () => {
    expect(sanitizeStreamSettings({ videoKbps: 1 }).videoKbps).toBe(500)
    expect(sanitizeStreamSettings({ videoKbps: 999999 }).videoKbps).toBe(20000)
    expect(sanitizeStreamSettings({ videoKbps: 4500.7 }).videoKbps).toBe(4501)
    expect(sanitizeStreamSettings({ videoKbps: NaN }).videoKbps).toBe(defaultStreamSettings.videoKbps)
    expect(sanitizeStreamSettings({ videoKbps: '5000' }).videoKbps).toBe(defaultStreamSettings.videoKbps)
  })
  it('keeps the keyframe interval within what YouTube accepts (1-4 s)', () => {
    expect(sanitizeStreamSettings({ keyframeSec: 0 }).keyframeSec).toBe(1)
    expect(sanitizeStreamSettings({ keyframeSec: 10 }).keyframeSec).toBe(4)
  })
  it('rejects an unknown encoder or preset', () => {
    expect(sanitizeStreamSettings({ encoder: 'rm -rf', preset: 'turbo' })).toMatchObject({ encoder: 'auto', preset: 'veryfast' })
  })
  it('is idempotent', () => {
    const once = sanitizeStreamSettings({ width: 854, height: 480, fps: 25, videoKbps: 1200, keyframeSec: 2 })
    expect(sanitizeStreamSettings(once)).toEqual(once)
  })
  it('has defaults that are themselves valid and inside YouTube\'s range', () => {
    expect(sanitizeStreamSettings(defaultStreamSettings)).toEqual(defaultStreamSettings)
    expect(settingsWarnings(defaultStreamSettings)).toEqual([])
  })
})

describe('recommendations', () => {
  it('gives a sensible range for every size and rate, with the suggestion inside it', () => {
    for (const r of RESOLUTIONS) for (const fps of FPS_CHOICES) {
      const range = youtubeRange(r.height, fps)
      expect(range.min).toBeLessThan(range.rec)
      expect(range.rec).toBeLessThanOrEqual(range.max)
      expect(recommendedKbps(r.height, fps)).toBe(range.rec)
    }
  })
  it('suggests more for 60 fps and for larger pictures', () => {
    expect(recommendedKbps(1080, 60)).toBeGreaterThan(recommendedKbps(1080, 30))
    expect(recommendedKbps(1080, 30)).toBeGreaterThan(recommendedKbps(720, 30))
    expect(recommendedKbps(720, 30)).toBeGreaterThan(recommendedKbps(480, 30))
  })
  it('estimates upload volume per hour', () => {
    expect(dataPerHourMB(4500, 128)).toBe(2083) // 4628 kbit/s * 3600 s / 8 = 2082.6 MB
    expect(dataPerHourMB(0, 0)).toBe(0)
  })
  it('warns, in plain words, about a bitrate outside the usual range and about heavy 60 fps software encoding', () => {
    const base = { ...defaultStreamSettings, encoder: 'libx264' as const }
    expect(settingsWarnings({ ...base, videoKbps: 800 })[0]).toMatch(/soft/)
    expect(settingsWarnings({ ...base, videoKbps: 15000 })[0]).toMatch(/Above/)
    expect(settingsWarnings({ ...base, fps: 60, videoKbps: 6000, preset: 'medium' }).some((w) => /heavy/.test(w))).toBe(true)
    expect(settingsWarnings({ ...base, fps: 60, videoKbps: 6000, preset: 'veryfast' })).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { MAX_ANNOUNCE_CHARS, SEED_QUICK_MESSAGES, TONE_COLORS, announceFontPx, appliesTo, sanitizeAnnounceRequest, sanitizeQuickMessage, type Announcement } from '../src/shared/announce'

const request = (over: Record<string, unknown> = {}) => ({ text: 'Hello', style: 'fullscreen', tone: 'info', screens: ['a'], autoHideSec: 30, ...over })

describe('sanitizeAnnounceRequest', () => {
  it('accepts a complete request unchanged', () => {
    expect(sanitizeAnnounceRequest(request())).toEqual({ text: 'Hello', style: 'fullscreen', tone: 'info', screens: ['a'], autoHideSec: 30 })
  })
  it('refuses to show nothing', () => {
    for (const bad of [null, undefined, 5, 'x', {}, request({ text: '' }), request({ text: '   \n ' }), request({ text: 7 })]) expect(sanitizeAnnounceRequest(bad)).toBeNull()
  })
  it('trims the text and limits its length', () => {
    expect(sanitizeAnnounceRequest(request({ text: '  hi  ' }))?.text).toBe('hi')
    expect(sanitizeAnnounceRequest(request({ text: 'x'.repeat(5000) }))?.text).toHaveLength(MAX_ANNOUNCE_CHARS)
  })
  it('falls back to a bottom alert banner for unknown style or colour', () => {
    expect(sanitizeAnnounceRequest(request({ style: 'spin', tone: 'rainbow' }))).toMatchObject({ style: 'banner-bottom', tone: 'alert' })
  })
  it('treats anything but a list of screens as "every screen"', () => {
    expect(sanitizeAnnounceRequest(request({ screens: null }))?.screens).toBeNull()
    expect(sanitizeAnnounceRequest(request({ screens: 'all' }))?.screens).toBeNull()
    expect(sanitizeAnnounceRequest(request({ screens: ['a', 5, 'b'] }))?.screens).toEqual(['a', 'b'])
  })
  it('keeps auto-hide between one second and an hour, otherwise "until cleared"', () => {
    expect(sanitizeAnnounceRequest(request({ autoHideSec: 0 }))?.autoHideSec).toBeNull()
    expect(sanitizeAnnounceRequest(request({ autoHideSec: -5 }))?.autoHideSec).toBeNull()
    expect(sanitizeAnnounceRequest(request({ autoHideSec: NaN }))?.autoHideSec).toBeNull()
    expect(sanitizeAnnounceRequest(request({ autoHideSec: 'soon' }))?.autoHideSec).toBeNull()
    expect(sanitizeAnnounceRequest(request({ autoHideSec: 99999 }))?.autoHideSec).toBe(3600)
    expect(sanitizeAnnounceRequest(request({ autoHideSec: 9.6 }))?.autoHideSec).toBe(10)
  })
})

describe('appliesTo', () => {
  const on = (screens: string[] | null): Announcement => ({ id: '1', text: 't', style: 'fullscreen', tone: 'alert', screens, autoHideSec: null })
  it('shows on every screen when none are named', () => expect(appliesTo(on(null), 'anything')).toBe(true))
  it('shows only on the named screens', () => {
    expect(appliesTo(on(['a', 'b']), 'a')).toBe(true)
    expect(appliesTo(on(['a', 'b']), 'c')).toBe(false)
  })
  it('shows nowhere when there is no announcement, or the list is empty', () => {
    expect(appliesTo(null, 'a')).toBe(false)
    expect(appliesTo(undefined, 'a')).toBe(false)
    expect(appliesTo(on([]), 'a')).toBe(false)
  })
})

describe('announceFontPx', () => {
  it('makes short messages bigger than long ones', () => {
    expect(announceFontPx('Fire!', 'fullscreen', 1080)).toBeGreaterThan(announceFontPx('x'.repeat(200), 'fullscreen', 1080))
    expect(announceFontPx('Short', 'banner-bottom', 1080)).toBeGreaterThan(announceFontPx('x'.repeat(300), 'banner-bottom', 1080))
  })
  it('is bigger full screen than in a banner, and scales with the screen height', () => {
    expect(announceFontPx('Hello', 'fullscreen', 1080)).toBeGreaterThan(announceFontPx('Hello', 'banner-top', 1080))
    expect(announceFontPx('Hello', 'banner-top', 2160)).toBe(announceFontPx('Hello', 'banner-top', 1080) * 2)
  })
  it('always leaves room for a maximum-length message to fit a full-screen takeover', () => {
    const px = announceFontPx('x'.repeat(MAX_ANNOUNCE_CHARS), 'fullscreen', 1080)
    expect(px).toBeGreaterThanOrEqual(40)
    // rough fit: ~0.5 em per character across ~85% of a 16:9 width, lines of 1.25 em within 85% of the height
    const perLine = (1920 * 0.85) / (px * 0.5)
    expect(Math.ceil(MAX_ANNOUNCE_CHARS / perLine) * px * 1.25).toBeLessThan(1080 * 0.85)
  })
})

describe('quick messages', () => {
  it('validates saved messages and requires an id', () => {
    expect(sanitizeQuickMessage({ id: 'q', text: ' Hi ', style: 'fullscreen', tone: 'info' })).toEqual({ id: 'q', text: 'Hi', style: 'fullscreen', tone: 'info' })
    expect(sanitizeQuickMessage({ text: 'no id' })).toBeNull()
    expect(sanitizeQuickMessage({ id: 'q', text: '' })).toBeNull()
  })
  it('ships useful starting messages that are all valid', () => {
    expect(SEED_QUICK_MESSAGES.length).toBeGreaterThan(0)
    for (const q of SEED_QUICK_MESSAGES) expect(sanitizeQuickMessage(q)).toEqual(q)
  })
  it('has a colour for every tone', () => expect(Object.keys(TONE_COLORS).sort()).toEqual(['alert', 'info', 'notice']))
})

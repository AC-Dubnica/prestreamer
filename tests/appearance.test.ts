import { describe, expect, it } from 'vitest'
import { applyDefaultBackground, defaultAppearance, forgetAppearanceMedia, isLogoSlide, logoSlide, sanitizeAppearance } from '../src/shared/appearance'
import type { Slide } from '../src/shared/types'

const img = { kind: 'image' as const, file: 'a.png' }
const vid = { kind: 'video' as const, file: 'b.mp4' }

describe('sanitizeAppearance', () => {
  it('keeps valid pictures, videos and a logo', () => {
    expect(sanitizeAppearance({ songBackground: img, scriptureBackground: vid, logo: 'logo.png' })).toEqual({ songBackground: img, scriptureBackground: vid, logo: 'logo.png' })
  })
  it('drops anything else: unknown kinds, paths that could leave the media folder, wrong types', () => {
    const out = sanitizeAppearance({ songBackground: { kind: 'css', css: 'red' }, scriptureBackground: { kind: 'image', file: '../x.png' }, logo: '/etc/passwd' })
    expect(out).toEqual(defaultAppearance)
    expect(sanitizeAppearance({ songBackground: { kind: 'image', file: 'a/b.png' }, logo: 5 })).toEqual(defaultAppearance)
    expect(sanitizeAppearance(null)).toEqual(defaultAppearance)
    expect(sanitizeAppearance('x')).toEqual(defaultAppearance)
  })
})

describe('forgetAppearanceMedia', () => {
  const a = { songBackground: img, scriptureBackground: img, logo: 'b.mp4' }
  it('lets go of every use of a deleted file', () => {
    expect(forgetAppearanceMedia(a, 'a.png')).toEqual({ songBackground: null, scriptureBackground: null, logo: 'b.mp4' })
    expect(forgetAppearanceMedia(a, 'b.mp4').logo).toBeNull()
  })
  it('returns the same object when nothing used the file', () => {
    expect(forgetAppearanceMedia(a, 'zzz.png')).toBe(a)
  })
})

describe('applyDefaultBackground', () => {
  const plain: Slide = { label: 'Verse', text: 'a' }
  it('does nothing without a default', () => {
    const list = [plain]
    expect(applyDefaultBackground(list, null)).toBe(list)
  })
  it('fills slides with no background or only a colour', () => {
    const css: Slide = { label: 'Chorus', text: 'b', background: { kind: 'css', css: 'red' } }
    expect(applyDefaultBackground([plain, css], img).map((s) => s.background)).toEqual([img, img])
  })
  it('keeps a slide\'s own picture or video, videos cues and picture slides', () => {
    const own: Slide = { label: 'x', text: 'c', background: vid }
    const cue: Slide = { label: 'Video', text: 't', video: { file: 'v.mp4', title: 't', durationSec: 5 } }
    const pic: Slide = { label: 'Slide 1', text: '', picture: { file: 'p.png' } }
    const out = applyDefaultBackground([own, cue, pic], img)
    expect(out[0].background).toEqual(vid)
    expect(out[1]).toBe(cue)
    expect(out[2]).toBe(pic)
  })
})

describe('logo slide', () => {
  it('is a picture slide, and only exists with a logo', () => {
    expect(logoSlide(defaultAppearance)).toBeNull()
    const a = { ...defaultAppearance, logo: 'logo.png' }
    expect(logoSlide(a)).toEqual({ label: 'Logo', text: '', picture: { file: 'logo.png' } })
  })
  it('is recognised while on air', () => {
    const a = { ...defaultAppearance, logo: 'logo.png' }
    expect(isLogoSlide(logoSlide(a), a)).toBe(true)
    expect(isLogoSlide({ label: 'Slide 1', text: '', picture: { file: 'logo.png' } }, a)).toBe(false)
    expect(isLogoSlide(null, a)).toBe(false)
    expect(isLogoSlide(logoSlide(a), defaultAppearance)).toBe(false)
  })
})

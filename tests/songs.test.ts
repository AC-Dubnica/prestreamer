import { describe, expect, it } from 'vitest'
import { SEED_SONGS, SONG_DETAIL_FIELDS, parseSong, readingSlides, trimSlideBackgrounds, withSlideBackground } from '../src/shared/songs'
import type { Song } from '../src/shared/types'

const song = (body: string, background: Song['background'] = null): Song => ({ id: 's', title: 't', body, background })

describe('parseSong', () => {
  it('turns a [Label] header into a section and a blank line into a new slide', () => {
    const slides = parseSong(song('[Verse 1]\nline one\nline two\n\nline three\n\n[Chorus]\nsing'))
    expect(slides.map((s) => [s.label, s.text])).toEqual([
      ['Verse 1', 'line one\nline two'],
      ['Verse 1', 'line three'],
      ['Chorus', 'sing'],
    ])
  })

  it('gives text before any header the label "Slide"', () => {
    expect(parseSong(song('just words'))).toEqual([{ label: 'Slide', text: 'just words', background: null }])
  })

  it('handles Windows line endings', () => {
    const slides = parseSong(song('[A]\r\none\r\n\r\ntwo'))
    expect(slides.map((s) => s.text)).toEqual(['one', 'two'])
  })

  it('never produces empty slides from repeated blank lines or empty sections', () => {
    expect(parseSong(song('\n\n[A]\n\n\n[B]\nx\n\n\n\n'))).toEqual([{ label: 'B', text: 'x', background: null }])
    expect(parseSong(song(''))).toEqual([])
  })

  it('trims header whitespace and ignores brackets in the middle of a line', () => {
    const slides = parseSong(song('  [ Chorus ]  \nHello [x] world'))
    expect(slides).toEqual([{ label: 'Chorus', text: 'Hello [x] world', background: null }])
  })

  it('attaches the song background to every slide', () => {
    const background = { kind: 'css', css: 'red' } as const
    const slides = parseSong(song('[A]\none\n\ntwo', background))
    expect(slides.every((s) => s.background === background)).toBe(true)
  })

  it('parses the built-in sample songs into slides', () => {
    for (const s of SEED_SONGS) expect(parseSong(s).length).toBeGreaterThan(0)
  })
})

describe('backgrounds for single slides', () => {
  const song = { id: 's', title: 'T', body: '[V1]\none\n\ntwo\n\n[C]\nthree', background: { kind: 'css' as const, css: 'red' } }
  const img = { kind: 'image' as const, file: 'a.png' }
  const vid = { kind: 'video' as const, file: 'b.mp4' }
  it('a song\'s slides share its background', () => expect(parseSong(song).map((s) => s.background)).toEqual([song.background, song.background, song.background]))
  it('a slide can have its own picture or video; the others keep the song\'s', () => {
    const slides = parseSong({ ...song, slideBackgrounds: [null, img] })
    expect(slides.map((s) => s.background)).toEqual([song.background, img, song.background])
  })
  it('readingSlides: a slide\'s own first, then the shared one, else none', () => {
    const base = [{ label: 'a', text: '1' }, { label: 'b', text: '2' }, { label: 'c', text: '3' }]
    const out = readingSlides(base, img, [null, vid])
    expect(out.map((s) => s.background)).toEqual([img, vid, img])
    expect(readingSlides(base, null, undefined).every((s) => !('background' in s))).toBe(true)
  })
  it('withSlideBackground sets one slide, pads gaps with null and drops trailing nulls', () => {
    expect(withSlideBackground(undefined, 2, img)).toEqual([null, null, img])
    expect(withSlideBackground([null, null, img], 2, null)).toEqual([])
    expect(withSlideBackground([img, vid], 0, null)).toEqual([null, vid])
  })
})

describe('trimSlideBackgrounds', () => {
  const img = { kind: 'image' as const, file: 'a.png' }
  it('drops entries beyond the last slide and trailing blanks', () => {
    expect(trimSlideBackgrounds([null, img, null, img], 3)).toEqual([null, img])
    expect(trimSlideBackgrounds([img, null, null], 3)).toEqual([img])
    expect(trimSlideBackgrounds([null, null], 2)).toEqual([])
  })
  it('copes with no list and no slides', () => {
    expect(trimSlideBackgrounds(undefined, 4)).toEqual([])
    expect(trimSlideBackgrounds([img], 0)).toEqual([])
  })
  it('leaves earlier gaps alone, so positions stay put', () => {
    expect(trimSlideBackgrounds([null, null, img], 5)).toEqual([null, null, img])
  })
})

describe('song details', () => {
  it('lists the details Quelea keeps with a song', () => {
    expect(SONG_DETAIL_FIELDS.map((f) => f.key)).toEqual(['author', 'copyright', 'ccli', 'year', 'publisher', 'key', 'capo', 'notes'])
  })
})

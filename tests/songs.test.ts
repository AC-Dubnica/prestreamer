import { describe, expect, it } from 'vitest'
import { SEED_SONGS, parseSong } from '../src/shared/songs'
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

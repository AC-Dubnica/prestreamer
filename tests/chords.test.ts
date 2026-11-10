import { describe, expect, it } from 'vitest'
import { parseSong } from '../src/shared/songs'
import { sanitizeLook } from '../src/shared/screens'
import type { Song } from '../src/shared/types'

const song = (body: string): Song => ({ id: 's', title: 'T', body, background: null })

describe('chord lines in song text', () => {
  const body = '[Verse 1]\n  G      D\nAmazing grace\nEm     C\nhow sweet the sound\n\n  Am\nSecond slide'

  it('keeps them out of the slide text', () => {
    const [a, b] = parseSong(song(body))
    expect(a.text).toBe('Amazing grace\nhow sweet the sound')
    expect(b.text).toBe('Second slide')
  })

  it('offers the same slide with its chords', () => {
    const [a, b] = parseSong(song(body))
    expect(a.chords).toBe('  G      D\nAmazing grace\nEm     C\nhow sweet the sound')
    expect(b.chords).toBe('  Am\nSecond slide')
  })

  it('has no chords version for a song without chord lines', () => {
    expect(parseSong(song('[Chorus]\nSing it loud'))[0].chords).toBeUndefined()
  })

  it('does not make a slide out of chords alone (an intro)', () => {
    expect(parseSong(song('[Intro]\nG D Em C\n\n[Verse]\nWords'))).toHaveLength(1)
  })

  it('is a per-screen look setting, off by default', () => {
    expect(sanitizeLook({}).showChords).toBe(false)
    expect(sanitizeLook({ showChords: true }).showChords).toBe(true)
  })
})

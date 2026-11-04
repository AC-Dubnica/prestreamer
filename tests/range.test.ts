import { describe, expect, it } from 'vitest'
import { mediaNameFromUrl } from '../src/main/media-path'
import { parseRange } from '../src/main/range'

describe('parseRange (HTTP Range header, needed so <video> can seek)', () => {
  it('returns null (serve everything) without a usable header', () => {
    for (const h of [null, '', 'garbage', 'bytes=-', 'items=0-5']) expect(parseRange(h, 1000)).toBeNull()
  })
  it('parses a closed range', () => expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 }))
  it('parses an open-ended range', () => expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 }))
  it('parses the suffix form (last n bytes)', () => expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 }))
  it('clamps an end past the file and a suffix larger than the file', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })
  it('flags ranges outside the file as unsatisfiable (416)', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=10-5', 1000)).toBe('unsatisfiable')
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable')
  })
})

describe('mediaNameFromUrl (path traversal guard for media://)', () => {
  it('accepts plain file names', () => {
    expect(mediaNameFromUrl('media://local/3f2a.mp4')).toBe('3f2a.mp4')
    expect(mediaNameFromUrl('media://local/with%20space.png')).toBe('with space.png')
  })
  it('rejects anything that could leave the media folder', () => {
    for (const url of [
      'media://local/..%2F..%2Fetc%2Fpasswd',
      'media://local/%2e%2e%2fsecret',
      'media://local/sub%2Ffile.mp4',
      'media://local/..%5Csecret',
      'media://local/..',
      'media://local/',
      'media://local/%E0%A4%A', // malformed percent-encoding
    ]) expect(mediaNameFromUrl(url), url).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { MEDIA_SCHEME, defaultLook, mediaUrl } from '../src/shared/types'

describe('mediaUrl', () => {
  it('builds a media:// URL for a stored file', () => expect(mediaUrl('abc.mp4')).toBe(`${MEDIA_SCHEME}://local/abc.mp4`))
  it('escapes characters that would change the path', () => {
    expect(mediaUrl('a b.mp4')).toBe('media://local/a%20b.mp4')
    expect(mediaUrl('../x')).not.toContain('/../')
  })
})

describe('defaultLook', () => {
  it('shows backgrounds, no live source, and keeps video sound off until a screen opts in', () => {
    expect(defaultLook).toMatchObject({ showMedia: true, videoAudio: false, source: { type: 'none' } })
  })
})

import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listMedia, rememberMedia } from '../src/main/media-library'
import { sanitizeBackgroundMedia, sanitizeLook } from '../src/shared/screens'

const folder = () => mkdtempSync(join(tmpdir(), 'prestreamer-media-'))
const touch = (dir: string, name: string, secondsAgo = 0) => {
  writeFileSync(join(dir, name), 'x')
  const t = new Date(Date.now() - secondsAgo * 1000)
  utimesSync(join(dir, name), t, t)
}

describe('listMedia', () => {
  it('is empty for a folder that does not exist yet', () => expect(listMedia(join(tmpdir(), 'no-such-media-folder-xyz'))).toEqual([]))

  it('lists pictures and videos, newest first, with the name they were imported under', () => {
    const dir = folder()
    touch(dir, 'a.png'); touch(dir, 'b.mp4')
    rememberMedia(dir, 'a.png', 'image', '/Users/me/Easter sunrise.png')
    rememberMedia(dir, 'b.mp4', 'video', '/Users/me/clouds.mp4')
    const list = listMedia(dir)
    expect(list.map((m) => m.file).sort()).toEqual(['a.png', 'b.mp4'])
    expect(list.find((m) => m.file === 'a.png')).toEqual({ file: 'a.png', kind: 'image', name: 'Easter sunrise' })
    expect(list.find((m) => m.file === 'b.mp4')).toEqual({ file: 'b.mp4', kind: 'video', name: 'clouds' })
  })

  it('puts a later import first', () => {
    const dir = folder()
    touch(dir, 'old.png'); touch(dir, 'new.png')
    rememberMedia(dir, 'old.png', 'image', '/x/old.png')
    const lib = join(dir, 'library.json')
    // age the first entry so the order does not depend on the clock resolution
    writeFileSync(lib, JSON.stringify({ 'old.png': { name: 'old', kind: 'image', addedAt: 1 }, 'new.png': { name: 'new', kind: 'image', addedAt: 2 } }))
    expect(listMedia(dir).map((m) => m.file)).toEqual(['new.png', 'old.png'])
  })

  it('leaves out presentation slides, test pictures, the library file and other file types', () => {
    const dir = folder()
    touch(dir, 'photo.jpg'); touch(dir, 'notes.txt'); touch(dir, 'library.json')
    touch(dir, '123e4567-e89b-12d3-a456-426614174000-001.png') // a presentation slide
    touch(dir, 'devpic-0.png')
    expect(listMedia(dir).map((m) => m.file)).toEqual(['photo.jpg'])
  })

  it('names a file imported before names were kept', () => {
    const dir = folder()
    touch(dir, 'p.webp'); touch(dir, 'v.mov')
    expect(listMedia(dir).map((m) => [m.file, m.name]).sort()).toEqual([['p.webp', 'Picture'], ['v.mov', 'Video']])
  })

  it('survives a broken library file', () => {
    const dir = folder()
    touch(dir, 'p.png')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'library.json'), '{not json')
    expect(listMedia(dir)).toEqual([{ file: 'p.png', kind: 'image', name: 'Picture' }])
  })
})

describe('sanitizeBackgroundMedia', () => {
  it('keeps a plain picture or video file name', () => {
    expect(sanitizeBackgroundMedia({ kind: 'image', file: 'a.png' })).toEqual({ kind: 'image', file: 'a.png' })
    expect(sanitizeBackgroundMedia({ kind: 'video', file: 'b.mp4' })).toEqual({ kind: 'video', file: 'b.mp4' })
  })
  it('rejects paths, other kinds and junk', () => {
    for (const bad of [null, 5, {}, { kind: 'css', css: 'red' }, { kind: 'image', file: '../x.png' }, { kind: 'image', file: 'a/b.png' }, { kind: 'image', file: 'a\\b.png' }, { kind: 'image', file: '..' }, { kind: 'image', file: '' }, { kind: 'image', file: 5 }]) {
      expect(sanitizeBackgroundMedia(bad)).toBeNull()
    }
  })
  it('is part of a screen look, and off by default', () => {
    expect(sanitizeLook({}).backgroundMedia).toBeNull()
    expect(sanitizeLook({ backgroundMedia: { kind: 'video', file: 'c.mp4' } }).backgroundMedia).toEqual({ kind: 'video', file: 'c.mp4' })
  })
})

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { BibleStore, autoImportFromQuelea, findBibleFiles, queleaBibleFolders } from '../src/main/bibles'

const bibleXml = (name: string, text = 'Invented verse.') =>
  `\uFEFF<?xml version="1.0"?><XMLBIBLE biblename="${name}"><BIBLEBOOK bnumber="43" bname="Ján" bsname="Jn"><CHAPTER cnumber="3"><VERS vnumber="16">${text}</VERS><VERS vnumber="17">Another.</VERS></CHAPTER></BIBLEBOOK></XMLBIBLE>`

describe('BibleStore', () => {
  let root: string
  let dir: string
  const make = () => new BibleStore(() => dir)
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'prestreamer-bibles-'))
    dir = join(root, 'bibles')
  })
  const write = (name: string, content: string) => {
    const path = join(root, name)
    writeFileSync(path, content)
    return path
  }

  it('starts empty, even before the folder exists', () => expect(make().list()).toEqual([]))

  it('imports a Bible from XML (tolerating a byte-order mark) and lists it without any text', () => {
    const store = make()
    const { summary, replaced } = store.importXml(bibleXml('Roháček'), 'x')
    expect(replaced).toBe(false)
    expect(summary).toMatchObject({ name: 'Roháček', books: [{ number: 43, name: 'Ján', chapters: 3 }] })
    expect(JSON.stringify(store.list())).not.toContain('Invented')
  })

  it('returns the verses of a chapter, and null for anything that does not exist', () => {
    const store = make()
    store.importXml(bibleXml('Roháček'), 'x')
    expect(store.chapter('rohacek', 43, 3)?.map((v) => v.n)).toEqual([16, 17])
    expect(store.chapter('rohacek', 43, 99)).toBeNull()
    expect(store.chapter('rohacek', 1, 3)).toBeNull()
    expect(store.chapter('nope', 43, 3)).toBeNull()
  })

  it('keeps imported versions across restarts', () => {
    make().importXml(bibleXml('Roháček'), 'x')
    const again = make()
    expect(again.list().map((b) => b.name)).toEqual(['Roháček'])
    expect(again.chapter('rohacek', 43, 3)?.[0].text).toBe('Invented verse.')
  })

  it('replaces a version imported twice instead of duplicating it', () => {
    const store = make()
    store.importXml(bibleXml('Roháček', 'old'), 'x')
    expect(store.importXml(bibleXml('Roháček', 'new'), 'x').replaced).toBe(true)
    expect(store.list()).toHaveLength(1)
    expect(store.chapter('rohacek', 43, 3)?.[0].text).toBe('new')
  })

  it('lists versions alphabetically', () => {
    const store = make()
    store.importXml(bibleXml('Zeta'), 'x')
    store.importXml(bibleXml('Alfa'), 'x')
    expect(store.list().map((b) => b.name)).toEqual(['Alfa', 'Zeta'])
  })

  it('removes a version and its file', () => {
    const store = make()
    store.importXml(bibleXml('Alfa'), 'x')
    store.remove('alfa')
    expect(store.list()).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('ignores a damaged saved file instead of failing to start', () => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    const store = make()
    store.importXml(bibleXml('Alfa'), 'x')
    expect(make().list().map((b) => b.name)).toEqual(['Alfa'])
  })

  it('imports files and reports failures per file without stopping', () => {
    const store = make()
    expect(store.importFile(write('ekum.xml', bibleXml('Ekumenický')))).toEqual({ file: 'ekum.xml', name: 'Ekumenický', status: 'imported' })
    expect(store.importFile(write('ekum2.xml', bibleXml('Ekumenický')))).toMatchObject({ status: 'replaced' })
    expect(store.importFile(write('page.xml', '<html/>'))).toMatchObject({ status: 'failed', error: expect.stringMatching(/Zefania/) })
    expect(store.importFile(write('notes.txt', 'x'))).toMatchObject({ status: 'failed', error: expect.stringMatching(/\.xml/) })
    expect(store.importFile(join(root, 'missing.xml'))).toMatchObject({ status: 'failed' })
    expect(store.list()).toHaveLength(1)
  })

  it('names a version after its file when the file states no name', () => {
    const store = make()
    expect(store.importFile(write('SK_Rohacek.xml', bibleXml('x').replace(/ biblename="x"/, '')))).toMatchObject({ name: 'SK_Rohacek', status: 'imported' })
  })

  it('never lets an id escape the data folder when removing', () => {
    const store = make()
    store.importXml(bibleXml('Alfa'), 'x')
    store.remove('../../etc/passwd') // must not throw or touch anything outside
    expect(store.list()).toHaveLength(1)
  })
})

describe('Quelea Bible discovery', () => {
  it('lists the per-user folder first on every platform, plus install folders for that platform', () => {
    expect(queleaBibleFolders('/home/me', 'linux')[0]).toBe(join('/home/me', '.quelea', 'bibles'))
    expect(queleaBibleFolders('/Users/me', 'darwin')).toContain('/Applications/Quelea.app/Contents/Resources/bibles')
    expect(queleaBibleFolders('C:\\Users\\me', 'win32').some((f) => f.includes('Program Files'))).toBe(true)
  })

  it('uses only folders that exist, and only .xml files, sorted', () => {
    const root = mkdtempSync(join(tmpdir(), 'prestreamer-quelea-'))
    const a = join(root, 'a')
    mkdirSync(a)
    for (const f of ['b.xml', 'a.XML', 'readme.txt']) writeFileSync(join(a, f), '')
    const found = findBibleFiles([join(root, 'missing'), a])
    expect(found.folders).toEqual([a])
    expect(found.files).toEqual([join(a, 'a.XML'), join(a, 'b.xml')])
  })

  it('finds nothing when Quelea is not installed', () => expect(findBibleFiles([join(tmpdir(), 'no-such-quelea-folder')])).toEqual({ folders: [], files: [] }))
})

describe('autoImportFromQuelea', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'prestreamer-auto-'))
    const home = join(root, 'home')
    mkdirSync(join(home, '.quelea', 'bibles'), { recursive: true })
    writeFileSync(join(home, '.quelea', 'bibles', 'a.xml'), bibleXml('Roháček'))
    writeFileSync(join(home, '.quelea', 'bibles', 'b.xml'), bibleXml('Ekumenický'))
    return { home, marker: join(root, 'marker.json'), store: new BibleStore(() => join(root, 'bibles')) }
  }
  it('imports what Quelea has, once', () => {
    const { home, marker, store } = setup()
    expect(autoImportFromQuelea(store, marker, home, 'linux-test' as NodeJS.Platform).map((r) => r.status)).toEqual(['imported', 'imported'])
    expect(store.list().map((b) => b.name).sort()).toEqual(['Ekumenický', 'Roháček'])
    store.remove('rohacek')
    expect(autoImportFromQuelea(store, marker, home, 'linux-test' as NodeJS.Platform)).toEqual([]) // a removed Bible does not come back
    expect(store.list().map((b) => b.name)).toEqual(['Ekumenický'])
  })
  it('does nothing without Quelea files, and does not use up its one chance', () => {
    const { marker, store } = setup()
    expect(autoImportFromQuelea(store, marker, join(tmpdir(), 'no-such-home-xyz'), 'linux-test' as NodeJS.Platform)).toEqual([])
  })
  it('leaves Bibles the user already has alone', () => {
    const { home, marker, store } = setup()
    store.importXml(bibleXml('Mine'), 'x')
    expect(autoImportFromQuelea(store, marker, home, 'linux-test' as NodeJS.Platform)).toEqual([])
    expect(store.list().map((b) => b.name)).toEqual(['Mine'])
  })
})

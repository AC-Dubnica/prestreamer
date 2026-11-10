import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { parseZefania, summarize, type Bible, type BibleImportResult, type BibleSummary, type BibleVerse } from '../shared/bible'
import { writeJsonAtomic } from './store'
import { t } from '../shared/i18n'

const MAX_FILE_BYTES = 60 * 1024 * 1024 // the largest real Bibles are about 5 MB; anything far bigger is not one

/**
 * Imported Bible versions, one JSON file each in the app's data folder. The app ships no Bible text: versions are
 * imported from Zefania XML files the user already has (for example Quelea's). Parsed versions are cached in memory.
 */
export class BibleStore {
  private cache = new Map<string, Bible>()
  private loaded = false

  /** A function, so Electron's userData path is only resolved when the app is ready (or overridden by tests). */
  constructor(private readonly dir: () => string) {}

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.dir())) return
    for (const f of readdirSync(this.dir())) {
      if (extname(f) !== '.json') continue
      try {
        const b = JSON.parse(readFileSync(join(this.dir(), f), 'utf8')) as Bible
        if (b && typeof b.id === 'string' && Array.isArray(b.books)) this.cache.set(b.id, b)
      } catch {
        // a damaged file only loses that version
      }
    }
  }

  list(): BibleSummary[] {
    this.load()
    return [...this.cache.values()].map(summarize).sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Verses of one chapter, or null if the version, book or chapter does not exist. */
  chapter(id: string, bookNumber: number, chapter: number): BibleVerse[] | null {
    this.load()
    const verses = this.cache.get(id)?.books.find((b) => b.number === bookNumber)?.chapters.find((c) => c.n === chapter)?.verses
    return verses ?? null
  }

  importXml(xml: string, fallbackName: string): { summary: BibleSummary; replaced: boolean } {
    this.load()
    const bible = parseZefania(xml.replace(/^\uFEFF/, ''), fallbackName)
    const replaced = this.cache.has(bible.id)
    this.cache.set(bible.id, bible)
    writeJsonAtomic(join(this.dir(), `${bible.id}.json`), bible)
    return { summary: summarize(bible), replaced }
  }

  /** Imports one file. Never throws: a bad file is reported in the result so the others can still be imported. */
  importFile(path: string): BibleImportResult {
    const file = basename(path)
    try {
      if (extname(path).toLowerCase() !== '.xml') throw new Error(t('main.bibles.onlyXml'))
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error(t('main.bibles.tooLarge'))
      const { summary, replaced } = this.importXml(readFileSync(path, 'utf8'), basename(path, extname(path)))
      return { file, name: summary.name, status: replaced ? 'replaced' : 'imported' }
    } catch (err) {
      return { file, name: file, status: 'failed', error: (err as Error).message }
    }
  }

  remove(id: string): void {
    this.load()
    this.cache.delete(id)
    if (/^[a-z0-9-]+$/.test(id)) rmSync(join(this.dir(), `${id}.json`), { force: true })
  }
}

/** Where Quelea keeps Bible files. Only the first (per-user) folder is certain; the install-folder guesses are unverified. */
export function queleaBibleFolders(home: string, platform: NodeJS.Platform): string[] {
  const folders = [join(home, '.quelea', 'bibles')]
  if (platform === 'darwin') folders.push('/Applications/Quelea.app/Contents/Resources/bibles')
  if (platform === 'win32') folders.push('C:\\Program Files\\Quelea\\bibles', 'C:\\Program Files (x86)\\Quelea\\bibles')
  if (platform === 'linux') folders.push('/opt/quelea/bibles', '/usr/share/quelea/bibles')
  return folders
}

/**
 * First launch only: copies in the Bibles Quelea already has on this computer, so the versions the church uses are there
 * without a click. Done once (a marker file records it), so a Bible the user later removes is not brought back.
 * Nothing is downloaded and no Bible text ships with PreStreamer.
 */
export function autoImportFromQuelea(store: BibleStore, markerPath: string, home: string, platform: NodeJS.Platform): BibleImportResult[] {
  if (existsSync(markerPath) || store.list().length) return []
  const { files } = findBibleFiles(queleaBibleFolders(home, platform))
  const results = files.map((f) => store.importFile(f))
  if (files.length) writeJsonAtomic(markerPath, { importedAt: new Date().toISOString(), count: results.filter((r) => r.status !== 'failed').length })
  return results
}

/** The .xml files in whichever of the folders exist, in a stable order. */
export function findBibleFiles(folders: string[]): { folders: string[]; files: string[] } {
  const found = folders.filter((f) => existsSync(f) && statSync(f).isDirectory())
  const files = found.flatMap((f) => readdirSync(f).filter((n) => extname(n).toLowerCase() === '.xml').sort().map((n) => join(f, n)))
  return { folders: found, files }
}

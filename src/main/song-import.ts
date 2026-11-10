import { dialog, type BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { queleaSongXml, songFromQueleaXml } from '../shared/quelea'
import { IMPORT_BACKGROUND, planSongImport, songFromPdfLines, type ImportedSong } from '../shared/song-import'
import type { Song, SongExportResult, SongImportResult } from '../shared/types'
import { readPdfTexts } from './pdf'
import { readZip, writeZip } from './zip'
import { t } from '../shared/i18n'

const isPdf = (data: Buffer): boolean => data.subarray(0, 5).toString('latin1') === '%PDF-'

/**
 * Songs from a ZIP: a Quelea song pack (.qsp, XML per song) or a ZIP of chord-sheet PDFs, minus the ones the library already has.
 * Quelea names repeated titles ".pdf" although they hold XML, so a file is told apart by what is inside.
 */
export async function songsFromZip(path: string, existing: Song[]): Promise<{ songs: Song[]; result: SongImportResult }> {
  const entries = readZip(readFileSync(path)).filter((e) => !basename(e.name).startsWith('.') && !e.name.startsWith('__MACOSX/'))
  const files = entries.map((e) => ({ name: basename(e.name, extname(e.name)), data: e.read() }))
  const pdfs = files.filter((f) => isPdf(f.data))
  if (!files.length) throw new Error(t('main.songs.zipEmpty'))
  const texts = pdfs.length ? await readPdfTexts(pdfs.map((f) => f.data)) : []
  const imported: ImportedSong[] = []
  const unreadable: string[] = []
  let pdfIndex = 0
  for (const f of files) {
    const song = isPdf(f.data) ? songFromPdfLines(texts[pdfIndex++] ?? [], f.name) : songFromQueleaXml(f.data.toString('utf8').replace(/^\uFEFF/, ''))
    if (song?.body) imported.push(song)
    else unreadable.push(f.name)
  }
  const { fresh, skipped } = planSongImport(imported, existing.map((s) => s.title))
  const songs: Song[] = fresh.map(({ title, body, ...details }) => ({ id: randomUUID(), title, body, background: IMPORT_BACKGROUND, ...details }))
  return { songs, result: { added: songs.length, skipped: skipped.length, unreadable } }
}

/** The whole library as a Quelea song pack: a ZIP with one XML file per song (repeated titles get "(2)", "(3)"...). */
export function songPack(songs: Song[]): Buffer {
  const used = new Set<string>()
  return writeZip(songs.map((song) => {
    const base = (song.number ? `${song.number} ${song.title}` : song.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'song'
    let name = `${base}.xml`
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).xml`
    used.add(name.toLowerCase())
    return { name, data: Buffer.from(queleaSongXml(song), 'utf8') }
  }))
}

/** Asks where to save the song pack (PRESTREAMER_SONGS_EXPORT_FILE stands in for the dialog in tests) and writes it; null when cancelled. */
export async function exportSongs(parent: BrowserWindow | null, songs: Song[], folder: string): Promise<SongExportResult | null> {
  let path = process.env.PRESTREAMER_SONGS_EXPORT_FILE
  if (!path) {
    const options: Electron.SaveDialogOptions = { title: t('main.songs.exportTitle'), defaultPath: join(folder, 'PreStreamer songs.qsp'), filters: [{ name: t('main.songs.filterPack'), extensions: ['qsp'] }] }
    const r = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (r.canceled || !r.filePath) return null
    path = r.filePath
  }
  writeFileSync(path, songPack(songs))
  return { count: songs.length, path }
}

/** Asks for the ZIP (PRESTREAMER_SONGS_FILE stands in for the dialog in tests); null when cancelled. */
export async function pickSongsZip(parent: BrowserWindow | null, downloads: string): Promise<string | null> {
  const forced = process.env.PRESTREAMER_SONGS_FILE
  if (forced) return forced
  const options: Electron.OpenDialogOptions = { title: t('main.songs.importTitle'), defaultPath: downloads, properties: ['openFile'], filters: [{ name: t('main.songs.filterPackOrZip'), extensions: ['qsp', 'zip'] }] }
  const r = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
}

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import type { MediaEntry, MediaKind } from '../shared/types'
import { writeJsonAtomic } from './store'

export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif']
export const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm']

interface LibraryFile { [file: string]: { name: string; kind: MediaKind; addedAt: number } }

/** Pictures of presentation slides and other generated files live in the media folder too, but are not backgrounds. */
const GENERATED = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-\d{3}\.(?:png|jpe?g|webp|gif)|devpic-.*|pic-.*)$/i

const libraryFile = (dir: string) => join(dir, 'library.json')

function readLibrary(dir: string): LibraryFile {
  try {
    const raw = JSON.parse(readFileSync(libraryFile(dir), 'utf8')) as unknown
    return raw && typeof raw === 'object' ? (raw as LibraryFile) : {}
  } catch {
    return {}
  }
}

/** Remembers the name a background had when it was imported (the file itself is stored under a generated name). */
export function rememberMedia(dir: string, file: string, kind: MediaKind, originalPath: string): void {
  const lib = readLibrary(dir)
  lib[file] = { name: basename(originalPath, extname(originalPath)).slice(0, 80), kind, addedAt: Date.now() }
  writeJsonAtomic(libraryFile(dir), lib)
}

/** Every picture and video in the media folder that can be a background, newest first. */
export function listMedia(dir: string): MediaEntry[] {
  if (!existsSync(dir)) return []
  const lib = readLibrary(dir)
  const out: (MediaEntry & { at: number })[] = []
  for (const file of readdirSync(dir)) {
    const ext = extname(file).slice(1).toLowerCase()
    const kind: MediaKind | null = IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : null
    if (!kind || GENERATED.test(file)) continue
    const known = lib[file]
    out.push({ file, kind, name: known?.name ?? (kind === 'image' ? 'Picture' : 'Video'), at: known?.addedAt ?? statSync(join(dir, file)).mtimeMs })
  }
  return out.sort((a, b) => b.at - a.at).map(({ at: _at, ...e }) => e)
}

/** Deletes a library picture or video and forgets its name. Only plain file names in the folder are accepted. Returns whether anything was removed. */
export function removeMedia(dir: string, file: string): boolean {
  if (!file || file !== basename(file) || file === 'library.json' || file.includes('\\')) return false
  const path = join(dir, file)
  if (!existsSync(path) || !listMedia(dir).some((m) => m.file === file)) return false // not a library file (a slide picture, say)
  rmSync(path, { force: true })
  const lib = readLibrary(dir)
  if (file in lib) { delete lib[file]; writeJsonAtomic(libraryFile(dir), lib) }
  return true
}

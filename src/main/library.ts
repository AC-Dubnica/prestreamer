import { app, dialog, type BrowserWindow } from 'electron'
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { IMAGE_EXT, VIDEO_EXT, listMedia, rememberMedia, removeMedia } from './media-library'
import { Readable } from 'node:stream'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Background, MediaKind } from '../shared/types'
import { mediaNameFromUrl } from './media-path'
import { parseRange } from './range'

export const mediaDir = () => join(app.getPath('userData'), 'media')

/** Copies a user-chosen file into the media folder under a generated name and returns its Background. */
export function importMediaFile(path: string, kind: MediaKind): Background {
  mkdirSync(mediaDir(), { recursive: true })
  const file = `${randomUUID()}${extname(path).toLowerCase()}`
  copyFileSync(path, join(mediaDir(), file))
  rememberMedia(mediaDir(), file, kind, path)
  return { kind, file }
}

export async function pickMedia(parent: BrowserWindow | null, kind: MediaKind): Promise<Background | null> {
  const options: Electron.OpenDialogOptions = {
    title: kind === 'image' ? 'Choose a background image' : 'Choose a background video',
    properties: ['openFile'],
    filters: [{ name: kind === 'image' ? 'Images' : 'Videos', extensions: kind === 'image' ? IMAGE_EXT : VIDEO_EXT }],
  }
  // PRESTREAMER_MEDIA_FILE stands in for the file dialog in the end-to-end tests.
  if (process.env.PRESTREAMER_MEDIA_FILE) return importMediaFile(process.env.PRESTREAMER_MEDIA_FILE, kind)
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths[0] ? null : importMediaFile(result.filePaths[0], kind)
}

/**
 * One or more pictures for the run sheet, each shown whole as a slide (like a presentation). They are stored under generated
 * names that keep them out of the backgrounds library: they are slides, not backgrounds.
 */
export async function pickPictures(parent: BrowserWindow | null): Promise<{ title: string; slides: string[] } | null> {
  let paths: string[]
  if (process.env.PRESTREAMER_PICTURE_FILES) {
    paths = process.env.PRESTREAMER_PICTURE_FILES.split(',') // stands in for the file dialog in the end-to-end tests
  } else {
    const options: Electron.OpenDialogOptions = { title: 'Choose pictures to show', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Pictures', extensions: IMAGE_EXT }] }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    paths = [...result.filePaths].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) // 2.png before 10.png
  }
  mkdirSync(mediaDir(), { recursive: true })
  const stamp = randomUUID()
  const slides = paths.map((p, i) => {
    const file = `${stamp}-${String(i + 1).padStart(3, '0')}${extname(p).toLowerCase()}`
    copyFileSync(p, join(mediaDir(), file))
    return file
  })
  return { title: paths.length === 1 ? basename(paths[0], extname(paths[0])) : `${basename(paths[0], extname(paths[0]))} + ${paths.length - 1} more`, slides }
}

/** Every picture and video imported so far, for the background picker. */
export const listLibrary = () => listMedia(mediaDir())
export const deleteFromLibrary = (file: string) => removeMedia(mediaDir(), file)

/** Resolves a media:// request to a file in the media folder; rejects anything outside it. */
export function resolveMediaPath(requestUrl: string): string | null {
  const name = mediaNameFromUrl(requestUrl)
  if (!name) return null
  const full = join(mediaDir(), name)
  return existsSync(full) ? full : null
}

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/mp4',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
}

/**
 * Serves a media:// request with HTTP range support. <video> needs 206 responses to seek or scrub;
 * without them the player silently falls back to the start of the file.
 */
export function serveMedia(req: Request): Response {
  const path = resolveMediaPath(req.url)
  if (!path) return new Response('Not found', { status: 404 })
  const size = statSync(path).size
  const base = { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Access-Control-Allow-Origin': '*' }
  const toBody = (start: number, end: number) => Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream

  const range = parseRange(req.headers.get('range'), size)
  if (range === null) return new Response(size ? toBody(0, size - 1) : null, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  return new Response(toBody(range.start, range.end), { status: 206, headers: { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) } })
}

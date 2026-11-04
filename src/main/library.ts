import { app, dialog, type BrowserWindow } from 'electron'
import { copyFileSync, createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Background, MediaKind } from '../shared/types'
import { mediaNameFromUrl } from './media-path'
import { parseRange } from './range'

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif']
const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'webm']

export const mediaDir = () => join(app.getPath('userData'), 'media')

/** Copies a user-chosen file into the media folder under a generated name and returns its Background. */
export function importMediaFile(path: string, kind: MediaKind): Background {
  mkdirSync(mediaDir(), { recursive: true })
  const file = `${randomUUID()}${extname(path).toLowerCase()}`
  copyFileSync(path, join(mediaDir(), file))
  return { kind, file }
}

export async function pickMedia(parent: BrowserWindow | null, kind: MediaKind): Promise<Background | null> {
  const options: Electron.OpenDialogOptions = {
    title: kind === 'image' ? 'Choose a background image' : 'Choose a background video',
    properties: ['openFile'],
    filters: [{ name: kind === 'image' ? 'Images' : 'Videos', extensions: kind === 'image' ? IMAGE_EXT : VIDEO_EXT }],
  }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  return result.canceled || !result.filePaths[0] ? null : importMediaFile(result.filePaths[0], kind)
}

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
  const base = { 'Content-Type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes' }
  const toBody = (start: number, end: number) => Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream

  const range = parseRange(req.headers.get('range'), size)
  if (range === null) return new Response(size ? toBody(0, size - 1) : null, { status: 200, headers: { ...base, 'Content-Length': String(size) } })
  if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}` } })
  return new Response(toBody(range.start, range.end), { status: 206, headers: { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(range.end - range.start + 1) } })
}

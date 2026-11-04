import { basename } from 'node:path'

/**
 * The file name a media:// request asks for, or null if it could reach outside the media folder.
 * Only plain file names are accepted: no separators, no "..", nothing empty.
 */
export function mediaNameFromUrl(requestUrl: string): string | null {
  let name: string
  try {
    name = decodeURIComponent(new URL(requestUrl).pathname.slice(1))
  } catch {
    return null // malformed URL or percent-encoding
  }
  return name && name === basename(name) && name !== '.' && name !== '..' && !name.includes('\\') ? name : null
}

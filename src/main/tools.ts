import { existsSync } from 'node:fs'

/**
 * External media tools, resolved in this order:
 *   1. FFMPEG_PATH / FFPROBE_PATH (explicit override, also used by the tests)
 *   2. the binaries shipped inside the installer (packaged app only, so development uses your own ffmpeg)
 *   3. whatever `ffmpeg` / `ffprobe` is on PATH
 */
let useBundled = false

/** Called once at startup with `app.isPackaged`. */
export function setBundledToolsEnabled(enabled: boolean): void {
  useBundled = enabled
}

function bundled(pkg: 'ffmpeg-static' | 'ffprobe-static'): string | null {
  if (!useBundled) return null
  try {
    const mod = require(pkg) as string | { path: string }
    const path = typeof mod === 'string' ? mod : mod.path
    // Executables cannot run from inside app.asar; electron-builder unpacks them next to it.
    const unpacked = path.replace('app.asar', 'app.asar.unpacked')
    return existsSync(unpacked) ? unpacked : null
  } catch {
    return null
  }
}

export const ffmpegPath = (): string => process.env.FFMPEG_PATH || bundled('ffmpeg-static') || 'ffmpeg'
export const ffprobePath = (): string => process.env.FFPROBE_PATH || bundled('ffprobe-static') || 'ffprobe'

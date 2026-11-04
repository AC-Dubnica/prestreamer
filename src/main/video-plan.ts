export interface Probe {
  container: string
  videoCodec: string
  pixFmt: string
  audioCodec: string | null
  durationSec: number
}

// What Chromium can decode without help. HEVC, ProRes, 10-bit and 4:2:2 H.264 are NOT in this set.
const SAFE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])
const SAFE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis'])
const SAFE_PIXFMT = new Set(['yuv420p', 'yuvj420p'])

export type ImportPlan = 'copy' | 'remux' | 'transcode'

/** Copy when already playable as mp4/webm, remux (fast, lossless) when only the container is wrong, else transcode. */
export function planImport(p: Probe, ext: string): ImportPlan {
  const codecsOk = SAFE_VIDEO.has(p.videoCodec) && SAFE_PIXFMT.has(p.pixFmt) && (p.audioCodec === null || SAFE_AUDIO.has(p.audioCodec))
  if (!codecsOk) return 'transcode'
  // ffprobe names .mp4 and .mov the same ("mov,mp4,..."), and .mkv and .webm alike, so the extension decides.
  const playableAsIs = (['.mp4', '.m4v'].includes(ext) && p.container.includes('mp4')) || (ext === '.webm' && p.container.includes('webm'))
  return playableAsIs ? 'copy' : 'remux'
}

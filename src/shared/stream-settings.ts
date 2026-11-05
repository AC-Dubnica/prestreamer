/** How the outgoing stream is encoded. Everything here is validated before it reaches ffmpeg. */

export type EncoderChoice = 'auto' | 'libx264' | 'h264_videotoolbox' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf'
export type X264Preset = 'ultrafast' | 'superfast' | 'veryfast' | 'faster' | 'fast' | 'medium'

export interface StreamSettings {
  width: number
  height: number
  fps: number
  /** Video bitrate in kbit/s. */
  videoKbps: number
  /** Audio bitrate in kbit/s (AAC, 48 kHz stereo). */
  audioKbps: number
  /** Seconds between keyframes. YouTube requires at most 4. */
  keyframeSec: number
  encoder: EncoderChoice
  /** Software (x264) speed/quality trade-off; other encoders ignore it. */
  preset: X264Preset
}

export const RESOLUTIONS = [
  { label: '1080p (1920×1080)', width: 1920, height: 1080 },
  { label: '720p (1280×720)', width: 1280, height: 720 },
  { label: '480p (854×480)', width: 854, height: 480 },
] as const

export const FPS_CHOICES = [24, 25, 30, 50, 60] as const
export const AUDIO_KBPS_CHOICES = [96, 128, 160, 192, 256] as const
export const PRESETS: X264Preset[] = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium']
export const ENCODER_CHOICES: { value: EncoderChoice; label: string }[] = [
  { value: 'auto', label: 'Automatic (hardware if it works)' },
  { value: 'libx264', label: 'Software (x264)' },
  { value: 'h264_videotoolbox', label: 'Apple VideoToolbox (Mac)' },
  { value: 'h264_nvenc', label: 'NVIDIA NVENC' },
  { value: 'h264_qsv', label: 'Intel Quick Sync' },
  { value: 'h264_amf', label: 'AMD AMF' },
]
export const KBPS_LIMITS = [500, 20000] as const
export const MAX_KEYFRAME_SEC = 4

export const defaultStreamSettings: StreamSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  videoKbps: 4500,
  audioKbps: 128,
  keyframeSec: 2,
  encoder: 'auto',
  preset: 'veryfast',
}

const pick = <T>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback)

/** Validates settings from disk or the interface. Anything unusable falls back to the default for that field. */
export function sanitizeStreamSettings(raw: unknown): StreamSettings {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const d = defaultStreamSettings
  const res = RESOLUTIONS.find((x) => x.width === r.width && x.height === r.height) ?? RESOLUTIONS[0]
  const kbps = typeof r.videoKbps === 'number' && Number.isFinite(r.videoKbps) ? Math.round(r.videoKbps) : d.videoKbps
  const key = typeof r.keyframeSec === 'number' && Number.isFinite(r.keyframeSec) ? Math.round(r.keyframeSec) : d.keyframeSec
  return {
    width: res.width,
    height: res.height,
    fps: pick(r.fps, FPS_CHOICES, d.fps),
    videoKbps: Math.min(KBPS_LIMITS[1], Math.max(KBPS_LIMITS[0], kbps)),
    audioKbps: pick(r.audioKbps, AUDIO_KBPS_CHOICES, d.audioKbps),
    keyframeSec: Math.min(MAX_KEYFRAME_SEC, Math.max(1, key)),
    encoder: pick(r.encoder, ENCODER_CHOICES.map((e) => e.value), d.encoder),
    preset: pick(r.preset, PRESETS, d.preset),
  }
}

export interface BitrateRange { min: number; max: number; rec: number }

/** YouTube's published live-encoding ranges (kbit/s) by picture size and frame rate, as the author last read them; check YouTube's current guidance. */
export function youtubeRange(height: number, fps: number): BitrateRange {
  const high = fps > 30
  if (height >= 1080) return high ? { min: 4500, max: 9000, rec: 6000 } : { min: 3000, max: 6000, rec: 4500 }
  if (height >= 720) return high ? { min: 2250, max: 6000, rec: 4000 } : { min: 1500, max: 4000, rec: 2500 }
  return { min: 500, max: 2000, rec: 1000 }
}

export const recommendedKbps = (height: number, fps: number): number => youtubeRange(height, fps).rec

/** Megabytes uploaded per hour at these bitrates (decimal MB). */
export const dataPerHourMB = (videoKbps: number, audioKbps: number): number => Math.round(((videoKbps + audioKbps) * 1000 * 3600) / 8 / 1_000_000)

/** Plain-language cautions about a combination of settings (never blocks saving). */
export function settingsWarnings(s: StreamSettings): string[] {
  const out: string[] = []
  const range = youtubeRange(s.height, s.fps)
  if (s.videoKbps < range.min) out.push(`Below YouTube's usual range for ${s.height}p${s.fps} (${range.min}-${range.max} kb/s): the picture may look soft.`)
  if (s.videoKbps > range.max) out.push(`Above YouTube's usual range for ${s.height}p${s.fps} (${range.min}-${range.max} kb/s): it may not be accepted, and needs more upload speed.`)
  if (s.fps > 30 && s.encoder === 'libx264' && s.preset !== 'ultrafast' && s.preset !== 'superfast' && s.preset !== 'veryfast') out.push('60 fps with a slow x264 preset is heavy: choose a faster preset or hardware encoding.')
  return out
}

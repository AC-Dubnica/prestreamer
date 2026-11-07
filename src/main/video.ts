import { dialog, type BrowserWindow } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import type { ImportedVideo } from '../shared/types'
import { mediaDir } from './library'
import { ffmpegPath, ffprobePath } from './tools'
import { planImport, type ImportPlan, type Probe } from './video-plan'

const run = promisify(execFile)

async function probe(path: string): Promise<Probe> {
  const { stdout } = await run(ffprobePath(), ['-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,pix_fmt', '-of', 'json', path])
  const info = JSON.parse(stdout) as { format: { format_name: string; duration?: string }; streams: { codec_type: string; codec_name: string; pix_fmt?: string }[] }
  const v = info.streams.find((s) => s.codec_type === 'video')
  if (!v) throw new Error('No video stream found in this file')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  return {
    container: info.format.format_name,
    videoCodec: v.codec_name,
    pixFmt: v.pix_fmt ?? '',
    audioCodec: a?.codec_name ?? null,
    durationSec: Number(info.format.duration) || 0,
  }
}

/** Runs ffmpeg, reporting 0-100 from its -progress output. */
function ffmpeg(args: string[], durationSec: number, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-y', '-nostats', '-progress', 'pipe:1', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    proc.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-600) })
    proc.stdout.on('data', (d: Buffer) => {
      const m = /out_time_us=(\d+)/.exec(d.toString())
      if (m && durationSec > 0) onProgress(Math.min(99, Math.round((Number(m[1]) / 1e6 / durationSec) * 100)))
    })
    proc.on('error', (e) => reject(new Error(e.message.includes('ENOENT') ? 'ffmpeg not found (set FFMPEG_PATH)' : e.message)))
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited with code ${code}`))))
  })
}

export async function importVideoFile(path: string, onProgress: (pct: number) => void = () => {}): Promise<ImportedVideo & { plan: ImportPlan }> {
  const info = await probe(path)
  const sourceExt = extname(path).toLowerCase()
  const plan = planImport(info, sourceExt)
  mkdirSync(mediaDir(), { recursive: true })
  const ext = plan === 'copy' && sourceExt === '.webm' ? '.webm' : '.mp4'
  const file = `${randomUUID()}${ext}`
  const out = join(mediaDir(), file)
  const maps = ['-map', '0:v:0', '-map', '0:a:0?']

  try {
    if (plan === 'copy') {
      copyFileSync(path, out)
    } else if (plan === 'remux') {
      try {
        await ffmpeg(['-i', path, ...maps, '-c', 'copy', '-movflags', '+faststart', out], info.durationSec, onProgress)
      } catch {
        // e.g. an audio codec the mp4 container refuses: fall back to a full conversion
        await transcode(path, out, maps, info.durationSec, onProgress)
        return { file, title: basename(path, extname(path)), durationSec: info.durationSec, plan: 'transcode' }
      }
    } else {
      await transcode(path, out, maps, info.durationSec, onProgress)
    }
  } catch (err) {
    rmSync(out, { force: true })
    throw err
  }
  onProgress(100)
  return { file, title: basename(path, extname(path)), durationSec: info.durationSec, plan }
}

function transcode(path: string, out: string, maps: string[], durationSec: number, onProgress: (pct: number) => void): Promise<void> {
  return ffmpeg(
    ['-i', path, ...maps, '-vf', "scale='min(1920,iw)':-2,format=yuv420p", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out],
    durationSec,
    onProgress,
  )
}

const VIDEO_EXT = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'mpg', 'mpeg', 'mts', 'm2ts', 'flv', 'ts']

export async function pickVideo(parent: BrowserWindow | null, onProgress: (pct: number) => void): Promise<ImportedVideo | null> {
  if (process.env.PRESTREAMER_VIDEO_FILE) return importVideoFile(process.env.PRESTREAMER_VIDEO_FILE, onProgress) // dev hook: stands in for the file dialog
  const options: Electron.OpenDialogOptions = {
    title: 'Choose a video for the service',
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }],
  }
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  const { file, title, durationSec } = await importVideoFile(result.filePaths[0], onProgress)
  return { file, title, durationSec }
}

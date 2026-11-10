import { dialog, type BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { PRESENTATION_EXTENSIONS, converterPlan, keynoteScript, libreOfficeArgs, powerPointMacScript, powerPointWindowsScript, powerShellArgs, unsupportedMessage, type Converter, type Platform } from '../shared/presentation'
import { mediaDir } from './library'
import { renderPdfPages } from './pdf'
import { renderPptxSlides } from './pptx'
import { t } from '../shared/i18n'

export interface ImportedPresentation { title: string; slides: string[] }

const CONVERT_TIMEOUT_MS = 4 * 60_000

/** Runs a program; rejects with its error output on failure, or when it takes too long. */
function run(cmd: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true, maxBuffer: 1 << 20 }, (err, _out, stderr) => {
      if (!err) return resolve()
      const e = err as NodeJS.ErrnoException & { killed?: boolean }
      reject(new Error(e.code === 'ENOENT' ? t('main.presentations.cmdMissing', { cmd }) : e.killed ? t('main.presentations.tookTooLong') : (stderr || e.message).trim().split('\n').slice(-3).join(' ')))
    })
    if (input !== undefined) child.stdin?.end(input)
  })
}

const MAC_APPS = { keynote: '/Applications/Keynote.app', 'powerpoint-mac': '/Applications/Microsoft PowerPoint.app' } as const

function libreOfficePaths(platform: Platform): string[] {
  if (platform === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice', 'soffice']
  if (platform === 'win32') return ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
  return ['soffice', 'libreoffice']
}

const NAMES: Record<Converter, string> = { builtin: 'PreStreamer', keynote: 'Keynote', 'powerpoint-mac': 'PowerPoint', 'powerpoint-windows': 'PowerPoint', libreoffice: 'LibreOffice' }

/** Turns a deck into a PDF with one external program. Throws if it could not (including when it silently produced nothing). */
async function convert(which: Converter, input: string, outDir: string, platform: Platform): Promise<string> {
  const out = join(outDir, `${basename(input, extname(input))}.pdf`)
  if (which === 'keynote' || which === 'powerpoint-mac') {
    if (!existsSync(MAC_APPS[which])) throw new Error(t('main.presentations.appMissing', { name: NAMES[which] }))
    await run('osascript', ['-'], which === 'keynote' ? keynoteScript(input, out) : powerPointMacScript(input, out))
  } else if (which === 'powerpoint-windows') {
    await run('powershell.exe', powerShellArgs(powerPointWindowsScript(input, out)))
  } else {
    let last: Error | null = null
    for (const exe of libreOfficePaths(platform)) {
      if (exe.includes('/') || exe.includes('\\') ? !existsSync(exe) : false) continue
      try { await run(exe, libreOfficeArgs(input, outDir)); last = null; break } catch (e) { last = e as Error }
    }
    if (last) throw last
  }
  if (!existsSync(out) || statSync(out).size === 0) throw new Error(t('main.presentations.noPdf', { name: NAMES[which] }))
  return out
}

/**
 * Imports a PowerPoint, Keynote, OpenDocument or PDF file: converts it to a PDF with whatever program is available (trying
 * the next one if one fails), then draws every page as a picture in the media folder.
 */
export async function importPresentationFile(path: string, onStatus: (message: string) => void = () => {}, platform: Platform = process.platform as Platform): Promise<ImportedPresentation> {
  const ext = extname(path).slice(1).toLowerCase()
  if (!PRESENTATION_EXTENSIONS.includes(ext)) throw new Error(unsupportedMessage(path, platform))
  const title = basename(path, extname(path))
  const stamp = randomUUID()
  const nameFor = (i: number) => `${stamp}-${String(i + 1).padStart(3, '0')}.png`
  const drawing = (done: number, total: number) => onStatus(t('main.presentations.drawing', { done, total }))
  const tmp = mkdtempSync(join(tmpdir(), 'prestreamer-deck-'))
  try {
    let pdf: string | null = ext === 'pdf' ? path : null
    if (!pdf) {
      const plan = converterPlan(path, platform)
      if (!plan.length) throw new Error(unsupportedMessage(path, platform))
      const failures: string[] = []
      for (const which of plan) {
        try {
          if (which === 'builtin') {
            // Read by PreStreamer itself: nothing else is started.
            onStatus(t('main.presentations.reading'))
            const { files } = await renderPptxSlides(readFileSync(path), mediaDir(), nameFor, drawing)
            if (!files.length) throw new Error(t('main.presentations.noSlidesIt'))
            return { title, slides: files }
          }
          onStatus(which === 'keynote' || which === 'powerpoint-mac' ? t('main.presentations.openingMac', { name: NAMES[which] }) : t('main.presentations.opening', { name: NAMES[which] }))
          pdf = await convert(which, path, tmp, platform)
          break
        } catch (e) {
          failures.push(`${NAMES[which]}: ${(e as Error).message}`)
        }
      }
      if (!pdf) throw new Error(t('main.presentations.couldNotRead', { failures: failures.join('; '), hint: unsupportedMessage(path, platform) }))
    }
    const files = await renderPdfPages(readFileSync(pdf), mediaDir(), nameFor, drawing)
    if (!files.length) throw new Error(t('main.presentations.noSlides'))
    return { title, slides: files }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

export async function pickPresentation(parent: BrowserWindow | null, onStatus: (message: string) => void): Promise<ImportedPresentation | null> {
  const options: Electron.OpenDialogOptions = {
    title: t('main.presentations.pickTitle'),
    properties: ['openFile'],
    filters: [{ name: t('main.presentations.filterName'), extensions: PRESENTATION_EXTENSIONS }],
  }
  // PRESTREAMER_PRESENTATION_FILE stands in for the file dialog in the end-to-end tests.
  const forced = process.env.PRESTREAMER_PRESENTATION_FILE
  if (forced) return importPresentationFile(forced, onStatus)
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled || !result.filePaths[0]) return null
  return importPresentationFile(result.filePaths[0], onStatus)
}

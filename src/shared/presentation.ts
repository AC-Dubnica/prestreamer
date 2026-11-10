/**
 * Presentations (PowerPoint, Keynote, PDF) are turned into one picture per slide, so they show the same on every screen and
 * on the stream. Pure parts only: how a deck becomes slides, which converters to try, and the scripts that drive them.
 */
import type { ServiceItem, Slide } from './types'
import { t } from './i18n'

export type PresentationItem = Extract<ServiceItem, { kind: 'presentation' }>

/** File types the import accepts. */
export const PRESENTATION_EXTENSIONS = ['pptx', 'ppt', 'pps', 'ppsx', 'key', 'odp', 'pdf']

/** One slide per picture; the label ("Slide 3 / 12") is unique, so the live slide is never mistaken for another one. */
export function presentationSlides(it: PresentationItem): Slide[] {
  return it.slides.map((file, i) => ({ label: t('shared.presentation.slide', { n: i + 1, total: it.slides.length }), text: '', picture: { file }, itemId: it.id }))
}

export type Platform = 'darwin' | 'win32' | 'linux'
export type Converter = 'builtin' | 'keynote' | 'powerpoint-mac' | 'powerpoint-windows' | 'libreoffice'

const extOf = (path: string): string => /\.([^./\\]+)$/.exec(path)?.[1].toLowerCase() ?? ''

/**
 * How to read a deck, best first. A .pptx / .ppsx is read by PreStreamer itself ('builtin'): nothing to install, nothing
 * launched, no permission prompts. The programs below are for what it cannot read: old binary .ppt files, OpenDocument and
 * Keynote. Keynote only exists on macOS. Returns [] for a type that cannot be imported on this system.
 */
export function converterPlan(path: string, platform: Platform): Converter[] {
  const ext = extOf(path)
  if (ext === 'pptx' || ext === 'ppsx') return ['builtin', 'libreoffice']
  const oldPowerPoint = ext === 'ppt' || ext === 'pps'
  if (platform === 'darwin') {
    if (ext === 'key') return ['keynote']
    if (oldPowerPoint) return ['libreoffice', 'powerpoint-mac', 'keynote']
    if (ext === 'odp') return ['libreoffice', 'keynote']
    return []
  }
  if (ext === 'key') return [] // Keynote files cannot be read outside macOS
  if (platform === 'win32' && oldPowerPoint) return ['libreoffice', 'powerpoint-windows']
  if (oldPowerPoint || ext === 'odp') return ['libreoffice']
  return []
}

/** Why a file cannot be imported, in words for the operator. */
export function unsupportedMessage(path: string, platform: Platform): string {
  const ext = extOf(path)
  if (ext === 'key' && platform !== 'darwin') return t('shared.presentation.keynoteMac')
  if (!PRESENTATION_EXTENSIONS.includes(ext)) return t('shared.presentation.badType', { ext: ext || '?' })
  return t('shared.presentation.noProgram')
}

const appleString = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** AppleScript for Keynote: open the deck, export it as a PDF, close it without saving. */
export const keynoteScript = (input: string, outPdf: string): string =>
  [
    'tell application "Keynote"',
    `  set theDoc to open POSIX file ${appleString(input)}`,
    '  try',
    `    export theDoc to POSIX file ${appleString(outPdf)} as PDF`,
    '  end try',
    '  close theDoc saving no',
    'end tell',
  ].join('\n')

/** AppleScript for PowerPoint for Mac: open the deck, save a PDF copy, close it without saving. */
export const powerPointMacScript = (input: string, outPdf: string): string =>
  [
    'tell application "Microsoft PowerPoint"',
    `  open POSIX file ${appleString(input)}`,
    '  set thePres to active presentation',
    '  try',
    `    save thePres in POSIX file ${appleString(outPdf)} as save as PDF`,
    '  end try',
    '  close thePres saving no',
    'end tell',
  ].join('\n')

const psString = (s: string): string => `'${s.replace(/'/g, "''")}'`

/** PowerShell for PowerPoint on Windows (COM): opens read-only without a window, saves a PDF (32 = ppSaveAsPDF), quits only if it started it. */
export const powerPointWindowsScript = (input: string, outPdf: string): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    '$app = New-Object -ComObject PowerPoint.Application',
    '$wasRunning = $app.Presentations.Count -gt 0',
    'try {',
    `  $p = $app.Presentations.Open(${psString(input)}, $true, $false, $false)`,
    `  $p.SaveAs(${psString(outPdf)}, 32)`,
    '  $p.Close()',
    '} finally {',
    '  if (-not $wasRunning) { $app.Quit() }',
    '}',
  ].join('\n')

/** powershell.exe arguments that run a script safely whatever characters it holds (the script is passed encoded). */
export const powerShellArgs = (script: string): string[] => [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
]

/** LibreOffice's command line for a PDF conversion into `outDir` (the PDF is named after the input). */
export const libreOfficeArgs = (input: string, outDir: string): string[] => ['--headless', '--convert-to', 'pdf', '--outdir', outDir, input]

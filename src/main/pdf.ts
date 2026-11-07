import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PdfLine } from '../shared/song-import'

export const MAX_PAGES = 300
const RENDER_WIDTH = 1920

/**
 * Draws every page of a PDF as a PNG (1920 px wide) in a hidden window, using pdf.js. It runs in Chromium's own canvas, so it
 * works the same on macOS and Windows and needs nothing installed. `nameFor(i)` gives the file name for page i in `outDir`.
 */
export function renderPdfPages(data: Buffer, outDir: string, nameFor: (index: number) => string, onProgress: (done: number, total: number) => void = () => {}): Promise<string[]> {
  mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 720,
      webPreferences: { preload: join(__dirname, '../preload/pdf.js'), contextIsolation: true, sandbox: true },
    })
    const ipc = win.webContents.ipc
    let settled = false
    const finish = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      if (err) reject(err)
      else resolve(files)
    }
    const timer = setTimeout(() => finish(new Error('Drawing the PDF took too long')), 5 * 60_000)
    ipc.handle('pdf:page', (_e, index: number, png: Uint8Array) => {
      const name = nameFor(index)
      writeFileSync(join(outDir, name), Buffer.from(png))
      files[index] = name
    })
    ipc.on('pdf:progress', (_e, done: number, total: number) => onProgress(done, total))
    ipc.on('pdf:done', (_e, result: { pages: number } | { error: string }) => {
      if ('error' in result) finish(new Error(`The PDF could not be read: ${result.error}`))
      else finish(null)
    })
    ipc.on('pdf:ready', () => win.webContents.send('pdf:job', { data: new Uint8Array(data), width: RENDER_WIDTH, maxPages: MAX_PAGES }))
    win.webContents.on('render-process-gone', () => finish(new Error('The PDF renderer crashed')))
    void win.loadFile(join(__dirname, '../renderer/pdf-render.html')).catch((err) => finish(err as Error))
  })
}

/** The text lines of the first page of each PDF, read in a hidden window with pdf.js. */
export function readPdfTexts(files: Buffer[]): Promise<PdfLine[][]> {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { preload: join(__dirname, '../preload/pdf.js'), contextIsolation: true, sandbox: true } })
    const ipc = win.webContents.ipc
    let settled = false
    const finish = (err: Error | null, texts: PdfLine[][] = []) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      if (err) reject(err)
      else resolve(texts)
    }
    const timer = setTimeout(() => finish(new Error('Reading the PDFs took too long')), 5 * 60_000)
    ipc.on('pdf:done', (_e, result: { texts: PdfLine[][] } | { error: string }) => {
      if ('texts' in result) finish(null, result.texts)
      else finish(new Error(`The PDFs could not be read: ${result.error}`))
    })
    ipc.on('pdf:ready', () => win.webContents.send('pdf:job', { texts: files.map((f) => new Uint8Array(f)) }))
    win.webContents.on('render-process-gone', () => finish(new Error('The PDF reader crashed')))
    void win.loadFile(join(__dirname, '../renderer/pdf-render.html')).catch((err) => finish(err as Error))
  })
}

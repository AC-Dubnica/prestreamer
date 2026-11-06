import { BrowserWindow } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_SLIDES = 300
const RENDER_WIDTH = 1920

/**
 * Draws every slide of a .pptx file as a PNG without PowerPoint: a hidden window lays the slide out (text, shapes, pictures,
 * backgrounds) with pptx-preview and takes a screenshot of it. `nameFor(i)` gives the file name for slide i in `outDir`.
 */
export function renderPptxSlides(data: Buffer, outDir: string, nameFor: (index: number) => string, onProgress: (done: number, total: number) => void = () => {}): Promise<{ files: string[]; info?: unknown }> {
  mkdirSync(outDir, { recursive: true })
  const files: string[] = []
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: RENDER_WIDTH,
      height: 1440,
      useContentSize: true,
      webPreferences: { preload: join(__dirname, '../preload/pptx.js'), contextIsolation: true, sandbox: true, offscreen: true },
    })
    const ipc = win.webContents.ipc
    let settled = false
    const finish = (err: Error | null, info?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      if (err) reject(err)
      else resolve({ files, info })
    }
    const timer = setTimeout(() => finish(new Error('Drawing the presentation took too long')), 5 * 60_000)
    // An offscreen window hands out the last frame it painted. Without a GPU (a CI machine) a picture that has just been decoded can
    // take a few frames to appear, so wait for a few paints, nudging the window to draw, before the slide is captured.
    const painted = (frames: number, timeoutMs: number) => new Promise<void>((resolve) => {
      let n = 0
      const done = () => { clearTimeout(t); win.webContents.off('paint', onPaint); resolve() }
      const onPaint = () => { if (++n >= frames) done() }
      const t = setTimeout(done, timeoutMs)
      win.webContents.on('paint', onPaint)
      win.webContents.invalidate()
    })
    ipc.handle('pptx:capture', async (_e, index: number, rect: { x: number; y: number; width: number; height: number }) => {
      await painted(3, 2000)
      const image = await win.webContents.capturePage(rect)
      const name = nameFor(index)
      writeFileSync(join(outDir, name), image.toPNG())
      files[index] = name
    })
    if (process.env.PRESTREAMER_DEBUG_PPTX) win.webContents.on('console-message', (...a: unknown[]) => { const m = String((a[0] as { message?: string })?.message ?? a[2] ?? ''); if (m.startsWith('PPTXDBG')) console.log(m) })
    ipc.on('pptx:progress', (_e, done: number, total: number) => onProgress(done, total))
    ipc.on('pptx:done', (_e, result: { slides: number; info?: unknown } | { error: string }) => {
      if ('error' in result) finish(new Error(`This presentation could not be read: ${result.error}`))
      else finish(null, result.info)
    })
    ipc.on('pptx:ready', () => win.webContents.send('pptx:job', { data: new Uint8Array(data), width: RENDER_WIDTH, maxSlides: MAX_SLIDES }))
    win.webContents.on('render-process-gone', () => finish(new Error('The presentation renderer crashed')))
    void win.loadFile(join(__dirname, '../renderer/pptx-render.html')).catch((err) => finish(err as Error))
  })
}

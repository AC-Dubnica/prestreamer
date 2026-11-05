import * as pdfjs from 'pdfjs-dist/build/pdf.min.mjs'
import * as worker from 'pdfjs-dist/build/pdf.worker.min.mjs'

interface Bridge {
  onJob(cb: (job: { data: Uint8Array; width: number; maxPages: number }) => void): void
  page(index: number, png: Uint8Array): Promise<void>
  progress(done: number, total: number): void
  done(result: { pages: number } | { error: string }): void
  ready(): void
}
declare const pdfBridge: Bridge

// Run pdf.js's worker code in this page instead of a Worker: module workers cannot be loaded from file:// pages, and a
// hidden renderer window has nothing else to keep responsive.
;(globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = worker

pdfBridge.onJob(async ({ data, width, maxPages }) => {
  try {
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
    const total = Math.min(doc.numPages, maxPages)
    for (let n = 1; n <= total; n++) {
      const page = await doc.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: width / base.width })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      await page.render({ canvasContext: canvas.getContext('2d')!, viewport, background: '#ffffff' }).promise
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error(`Could not draw page ${n}`)
      await pdfBridge.page(n - 1, new Uint8Array(await blob.arrayBuffer()))
      page.cleanup()
      pdfBridge.progress(n, total)
    }
    pdfBridge.done({ pages: total })
  } catch (err) {
    pdfBridge.done({ error: (err as Error).message || String(err) })
  }
})
pdfBridge.ready()

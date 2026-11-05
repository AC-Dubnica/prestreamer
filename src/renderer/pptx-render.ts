import { init } from 'pptx-preview'

interface Bridge {
  onJob(cb: (job: { data: Uint8Array; width: number; maxSlides: number }) => void): void
  capture(index: number, rect: { x: number; y: number; width: number; height: number }): Promise<void>
  progress(done: number, total: number): void
  done(result: { slides: number; info?: unknown } | { error: string }): void
  ready(): void
}
declare const pptxBridge: Bridge

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Waits for every picture in the slide to load, then a moment for fonts and layout. */
async function whenDrawn(root: HTMLElement): Promise<void> {
  const imgs = [...root.querySelectorAll('img')]
  await Promise.all(imgs.map((i) => (i.complete ? null : new Promise((r) => { i.onload = i.onerror = () => r(null) }))))
  await document.fonts.ready
  await settle(120)
}

pptxBridge.onJob(async ({ data, width, maxSlides }) => {
  try {
    const host = document.createElement('div')
    host.style.cssText = `position:absolute;left:0;top:0;width:${width}px;background:#fff`
    document.body.append(host)
    const previewer = init(host, { width, height: Math.round((width * 9) / 16), mode: 'slide' }) as unknown as {
      load(buf: ArrayBuffer): Promise<{ width: number; height: number }>
      slideCount: number
      options: { height: number }
      removeCurrentSlide(): void
      renderSingleSlide(i: number): void
    }
    const deck = await previewer.load(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
    const height = Math.round((width * deck.height) / deck.width)
    previewer.options.height = height
    host.style.height = `${height}px`
    const total = Math.min(previewer.slideCount, maxSlides)
    for (let i = 0; i < total; i++) {
      previewer.removeCurrentSlide()
      previewer.renderSingleSlide(i)
      await whenDrawn(host)
      await pptxBridge.capture(i, { x: 0, y: 0, width, height })
      pptxBridge.progress(i + 1, total)
    }
    pptxBridge.done({ slides: total })
  } catch (err) {
    pptxBridge.done({ error: (err as Error).message || String(err) })
  }
})
pptxBridge.ready()

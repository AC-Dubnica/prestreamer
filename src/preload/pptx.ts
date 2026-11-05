import { contextBridge, ipcRenderer } from 'electron'

/** The hidden PowerPoint-file renderer's link to the main process: it receives a .pptx and asks for a screenshot per slide. */
contextBridge.exposeInMainWorld('pptxBridge', {
  onJob: (cb: (job: { data: Uint8Array; width: number; maxSlides: number }) => void) => {
    ipcRenderer.on('pptx:job', (_e, job) => cb(job))
  },
  capture: (index: number, rect: { x: number; y: number; width: number; height: number }): Promise<void> => ipcRenderer.invoke('pptx:capture', index, rect),
  progress: (done: number, total: number): void => ipcRenderer.send('pptx:progress', done, total),
  done: (result: { slides: number; info?: unknown } | { error: string }): void => ipcRenderer.send('pptx:done', result),
  ready: (): void => ipcRenderer.send('pptx:ready'),
})

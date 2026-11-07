import { contextBridge, ipcRenderer } from 'electron'

/** The hidden PDF page renderer's link to the main process: it receives a PDF, hands back one PNG per page. */
contextBridge.exposeInMainWorld('pdfBridge', {
  onJob: (cb: (job: unknown) => void) => {
    ipcRenderer.on('pdf:job', (_e, job) => cb(job))
  },
  page: (index: number, png: Uint8Array): Promise<void> => ipcRenderer.invoke('pdf:page', index, png),
  progress: (done: number, total: number): void => ipcRenderer.send('pdf:progress', done, total),
  done: (result: unknown): void => ipcRenderer.send('pdf:done', result),
  ready: (): void => ipcRenderer.send('pdf:ready'),
})

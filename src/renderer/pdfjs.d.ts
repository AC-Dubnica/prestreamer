// pdf.js ships its types for the package root, not for the pre-built bundles imported here; only the used part is declared.
declare module 'pdfjs-dist/build/pdf.min.mjs' {
  interface Viewport { width: number; height: number }
  interface Page {
    getViewport(o: { scale: number }): Viewport
    render(o: { canvasContext: CanvasRenderingContext2D; viewport: Viewport; background?: string }): { promise: Promise<void> }
    cleanup(): void
    getTextContent(): Promise<{ items: unknown[] }>
  }
  export function getDocument(o: { data: Uint8Array; isEvalSupported?: boolean; useSystemFonts?: boolean }): { promise: Promise<{ numPages: number; getPage(n: number): Promise<Page>; destroy(): Promise<void> }> }
}
declare module 'pdfjs-dist/build/pdf.worker.min.mjs'

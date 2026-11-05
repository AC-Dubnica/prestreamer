export interface GridChoice { cols: number; rows: number; /** Width of one picture in pixels, as large as the space allows. */ cellWidth: number }

/**
 * How many columns to lay `count` pictures of one aspect ratio out in so that each is as large as possible inside a space
 * of `width` x `height` (with `gap` between them and `labelHeight` under each). Ties go to fewer columns.
 */
export function bestGrid(count: number, width: number, height: number, aspect = 16 / 9, gap = 10, labelHeight = 24): GridChoice {
  const n = Math.max(1, Math.floor(count))
  let best: GridChoice = { cols: 1, rows: n, cellWidth: 0 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cellW = (width - gap * (cols - 1)) / cols
    const cellH = (height - gap * (rows - 1)) / rows - labelHeight
    const cellWidth = Math.max(0, Math.min(cellW, cellH * aspect))
    if (cellWidth > best.cellWidth + 0.5) best = { cols, rows, cellWidth }
  }
  return best
}

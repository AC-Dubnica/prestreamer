import { describe, expect, it } from 'vitest'
import { bestGrid } from '../src/shared/layout'

describe('bestGrid', () => {
  it('one picture takes as much of the space as its shape allows', () => {
    expect(bestGrid(1, 1600, 900, 16 / 9, 10, 0)).toMatchObject({ cols: 1, rows: 1, cellWidth: 1600 })
    expect(bestGrid(1, 1600, 400, 16 / 9, 10, 0).cellWidth).toBeCloseTo(400 * (16 / 9), 5) // height is the limit
  })
  it('two pictures sit side by side in a wide space and stacked in a tall one', () => {
    expect(bestGrid(2, 1600, 500, 16 / 9, 10, 0)).toMatchObject({ cols: 2, rows: 1 })
    expect(bestGrid(2, 500, 1600, 16 / 9, 10, 0)).toMatchObject({ cols: 1, rows: 2 })
  })
  it('four pictures make a 2 x 2 grid in a screen-shaped space', () => {
    expect(bestGrid(4, 1600, 900, 16 / 9, 10, 0)).toMatchObject({ cols: 2, rows: 2 })
  })
  it('never makes a picture wider than its cell or taller than the space allows', () => {
    for (const n of [1, 2, 3, 5, 7, 9]) {
      for (const [w, h] of [[1200, 700], [600, 900], [2000, 300]] as const) {
        const g = bestGrid(n, w, h, 16 / 9, 10, 24)
        expect(g.cellWidth * g.cols + 10 * (g.cols - 1)).toBeLessThanOrEqual(w + 0.001)
        expect((g.cellWidth / (16 / 9) + 24) * g.rows + 10 * (g.rows - 1)).toBeLessThanOrEqual(h + 0.001)
        expect(g.cols * g.rows).toBeGreaterThanOrEqual(n)
      }
    }
  })
  it('copes with no space and with silly counts', () => {
    expect(bestGrid(3, 0, 0).cellWidth).toBe(0)
    expect(bestGrid(0, 800, 600).cols).toBe(1)
  })
})

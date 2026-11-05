import { describe, expect, it } from 'vitest'
import { fitBounds, safeToRestore, sanitizeSession } from '../src/shared/session'
import { defaultScreens } from '../src/shared/screens'
import type { DisplayInfo, ScreenConfig } from '../src/shared/types'

const display = (id: number, primary: boolean): DisplayInfo => ({ id, label: `D${id}`, x: 0, y: 0, width: 1920, height: 1080, primary })
const screen = (kind: 'display' | 'virtual', displayId: number | null): ScreenConfig => ({ ...defaultScreens()[0], kind, displayId })

describe('sanitizeSession', () => {
  it('falls back to an empty session for anything unusable', () => {
    for (const bad of [null, undefined, 3, 'x', [], {}]) expect(sanitizeSession(bad)).toEqual({ bounds: null, maximized: false, liveScreens: [] })
  })
  it('keeps good values and rejects tiny, huge or non-numeric bounds', () => {
    expect(sanitizeSession({ bounds: { x: 10, y: 20, width: 1400, height: 860 }, maximized: true, liveScreens: ['a', 5, 'b'] })).toEqual({ bounds: { x: 10, y: 20, width: 1400, height: 860 }, maximized: true, liveScreens: ['a', 'b'] })
    expect(sanitizeSession({ bounds: { x: 0, y: 0, width: 100, height: 100 } }).bounds).toBeNull()
    expect(sanitizeSession({ bounds: { x: 0, y: 0, width: 99999, height: 900 } }).bounds).toBeNull()
    expect(sanitizeSession({ bounds: { x: 'a', y: 0, width: 1400, height: 900 } }).bounds).toBeNull()
  })
})

describe('fitBounds', () => {
  const area = { x: 0, y: 0, width: 1920, height: 1080 }
  it('keeps a window whose middle is on a connected display', () => expect(fitBounds({ x: 100, y: 100, width: 1400, height: 860 }, [area])).toEqual({ x: 100, y: 100, width: 1400, height: 860 }))
  it('drops one that was on a display that is gone', () => expect(fitBounds({ x: 3000, y: 100, width: 1400, height: 860 }, [area])).toBeNull())
  it('handles no saved bounds', () => expect(fitBounds(null, [area])).toBeNull())
})

describe('safeToRestore', () => {
  const displays = [display(1, true), display(2, false)]
  it('reopens virtual screens and plain windows', () => {
    expect(safeToRestore(screen('virtual', null), displays)).toBe(true)
    expect(safeToRestore(screen('display', null), displays)).toBe(true)
  })
  it('reopens a screen on a second display, never one that would cover the main display', () => {
    expect(safeToRestore(screen('display', 2), displays)).toBe(true)
    expect(safeToRestore(screen('display', 1), displays)).toBe(false)
  })
  it('a display that is not connected opens as a window', () => expect(safeToRestore(screen('display', 9), displays)).toBe(true))
})

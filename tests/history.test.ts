import { describe, expect, it } from 'vitest'
import { History } from '../src/shared/history'

describe('History', () => {
  it('starts with nothing to undo or redo', () => {
    const h = new History('a')
    expect(h.canUndo).toBe(false)
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBeNull()
  })

  it('goes back one change at a time, then forward again', () => {
    const h = new History('a')
    h.record('b')
    h.record('c')
    expect(h.undo()).toBe('b')
    expect(h.undo()).toBe('a')
    expect(h.undo()).toBeNull()
    expect(h.redo()).toBe('b')
    expect(h.redo()).toBe('c')
    expect(h.redo()).toBeNull()
  })

  it('ignores a "change" to the state it already has', () => {
    const h = new History('a')
    expect(h.record('a')).toBe(false)
    expect(h.canUndo).toBe(false)
    h.record('b')
    expect(h.record('b')).toBe(false)
    expect(h.undoSteps).toBe(1)
  })

  it('a new change after an undo ends the redo trail', () => {
    const h = new History('a')
    h.record('b')
    h.undo()
    expect(h.canRedo).toBe(true)
    h.record('c')
    expect(h.canRedo).toBe(false)
    expect(h.undo()).toBe('a')
  })

  it('undoing then recording the old state again counts as a change (it is a different place in time)', () => {
    const h = new History('a')
    h.record('b')
    h.undo() // now at 'a'
    expect(h.record('b')).toBe(true)
    expect(h.undo()).toBe('a')
  })

  it('keeps only the most recent changes', () => {
    const h = new History('0', 3)
    for (let i = 1; i <= 10; i++) h.record(String(i))
    expect(h.undoSteps).toBe(3)
    expect([h.undo(), h.undo(), h.undo(), h.undo()]).toEqual(['9', '8', '7', null])
  })

  it('reset forgets everything', () => {
    const h = new History('a')
    h.record('b')
    h.undo()
    h.reset('z')
    expect([h.canUndo, h.canRedo]).toEqual([false, false])
    h.record('y')
    expect(h.undo()).toBe('z')
  })
})

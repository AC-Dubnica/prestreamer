/**
 * Undo and redo over snapshots (strings, e.g. JSON). `record` is told the state after each finished change; `undo` and
 * `redo` hand back the snapshot to go to. A new change after an undo ends the redo trail, like in any editor.
 */
export class History {
  private undoStack: string[] = []
  private redoStack: string[] = []
  private current: string

  constructor(initial: string, private readonly limit = 100) {
    this.current = initial
  }

  /** Notes the state after a change. Returns false (and records nothing) when it is the state we already have. */
  record(next: string): boolean {
    if (next === this.current) return false
    this.undoStack.push(this.current)
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
    this.current = next
    return true
  }

  /** The snapshot before the last change, or null when there is nothing to go back to. */
  undo(): string | null {
    const prev = this.undoStack.pop()
    if (prev === undefined) return null
    this.redoStack.push(this.current)
    this.current = prev
    return prev
  }

  redo(): string | null {
    const next = this.redoStack.pop()
    if (next === undefined) return null
    this.undoStack.push(this.current)
    this.current = next
    return next
  }

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }
  get undoSteps(): number { return this.undoStack.length }
  get redoSteps(): number { return this.redoStack.length }

  /** Starts over from a state (the mixer was loaded or replaced from outside): nothing to undo or redo. */
  reset(initial: string): void {
    this.undoStack = []
    this.redoStack = []
    this.current = initial
  }
}

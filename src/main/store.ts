import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Writes via temp file + rename so a crash or power loss mid-write can't leave a truncated file. */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

/** A list of records persisted as one JSON file, written via temp file + rename so a crash can't truncate it. */
export class ListStore<T extends { id: string }> {
  private items: T[] = []

  /** `dir` is a function so Electron's userData path is only resolved when the app is ready (or overridden by tests). */
  constructor(
    private readonly fileName: string,
    private readonly seed: T[],
    private readonly dir: () => string,
  ) {}

  private path = () => join(this.dir(), this.fileName)

  load(): T[] {
    try {
      this.items = JSON.parse(readFileSync(this.path(), 'utf8')) as T[]
    } catch {
      this.items = structuredClone(this.seed)
      this.persist()
    }
    return this.items
  }

  list(): T[] {
    return this.items
  }

  save(item: T): T[] {
    const i = this.items.findIndex((x) => x.id === item.id)
    if (i >= 0) this.items[i] = item
    else this.items.push(item)
    this.persist()
    return this.items
  }

  /** Replaces the whole list (used when the owner keeps its own ordered copy, such as the screens). */
  replaceAll(items: T[]): void {
    this.items = items
    this.persist()
  }

  remove(id: string): T[] {
    this.items = this.items.filter((x) => x.id !== id)
    this.persist()
    return this.items
  }

  private persist(): void {
    writeJsonAtomic(this.path(), this.items)
  }
}

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { ListStore, writeJsonAtomic } from '../src/main/store'

interface Item { id: string; name: string }
const SEED: Item[] = [{ id: 'a', name: 'Alpha' }]

describe('ListStore', () => {
  let dir: string
  const make = () => new ListStore<Item>('items.json', SEED, () => dir)
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'prestreamer-store-')) })

  it('seeds a new file on first load', () => {
    expect(make().load()).toEqual(SEED)
    expect(JSON.parse(readFileSync(join(dir, 'items.json'), 'utf8'))).toEqual(SEED)
  })

  it('does not let callers mutate the seed', () => {
    const store = make()
    store.load()
    store.save({ id: 'b', name: 'Beta' })
    expect(SEED).toHaveLength(1)
  })

  it('adds, replaces and removes by id, and persists each change', () => {
    const store = make()
    store.load()
    store.save({ id: 'b', name: 'Beta' })
    store.save({ id: 'a', name: 'Alpha 2' })
    expect(make().load()).toEqual([{ id: 'a', name: 'Alpha 2' }, { id: 'b', name: 'Beta' }])
    store.remove('a')
    expect(make().load()).toEqual([{ id: 'b', name: 'Beta' }])
  })

  it('re-seeds when the file is corrupt instead of crashing', () => {
    writeFileSync(join(dir, 'items.json'), '{ not json')
    expect(make().load()).toEqual(SEED)
  })

  it('leaves no temp file behind after a write', () => {
    const store = make()
    store.load()
    store.save({ id: 'b', name: 'Beta' })
    expect(readdirSync(dir)).toEqual(['items.json'])
  })

  it('creates the data folder if it does not exist yet', () => {
    const nested = join(dir, 'a', 'b', 'file.json')
    writeJsonAtomic(nested, { ok: true })
    expect(JSON.parse(readFileSync(nested, 'utf8'))).toEqual({ ok: true })
  })
})

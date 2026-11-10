import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  blendLevels, dmxPortCandidates, fitLevels, isDmxPort, newId, nextFreeAddress, patchProblems, renderUniverse, sanitizeDmxSettings,
  type DmxSettings, type DmxStatus, type Fixture,
} from '../src/shared/dmx'
import { DmxController, type DmxDeps, type DmxLinkEvents } from '../src/main/dmx'

const fx = (id: string, kind: Fixture['kind'], address: number, channels: number): Fixture => ({ id, name: id, kind, address, channels })

describe('DMX settings', () => {
  it('starts switched off and empty, whatever the file holds', () => {
    expect(sanitizeDmxSettings(null)).toMatchObject({ enabled: false, fixtures: [], scenes: [], fadeSec: 1.5, blackoutOnQuit: false })
    expect(sanitizeDmxSettings('nonsense').enabled).toBe(false)
  })

  it('fixes fixtures: kind fixes the channel count, addresses stay in 1..512, ids stay unique', () => {
    const s = sanitizeDmxSettings({ fixtures: [{ id: 'a', kind: 'rgb', address: 9999, channels: 7 }, { id: 'a', kind: 'raw', address: 0, channels: 99 }, { kind: 'bogus', name: '  ' }] })
    expect(s.fixtures.map((f) => [f.kind, f.address, f.channels])).toEqual([['rgb', 512, 3], ['raw', 1, 32], ['dimmer', 1, 1]])
    expect(new Set(s.fixtures.map((f) => f.id)).size).toBe(3)
    expect(s.fixtures[2].name).toBe('Light 3')
  })

  it('fits scene values to the fixtures: unknown fixtures dropped, short rows padded, bytes clamped', () => {
    const fixtures = [fx('a', 'rgb', 1, 3), fx('b', 'dimmer', 4, 1)]
    expect(fitLevels(fixtures, { a: [300, -5], ghost: [1] })).toEqual({ a: [255, 0, 0], b: [0] })
    const s = sanitizeDmxSettings({ fixtures, scenes: [{ id: 's', name: 'Song', fadeSec: 999, values: { a: [1, 2, 3] } }, { id: 't', fadeSec: null }], startScene: 'gone' })
    expect(s.scenes[0].fadeSec).toBe(60)
    expect(s.scenes[1].fadeSec).toBeNull()
    expect(s.scenes[0].values).toEqual({ a: [1, 2, 3], b: [0] })
    expect(s.startScene).toBe('')
    expect(sanitizeDmxSettings({ fixtures, scenes: [{ id: 's' }], startScene: 's' }).startScene).toBe('s')
  })

  it('refuses ports that are not plain strings of path characters', () => {
    expect(sanitizeDmxSettings({ port: '/dev/cu.usbserial-AB0K12' }).port).toBe('/dev/cu.usbserial-AB0K12')
    expect(sanitizeDmxSettings({ port: '/dev/x; rm -rf /' }).port).toBe('')
  })
})

describe('the patch', () => {
  it('reports overlaps and fixtures that run past channel 512', () => {
    expect(patchProblems([fx('a', 'rgb', 1, 3), fx('b', 'dimmer', 4, 1)])).toEqual([])
    expect(patchProblems([fx('a', 'rgb', 1, 3), fx('b', 'rgb', 3, 3)])).toEqual(['b and a share channel 3'])
    expect(patchProblems([fx('a', 'rgbw', 510, 4)])[0]).toMatch(/510–513/)
  })

  it('finds the first gap that fits', () => {
    expect(nextFreeAddress([], 3)).toBe(1)
    expect(nextFreeAddress([fx('a', 'rgb', 1, 3), fx('b', 'dimmer', 5, 1)], 1)).toBe(4)
    expect(nextFreeAddress([fx('a', 'rgb', 1, 3), fx('b', 'dimmer', 5, 1)], 3)).toBe(6)
    expect(nextFreeAddress([fx('a', 'raw', 1, 32)], 481)).toBeNull()
    expect(nextFreeAddress([fx('a', 'raw', 1, 32)], 480)).toBe(33)
  })

  it('makes unused ids', () => { expect(newId('scene', [{ id: 'scene1' }, { id: 'scene2' }])).toBe('scene3') })
})

describe('the universe', () => {
  const fixtures = [fx('wash', 'rgb', 1, 3), fx('par', 'dimmer', 10, 1)]
  const levels = { wash: [255, 100, 0], par: [200] }

  it('places each fixture at its address', () => {
    const u = renderUniverse(fixtures, levels)
    expect(u.length).toBe(512)
    expect([...u.slice(0, 4)]).toEqual([255, 100, 0, 0])
    expect(u[9]).toBe(200)
  })

  it('scales by the grand master and goes dark on blackout', () => {
    expect([...renderUniverse(fixtures, levels, 50).slice(0, 3)]).toEqual([128, 50, 0])
    expect(renderUniverse(fixtures, levels, 100, true).every((b) => b === 0)).toBe(true)
  })

  it('blends between scenes', () => {
    expect(blendLevels({ a: [0, 100] }, { a: [100, 0] }, 0.5)).toEqual({ a: [50, 50] })
    expect(blendLevels({}, { a: [80] }, 0.25)).toEqual({ a: [20] })
    expect(blendLevels({ a: [0] }, { a: [10] }, 5)).toEqual({ a: [10] })
  })
})

describe('finding the interface', () => {
  it('lists USB serial adapters on macOS and Linux only', () => {
    const dev = ['cu.Bluetooth-Incoming-Port', 'cu.usbserial-AB0K12', 'tty.usbserial-AB0K12', 'ttyUSB1', 'ttyUSB0', 'ttyS0']
    expect(dmxPortCandidates(dev, 'darwin')).toEqual(['/dev/cu.usbserial-AB0K12'])
    expect(dmxPortCandidates(dev, 'linux')).toEqual(['/dev/ttyUSB0', '/dev/ttyUSB1'])
    expect(dmxPortCandidates(dev, 'win32')).toEqual([])
  })

  it('only lets the helper open what would be offered', () => {
    expect(isDmxPort('/dev/cu.usbserial-1', 'darwin')).toBe(true)
    expect(isDmxPort('/dev/cu.usbserial-1/../../etc/passwd', 'darwin')).toBe(false)
    expect(isDmxPort('/etc/passwd', 'linux')).toBe(false)
    expect(isDmxPort('/dev/ttyUSB0', 'darwin')).toBe(false)
  })
})

describe('DmxController', () => {
  const settings: DmxSettings = sanitizeDmxSettings({
    enabled: true,
    fadeSec: 1,
    fixtures: [fx('wash', 'rgb', 1, 3), fx('par', 'dimmer', 4, 1)],
    scenes: [
      { id: 'worship', name: 'Worship', fadeSec: 0, values: { wash: [200, 0, 100], par: [120] } },
      { id: 'sermon', name: 'Sermon', fadeSec: null, values: { wash: [255, 255, 255], par: [255] } },
    ],
  })
  let clock = 0
  let ports: string[]
  let frames: Uint8Array[]
  let opened: { port: string; events: DmxLinkEvents }[]
  let closed: number
  let unavailable: string | null
  let statuses: DmxStatus[]
  let saved: DmxSettings[]

  const deps = (): DmxDeps => ({
    listPorts: () => ports,
    unavailable: () => unavailable,
    now: () => clock,
    open: (port, events) => { opened.push({ port, events }); return { write: (s) => frames.push(s.slice()), close: () => { closed++ } } },
  })
  const make = (initial: DmxSettings = settings) => new DmxController((s) => statuses.push(s), deps(), (s) => saved.push(s), initial)

  beforeEach(() => { vi.useFakeTimers(); clock = 0; ports = ['/dev/cu.usbserial-1']; frames = []; opened = []; closed = 0; unavailable = null; statuses = []; saved = [] })
  afterEach(() => { vi.useRealTimers() })

  it('opens nothing and sends nothing until asked', () => {
    const c = make()
    c.start()
    expect(opened).toEqual([])
    expect(frames).toEqual([])
    expect(c.getStatus().state).toBe('idle')
    expect(make({ ...settings, enabled: false }).getStatus().state).toBe('off')
  })

  it('does nothing while switched off', () => {
    const c = make({ ...settings, enabled: false })
    c.command({ type: 'scene', id: 'worship' })
    expect(opened).toEqual([])
  })

  it('recalls a scene without a fade at once, through the first interface found', () => {
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    expect(opened.map((o) => o.port)).toEqual(['/dev/cu.usbserial-1'])
    expect([...frames[frames.length - 1].slice(0, 4)]).toEqual([200, 0, 100, 120])
    expect(c.getStatus()).toMatchObject({ scene: 'worship', state: 'starting' })
    opened[0].events.ready()
    expect(c.getStatus().state).toBe('sending')
  })

  it('fades to a scene over its fade time, then stops ticking', () => {
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    clock = 100
    c.command({ type: 'scene', id: 'sermon' }) // default fade: 1 s
    expect(c.getStatus().levels.wash).toEqual([255, 255, 255]) // the status is the target
    clock = 600
    vi.advanceTimersByTime(25)
    const half = frames[frames.length - 1]
    expect(half[0]).toBeGreaterThan(220)
    expect(half[0]).toBeLessThan(240) // 200 → 255, half way
    expect(half[1]).toBeGreaterThan(110)
    expect(half[1]).toBeLessThan(145)
    clock = 1200
    vi.advanceTimersByTime(25)
    expect([...frames[frames.length - 1].slice(0, 4)]).toEqual([255, 255, 255, 255])
    const n = frames.length
    vi.advanceTimersByTime(500)
    expect(frames.length).toBe(n)
  })

  it('a fader change is immediate and leaves the scene', () => {
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    c.command({ type: 'level', fixture: 'par', channel: 0, value: 33.4 })
    expect(frames[frames.length - 1][3]).toBe(33)
    expect(c.getStatus().scene).toBe('')
    c.command({ type: 'level', fixture: 'par', channel: 5, value: 1 })
    c.command({ type: 'level', fixture: 'nobody', channel: 0, value: 1 })
    expect(c.getStatus().levels.par).toEqual([33])
  })

  it('blackout and master change the output but not the levels', () => {
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    c.command({ type: 'master', value: 50 })
    expect(frames[frames.length - 1][0]).toBe(100)
    c.command({ type: 'blackout', on: true })
    expect(frames[frames.length - 1].every((b) => b === 0)).toBe(true)
    c.command({ type: 'blackout', on: false })
    expect(frames[frames.length - 1][0]).toBe(100)
    expect(c.getStatus().levels.wash).toEqual([200, 0, 100])
  })

  it('shows what is wrong: no interface, a failure while running, an unsupported build', () => {
    ports = []
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    expect(c.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/No DMX interface/) })
    ports = ['/dev/cu.usbserial-1']
    c.command({ type: 'rescan' })
    expect(opened).toHaveLength(1)
    opened[0].events.failed('the driver does not accept 250000 baud')
    expect(c.getStatus()).toMatchObject({ state: 'error', message: expect.stringMatching(/250000/) })
    unavailable = 'This build has no DMX sender'
    c.command({ type: 'blackout', on: true })
    expect(c.getStatus().message).toBe('This build has no DMX sender')
  })

  it('tries again by itself after the interface comes back', () => {
    ports = []
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    ports = ['/dev/cu.usbserial-1']
    vi.advanceTimersByTime(5100)
    expect(opened).toHaveLength(1)
    expect([...frames[frames.length - 1].slice(0, 4)]).toEqual([200, 0, 100, 120])
  })

  it('recalls the start scene when it starts, if one is set', () => {
    make({ ...settings, startScene: 'worship' }).start()
    expect(frames.length).toBeGreaterThan(0)
  })

  it('saves new settings, keeps the levels of fixtures that stay and drops a scene that is gone', () => {
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    const st = c.setSettings({ ...settings, fixtures: [settings.fixtures[1]], scenes: [settings.scenes[1]] })
    expect(saved).toHaveLength(1)
    expect(st.levels).toEqual({ par: [120] })
    expect(st.scene).toBe('')
    expect([frames[frames.length - 1][0], frames[frames.length - 1][3]]).toEqual([0, 120]) // the dimmer sits at address 4 (slot 3); the wash is gone
  })

  it('closes the output when switched off, and sends darkness on quit only if asked', async () => {
    const c = make()
    c.command({ type: 'scene', id: 'worship' })
    c.setSettings({ ...settings, enabled: false })
    expect(closed).toBe(1)
    expect(c.getStatus().state).toBe('off')

    const hold = make()
    hold.command({ type: 'scene', id: 'worship' })
    const before = frames.length
    await hold.stop()
    expect(frames.length).toBe(before)

    const dark = make({ ...settings, blackoutOnQuit: true })
    dark.command({ type: 'scene', id: 'worship' })
    const stopped = dark.stop()
    vi.advanceTimersByTime(200)
    await stopped
    expect(frames[frames.length - 1].every((b) => b === 0)).toBe(true)
  })
})

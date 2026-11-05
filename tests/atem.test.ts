import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_ATEM_ADDRESS, atemAddress, canSend, idleAtem, isValidAtemAddress, sanitizeAtemSettings, switchableInputs, type AtemStatus } from '../src/shared/atem'
import { AtemController, type AtemClient } from '../src/main/atem'

const raw = (inputId: number, shortName: string, meAvailability = 15) => ({ inputId, shortName, longName: `${shortName} long`, meAvailability })
const connected = (patch: Partial<AtemStatus> = {}): AtemStatus => ({
  ...idleAtem,
  state: 'connected',
  model: 'ATEM Mini Pro',
  inputs: [{ id: 1, name: 'CAM 1', longName: 'Front' }, { id: 2, name: 'CAM 2', longName: 'Back' }],
  program: 1,
  preview: 2,
  ...patch,
})

describe('ATEM addresses', () => {
  it('accepts IPv4 addresses and host names, nothing else', () => {
    for (const ok of ['192.168.10.240', '10.0.0.1', ' 10.0.0.1 ', 'atem.local', 'atem-mini']) expect(isValidAtemAddress(ok), ok).toBe(true)
    for (const bad of ['', '999.1.1.1', '1.2.3', '1.2.3.4.5', 'http://1.2.3.4', '1.2.3.4:9910', 'a b', '-bad', 5, null]) expect(isValidAtemAddress(bad), String(bad)).toBe(false)
  })

  it('falls back to the factory address', () => {
    expect(sanitizeAtemSettings({ address: 'nonsense url' })).toEqual({ address: '' })
    expect(sanitizeAtemSettings(null)).toEqual({ address: '' })
    expect(sanitizeAtemSettings({ address: ' 10.1.1.9 ' })).toEqual({ address: '10.1.1.9' })
    expect(atemAddress({ address: '' })).toBe(DEFAULT_ATEM_ADDRESS)
    expect(atemAddress({ address: '10.1.1.9' })).toBe('10.1.1.9')
  })
})

describe('switchableInputs', () => {
  it('keeps what mix effect 1 can take, in the switcher\'s order, and drops its own outputs', () => {
    const list = switchableInputs([raw(10010, 'Prog'), raw(2, 'CAM 2'), raw(0, 'Black'), raw(1, 'CAM 1'), raw(3, 'CAM 3', 2), raw(1000, 'Bars')])
    expect(list.map((i) => i.id)).toEqual([0, 1, 2, 1000])
    expect(list[1]).toEqual({ id: 1, name: 'CAM 1', longName: 'CAM 1 long' })
  })

  it('never leaves a button without a label', () => {
    expect(switchableInputs([{ inputId: 4, shortName: '', longName: '', meAvailability: 1 }])).toEqual([{ id: 4, name: '4', longName: '4' }])
  })
})

describe('canSend', () => {
  it('nothing can be sent without a switcher', () => {
    expect(canSend(idleAtem, { type: 'cut' })).toBe(false)
    expect(canSend(idleAtem, { type: 'program', input: 1 })).toBe(false)
  })

  it('needs a known input for program and preview', () => {
    expect(canSend(connected(), { type: 'program', input: 2 })).toBe(true)
    expect(canSend(connected(), { type: 'preview', input: 9 })).toBe(false)
    expect(canSend(connected(), { type: 'program', input: 1.5 })).toBe(false)
  })

  it('cut and auto wait while a transition runs', () => {
    expect(canSend(connected(), { type: 'auto' })).toBe(true)
    expect(canSend(connected({ inTransition: true }), { type: 'auto' })).toBe(false)
    expect(canSend(connected({ inTransition: true }), { type: 'cut' })).toBe(false)
  })
})

/** A switcher that is there only when told to be. */
function fakeClient() {
  const handlers: Record<string, ((...a: string[]) => void)[]> = {}
  const state = {
    info: { productIdentifier: 'ATEM Mini Pro' },
    inputs: { 1: raw(1, 'CAM 1'), 2: raw(2, 'CAM 2'), 10010: raw(10010, 'Prog') } as Record<string, ReturnType<typeof raw>>,
    video: { mixEffects: [{ programInput: 1, previewInput: 2, inTransition: false }] },
  }
  const client = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    on: vi.fn((event: string, cb: (...a: string[]) => void) => { (handlers[event] ??= []).push(cb) }),
    state,
    changeProgramInput: vi.fn(async () => {}),
    changePreviewInput: vi.fn(async () => {}),
    cut: vi.fn(async () => {}),
    autoTransition: vi.fn(async () => {}),
  }
  const emit = (event: string, ...args: string[]) => handlers[event]?.forEach((h) => h(...args))
  return { client: client as unknown as AtemClient & typeof client, emit, state }
}

describe('AtemController', () => {
  const make = (initial = { address: '' }) => {
    const f = fakeClient()
    const statuses: AtemStatus[] = []
    const saved: unknown[] = []
    const ctl = new AtemController((s) => statuses.push(s), () => f.client, (s) => saved.push(s), initial)
    return { ...f, ctl, statuses, saved }
  }

  it('starts "not found", connects to the factory address and fills in the switcher\'s state', async () => {
    const t = make()
    expect(t.ctl.getStatus()).toMatchObject({ state: 'searching', message: 'No ATEM found at 192.168.10.240' })
    t.ctl.start()
    await vi.waitFor(() => expect(t.client.connect).toHaveBeenCalledWith('192.168.10.240'))
    expect(t.ctl.getStatus().state).toBe('searching')
    t.emit('connected')
    expect(t.ctl.getStatus()).toMatchObject({ state: 'connected', model: 'ATEM Mini Pro', program: 1, preview: 2 })
    expect(t.ctl.getStatus().inputs.map((i) => i.id)).toEqual([1, 2])
    await t.ctl.stop()
  })

  it('follows the switcher when it changes, and goes back to "not found" when it disappears', async () => {
    const t = make({ address: '10.0.0.7' })
    t.ctl.start()
    await vi.waitFor(() => expect(t.client.connect).toHaveBeenCalledWith('10.0.0.7'))
    t.emit('connected')
    t.state.video.mixEffects[0] = { programInput: 2, previewInput: 1, inTransition: true }
    t.emit('stateChanged')
    expect(t.ctl.getStatus()).toMatchObject({ program: 2, preview: 1, inTransition: true })
    t.emit('disconnected')
    expect(t.ctl.getStatus()).toMatchObject({ state: 'searching', inputs: [], message: 'No ATEM found at 10.0.0.7' })
    await t.ctl.stop()
  })

  it('sends switching actions, but only while connected', async () => {
    const t = make()
    t.ctl.start()
    await vi.waitFor(() => expect(t.client.connect).toHaveBeenCalled())
    expect(await t.ctl.send({ type: 'cut' })).toBe(false)
    expect(t.client.cut).not.toHaveBeenCalled()
    t.emit('connected')
    expect(await t.ctl.send({ type: 'program', input: 2 })).toBe(true)
    expect(await t.ctl.send({ type: 'preview', input: 1 })).toBe(true)
    expect(await t.ctl.send({ type: 'cut' })).toBe(true)
    expect(await t.ctl.send({ type: 'auto' })).toBe(true)
    expect(await t.ctl.send({ type: 'program', input: 77 })).toBe(false)
    expect(t.client.changeProgramInput).toHaveBeenCalledWith(2)
    expect(t.client.changePreviewInput).toHaveBeenCalledWith(1)
    expect(t.client.cut).toHaveBeenCalledTimes(1)
    expect(t.client.autoTransition).toHaveBeenCalledTimes(1)
    await t.ctl.stop()
  })

  it('reports a failing command instead of throwing', async () => {
    const t = make()
    t.ctl.start()
    await vi.waitFor(() => expect(t.client.connect).toHaveBeenCalled())
    t.emit('connected')
    t.client.cut.mockRejectedValueOnce(new Error('timeout'))
    expect(await t.ctl.send({ type: 'cut' })).toBe(false)
    expect(t.ctl.getStatus().message).toContain('timeout')
  })

  it('remembers a new address and reconnects to it; a bad one is refused and changes nothing', async () => {
    const t = make()
    t.ctl.start()
    await vi.waitFor(() => expect(t.client.connect).toHaveBeenCalled())
    t.emit('connected')
    const refused = await t.ctl.setAddress('http://nope')
    expect(refused.message).toContain('not an IP address')
    expect(t.saved).toEqual([])
    expect(t.ctl.getStatus().state).toBe('connected')
    await t.ctl.setAddress('10.9.9.9')
    expect(t.saved).toEqual([{ address: '10.9.9.9' }])
    expect(t.client.disconnect).toHaveBeenCalled()
    expect(t.ctl.getStatus()).toMatchObject({ state: 'searching', address: '10.9.9.9' })
    await vi.waitFor(() => expect(t.client.connect).toHaveBeenLastCalledWith('10.9.9.9'))
    await t.ctl.stop()
  })

  it('stays disabled instead of crashing when the library cannot be loaded', async () => {
    const statuses: AtemStatus[] = []
    const ctl = new AtemController((s) => statuses.push(s), () => { throw new Error('missing module') }, () => {}, { address: '' })
    ctl.start()
    await Promise.resolve()
    expect(ctl.getStatus()).toMatchObject({ state: 'searching' })
    expect(ctl.getStatus().message).toContain('missing module')
    expect(await ctl.send({ type: 'cut' })).toBe(false)
  })

  it('tries again when no switcher answers', async () => {
    vi.useFakeTimers()
    try {
      const t = make()
      t.ctl.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(t.client.connect).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(8100)
      expect(t.client.connect).toHaveBeenCalledTimes(2)
      await t.ctl.stop()
      await vi.advanceTimersByTimeAsync(20000)
      expect(t.client.connect).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

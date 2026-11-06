import { describe, expect, it } from 'vitest'
import { SCREEN_LIMITS, SIZE_PRESETS, STAGE_LOOK, clampSize, defaultScreens, isBlank, moveById, roleOf, rolePatch, sanitizeLook, sanitizeScreens } from '../src/shared/screens'
import { defaultLook } from '../src/shared/types'

describe('defaultScreens', () => {
  it('starts with an audience display screen (plays video sound) and a virtual stream screen', () => {
    const [audience, stream] = defaultScreens()
    expect(audience).toMatchObject({ id: 'audience', kind: 'display', displayId: null, look: { videoAudio: true } })
    expect(stream).toMatchObject({ id: 'stream', kind: 'virtual', width: 1920, height: 1080 })
  })
  it('returns fresh objects each time, so callers cannot corrupt the defaults', () => {
    defaultScreens()[0].name = 'changed'
    expect(defaultScreens()[0].name).toBe('Audience')
  })
  it('offers presets inside the allowed size limits', () => {
    for (const p of SIZE_PRESETS) {
      expect(p.width).toBeGreaterThanOrEqual(SCREEN_LIMITS.width[0])
      expect(p.width).toBeLessThanOrEqual(SCREEN_LIMITS.width[1])
      expect(p.height).toBeGreaterThanOrEqual(SCREEN_LIMITS.height[0])
      expect(p.height).toBeLessThanOrEqual(SCREEN_LIMITS.height[1])
    }
  })
})

describe('sanitizeLook', () => {
  it('returns the default look for garbage', () => {
    for (const bad of [null, undefined, 5, 'x', [], {}]) expect(sanitizeLook(bad)).toEqual(defaultLook)
  })
  it('keeps valid values and clamps the rest', () => {
    const look = sanitizeLook({ fontSize: 9999, textBoxOpacity: 7, layout: 'lower-third', showMedia: false, background: '#00b140' })
    expect(look).toMatchObject({ fontSize: SCREEN_LIMITS.fontSize[1], textBoxOpacity: 1, layout: 'lower-third', showMedia: false, background: '#00b140' })
  })
  it('only accepts known layouts', () => expect(sanitizeLook({ layout: 'diagonal' }).layout).toBe('full'))
  it('validates the video source', () => {
    expect(sanitizeLook({ source: { type: 'testpattern' } }).source).toEqual({ type: 'testpattern' })
    expect(sanitizeLook({ source: { type: 'camera', deviceId: 'abc', label: 'ATEM Mini' } }).source).toEqual({ type: 'camera', deviceId: 'abc', label: 'ATEM Mini' })
    expect(sanitizeLook({ source: { type: 'camera' } }).source).toEqual({ type: 'none' }) // camera without a device id
    expect(sanitizeLook({ source: { type: 'rm -rf' } }).source).toEqual({ type: 'none' })
  })
  it('truncates absurdly long strings', () => expect(sanitizeLook({ background: 'x'.repeat(5000) }).background).toHaveLength(500))
})

describe('sanitizeScreens', () => {
  const screen = (over: Record<string, unknown> = {}) => ({ id: 's1', name: 'Hall', kind: 'display', displayId: 7, displayLabel: 'LG', width: 1920, height: 1080, look: {}, ...over })

  it('falls back to the defaults for anything that is not a usable list', () => {
    for (const bad of [null, 'x', {}, [], [{}], [{ id: 'a', kind: 'weird' }]]) expect(sanitizeScreens(bad)).toEqual(defaultScreens())
  })
  it('keeps a valid screen, including its display binding', () => {
    expect(sanitizeScreens([screen()])[0]).toMatchObject({ id: 's1', name: 'Hall', kind: 'display', displayId: 7, displayLabel: 'LG' })
  })
  it('drops duplicates by id and invalid entries, keeping the rest in order', () => {
    const out = sanitizeScreens([screen({ id: 'a' }), screen({ id: 'a', name: 'dup' }), { nope: true }, screen({ id: 'b', kind: 'virtual' })])
    expect(out.map((s) => [s.id, s.name])).toEqual([['a', 'Hall'], ['b', 'Hall']])
  })
  it('clamps sizes into the allowed range and rounds them', () => {
    const [s] = sanitizeScreens([screen({ kind: 'virtual', width: 99999, height: 10.6 })])
    expect(s.width).toBe(SCREEN_LIMITS.width[1])
    expect(s.height).toBe(SCREEN_LIMITS.height[0])
  })
  it('names blank screens "Screen" and limits names to 40 characters', () => {
    expect(sanitizeScreens([screen({ name: '   ' })])[0].name).toBe('Screen')
    expect(sanitizeScreens([screen({ name: 'n'.repeat(90) })])[0].name).toHaveLength(40)
  })
  it('only display screens carry a display binding', () => {
    const [s] = sanitizeScreens([screen({ kind: 'virtual', displayId: 7, displayLabel: 'LG' })])
    expect(s.displayId).toBeNull()
    expect(s.displayLabel).toBeUndefined()
  })
  it('ignores a non-integer display id', () => expect(sanitizeScreens([screen({ displayId: 1.5 })])[0].displayId).toBeNull())
  it('is idempotent on its own output', () => {
    const once = sanitizeScreens([screen(), screen({ id: 'v', kind: 'virtual', look: { layout: 'lower-third', textBoxOpacity: 0.5 } })])
    expect(sanitizeScreens(once)).toEqual(once)
  })
})

describe('moveById (screen priority order)', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const ids = (l: { id: string }[] | null) => l?.map((x) => x.id)

  it('moves an item up or down one place', () => {
    expect(ids(moveById(list, 'b', -1))).toEqual(['b', 'a', 'c'])
    expect(ids(moveById(list, 'b', 1))).toEqual(['a', 'c', 'b'])
  })
  it('refuses to move past either end, and for an unknown id', () => {
    expect(moveById(list, 'a', -1)).toBeNull()
    expect(moveById(list, 'c', 1)).toBeNull()
    expect(moveById(list, 'zzz', 1)).toBeNull()
    expect(moveById([], 'a', 1)).toBeNull()
  })
  it('leaves the original list untouched', () => {
    moveById(list, 'b', -1)
    expect(ids(list)).toEqual(['a', 'b', 'c'])
  })
  it('survives a save and reload: the order is kept by sanitizeScreens', () => {
    const screens = defaultScreens()
    const reordered = moveById(screens, 'stream', -1)!
    expect(sanitizeScreens(reordered).map((s) => s.id)).toEqual(['stream', 'audience'])
  })
})

describe('LIVE badge setting', () => {
  it('is off by default, kept when on, and ignored when not a boolean', () => {
    expect(defaultLook.liveBadge).toBe(false)
    expect(sanitizeLook({ liveBadge: true }).liveBadge).toBe(true)
    expect(sanitizeLook({ liveBadge: 'yes' }).liveBadge).toBe(false)
  })
})

describe('stage layout', () => {
  it('is accepted as a layout; unknown layouts fall back to full', () => {
    expect(sanitizeLook({ layout: 'stage' }).layout).toBe('stage')
    expect(sanitizeLook({ layout: 'lower-third' }).layout).toBe('lower-third')
    expect(sanitizeLook({ layout: 'sideways' }).layout).toBe('full')
  })
})

describe('mirror screens', () => {
  const base = (id: string, kind: 'display' | 'virtual', extra: object = {}) => ({ id, name: id, kind, displayId: null, width: 1920, height: 1080, look: {}, ...extra })
  it('keeps a display screen that follows an existing, non-mirror screen', () => {
    const out = sanitizeScreens([base('stream', 'virtual'), base('mon', 'display', { mirrorOf: 'stream' })])
    expect(out.find((s) => s.id === 'mon')?.mirrorOf).toBe('stream')
  })
  it('drops a mirror of a missing screen, of itself, of another mirror, or on a virtual screen', () => {
    const out = sanitizeScreens([
      base('stream', 'virtual', { mirrorOf: 'aud' }),
      base('aud', 'display'),
      base('a', 'display', { mirrorOf: 'gone' }),
      base('b', 'display', { mirrorOf: 'b' }),
      base('c', 'display', { mirrorOf: 'd' }),
      base('d', 'display', { mirrorOf: 'aud' }),
    ])
    const m = Object.fromEntries(out.map((s) => [s.id, s.mirrorOf]))
    expect(m).toEqual({ stream: undefined, aud: undefined, a: undefined, b: undefined, c: undefined, d: 'aud' })
  })
})

describe('the level of the video sound for the audience', () => {
  it('starts at full level, not muted', () => {
    expect(defaultLook).toMatchObject({ videoVolumeDb: 0, videoMuted: false })
    expect(sanitizeLook({})).toMatchObject({ videoVolumeDb: 0, videoMuted: false })
  })
  it('keeps a level and the mute through validation', () => {
    expect(sanitizeLook({ videoVolumeDb: -12.5, videoMuted: true })).toMatchObject({ videoVolumeDb: -12.5, videoMuted: true })
  })
  it('can only turn the sound down, and never below -60 dB', () => {
    expect(sanitizeLook({ videoVolumeDb: 12 }).videoVolumeDb).toBe(SCREEN_LIMITS.videoVolumeDb[1])
    expect(sanitizeLook({ videoVolumeDb: -500 }).videoVolumeDb).toBe(SCREEN_LIMITS.videoVolumeDb[0])
  })
  it('replaces wrong types with the defaults, and old saved screens (without them) get the defaults', () => {
    expect(sanitizeLook({ videoVolumeDb: 'loud', videoMuted: 'yes' })).toMatchObject({ videoVolumeDb: 0, videoMuted: false })
    expect(sanitizeLook({ videoVolumeDb: NaN }).videoVolumeDb).toBe(0)
  })
  it('is stable: sanitising a look changes nothing', () => {
    const once = sanitizeLook({ videoVolumeDb: -20, videoMuted: true })
    expect(sanitizeLook(once)).toEqual(once)
  })
})

describe('isBlank', () => {
  const [audience, stream] = defaultScreens()
  const mirror = { ...audience, id: 'copy', mirrorOf: 'audience' }
  const all = [audience, stream, mirror]

  it('is true only for a cleared screen', () => {
    expect(isBlank(all, ['stream'], 'stream')).toBe(true)
    expect(isBlank(all, ['stream'], 'audience')).toBe(false)
    expect(isBlank(all, [], 'stream')).toBe(false)
  })

  it('a mirror is empty with the screen it follows, but clearing the mirror leaves the original', () => {
    expect(isBlank(all, ['audience'], 'copy')).toBe(true)
    expect(isBlank(all, ['copy'], 'audience')).toBe(false)
  })
})

describe('screen roles', () => {
  const [audience] = defaultScreens()
  const stage = { ...audience, id: 'st', look: { ...audience.look, ...STAGE_LOOK } }

  it('tells what a display screen shows', () => {
    expect(roleOf(audience)).toEqual({ kind: 'own' })
    expect(roleOf(stage)).toEqual({ kind: 'stage' })
    expect(roleOf({ ...audience, mirrorOf: 'stream' })).toEqual({ kind: 'mirror', of: 'stream' })
  })

  it('becoming a stage monitor takes the stage look and stops mirroring', () => {
    const p = rolePatch({ kind: 'stage' }, { ...audience, mirrorOf: 'stream' })
    expect(p.mirrorOf).toBe('')
    expect(p.look).toMatchObject({ layout: 'stage', background: '#000', showMedia: false, fontSize: 80 })
  })

  it('leaving the stage view brings back the plain slide look, and keeps other settings', () => {
    const p = rolePatch({ kind: 'own' }, { ...stage, look: { ...stage.look, textColor: '#ff0' } })
    expect(p.look).toMatchObject({ layout: defaultLook.layout, background: defaultLook.background, showMedia: defaultLook.showMedia, fontSize: defaultLook.fontSize, textColor: '#ff0' })
    expect(rolePatch({ kind: 'own' }, audience)).toEqual({ mirrorOf: '' })
  })

  it('a mirror only names its target', () => {
    expect(rolePatch({ kind: 'mirror', of: 'stream' }, audience)).toEqual({ mirrorOf: 'stream' })
  })
})

describe('clampSize', () => {
  it('keeps sizes inside the limits and even', () => {
    expect(clampSize(1921, 1081)).toEqual({ width: 1920, height: 1080 })
    expect(clampSize(10, 99999)).toEqual({ width: 320, height: 4320 })
    expect(clampSize(NaN, 721)).toEqual({ width: 1920, height: 720 })
  })
})

import { describe, expect, it } from 'vitest'
import { NDI_NAME_MAX, ndiLibraryCandidates, ndiLibraryFile, ndiSourceName } from '../src/shared/ndi'
import { hasRoles, isOffscreen, sanitizeScreens } from '../src/shared/screens'
import { safeToRestore } from '../src/shared/session'
import { defaultLook } from '../src/shared/types'

describe('ndiLibraryFile', () => {
  it('uses the names of NDI\'s SDK', () => {
    expect(ndiLibraryFile('darwin', 'arm64')).toBe('libndi.dylib')
    expect(ndiLibraryFile('linux', 'x64')).toBe('libndi.so.6')
    expect(ndiLibraryFile('win32', 'x64')).toBe('Processing.NDI.Lib.x64.dll')
    expect(ndiLibraryFile('win32', 'arm64')).toBe('Processing.NDI.Lib.Arm64.dll')
  })
})

describe('ndiLibraryCandidates', () => {
  const base = { platform: 'darwin', arch: 'arm64', env: {} as Record<string, string | undefined> }
  it('tries the override first, then the one shipped with the app, then the installed runtime', () => {
    const list = ndiLibraryCandidates({ ...base, env: { PRESTREAMER_NDI_LIB: '/x/libndi.dylib', NDI_RUNTIME_DIR_V6: '/rt' }, resourcesPath: '/App/Resources' })
    expect(list.slice(0, 3)).toEqual(['/x/libndi.dylib', '/App/Resources/ndi/libndi.dylib', '/rt/libndi.dylib'])
    expect(list).toContain('/usr/local/lib/libndi.dylib')
  })
  it('looks in vendor/ndi/<os>-<arch> during development, the folder the installers take it from', () => {
    expect(ndiLibraryCandidates({ ...base, projectDir: '/repo' })[0]).toBe('/repo/vendor/ndi/mac-arm64/libndi.dylib')
    expect(ndiLibraryCandidates({ platform: 'win32', arch: 'x64', env: {}, projectDir: 'C:\\repo' })[0]).toBe('C:\\repo\\vendor\\ndi\\win-x64\\Processing.NDI.Lib.x64.dll')
  })
  it('knows the runtime folders of the older NDI versions', () => {
    expect(ndiLibraryCandidates({ ...base, env: { NDI_RUNTIME_DIR_V5: '/v5' } })).toContain('/v5/libndi.dylib')
  })
})

describe('ndiSourceName', () => {
  it('keeps a normal name', () => expect(ndiSourceName('Stage left')).toBe('Stage left'))
  it('removes control characters and trims', () => expect(ndiSourceName('  a\nb\u0000 ')).toBe('a b'))
  it('is never empty and never too long', () => {
    expect(ndiSourceName('   ')).toBe('PreStreamer')
    expect(ndiSourceName('x'.repeat(100))).toHaveLength(NDI_NAME_MAX)
  })
})

describe('NDI screens', () => {
  const ndi = { id: 'n1', name: 'Hall', kind: 'ndi', width: 1280, height: 720, look: { ...defaultLook, layout: 'stage' } }
  it('are kept by sanitizing, with their size and role', () => {
    const [s] = sanitizeScreens([ndi])
    expect(s).toMatchObject({ id: 'n1', kind: 'ndi', width: 1280, height: 720, displayId: null })
    expect(s.look.layout).toBe('stage')
  })
  it('can mirror another screen, like a display, but a virtual screen cannot', () => {
    const screens = sanitizeScreens([{ id: 'v', name: 'Stream', kind: 'virtual', width: 1920, height: 1080, look: defaultLook }, { ...ndi, mirrorOf: 'v' }, { id: 'v2', name: 'V2', kind: 'virtual', width: 1920, height: 1080, mirrorOf: 'v', look: defaultLook }])
    expect(screens.find((s) => s.id === 'n1')?.mirrorOf).toBe('v')
    expect(screens.find((s) => s.id === 'v2')?.mirrorOf).toBeUndefined()
  })
  it('carry the stream sound unless another is chosen, and only NDI screens have the setting', () => {
    const screens = sanitizeScreens([ndi, { ...ndi, id: 'n2', ndiSound: 'none' }, { ...ndi, id: 'n3', ndiSound: 'video' }, { ...ndi, id: 'n4', ndiSound: 'loud' }, { id: 'v', name: 'V', kind: 'virtual', width: 1920, height: 1080, ndiSound: 'video', look: defaultLook }])
    expect(screens.map((s) => s.ndiSound)).toEqual(['stream', 'none', 'video', 'stream', undefined])
  })
  it('read the true/false an early version saved', () => {
    const screens = sanitizeScreens([{ ...ndi, ndiSound: true }, { ...ndi, id: 'n2', ndiSound: false }])
    expect(screens.map((s) => s.ndiSound)).toEqual(['stream', 'none'])
  })
  it('are drawn offscreen and take roles', () => {
    expect(isOffscreen('ndi')).toBe(true)
    expect(isOffscreen('display')).toBe(false)
    expect(hasRoles('ndi')).toBe(true)
    expect(hasRoles('virtual')).toBe(false)
  })
  it('reopen by themselves after a restart: nothing covers the controls', () => {
    expect(safeToRestore(sanitizeScreens([ndi])[0], [])).toBe(true)
  })
})

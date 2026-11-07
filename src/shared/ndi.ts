/**
 * NDI output. A screen of kind 'ndi' is drawn offscreen like a virtual screen and its frames are sent over the network as an NDI
 * source, so a display far from this computer can show it through an NDI decoder. The sending is done by a small helper program
 * (src/native/ndisend.c) that loads NDI's own library at run time; this file holds the parts that need no Electron.
 */

/** The frame rate of an NDI screen. Offscreen windows only paint when something changes, so the sender repeats the last frame at this rate. */
export const NDI_FPS = 30

export const NDI_NAME_MAX = 40

/** Bytes of one raw BGRA frame. */
export const frameBytes = (width: number, height: number): number => width * height * 4

/** The file name of NDI's library on a platform (the SDK's own names). */
export function ndiLibraryFile(platform: string, arch: string): string {
  if (platform === 'win32') return arch === 'arm64' ? 'Processing.NDI.Lib.Arm64.dll' : 'Processing.NDI.Lib.x64.dll'
  if (platform === 'darwin') return 'libndi.dylib'
  return 'libndi.so.6'
}

export interface NdiLibraryWhere {
  platform: string
  arch: string
  env: Record<string, string | undefined>
  /** The `resources` folder of an installed app (where electron-builder puts `extraResources`), if packaged. */
  resourcesPath?: string
  /** The project folder, in development (`vendor/ndi/<mac|win|linux>-<arch>` holds the library there, the same folders the installers take it from). */
  projectDir?: string
}

/**
 * Where to look for NDI's library, best first: an explicit override, the one shipped with the app, then NDI Tools / the NDI
 * Runtime as the user installed it (they set NDI_RUNTIME_DIR_V6 and its older versions, and use the SDK's usual folders).
 */
export function ndiLibraryCandidates(w: NdiLibraryWhere): string[] {
  const file = ndiLibraryFile(w.platform, w.arch)
  const sep = w.platform === 'win32' ? '\\' : '/'
  const join = (...parts: string[]) => parts.join(sep)
  const out: string[] = []
  if (w.env.PRESTREAMER_NDI_LIB) out.push(w.env.PRESTREAMER_NDI_LIB)
  if (w.resourcesPath) out.push(join(w.resourcesPath, 'ndi', file))
  if (w.projectDir) out.push(join(w.projectDir, 'vendor', 'ndi', `${w.platform === 'darwin' ? 'mac' : w.platform === 'win32' ? 'win' : 'linux'}-${w.arch}`, file))
  for (const v of ['V6', 'V5', 'V4']) {
    const dir = w.env[`NDI_RUNTIME_DIR_${v}`]
    if (dir) out.push(join(dir, file))
  }
  if (w.platform === 'darwin') out.push('/usr/local/lib/libndi.dylib', '/Library/NDI SDK for Apple/lib/macOS/libndi.dylib')
  if (w.platform === 'linux') out.push('/usr/lib/libndi.so.6', '/usr/local/lib/libndi.so.6', '/usr/lib/x86_64-linux-gnu/libndi.so.6', '/usr/lib/aarch64-linux-gnu/libndi.so.6')
  return out
}

/** What the operator reads when no NDI library was found. */
export const NDI_MISSING = 'The NDI library was not found. Install the free NDI Tools from ndi.video (or put NDI\'s library in vendor/ndi before building), then open this screen again.'

/** A name for the NDI source: the screen's name, without control characters, within the limit. Never empty. */
export function ndiSourceName(screenName: string): string {
  const clean = screenName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, NDI_NAME_MAX)
  return clean || 'PreStreamer'
}

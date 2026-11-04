// electron-builder afterPack hook: ffprobe-static ships binaries for every platform (~350 MB). Keep only the one
// for the platform/architecture being packaged.
const { existsSync, readdirSync, rmSync } = require('node:fs')
const { join } = require('node:path')

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

exports.default = async function afterPack(context) {
  const platform = context.electronPlatformName
  const arch = ARCH[context.arch]
  const resources = platform === 'darwin' ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : join(context.appOutDir, 'resources')
  // Fail the build, not the user's first stream: a missing bundled ffmpeg would otherwise silently fall back to PATH.
  const ffmpeg = join(resources, 'app.asar.unpacked', 'node_modules', 'ffmpeg-static', platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
  if (!existsSync(ffmpeg)) throw new Error(`bundled ffmpeg is missing at ${ffmpeg} (run: node node_modules/ffmpeg-static/install.js)`)

  const bin = join(resources, 'app.asar.unpacked', 'node_modules', 'ffprobe-static', 'bin')
  if (!existsSync(bin)) throw new Error(`ffprobe-static was not unpacked at ${bin}`)

  for (const p of readdirSync(bin)) {
    if (p !== platform) rmSync(join(bin, p), { recursive: true, force: true })
    else for (const a of readdirSync(join(bin, p))) if (a !== arch) rmSync(join(bin, p, a), { recursive: true, force: true })
  }
  if (!existsSync(join(bin, platform, arch))) throw new Error(`no ffprobe binary for ${platform}/${arch}`) // fail the build, not the user's import
}

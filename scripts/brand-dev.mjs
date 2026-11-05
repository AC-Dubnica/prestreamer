// In development macOS takes the menu-bar and Dock name from the Electron app bundle ("Electron"), not from our code.
// This renames the dev bundle to PreStreamer and gives it the PreStreamer icon (packaged builds already carry both). Safe to run repeatedly;
// does nothing on other platforms.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { ensureElectron } from './electron-path.mjs'

const NAME = 'PreStreamer'
if (process.platform !== 'darwin') process.exit(0)

await ensureElectron() // downloads the binary first if this is a fresh checkout
const require = createRequire(import.meta.url)
const app = join(dirname(require.resolve('electron/package.json')), 'dist', 'Electron.app')
const plist = join(app, 'Contents', 'Info.plist')
if (!existsSync(plist)) process.exit(0)

const here = dirname(new URL(import.meta.url).pathname)
const icon = join(here, '..', 'build', 'icon.icns')
const bundleIcon = join(app, 'Contents', 'Resources', 'electron.icns')
const iconStale = existsSync(icon) && existsSync(bundleIcon) && !readFileSync(icon).equals(readFileSync(bundleIcon))
const current = spawnSync('plutil', ['-extract', 'CFBundleName', 'raw', plist], { encoding: 'utf8' }).stdout.trim()
if (current === NAME && !iconStale) process.exit(0)
if (iconStale) copyFileSync(icon, bundleIcon)

for (const key of ['CFBundleName', 'CFBundleDisplayName']) spawnSync('plutil', ['-replace', key, '-string', NAME, plist])
// Changing the plist invalidates the bundle's signature; re-sign ad hoc so macOS keeps launching it.
const sign = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' })
if (sign.status !== 0) console.warn('Could not re-sign the dev Electron bundle:', sign.stderr.trim())
spawnSync('touch', [app]) // nudge Finder and the Dock to pick up the new icon
console.log(`Dev Electron bundle named ${NAME}, with the PreStreamer icon`)

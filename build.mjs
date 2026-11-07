import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const common = { bundle: true, sourcemap: true, logLevel: 'info' }

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron', 'ffmpeg-static', 'ffprobe-static', 'atem-connection'] }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/audio.ts'], outfile: 'dist/preload/audio.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/pptx.ts'], outfile: 'dist/preload/pptx.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/pdf.ts'], outfile: 'dist/preload/pdf.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/operator.ts', 'src/renderer/output.ts', 'src/renderer/audio.ts', 'src/renderer/pdf-render.ts', 'src/renderer/pptx-render.ts'], outdir: 'dist/renderer', platform: 'browser', format: 'iife' }),
])

mkdirSync('dist/renderer', { recursive: true })
cpSync('src/renderer/operator.html', 'dist/renderer/operator.html')
cpSync('src/renderer/output.html', 'dist/renderer/output.html')
cpSync('src/renderer/audio.html', 'dist/renderer/audio.html')
cpSync('src/renderer/pdf-render.html', 'dist/renderer/pdf-render.html')
cpSync('src/renderer/pptx-render.html', 'dist/renderer/pptx-render.html')
cpSync('src/renderer/pcm-worklet.js', 'dist/renderer/pcm-worklet.js')
cpSync('src/renderer/gate-worklet.js', 'dist/renderer/gate-worklet.js')
cpSync('src/renderer/comp-worklet.js', 'dist/renderer/comp-worklet.js')
cpSync('src/renderer/deesser-worklet.js', 'dist/renderer/deesser-worklet.js')
cpSync('src/renderer/native-in-worklet.js', 'dist/renderer/native-in-worklet.js')

// The programs in src/native, built for the platform this runs on. Each is looked up by main/native-audio.ts and main/ndi.ts at run time.
//  - macOS: avcapture (reads a multichannel interface through CoreAudio; swiftc comes with the Xcode command line tools) and ndisend
//  - Linux: alsacapture (reads one through ALSA; libasound is loaded at run time, so no ALSA headers are needed) and ndisend
//  - Windows: wasapicapture.exe (reads one through WASAPI) with MinGW's gcc, which GitHub's Windows runners have; without a compiler
//    the app still runs and says the reader is missing when a multichannel interface is picked. NDI is not built on Windows yet.
function compile(command, args, { optional = false } = {}) {
  try {
    execFileSync(command, args, { stdio: 'inherit' })
  } catch (err) {
    if (!optional) throw err
    console.warn(`warning: ${command} ${args.join(' ')} failed; that program is left out`)
  }
}
mkdirSync('dist/native', { recursive: true })
if (process.platform === 'darwin') {
  compile('swiftc', ['-O', 'src/native/avcapture.swift', '-o', 'dist/native/avcapture'])
  compile('cc', ['-O2', '-Wall', 'src/native/ndisend.c', '-o', 'dist/native/ndisend'])
} else if (process.platform === 'linux') {
  compile('cc', ['-O2', '-Wall', 'src/native/alsacapture.c', '-o', 'dist/native/alsacapture', '-ldl'])
  compile('cc', ['-O2', '-Wall', 'src/native/ndisend.c', '-o', 'dist/native/ndisend', '-ldl', '-lpthread'])
} else if (process.platform === 'win32') {
  compile('gcc', ['-O2', '-Wall', 'src/native/wasapicapture.c', '-o', 'dist/native/wasapicapture.exe', '-lole32', '-loleaut32', '-luuid'], { optional: true })
}

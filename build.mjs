import { build } from 'esbuild'
import { cpSync, mkdirSync } from 'node:fs'

const common = { bundle: true, sourcemap: true, logLevel: 'info' }

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron', 'ffmpeg-static', 'ffprobe-static'] }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/audio.ts'], outfile: 'dist/preload/audio.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/operator.ts', 'src/renderer/output.ts', 'src/renderer/audio.ts'], outdir: 'dist/renderer', platform: 'browser', format: 'iife' }),
])

mkdirSync('dist/renderer', { recursive: true })
cpSync('src/renderer/operator.html', 'dist/renderer/operator.html')
cpSync('src/renderer/output.html', 'dist/renderer/output.html')
cpSync('src/renderer/audio.html', 'dist/renderer/audio.html')
cpSync('src/renderer/pcm-worklet.js', 'dist/renderer/pcm-worklet.js')
cpSync('src/renderer/gate-worklet.js', 'dist/renderer/gate-worklet.js')
cpSync('src/renderer/comp-worklet.js', 'dist/renderer/comp-worklet.js')

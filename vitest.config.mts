import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // The logic that can run without Electron or audio hardware. UI, windows and the audio graph are
      // covered by the end-to-end scripts (see README), which collect no line coverage.
      include: ['src/shared/**/*.ts', 'src/main/{store,range,media-path,video-plan,playback,streamer,tools,bibles,atem}.ts'],
    },
  },
})

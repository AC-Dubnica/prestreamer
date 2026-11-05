# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

PreStreamer: an Electron + TypeScript presenter and YouTube streamer for church services (macOS and Windows). Own clean-room app. Songs follow Quelea's workflow, the look follows ProPresenter. Developed and run on macOS; Windows builds exist but have not been run.

## Commands

```bash
npm start                      # build, rename the dev Electron bundle to "PreStreamer" (macOS), launch
npm run build                  # esbuild -> dist/ (must be re-run before any e2e script)
npm run typecheck              # tsc --noEmit (there is no linter)
npm test                       # vitest, pure logic only
npx vitest run tests/screens.test.ts          # one test file
npx vitest run -t "mirror screens"            # one test by name
npm run test:coverage
node scripts/e2e-stage.mjs     # one end-to-end script (needs a display, ffmpeg on PATH); `npm run e2e` runs all after a build
npm run package:dir            # unpacked installer for a quick check; `npm run package` for installers
npm version patch && git push --follow-tags   # release: the pushed vX.Y.Z tag runs .github/workflows/release.yml (mac arm64 + Intel, Windows)
```

Node 22+. Development needs `ffmpeg`/`ffprobe` on PATH (`FFMPEG_PATH`/`FFPROBE_PATH` override; installers bundle their own, see `src/main/tools.ts`). macOS has no `timeout` command.

## Architecture

**Processes.** `src/main` (Electron main), `src/preload` (contextBridge, sandboxed), `src/renderer` (pages), `src/shared` (pure logic and types, importable by both). `build.mjs` bundles each entry with esbuild; renderer pages are IIFE bundles and their HTML is copied to `dist/renderer`. A new renderer page or preload therefore needs an entry in `build.mjs` plus a `cpSync` for the HTML.

**Windows.** One operator window (`operator.ts`: tabs Present/Songs/Bible/Mixer/Settings) plus, per screen, an output window (`output.ts`). Virtual screens are offscreen windows whose `paint` frames go to the streamer. Hidden windows do the heavy lifting: the audio engine (`renderer/audio.ts`, Web Audio), PDF pages (`pdf-render.ts`, pdf.js) and `.pptx` slides (`pptx-render.ts`, pptx-preview + `capturePage`). Hidden helper windows get their own preload with a tiny bridge.

**IPC.** Channel names live in the `IPC` const in `shared/types.ts`; each needs a handler in `main/index.ts` and a method in `preload/index.ts` (the `PrestreamerApi` type is derived from it). Main pushes state to renderers (`stateChanged`, `outputUpdate`, `announceState`, ...).

**Screens (`main/screens.ts`, `ScreenManager`).** Owns `ScreenConfig[]` (persisted in `screens.json`), the live windows, the current slide, `next` slide, announcement, `streamLive` and `cameraOnly`. `payloadFor(id)` builds what an output renders; a screen with `mirrorOf` gets the followed screen's look/size (and `videoAudio` forced off). `update()` merges `look` patches field by field, so stale copies in the UI cannot overwrite other settings.

**Slides.** `Slide` (`shared/types.ts`) is text plus optionally `background` (css/image/video), `video` (cue) or `picture` (presentation/picture slide, shown whole above the camera). `SlideView` (`renderer/slideview.ts`) draws everything and is shared by output windows, thumbnails and previews. Layer order, bottom to top: backdrop, live source, video cue, picture, text, stage extras, LIVE badge, announcement. Background precedence: slide's own picture/video, then `look.backgroundMedia`, then css. Camera-only hides backdrop/video/picture/text/announcement. `sameSlide` in `operator.ts` identifies the live slide (label + text + itemId + picture file), so slide labels must stay unique per item. The run sheet's items are song, video, scripture and presentation (pictures reuse `presentation`).

**Streaming.** `main/streamer.ts` pipes raw BGRA frames of the virtual screen to an ffmpeg child process on a paced loop; audio arrives over a loopback TCP socket from `AudioBridge` (`main/audio.ts`), which feeds silence when the mixer is off so the stream never stalls. `-probesize 32 -analyzeduration 0` is essential for start-up. Stats come from `-progress pipe:1` (`shared/stream-stats.ts`). Encoder args come from `shared/stream-settings.ts` plus a hardware-encoder probe (only VideoToolbox verified).

**Mixer.** `shared/mixer.ts` is the model (strips keyed by `stripKey` = device + channel; order in the array is display order only). Every strip and the master has a **chain**: an ordered `Effect[]` (`{id, type}` + the settings of hpf, eq, gate, comp, limiter, deesser, reverb or delay), between the strip's trim and fader (master: `sum` and master fader). Effect ids are stable and unique across the mixer (sanitize keeps them; the engine tells chains apart by id, the meters report gain reduction by id, `MASTER`'s default limiter has the fixed id `master-limiter`); `sanitizeMixer` also converts old files (fixed hpf/eq/gate/comp/limiter fields, `masterLimiter`) into chains. `renderer/effects.ts` makes the nodes of one effect (`Fx`), `renderer/audio.ts` wires a chain with `syncChain` (rewires only when the id order changes; a bypassed effect stays in the graph and passes the signal on, so toggling never clicks) and applies changes live; worklets: `gate`, `compressor` (also the limiter), `deesser` (all channel-count agnostic, linked detection, report gain reduction on their port). The reverb's impulse response is made in `shared/reverb.ts`, not a file. The Mixer tab (`renderer/mixer.ts` draws the chain as cards joined by arrows; `knob.ts`, `mixer-graphs.ts`, curve maths in `shared/curves.ts`) edits it and `main` persists `mixer.json`. Undo/redo is `shared/history.ts` (`History` over JSON snapshots) driven by `mixer.ts`: `commit()` marks a change, and half a second without another one settles it into the history; Cmd/Ctrl+Z is a document keydown listener active on the Mixer tab only (text boxes keep their own undo). A new effect type needs: the config + `RANGES` + `defaultEffect` + `effectParams` in `shared/mixer.ts`, its nodes in `effects.ts`, its card in `effectBody` in `mixer.ts`, and a line in `EFFECT_INFO`. The built-in `app:video` source carries the sound of video cues. The mixer starts by itself when the app opens.

**ATEM.** `shared/atem.ts` is the model (status, commands, address validation, `switchableInputs`); `main/atem.ts` (`AtemController`) keeps the link through `atem-connection` (UDP, Ethernet only; the Mini's USB is a webcam), retries every 8 s, and takes the client through a factory so tests use a fake. Status goes to the operator over `IPC.atemState`; `renderer/atem-panel.ts` shows it in the Present tab, greyed out while `state !== 'connected'`. The library is loaded lazily, runs with `disableMultithreaded` (its worker process cannot start from an asar) and is an esbuild `external`. The address is saved in `atem.json`; with `PRESTREAMER_USER_DATA` set the search is off unless `PRESTREAMER_ATEM=1`.

**Songs and Quelea.** `Song` mirrors Quelea's song so a later import is lossless: a Quelea `<section title=… >` (+ optional `<theme>`, a `$`-separated `key:value` string with `backgroundcolour`/`backgroundimage`/`backgroundvideo`) = one slide (`[title]` + lines), the section's theme background = `slideBackgrounds[i]` (positional, trimmed on Save by `trimSlideBackgrounds`), the song's theme = `background`, and the metadata (`author, copyright, ccli, year, publisher, key, capo, notes`) are optional fields. Visuals live in the song record (saved by the editor's Save, or immediately from the Present tab); service items only reference `songId`. Not mapped yet: `sequence`, translations, `capitalise`, small lines. Quelea's own song XML (`<songs><song><title/><author/><lyrics><section …>`) was read from the format description bundled in Quelea.app (`songformat.xsl`, source in `Resources/src`); never run Quelea. There is no Quelea song import yet.

**Appearance.** `shared/appearance.ts` holds the app-wide look (`appearance.json`, pushed over `IPC.appearanceChanged`): a default background for songs, one for scripture, and the logo. `applyDefaultBackground` fills slides that have no picture/video of their own, applied where the operator builds slides (`songSlides`, `readingOf`, Bible `present`), so precedence is slide > song > app default > screen `backgroundMedia` > colour. The logo is an ordinary picture slide (label `Logo`) shown by the header button / `L`. Deleting a library file runs `forgetAppearanceMedia`.

**Media.** Everything imported lives in `userData/media`, served through the `media://` protocol with HTTP range support (`main/library.ts`). `library.json` names the backgrounds library (`main/media-library.ts`); slide pictures of presentations/pictures use generated names so they stay out of it.

**Persistence.** JSON files in `userData` (`prestreamer` folder): songs, services, screens, mixer, stream settings, session (`shared/session.ts`: window bounds, open screens), `bibles/`, `media/`. Session restore never reopens a full-screen output on the main display and never starts a stream.

## Testing conventions

- Put logic that does not need Electron in `src/shared` (or the few pure `src/main` modules listed in `vitest.config.mts`) and unit-test it in `tests/`.
- UI and windows are verified by `scripts/e2e-*.mjs`: each launches the real app with env-var **dev hooks** (`src/main/devhooks.ts`, documented at the top of that file: `PRESTREAMER_EVAL`, `_SNAPSHOT`, `_STREAMTEST`, `_NO_AUTO_OPEN`, `_PRESENTATION_FILE`, `_MEDIA_FILE`, ...), runs JS in the operator window and prints PASS/FAIL lines. Native file dialogs are replaced by env vars.
- Always run e2e with `PRESTREAMER_USER_DATA` pointing at a scratch folder (the scripts do, and delete it first); this also disables the Quelea auto-import.
- The snapshot/stream hooks keep windows `alwaysOnTop` because macOS stops painting occluded windows.
- Scripts that execute JS in the page: a line starting with `[` after a statement without `;` is joined to it. Don't dispatch key events on `window` (the handler calls `e.target.matches`), use `document.body`.

## Constraints

- Company policy forbids running Quelea.app; its Bible/song files are only read.
- Never store a YouTube stream key anywhere or stream with one without being told to; tests stream to a local file or a local RTMP server (`PRESTREAMER_RTMP_URL`).
- Don't use `pkill -f` patterns (they can kill the user's running app).
- Commit and push only when asked.
- Not verified: running the app on Windows, a real YouTube stream, Behringer Wing/ATEM hardware, Keynote/PowerPoint fallback import on macOS, signed builds. GitHub Actions work (`ci.yml` unit tests, `release.yml` published v0.1.0); the e2e jobs in CI are non-blocking.

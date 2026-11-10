# TODO: what is missing

What is not built, not yet verified with real equipment, or left for later. The state is as of the latest work; `CLAUDE.md` and the README table of what is tested hold the detail.

Tested by hand on macOS with real equipment: a Behringer Wing (32 channels), an ATEM switcher, Keynote and PowerPoint import. Everything else listed under "Not verified" has only run in simulation or not at all.

## Not verified with real equipment

- **YouTube broadcast control** (Settings → YouTube, the Present tab's broadcast buttons): runs against a simulated YouTube only. Try it with a private test broadcast: sign-in, the preview step (`testing`), going live, ending, and reconnecting after a dropped connection. The Google Cloud app in Testing mode signs out every 7 days.
- **A real YouTube stream** from the normal stream-key path.
- **DMX**: a real Enttec Open DMX USB interface and lights (the helper was only run into a file). Windows has no DMX sender.
- **NDI**: real receivers. Windows has no NDI sender.
- **Hardware video encoders** other than Apple's VideoToolbox: NVENC, Quick Sync, AMF. Whether the ffmpeg bundled in the Windows and Linux installers has them is unchecked.
- **Windows and Linux**: the app has never been run there; the Linux and Windows audio capture programs are compiled but not run against a device.
- **Slovak interface**: looked at in the screenshots (no overflow found); not used by a Slovak speaker for a service yet. The built-in mixer source "Video playback (stereo)" keeps its English name (it is saved with the strips).
- **LibreOffice** fallback for presentations; very complex decks (rendering is an approximation).
- **Signed builds** (macOS notarising, Windows signing).

## Not translated or not done for the guide

- Two pictures are not made by `scripts/screenshots.mjs` and stay English in the Slovak guide: `announce-stream.png` and `lower-third.png`.
- Not translated: the OS application menu, errors of the hidden PDF and PPTX renderers, the guide's English-only developer notes.
- No pictures yet of the YouTube panel while previewing or live (the pictures show it before the start).

## Features not built

### YouTube
- Creating a broadcast from the app (title, privacy, schedule, thumbnail); today it only runs one scheduled in YouTube Studio.
- Viewer count and stream health from YouTube in the panel.
- A plain sign-in that does not expire weekly (needs Google's verification of the app).

### Chords
- Quelea export drops chord lines (slides carry only the lyrics).
- Importing a chord-sheet PDF throws chords away (the library's chords were added with a one-off script).
- Transposing, capo handling, a printable or on-screen chord sheet for the band.
- A line of only chord-like letters (a lone "A") counts as a chord line and is hidden from the slide.
- Three songs only partly got their chords: *Majak*, *Narodený*, *Stalo se to*. Add the missing chord lines by hand.

### DMX
- Scenes tied to run-sheet items, chases, several universes, Art-Net and sACN.

### Songs and Quelea
- Quelea details not mapped: sequence, translations, capitalise, small lines.

### Platforms
- NDI and DMX senders for Windows.
- VAAPI (Intel and AMD GPUs) as a hardware encoder on Linux.

## Small things

- Reconnecting after a dropped connection only covers a stream that was started from the broadcast panel; a stream started with the plain stream-key button does not come back by itself.

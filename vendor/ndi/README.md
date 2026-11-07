# NDI library

PreStreamer sends NDI by loading NDI's own library at run time. It is **not** part of this repository's source and is covered by
NDI's licence, not ours. To ship it inside the installers:

1. Download the NDI SDK from https://ndi.video/for-developers/ndi-sdk/ and accept its licence (you must do this yourself).
2. Copy the redistributable library for each platform into its folder here:

   | Folder | File |
   |---|---|
   | `mac-arm64`, `mac-x64` | `libndi.dylib` (SDK: `lib/macOS/libndi.dylib`; a universal file works in both) |
   | `win-x64` | `Processing.NDI.Lib.x64.dll` (SDK: `Bin/x64`) |
   | `win-arm64` | `Processing.NDI.Lib.Arm64.dll` |
   | `linux-x64`, `linux-arm64` | `libndi.so.6` (SDK: `lib/<arch>`; keep the real file under that name) |

3. Build the installers as usual (`npm run package`). electron-builder copies the file for the target into `resources/ndi`.

Without a file here the app falls back to NDI Tools / the NDI Runtime installed on the computer (`NDI_RUNTIME_DIR_V6`,
`/usr/local/lib`, ...), and `PRESTREAMER_NDI_LIB=/path/to/libndi` overrides both.

The NDI SDK's licence asks for its attribution: "NDI® is a registered trademark of Vizrt Group." (it is in the README of the app).
The NDI sender here is only built on macOS and Linux so far.

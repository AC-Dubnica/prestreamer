import type { PrestreamerApi } from '../preload'
import type { OutputPayload, PlaybackState } from '../shared/types'
import { SlideView } from './slideview'

declare const prestreamer: PrestreamerApi

const view = new SlideView()
document.body.append(view.root)

let last: OutputPayload | null = null

function render(p: OutputPayload): void {
  last = p
  view.render(p.screen.look, p.slide, window.innerWidth, window.innerHeight, { liveVideo: true, audioAllowed: true })
  view.setPlayback(p.playback)
}

window.addEventListener('resize', () => last && render(last))

const screenId = new URLSearchParams(location.search).get('screenId')!

prestreamer.onPlayback((st: PlaybackState) => view.setPlayback(st))
// Report the video position so drift between screens can be observed.
setInterval(() => {
  const pos = view.videoPosition()
  if (pos !== null) prestreamer.playbackReport(screenId, pos)
}, 500)
prestreamer.outputInit(screenId).then((p) => p && render(p))
prestreamer.onOutputUpdate(render)

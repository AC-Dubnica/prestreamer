import type { PrestreamerApi } from '../preload'
import { appliesTo, type Announcement } from '../shared/announce'
import type { OutputPayload, PlaybackState } from '../shared/types'
import { SlideView } from './slideview'

declare const prestreamer: PrestreamerApi

const view = new SlideView()
document.body.append(view.root)

let last: OutputPayload | null = null
let announcement: Announcement | null = null
const screenId = new URLSearchParams(location.search).get('screenId')!
/** Only the screens the announcement is aimed at show it. */
// A mirror shows what the screen it follows shows, so an announcement aimed at that screen shows here too.
const applyAnnouncement = () => view.setAnnouncement(appliesTo(announcement, last?.screen.id ?? screenId) ? announcement : null)

function render(p: OutputPayload): void {
  last = p
  view.render(p.screen.look, p.slide, window.innerWidth, window.innerHeight, { liveVideo: true, audioAllowed: true, cameraOnly: p.cameraOnly })
  view.setPlayback(p.playback)
  announcement = p.announcement
  view.setStreamLive(p.streamLive)
  view.setNext(p.next)
  applyAnnouncement()
}

window.addEventListener('resize', () => last && render(last))

prestreamer.onAnnouncement((a) => { announcement = a; applyAnnouncement() })
prestreamer.onPlayback((st: PlaybackState) => view.setPlayback(st))
// Report the video position so drift between screens can be observed.
setInterval(() => {
  const pos = view.videoPosition()
  if (pos !== null) prestreamer.playbackReport(screenId, pos)
}, 500)
prestreamer.outputInit(screenId).then((p) => p && render(p))
prestreamer.onOutputUpdate(render)

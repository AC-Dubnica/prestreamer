import { mediaUrl, type Background, type Look, type PlaybackState, type Slide, type VideoSource } from '../shared/types'

/** Reference height that `Look.fontSize` is authored against; text scales with output height. */
const REFERENCE_HEIGHT = 1080

export interface RenderOptions {
  /** Run camera / animated sources. Static thumbnails pass false to stay cheap. */
  liveVideo?: boolean
  /** Only real output windows may play video sound; operator previews are always silent. */
  audioAllowed?: boolean
}

/**
 * Renders a slide with a screen's look into a fixed-size stage (baseW × baseH).
 * Used both by real output windows (scale 1) and by scaled previews in the operator,
 * so what the operator sees is rendered by the same code as what the audience sees.
 */
export class SlideView {
  readonly root = document.createElement('div')
  private readonly backdrop = document.createElement('div')
  private readonly media = document.createElement('div')
  private readonly videoLayer = document.createElement('div')
  private readonly content = document.createElement('div')
  private readonly label = document.createElement('div')
  private readonly text = document.createElement('div')
  private sourceKey = ''
  private backdropKey = ''
  private videoKey = ''
  private video: HTMLVideoElement | null = null
  private videoFile = ''
  private playback: PlaybackState | null = null
  private syncTimer: ReturnType<typeof setInterval> | null = null
  private stopSource: () => void = () => {}

  constructor() {
    Object.assign(this.root.style, {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      textAlign: 'center',
      fontFamily: 'system-ui, sans-serif',
      boxSizing: 'border-box',
      overflow: 'hidden',
    })
    Object.assign(this.backdrop.style, { position: 'absolute', inset: '0' })
    Object.assign(this.media.style, { position: 'absolute', inset: '0' })
    Object.assign(this.videoLayer.style, { position: 'absolute', inset: '0', background: '#000' })
    this.videoLayer.hidden = true
    Object.assign(this.content.style, { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' })
    Object.assign(this.label.style, { opacity: '.6', fontSize: '.4em', marginBottom: '.5em', textTransform: 'uppercase', letterSpacing: '.1em' })
    Object.assign(this.text.style, { whiteSpace: 'pre-wrap', lineHeight: '1.25', textShadow: '0 2px 12px rgba(0,0,0,.6)' })
    this.content.append(this.label, this.text)
    this.root.append(this.backdrop, this.media, this.videoLayer, this.content)
  }

  render(look: Look, slide: Slide | null, baseW: number, baseH: number, opts: RenderOptions = { liveVideo: true }): void {
    const s = this.root.style
    s.width = `${baseW}px`
    s.height = `${baseH}px`
    s.padding = `${baseW * 0.04}px`
    s.background = look.background
    s.color = look.textColor
    s.fontSize = `${(look.fontSize * baseH) / REFERENCE_HEIGHT}px`
    this.label.textContent = look.showLabel && slide ? slide.label : ''
    this.text.textContent = slide?.text ?? ''
    const live = opts.liveVideo !== false
    this.setBackdrop(look.showMedia ? (slide?.background ?? null) : null, live)
    this.setSource(look.source, live)
    this.setVideo(slide?.video ?? null, look, live, opts.audioAllowed === true)
  }

  dispose(): void {
    this.teardownVideo()
    this.stopSource()
    this.media.replaceChildren()
    this.backdrop.replaceChildren()
    this.sourceKey = ''
    this.backdropKey = ''
    this.videoKey = ''
  }

  /** Latest shared clock; the video follows it (see applyPlayback). */
  setPlayback(state: PlaybackState): void {
    this.playback = state
    this.applyPlayback()
  }

  /** Current video position in seconds, or null when no video is showing. */
  videoPosition(): number | null {
    return this.video ? this.video.currentTime : null
  }

  private teardownVideo(): void {
    if (this.syncTimer) clearInterval(this.syncTimer)
    this.syncTimer = null
    if (this.video) {
      this.video.pause()
      this.video.removeAttribute('src')
      this.video.load() // releases the decoder
    }
    this.video = null
    this.videoFile = ''
    this.videoLayer.replaceChildren()
    this.videoLayer.hidden = true
  }

  /** Full-screen video cue. Thumbnails get a marker, and only the sound-enabled output window is unmuted. */
  private setVideo(cue: Slide['video'] | null, look: Look, live: boolean, audioAllowed: boolean): void {
    const sound = audioAllowed && look.videoAudio
    const key = `${cue?.file ?? ''}|${live}|${sound}|${look.audioOutput}`
    if (key === this.videoKey) return
    this.videoKey = key
    this.teardownVideo()
    this.content.style.visibility = cue ? 'hidden' : 'visible'
    if (!cue) return

    this.videoLayer.hidden = false
    if (!live) {
      const mark = document.createElement('div')
      Object.assign(mark.style, { ...fill, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: '90px', textAlign: 'center', padding: '40px' })
      mark.textContent = `▶ ${cue.title}`
      this.videoLayer.append(mark)
      return
    }
    const v = document.createElement('video')
    v.src = mediaUrl(cue.file)
    v.preload = 'auto'
    v.playsInline = true
    v.muted = !sound
    Object.assign(v.style, { ...fill, objectFit: 'contain' })
    if (sound && look.audioOutput && 'setSinkId' in v) void (v as HTMLVideoElement & { setSinkId(id: string): Promise<void> }).setSinkId(look.audioOutput).catch(() => {})
    this.videoLayer.append(v)
    this.video = v
    this.videoFile = cue.file
    this.syncTimer = setInterval(() => this.applyPlayback(), 300) // also corrects drift while playing
    this.applyPlayback()
  }

  /** Follow the shared clock: seek when off by more than a quarter second, then play or pause. */
  private applyPlayback(): void {
    const v = this.video
    const st = this.playback
    if (!v || !st || st.file !== this.videoFile) return
    const expected = st.playing ? Math.min(st.durationSec, st.positionSec + (Date.now() - st.atMs) / 1000) : st.positionSec
    if (Math.abs(v.currentTime - expected) > (st.playing ? 0.25 : 0.05)) v.currentTime = expected
    if (st.playing && v.paused && expected < st.durationSec) void v.play().catch(() => {})
    else if (!st.playing && !v.paused) v.pause()
  }

  /** Slide background under the live source and text. Only rebuilt when it actually changes. */
  private setBackdrop(bg: Background | null, live: boolean): void {
    const key = `${JSON.stringify(bg)}|${live}`
    if (key === this.backdropKey) return
    this.backdropKey = key
    this.backdrop.replaceChildren()
    this.backdrop.style.background = ''
    if (!bg) return
    if (bg.kind === 'css') {
      this.backdrop.style.background = bg.css
    } else if (bg.kind === 'image') {
      this.backdrop.append(Object.assign(document.createElement('img'), { src: mediaUrl(bg.file) }))
      Object.assign((this.backdrop.firstChild as HTMLElement).style, fill)
    } else if (live) {
      const video = document.createElement('video')
      video.src = mediaUrl(bg.file)
      video.muted = true
      video.loop = true
      video.autoplay = true
      video.playsInline = true
      Object.assign(video.style, fill)
      this.backdrop.append(video)
    } else {
      // A <video> per thumbnail is too heavy; show a marker instead.
      const mark = document.createElement('div')
      Object.assign(mark.style, { ...fill, background: '#1f2937', color: '#6b7280', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '80px' })
      mark.textContent = '▶ video'
      this.backdrop.append(mark)
    }
  }

  private setSource(source: VideoSource, live: boolean): void {
    const key = `${JSON.stringify(source)}|${live}`
    if (key === this.sourceKey) return
    // Only the live-source layer: the slide backdrop is managed by setBackdrop.
    this.stopSource()
    this.stopSource = () => {}
    this.media.replaceChildren()
    this.sourceKey = key
    if (source.type === 'testpattern') this.stopSource = mountTestPattern(this.media, live)
    else if (source.type === 'camera') this.stopSource = mountCamera(this.media, source, live)
  }
}

const fill = { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'cover' } as const

/** Stand-in for a camera / ATEM feed: colour bars, a moving marker and a running clock. */
function mountTestPattern(host: HTMLElement, animate: boolean): () => void {
  const canvas = document.createElement('canvas')
  canvas.width = 1280
  canvas.height = 720
  Object.assign(canvas.style, fill)
  host.append(canvas)
  const ctx = canvas.getContext('2d')!
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']

  const draw = (t: number) => {
    const w = canvas.width
    const h = canvas.height
    bars.forEach((c, i) => {
      ctx.fillStyle = c
      ctx.fillRect((i * w) / bars.length, 0, w / bars.length + 1, h * 0.7)
    })
    ctx.fillStyle = '#101010'
    ctx.fillRect(0, h * 0.7, w, h * 0.3)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(((t / 4) % (w - 80)), h * 0.75, 80, 80)
    ctx.font = '600 44px system-ui, sans-serif'
    ctx.fillStyle = '#ffffff'
    ctx.fillText(`SIMULATED CAMERA  ${new Date().toISOString().slice(11, 23)}`, 40, h * 0.95)
    // Full-frame flash at the start of each wall-clock second; the audio test beep fires at the same instants.
    if (Date.now() % 1000 < 100) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, w, h)
    }
  }

  let stopped = false
  const loop = (t: number) => {
    if (stopped) return
    draw(t)
    requestAnimationFrame(loop)
  }
  if (animate) requestAnimationFrame(loop)
  else draw(0)
  return () => { stopped = true }
}

function mountCamera(host: HTMLElement, source: Extract<VideoSource, { type: 'camera' }>, live: boolean): () => void {
  if (!live) {
    const ph = document.createElement('div')
    Object.assign(ph.style, { ...fill, background: '#222', color: '#888', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '28px' })
    ph.textContent = `camera: ${source.label}`
    host.append(ph)
    return () => {}
  }
  const video = document.createElement('video')
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  Object.assign(video.style, fill)
  host.append(video)

  let stream: MediaStream | null = null
  let stopped = false
  navigator.mediaDevices
    .getUserMedia({ video: { deviceId: { exact: source.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } })
    .then((s) => {
      if (stopped) return s.getTracks().forEach((t) => t.stop())
      stream = s
      video.srcObject = s
    })
    .catch((err: Error) => {
      video.replaceWith(Object.assign(document.createElement('div'), { textContent: `camera error: ${err.message}` }))
    })
  return () => {
    stopped = true
    stream?.getTracks().forEach((t) => t.stop())
  }
}

export interface ScaledPreview {
  box: HTMLElement
  update(look: Look, slide: Slide | null, baseW: number, baseH: number, liveVideo?: boolean): void
  setPlayback(state: PlaybackState): void
  dispose(): void
}

/** A responsive box that shows a SlideView scaled down to the box's width. */
export function scaledPreview(): ScaledPreview {
  const box = document.createElement('div')
  Object.assign(box.style, { position: 'relative', overflow: 'hidden', width: '100%', background: '#000' })
  const view = new SlideView()
  Object.assign(view.root.style, { position: 'absolute', left: '0', top: '0', transformOrigin: '0 0' })
  box.append(view.root)

  let baseW = 1920
  const applyScale = () => {
    if (box.clientWidth) view.root.style.transform = `scale(${box.clientWidth / baseW})`
  }
  const observer = new ResizeObserver(applyScale)
  observer.observe(box)

  return {
    box,
    update(look, slide, w, h, liveVideo = false) {
      baseW = w
      box.style.aspectRatio = `${w} / ${h}`
      view.render(look, slide, w, h, { liveVideo, audioAllowed: false })
      applyScale()
    },
    setPlayback: (state) => view.setPlayback(state),
    dispose() {
      observer.disconnect()
      view.dispose()
    },
  }
}

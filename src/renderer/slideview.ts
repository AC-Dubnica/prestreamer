import { TONE_COLORS, announceFontPx, type Announcement } from '../shared/announce'
import { mediaUrl, type Background, type Look, type PlaybackState, type Slide, type VideoSource } from '../shared/types'

/** Reference height that `Look.fontSize` is authored against; text scales with output height. */
const REFERENCE_HEIGHT = 1080

export interface RenderOptions {
  /** Run camera / animated sources. Static thumbnails pass false to stay cheap. */
  liveVideo?: boolean
  /** Only real output windows may play video sound; operator previews are always silent. */
  audioAllowed?: boolean
  /** Show only the live source (the stream's camera-only mode). */
  cameraOnly?: boolean
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
  private readonly pictureLayer = document.createElement('div')
  private pictureFile = ''
  private readonly announceLayer = document.createElement('div')
  private readonly liveBadge = document.createElement('div')
  private readonly stageClock = document.createElement('div')
  private readonly stageNext = document.createElement('div')
  private clockTimer: ReturnType<typeof setInterval> | null = null
  private nextSlide: Slide | null = null
  private stage = false
  private cameraOnlyOn = false
  private hasText = false
  private streamLive = false
  private badgeWanted = false
  private readonly content = document.createElement('div')
  private readonly label = document.createElement('div')
  private readonly text = document.createElement('div')
  private sourceKey = ''
  private backdropKey = ''
  private videoKey = ''
  private announcement: Announcement | null = null
  private lastW = 1920
  private lastH = 1080
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
    // A presentation slide: the whole picture on black (never cropped), above the camera, below text and announcements.
    Object.assign(this.pictureLayer.style, { position: 'absolute', inset: '0', background: '#000' })
    this.pictureLayer.hidden = true
    // The announcement sits above everything and ignores the mouse: it never changes what is underneath.
    Object.assign(this.announceLayer.style, { position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '10' })
    this.announceLayer.dataset.announcement = ''
    this.announceLayer.hidden = true
    Object.assign(this.content.style, { position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' })
    Object.assign(this.label.style, { opacity: '.6', fontSize: '.4em', marginBottom: '.5em', textTransform: 'uppercase', letterSpacing: '.1em' })
    Object.assign(this.text.style, { whiteSpace: 'pre-wrap', lineHeight: '1.25', textShadow: '0 2px 12px rgba(0,0,0,.6)' })
    this.content.dataset.slideText = ''
    this.content.append(this.label, this.text)
    // A small "LIVE" pill in the corner, below the announcement. Ignores the mouse like the announcement does.
    Object.assign(this.liveBadge.style, {
      position: 'absolute', zIndex: '9', pointerEvents: 'none', display: 'flex', alignItems: 'center', gap: '0.45em',
      background: 'rgba(200,20,20,.92)', color: '#fff', fontWeight: '800', letterSpacing: '.12em', borderRadius: '0.4em', boxShadow: '0 2px 10px rgba(0,0,0,.4)',
    })
    this.liveBadge.dataset.liveBadge = ''
    this.liveBadge.hidden = true
    // Stage monitor extras: the clock and the "next" box are only shown by the 'stage' layout.
    Object.assign(this.stageClock.style, { position: 'absolute', fontWeight: '700', fontVariantNumeric: 'tabular-nums', opacity: '.85' })
    Object.assign(this.stageNext.style, { position: 'absolute', textAlign: 'left', whiteSpace: 'pre-wrap', lineHeight: '1.25', borderTop: '2px solid rgba(255,255,255,.25)', paddingTop: '0.5em', overflow: 'hidden', color: '#cbd5e1' })
    this.stageClock.dataset.stageClock = ''
    this.stageNext.dataset.stageNext = ''
    this.stageClock.hidden = true
    this.stageNext.hidden = true
    this.root.append(this.backdrop, this.media, this.videoLayer, this.pictureLayer, this.content, this.stageClock, this.stageNext, this.liveBadge, this.announceLayer)
  }

  render(look: Look, slide: Slide | null, baseW: number, baseH: number, opts: RenderOptions = { liveVideo: true }): void {
    this.lastW = baseW
    this.lastH = baseH
    const s = this.root.style
    s.width = `${baseW}px`
    s.height = `${baseH}px`
    s.padding = `${baseW * 0.04}px`
    s.background = opts.cameraOnly ? '#000' : look.background
    s.color = look.textColor
    s.fontSize = `${(look.fontSize * baseH) / REFERENCE_HEIGHT}px`
    // Layout: centred, or a caption bar along the bottom (for text over live video). An optional dark box keeps
    // text readable on top of camera pictures.
    const lower = look.layout === 'lower-third'
    const stage = look.layout === 'stage'
    this.stage = stage
    const boxed = look.textBoxOpacity > 0
    s.justifyContent = lower ? 'flex-end' : 'center'
    s.alignItems = stage ? 'stretch' : 'center'
    s.textAlign = stage ? 'left' : 'center'
    if (stage) s.background = '#000' // a stage monitor is always high-contrast on black
    Object.assign(this.content.style, {
      width: lower || stage ? '100%' : 'auto',
      alignItems: stage ? 'flex-start' : 'center',
      marginBottom: lower ? `${baseH * 0.04}px` : stage ? `${baseH * 0.26}px` : '0',
      padding: boxed ? '0.3em 0.7em' : '0',
      borderRadius: boxed ? '0.25em' : '0',
      background: boxed ? `rgba(0,0,0,${look.textBoxOpacity})` : 'transparent',
      boxSizing: 'border-box',
    })
    this.label.textContent = (look.showLabel || stage) && slide ? slide.label : ''
    // The stage monitor never plays the video: it says what is on and shows the clock.
    this.text.textContent = stage && slide?.video ? `▶ ${slide.video.title}` : stage && slide?.picture ? slide.label : slide?.text ?? ''
    this.hasText = this.text.textContent.trim() !== ''
    this.syncContent()
    const live = opts.liveVideo !== false
    // A picture or video: the slide's own first, then the screen's, then a colour the slide brings. Stage monitors stay plain.
    const own = slide?.background ?? null
    const wanted = own && own.kind !== 'css' ? own : look.backgroundMedia ?? own
    this.setBackdrop(look.showMedia && !stage ? wanted : null, live)
    this.setSource(stage ? { type: 'none' } : look.source, live)
    this.setVideo(stage ? null : slide?.video ?? null, look, live, opts.audioAllowed === true)
    this.setPicture(stage ? null : slide?.picture?.file ?? null)
    this.drawStage()
    this.setCameraOnly(opts.cameraOnly === true)
    this.badgeWanted = look.liveBadge
    this.drawBadge()
    this.drawAnnouncement(false) // the screen may have been resized
  }

  private setPicture(file: string | null): void {
    if ((file ?? '') === this.pictureFile) return
    this.pictureFile = file ?? ''
    this.pictureLayer.hidden = !file
    if (!file) return this.pictureLayer.replaceChildren()
    const img = document.createElement('img')
    img.src = mediaUrl(file)
    Object.assign(img.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', objectFit: 'contain' })
    this.pictureLayer.replaceChildren(img)
  }

  /** The slide that comes after this one, for the stage monitor. */
  setNext(slide: Slide | null): void {
    this.nextSlide = slide
    this.drawStage()
  }

  private drawStage(): void {
    const on = this.stage
    this.stageClock.hidden = !on
    this.stageNext.hidden = !on
    if (!on) {
      if (this.clockTimer) clearInterval(this.clockTimer)
      this.clockTimer = null
      return
    }
    const H = this.lastH
    const W = this.lastW
    const tick = () => { this.stageClock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
    tick()
    if (!this.clockTimer) this.clockTimer = setInterval(tick, 1000)
    Object.assign(this.stageClock.style, { top: `${H * 0.03}px`, right: `${W * 0.04}px`, fontSize: `${H * 0.07}px` })
    const tag = document.createElement('div')
    tag.textContent = 'NEXT'
    Object.assign(tag.style, { fontSize: '.6em', letterSpacing: '.12em', fontWeight: '800', opacity: '.6', marginBottom: '.2em' })
    const body = document.createElement('div')
    body.textContent = this.nextSlide ? (this.nextSlide.video ? `▶ ${this.nextSlide.video.title}` : this.nextSlide.picture ? this.nextSlide.label : this.nextSlide.text) : 'End of the list'
    if (!this.nextSlide) body.style.opacity = '.5'
    this.stageNext.replaceChildren(tag, body)
    Object.assign(this.stageNext.style, { left: `${W * 0.04}px`, right: `${W * 0.04}px`, bottom: `${H * 0.03}px`, height: `${H * 0.22}px`, fontSize: `${H * 0.05}px` })
  }

  /** Camera-only: hides everything except the live source layer (text, slide media, cue videos and announcements). */
  private setCameraOnly(on: boolean): void {
    for (const layer of [this.backdrop, this.videoLayer, this.pictureLayer, this.announceLayer]) layer.style.display = on ? 'none' : ''
    this.cameraOnlyOn = on
    this.syncContent()
  }

  /** The text block is only there when there is something to say: an empty one would leave its dark box on screen. */
  private syncContent(): void {
    this.content.style.display = this.cameraOnlyOn || !this.hasText ? 'none' : 'flex'
  }

  /** Whether the stream is on air; the badge shows only on screens whose look asks for it. */
  setStreamLive(live: boolean): void {
    this.streamLive = live
    this.drawBadge()
  }

  private drawBadge(): void {
    const b = this.liveBadge
    b.hidden = !(this.badgeWanted && this.streamLive)
    if (b.hidden) return
    const px = this.lastH * 0.035
    const dot = document.createElement('span')
    Object.assign(dot.style, { width: '0.6em', height: '0.6em', borderRadius: '50%', background: '#fff' })
    b.replaceChildren(dot, document.createTextNode('LIVE'))
    Object.assign(b.style, { top: `${this.lastH * 0.03}px`, right: `${this.lastH * 0.03}px`, fontSize: `${px}px`, padding: '0.3em 0.7em' })
  }

  dispose(): void {
    if (this.clockTimer) clearInterval(this.clockTimer)
    this.clockTimer = null
    this.teardownVideo()
    this.stopSource()
    this.media.replaceChildren()
    this.backdrop.replaceChildren()
    this.sourceKey = ''
    this.backdropKey = ''
    this.videoKey = ''
  }

  /** Puts a live announcement over everything (or removes it). Pass null for screens it does not apply to. */
  setAnnouncement(a: Announcement | null): void {
    const isNew = a?.id !== this.announcement?.id
    this.announcement = a
    this.drawAnnouncement(isNew)
  }

  private drawAnnouncement(animate: boolean): void {
    const a = this.announcement
    const layer = this.announceLayer
    if (!a) {
      layer.hidden = true
      layer.replaceChildren()
      return
    }
    const W = this.lastW
    const H = this.lastH
    const box = document.createElement('div')
    box.textContent = a.text
    Object.assign(box.style, {
      position: 'absolute',
      background: TONE_COLORS[a.tone],
      color: '#fff',
      fontFamily: 'system-ui, sans-serif',
      fontWeight: '800',
      lineHeight: '1.2',
      textAlign: 'center',
      whiteSpace: 'pre-wrap',
      textShadow: '0 2px 8px rgba(0,0,0,.35)',
      fontSize: `${announceFontPx(a.text, a.style, H)}px`,
      boxSizing: 'border-box',
    })
    if (a.style === 'fullscreen') {
      Object.assign(box.style, { inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `${H * 0.06}px ${W * 0.06}px` })
    } else {
      Object.assign(box.style, { left: '0', right: '0', [a.style === 'banner-top' ? 'top' : 'bottom']: '0', padding: `${H * 0.025}px ${W * 0.04}px`, boxShadow: '0 0 24px rgba(0,0,0,.45)' })
    }
    layer.replaceChildren(box)
    layer.hidden = false
    if (animate && typeof box.animate === 'function') box.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 }) // appears at once, just not abruptly
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
    // The level and the mute follow the settings at once, without restarting the video.
    if (this.video) this.applyLevel(this.video, look, sound)
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
    this.applyLevel(v, look, sound)
    Object.assign(v.style, { ...fill, objectFit: 'contain' })
    if (sound && look.audioOutput && 'setSinkId' in v) void (v as HTMLVideoElement & { setSinkId(id: string): Promise<void> }).setSinkId(look.audioOutput).catch(() => {})
    this.videoLayer.append(v)
    this.video = v
    this.videoFile = cue.file
    this.syncTimer = setInterval(() => this.applyPlayback(), 300) // also corrects drift while playing
    this.applyPlayback()
  }

  /** The sound of a video cue: off unless this window is the one that plays it, otherwise at the level set for the audience. */
  private applyLevel(v: HTMLVideoElement, look: Look, sound: boolean): void {
    v.muted = !sound || look.videoMuted
    v.volume = Math.min(1, Math.max(0, 10 ** (look.videoVolumeDb / 20)))
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
      // A thumbnail shows one still frame of the video: metadata only, paused, never playing (a playing video per thumbnail is too heavy).
      const still = document.createElement('video')
      still.src = `${mediaUrl(bg.file)}#t=0.5`
      still.muted = true
      still.preload = 'metadata'
      still.playsInline = true
      Object.assign(still.style, fill, { pointerEvents: 'none' })
      this.backdrop.append(still)
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
  update(look: Look, slide: Slide | null, baseW: number, baseH: number, liveVideo?: boolean, cameraOnly?: boolean): void
  setPlayback(state: PlaybackState): void
  setAnnouncement(a: Announcement | null): void
  setStreamLive(live: boolean): void
  setNext(slide: Slide | null): void
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
    update(look, slide, w, h, liveVideo = false, cameraOnly = false) {
      baseW = w
      box.style.aspectRatio = `${w} / ${h}`
      view.render(look, slide, w, h, { liveVideo, audioAllowed: false, cameraOnly })
      applyScale()
    },
    setPlayback: (state) => view.setPlayback(state),
    setAnnouncement: (a) => view.setAnnouncement(a),
    setStreamLive: (live) => view.setStreamLive(live),
    setNext: (s) => view.setNext(s),
    dispose() {
      observer.disconnect()
      view.dispose()
    },
  }
}

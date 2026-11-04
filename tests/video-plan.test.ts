import { describe, expect, it } from 'vitest'
import { planImport, type Probe } from '../src/main/video-plan'

const MP4_FAMILY = 'mov,mp4,m4a,3gp,3g2,mj2' // ffprobe uses this name for both .mp4 and .mov
const MKV_FAMILY = 'matroska,webm'
const probe = (over: Partial<Probe>): Probe => ({ container: MP4_FAMILY, videoCodec: 'h264', pixFmt: 'yuv420p', audioCodec: 'aac', durationSec: 10, ...over })

describe('planImport', () => {
  it('copies H.264/AAC mp4 as is', () => {
    expect(planImport(probe({}), '.mp4')).toBe('copy')
    expect(planImport(probe({}), '.m4v')).toBe('copy')
  })
  it('copies a video without audio', () => expect(planImport(probe({ audioCodec: null }), '.mp4')).toBe('copy'))
  it('copies VP9/Opus webm', () => expect(planImport(probe({ container: MKV_FAMILY, videoCodec: 'vp9', audioCodec: 'opus' }), '.webm')).toBe('copy'))

  it('only re-wraps (no re-encode) when the codecs are fine but the container is not mp4', () => {
    expect(planImport(probe({}), '.mov')).toBe('remux')
    expect(planImport(probe({ container: MKV_FAMILY }), '.mkv')).toBe('remux')
    expect(planImport(probe({ container: MKV_FAMILY, videoCodec: 'vp9', audioCodec: 'opus' }), '.mkv')).toBe('remux')
    expect(planImport(probe({ container: 'avi' }), '.mp4')).toBe('remux')
  })

  it('transcodes codecs Chromium cannot decode', () => {
    expect(planImport(probe({ videoCodec: 'hevc' }), '.mp4')).toBe('transcode')
    expect(planImport(probe({ videoCodec: 'prores', pixFmt: 'yuv422p10le', audioCodec: 'pcm_s16le' }), '.mov')).toBe('transcode')
    expect(planImport(probe({ videoCodec: 'mpeg2video' }), '.mpg')).toBe('transcode')
  })
  it('transcodes H.264 in pixel formats browsers do not support', () => {
    expect(planImport(probe({ pixFmt: 'yuv444p' }), '.mp4')).toBe('transcode')
    expect(planImport(probe({ pixFmt: 'yuv420p10le' }), '.mp4')).toBe('transcode')
  })
  it('transcodes audio the browser cannot play', () => {
    expect(planImport(probe({ audioCodec: 'pcm_s16le' }), '.mp4')).toBe('transcode')
    expect(planImport(probe({ audioCodec: 'ac3' }), '.mp4')).toBe('transcode')
  })
})

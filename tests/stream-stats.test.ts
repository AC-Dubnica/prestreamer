import { describe, expect, it } from 'vitest'
import { RateMeter, assessHealth, dropPercent, parseProgress, parseSpeed } from '../src/shared/stream-stats'

const block = (n: number, size: number, extra = '') => `frame=${n}\nfps=30.00\ntotal_size=${size}\nout_time_us=${n * 33333}\ndup_frames=0\ndrop_frames=0\nspeed=1.00x\n${extra}progress=continue\n`

describe('parseProgress (ffmpeg -progress output)', () => {
  it('reads complete blocks of key=value lines', () => {
    const { blocks, rest } = parseProgress(block(30, 100000) + block(60, 200000))
    expect(blocks).toHaveLength(2)
    expect(blocks[1]).toMatchObject({ frame: '60', total_size: '200000', speed: '1.00x', progress: 'continue' })
    expect(rest).toBe('')
  })
  it('copes with output that arrives in arbitrary pieces', () => {
    const text = block(30, 100000) + block(60, 200000)
    let carry = ''
    const all: Record<string, string>[] = []
    for (let i = 0; i < text.length; i += 7) {
      const r = parseProgress(text.slice(i, i + 7), carry)
      carry = r.rest
      all.push(...r.blocks)
    }
    expect(all.map((b) => b.frame)).toEqual(['30', '60'])
  })
  it('ignores junk lines and keeps an unfinished block for next time', () => {
    const first = parseProgress('nonsense\nframe=10\nfps=25')
    expect(first.blocks).toEqual([])
    const second = parseProgress('\nprogress=continue\n', first.rest)
    expect(second.blocks[0]).toMatchObject({ frame: '10', fps: '25' })
  })
  it('recognises the end of the stream', () => expect(parseProgress('frame=1\nprogress=end\n').blocks[0].progress).toBe('end'))
})

describe('parseSpeed', () => {
  it('reads ffmpeg speeds', () => {
    expect(parseSpeed('1.02x')).toBe(1.02)
    expect(parseSpeed(' 0.5x ')).toBe(0.5)
  })
  it('gives null for anything else', () => {
    for (const bad of ['N/A', '', undefined, 'fast']) expect(parseSpeed(bad)).toBeNull()
  })
})

describe('RateMeter', () => {
  it('measures kbit/s from cumulative bytes', () => {
    const m = new RateMeter(5000)
    m.push(0, 0)
    m.push(1000, 125000) // 125 kB in 1 s = 1000 kbit/s
    expect(m.kbps()).toBe(1000)
  })
  it('needs two samples, and never goes negative', () => {
    const m = new RateMeter()
    expect(m.kbps()).toBe(0)
    m.push(0, 500)
    expect(m.kbps()).toBe(0)
    m.push(1000, 100) // a counter that went backwards
    expect(m.kbps()).toBe(0)
  })
  it('only looks at the recent window, so a change in bitrate shows up', () => {
    const m = new RateMeter(3000)
    for (let t = 0; t <= 10_000; t += 1000) m.push(t, t < 5000 ? t * 100 : 5000 * 100 + (t - 5000) * 500) // 800 kbit/s, then 4000 kbit/s
    expect(m.kbps()).toBeGreaterThan(3500)
  })
})

describe('assessHealth', () => {
  it('does not judge the first seconds', () => expect(assessHealth({ speed: 0.2, recentDropPercent: 90, uptimeSec: 3 })).toBe('good'))
  it('is good at real-time speed with almost no drops', () => expect(assessHealth({ speed: 1, recentDropPercent: 0.4, uptimeSec: 60 })).toBe('good'))
  it('is unstable when the encoder is slightly behind or frames are being dropped', () => {
    expect(assessHealth({ speed: 0.95, recentDropPercent: 0, uptimeSec: 60 })).toBe('warn')
    expect(assessHealth({ speed: 1, recentDropPercent: 2, uptimeSec: 60 })).toBe('warn')
  })
  it('is poor when the encoder cannot keep up or many frames are lost', () => {
    expect(assessHealth({ speed: 0.7, recentDropPercent: 0, uptimeSec: 60 })).toBe('poor')
    expect(assessHealth({ speed: 1, recentDropPercent: 8, uptimeSec: 60 })).toBe('poor')
  })
  it('treats an unknown speed as real time', () => expect(assessHealth({ speed: null, recentDropPercent: 0, uptimeSec: 60 })).toBe('good'))
})

describe('dropPercent', () => {
  it('is the share of frames lost between two snapshots', () => {
    expect(dropPercent({ sent: 0, dropped: 0 }, { sent: 90, dropped: 10 })).toBe(10)
    expect(dropPercent({ sent: 100, dropped: 5 }, { sent: 300, dropped: 5 })).toBe(0)
  })
  it('is 0 when nothing happened', () => expect(dropPercent({ sent: 5, dropped: 1 }, { sent: 5, dropped: 1 })).toBe(0))
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Playback } from '../src/main/playback'
import type { PlaybackState } from '../src/shared/types'

describe('Playback clock', () => {
  let states: PlaybackState[]
  let pb: Playback

  beforeEach(() => {
    vi.useFakeTimers()
    states = []
    pb = new Playback((s) => states.push(s))
    pb.load({ file: 'a.mp4', durationSec: 10 })
  })
  afterEach(() => vi.useRealTimers())

  it('loads paused at the start', () => {
    expect(pb.get()).toMatchObject({ file: 'a.mp4', playing: false, positionSec: 0, durationSec: 10 })
    expect(pb.position()).toBe(0)
  })

  it('advances in real time while playing and freezes on pause', () => {
    pb.command({ type: 'play' })
    vi.advanceTimersByTime(2500)
    expect(pb.position()).toBeCloseTo(2.5, 2)
    pb.command({ type: 'pause' })
    vi.advanceTimersByTime(5000)
    expect(pb.position()).toBeCloseTo(2.5, 2)
  })

  it('seeks while paused and while playing', () => {
    pb.command({ type: 'seek', sec: 6 })
    expect(pb.position()).toBe(6)
    pb.command({ type: 'play' })
    vi.advanceTimersByTime(2000)
    expect(pb.position()).toBeCloseTo(8, 2)
    pb.command({ type: 'seek', sec: 1 })
    vi.advanceTimersByTime(1000)
    expect(pb.position()).toBeCloseTo(2, 2)
  })

  it('clamps seeks into the video', () => {
    pb.command({ type: 'seek', sec: -5 })
    expect(pb.position()).toBe(0)
    pb.command({ type: 'seek', sec: 99 })
    expect(pb.position()).toBe(10)
  })

  it('holds on the last frame, paused, when it runs to the end', () => {
    pb.command({ type: 'play' })
    vi.advanceTimersByTime(11_000)
    expect(pb.get().playing).toBe(false)
    expect(pb.position()).toBe(10)
    expect(states.at(-1)).toMatchObject({ playing: false, positionSec: 10 })
  })

  it('restarts from the beginning when play is pressed on a finished video', () => {
    pb.command({ type: 'play' })
    vi.advanceTimersByTime(11_000)
    pb.command({ type: 'play' })
    expect(pb.get()).toMatchObject({ playing: true, positionSec: 0 })
  })

  it('stop rewinds and pauses', () => {
    pb.command({ type: 'play' })
    vi.advanceTimersByTime(3000)
    pb.command({ type: 'stop' })
    expect(pb.get()).toMatchObject({ playing: false, positionSec: 0 })
    vi.advanceTimersByTime(3000)
    expect(pb.position()).toBe(0)
  })

  it('ignores commands when nothing is loaded, and load(null) resets', () => {
    pb.load(null)
    const count = states.length
    pb.command({ type: 'play' })
    expect(states).toHaveLength(count)
    expect(pb.get().file).toBeNull()
  })

  it('does not fire a stale end-of-video timer after pausing', () => {
    pb.command({ type: 'play' })
    pb.command({ type: 'pause' })
    const count = states.length
    vi.advanceTimersByTime(60_000)
    expect(states).toHaveLength(count)
  })

  it('notifies on every change', () => {
    const before = states.length
    pb.command({ type: 'play' })
    pb.command({ type: 'pause' })
    expect(states.length).toBe(before + 2)
  })
})

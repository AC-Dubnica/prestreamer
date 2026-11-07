import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FrameSplitter, keepChannels, nativeKey, nativeName, parseAlsaInputs, parseFfmpegAudio, parseNativeInputs, parseWasapiList } from '../src/shared/native-audio'

describe('native input ids', () => {
  it('round-trips a device name and ignores browser ids', () => {
    expect(nativeName(nativeKey('WING'))).toBe('WING')
    expect(nativeName('app:video')).toBeNull()
    expect(nativeName('3f9a…hash')).toBeNull()
  })
})

describe('parseNativeInputs', () => {
  const json = { SPAudioDataType: [{ _items: [
    { _name: 'WING', coreaudio_device_input: 32, coreaudio_device_output: 32 },
    { _name: 'MacBook Pro Microphone', coreaudio_device_input: 1 },
    { _name: 'BlackHole 2ch', coreaudio_device_input: 2 },
    { _name: 'MacBook Pro Speakers', coreaudio_device_output: 2 },
    { _name: 'WING', coreaudio_device_input: 32 },
  ] }] }
  it('lists only inputs with more than two channels, once each', () => {
    expect(parseNativeInputs(json)).toEqual([{ name: 'WING', channels: 32 }])
  })
  it('survives anything else', () => {
    expect(parseNativeInputs(null)).toEqual([])
    expect(parseNativeInputs({ SPAudioDataType: [{}] })).toEqual([])
  })
})

describe('parseFfmpegAudio', () => {
  it('reads channels and rate from the stream line', () => {
    expect(parseFfmpegAudio('Input #0, avfoundation\n  Stream #0:0: Audio: pcm_f32le, 48000 Hz, 32 channels, flt, 49152 kb/s')).toEqual({ rate: 48000, channels: 32 })
  })
  it('finds nothing in other lines', () => expect(parseFfmpegAudio('Stream #0:0: Video: h264')).toBeNull())
})

describe('keepChannels', () => {
  it('builds a pan filter that keeps the first channels', () => expect(keepChannels(3)).toBe('pan=3c|c0=c0|c1=c1|c2=c2'))
})

describe('FrameSplitter', () => {
  const CH = 32
  /** Frame f, channel c holds f * 100 + c, so a shifted channel shows at once. */
  const samples = (frames: number) => Float32Array.from({ length: frames * CH }, (_, i) => Math.floor(i / CH) * 100 + (i % CH))

  it('delivers the same samples whatever size the chunks come in', () => {
    const all = samples(50)
    const bytes = new Uint8Array(all.buffer)
    for (const size of [1, 3, 7, 127, 128, 129, 1000, 4096]) {
      const splitter = new FrameSplitter(CH)
      const got: number[] = []
      for (let at = 0; at < bytes.length; at += size) {
        const out = splitter.push(bytes.subarray(at, Math.min(at + size, bytes.length)))
        if (out) got.push(...out)
      }
      expect(got.length, `chunk size ${size}`).toBe(all.length)
      expect(got, `chunk size ${size}`).toEqual([...all])
    }
  })
  it('keeps channels in place after a chunk that ends inside a frame', () => {
    const all = samples(4)
    const bytes = new Uint8Array(all.buffer)
    const splitter = new FrameSplitter(CH)
    const first = splitter.push(bytes.subarray(0, 130)) // one frame and two stray bytes
    expect(first).toHaveLength(CH)
    const second = splitter.push(bytes.subarray(130))!
    expect(second[0]).toBe(100) // frame 1, channel 0
    expect(second[5]).toBe(105)
  })
  it('returns null until a whole frame has arrived', () => {
    expect(new FrameSplitter(CH).push(new Uint8Array(100))).toBeNull()
  })
})

/** The worklet runs in Node with its three globals stood in, like the others in worklets.test.ts. */
describe('native-in worklet', () => {
  const SR = 48000
  interface Proc { port: { onmessage: ((e: { data: Float32Array }) => void) | null }; process(i: unknown[], o: Float32Array[][]): boolean; fill: number; primed: boolean }
  function make(channels: number, targetMs = 60): Proc {
    const code = readFileSync(new URL('../src/renderer/native-in-worklet.js', import.meta.url), 'utf8')
    let Ctor: (new (o: unknown) => Proc) | null = null
    class AudioWorkletProcessor { port = { onmessage: null } }
    new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', code)(AudioWorkletProcessor, (_n: string, c: new (o: unknown) => Proc) => { Ctor = c }, SR)
    return new Ctor!({ processorOptions: { channels, targetMs } })
  }
  const feed = (p: Proc, data: Float32Array) => p.port.onmessage!({ data })
  const block = (p: Proc, channels: number): Float32Array[] => {
    const out = [Array.from({ length: channels }, () => new Float32Array(128))]
    p.process([], out)
    return out[0]
  }
  /** Interleaved frames where channel c holds c + 1 (a constant per channel, so order and silence are easy to see). */
  const constant = (frames: number, channels: number) => Float32Array.from({ length: frames * channels }, (_, i) => (i % channels) + 1)

  it('plays each channel on its own output once the cushion is full', () => {
    const p = make(8)
    feed(p, constant(4000, 8))
    block(p, 8) // the first block fades in
    const out = block(p, 8)
    for (let c = 0; c < 8; c++) expect(out[c].every((v) => v === c + 1)).toBe(true)
  })
  it('stays silent until the cushion has filled, so a start is not a stutter', () => {
    const p = make(2)
    feed(p, constant(1000, 2)) // under the 60 ms (2880 frames) cushion
    expect(block(p, 2)[0].every((v) => v === 0)).toBe(true)
    feed(p, constant(3000, 2))
    const first = block(p, 2)[0]
    expect(first[0]).toBe(0) // it starts from silence with a ramp, not a step
    expect(first[127]).toBeGreaterThan(0.9)
    expect(block(p, 2)[0].every((v) => v === 1)).toBe(true)
  })
  it('goes silent when it runs dry and refills before playing on', () => {
    const p = make(2)
    feed(p, constant(3000, 2))
    let blocks = 0
    while (p.primed || blocks === 0) { block(p, 2); blocks++; if (blocks > 100) break }
    expect(blocks).toBeLessThan(40) // 3000 frames last about 23 blocks
    expect(block(p, 2)[0].every((v) => v === 0)).toBe(true)
    feed(p, constant(500, 2))
    expect(block(p, 2)[0].every((v) => v === 0)).toBe(true) // still under the cushion
  })
  it('holds the delay steady when the source clock runs fast', () => {
    const p = make(2)
    feed(p, constant(2880, 2))
    // The source delivers 0.5 % more than the output plays, for ten simulated seconds.
    for (let n = 0; n < 3750; n++) { feed(p, constant(129, 2)); block(p, 2) } // 128 played, 129 delivered
    expect(p.fill).toBeLessThan(2880 * 2)
    expect(p.primed).toBe(true)
  })
  it('holds the delay steady when the source clock runs slow', () => {
    const p = make(2)
    feed(p, constant(2880, 2))
    for (let n = 0; n < 3750; n++) { feed(p, constant(127, 2)); block(p, 2) }
    expect(p.fill).toBeGreaterThan(2880 / 4)
    expect(p.primed).toBe(true)
  })
  it('cuts a burst of backlog back to the cushion at once instead of playing fast to work it off', () => {
    const p = make(2)
    feed(p, constant(2880, 2))
    block(p, 2)
    feed(p, constant(6000, 2)) // a burst: about 125 ms over the cushion
    const out = block(p, 2)
    expect(p.fill).toBeLessThanOrEqual(2880)
    expect(out[0].every((v) => v === 1 || v === 0 || (v > 0 && v < 1))).toBe(true) // a fade across the join, nothing else
  })
  it('does not keep the backlog of a long stall as delay', () => {
    const p = make(2)
    feed(p, constant(2880, 2))
    feed(p, constant(30000, 2)) // 0.6 s arrives at once
    expect(p.fill).toBeLessThanOrEqual(2880)
  })
})

describe('parseAlsaInputs', () => {
  const cards = ` 0 [PCH            ]: HDA-Intel - HDA Intel PCH
                      HDA Intel PCH at 0xf7210000 irq 130
 2 [WING           ]: USB-Audio - WING
                      BEHRINGER WING at usb-0000:00:14.0-2, high speed
 3 [Mic            ]: USB-Audio - USB Mic
                      Some USB Mic at usb-0000:00:14.0-3, full speed`
  const wing = `BEHRINGER WING at usb-0000:00:14.0-2, high speed

Playback:
  Status: Stop
  Interface 1
    Altset 1
    Format: S32_LE
    Channels: 48

Capture:
  Status: Stop
  Interface 2
    Altset 1
    Format: S32_LE
    Channels: 32
`
  const mic = `Some USB Mic at usb-0000:00:14.0-3, full speed

Capture:
  Status: Stop
  Interface 1
    Altset 1
    Format: S16_LE
    Channels: 1
`
  it('lists the cards with more than two capture channels, by their short id', () => {
    expect(parseAlsaInputs(cards, { '0': [], '2': [wing], '3': [mic] })).toEqual([{ name: 'WING', channels: 32 }])
  })
  it('counts capture channels only, not playback', () => {
    expect(parseAlsaInputs(cards, { '2': [wing.replace('Channels: 32', 'Channels: 2')] })).toEqual([])
  })
  it('takes the most channels over a card\'s stream files', () => {
    expect(parseAlsaInputs(cards, { '2': [mic, wing] })).toEqual([{ name: 'WING', channels: 32 }])
  })
  it('knows no cards without stream files', () => expect(parseAlsaInputs(cards, {})).toEqual([]))
})

describe('parseWasapiList', () => {
  it('keeps endpoints with more than two channels', () => {
    expect(parseWasapiList('Microphone (Realtek)\t2\r\nWING (BEHRINGER WING)\t32\r\n\r\n')).toEqual([{ name: 'WING (BEHRINGER WING)', channels: 32 }])
  })
  it('ignores lines that are not "name, tab, number"', () => expect(parseWasapiList('garbage\nname\tmany\n')).toEqual([]))
})

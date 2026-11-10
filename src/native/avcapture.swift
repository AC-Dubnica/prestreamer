// Reads every input channel of a CoreAudio device and writes interleaved f32le frames to stdout (see main/native-audio.ts).
// ffmpeg's avfoundation input drops about one buffer in nine, which is heard as constant crackle, so the samples are taken straight
// from the device here: the render callback only copies into a ring, and a separate thread writes the pipe, so a slow reader
// can never stall the device's real-time thread.
// Usage: avcapture <device name> <max channels>
// stderr gets one line in the style of ffmpeg's ("Stream #0:0: Audio: pcm_f32le, 48000 Hz, N channels") when capture has started.
import AudioToolbox
import CoreAudio
import Foundation

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

/// What the render callback needs; a C callback cannot capture variables, so it gets this through its refcon.
final class Capture {
  var unit: AudioUnit
  let deviceChannels: Int
  let outChannels: Int
  let ringFrames: Int
  let ring: UnsafeMutablePointer<Float>
  let scratch: UnsafeMutablePointer<Float>
  var head = 0 // next frame to write
  var tail = 0 // next frame to read
  var lock = os_unfair_lock()
  static let scratchFrames = 1 << 16 // the device asks for at most a few thousand frames per call

  init(unit: AudioUnit, deviceChannels: Int, outChannels: Int, ringFrames: Int) {
    self.unit = unit
    self.deviceChannels = deviceChannels
    self.outChannels = outChannels
    self.ringFrames = ringFrames
    ring = .allocate(capacity: ringFrames * outChannels)
    scratch = .allocate(capacity: Capture.scratchFrames * deviceChannels)
  }
}

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal, _ value: inout T) -> OSStatus {
  var address = AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
  var size = UInt32(MemoryLayout<T>.size)
  return withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0) }
}

func inputChannels(_ device: AudioObjectID) -> Int {
  var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: kAudioObjectPropertyScopeInput, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
  let raw = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: 16)
  defer { raw.deallocate() }
  guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, raw) == noErr else { return 0 }
  let list = UnsafeMutableAudioBufferListPointer(raw.assumingMemoryBound(to: AudioBufferList.self))
  return list.reduce(0) { $0 + Int($1.mNumberChannels) }
}

func findDevice(named name: String) -> AudioObjectID? {
  var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return nil }
  var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids) == noErr else { return nil }
  for id in ids where inputChannels(id) > 0 {
    var cfName: Unmanaged<CFString>?
    if property(id, kAudioObjectPropertyName, &cfName) == noErr, let n = cfName?.takeRetainedValue() as String?, n == name { return id }
  }
  return nil
}

let args = CommandLine.arguments
guard args.count >= 3, let maxChannels = Int(args[2]), maxChannels > 0 else { fail("usage: avcapture <device name> <max channels>") }
guard let device = findDevice(named: args[1]) else { fail("No input device named \(args[1])") }

let deviceChannels = inputChannels(device)
let outChannels = min(deviceChannels, maxChannels)
var nominal: Float64 = 0
_ = property(device, kAudioDevicePropertyNominalSampleRate, &nominal)
let rate = Int(nominal.rounded())
if rate != 48000 { fail("\(args[1]) runs at \(rate) Hz; set it to 48000 Hz (Audio MIDI Setup)") }

var unit: AudioUnit?
var desc = AudioComponentDescription(componentType: kAudioUnitType_Output, componentSubType: kAudioUnitSubType_HALOutput, componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0)
guard let comp = AudioComponentFindNext(nil, &desc), AudioComponentInstanceNew(comp, &unit) == noErr, let au = unit else { fail("Could not create the audio unit") }

var on: UInt32 = 1, off: UInt32 = 0
AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, 4)
AudioUnitSetProperty(au, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, 4)
var dev = device
guard AudioUnitSetProperty(au, kAudioOutputUnitProperty_CurrentDevice, kAudioUnitScope_Global, 0, &dev, UInt32(MemoryLayout<AudioObjectID>.size)) == noErr else { fail("Could not select the device") }

var format = AudioStreamBasicDescription(mSampleRate: nominal, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: UInt32(4 * deviceChannels), mFramesPerPacket: 1, mBytesPerFrame: UInt32(4 * deviceChannels), mChannelsPerFrame: UInt32(deviceChannels), mBitsPerChannel: 32, mReserved: 0)
guard AudioUnitSetProperty(au, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, UInt32(MemoryLayout<AudioStreamBasicDescription>.size)) == noErr else { fail("The device does not deliver \(deviceChannels) channels as floats") }

// The ring holds interleaved frames of `outChannels` samples, two seconds of them.
let cap = Capture(unit: au, deviceChannels: deviceChannels, outChannels: outChannels, ringFrames: rate * 2)

let callback: AURenderCallback = { refCon, flags, timeStamp, bus, frames, _ in
  let c = Unmanaged<Capture>.fromOpaque(refCon).takeUnretainedValue()
  let n = Int(frames)
  if n > Capture.scratchFrames { return noErr }
  var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: UInt32(c.deviceChannels), mDataByteSize: UInt32(n * c.deviceChannels * 4), mData: UnsafeMutableRawPointer(c.scratch)))
  var f = flags.pointee
  guard AudioUnitRender(c.unit, &f, timeStamp, bus, frames, &list) == noErr else { return noErr }
  os_unfair_lock_lock(&c.lock)
  if c.ringFrames - (c.head - c.tail) < n { c.tail = c.head - (c.ringFrames - n) } // the reader fell two seconds behind: drop the oldest
  for i in 0..<n {
    let slot = (c.head + i) % c.ringFrames
    for ch in 0..<c.outChannels { c.ring[slot * c.outChannels + ch] = c.scratch[i * c.deviceChannels + ch] }
  }
  c.head += n
  os_unfair_lock_unlock(&c.lock)
  return noErr
}
var input = AURenderCallbackStruct(inputProc: callback, inputProcRefCon: Unmanaged.passUnretained(cap).toOpaque())
AudioUnitSetProperty(au, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &input, UInt32(MemoryLayout<AURenderCallbackStruct>.size))

guard AudioUnitInitialize(au) == noErr else { fail("Could not initialise the device (is microphone access allowed?)") }
guard AudioOutputUnitStart(au) == noErr else { fail("Could not start the device (is microphone access allowed?)") }
FileHandle.standardError.write(Data("Stream #0:0: Audio: pcm_f32le, \(rate) Hz, \(outChannels) channels\n".utf8))

// stdout writer; a closed pipe means the app has stopped us
signal(SIGPIPE, SIG_IGN)
signal(SIGTERM) { _ in exit(0) }
let chunk = UnsafeMutablePointer<Float>.allocate(capacity: 4096 * outChannels)
while true {
  usleep(4000)
  os_unfair_lock_lock(&cap.lock)
  let n = min(cap.head - cap.tail, 4096)
  for i in 0..<n {
    let slot = (cap.tail + i) % cap.ringFrames
    for c in 0..<outChannels { chunk[i * outChannels + c] = cap.ring[slot * outChannels + c] }
  }
  cap.tail += n
  os_unfair_lock_unlock(&cap.lock)
  var offset = 0
  let bytes = n * outChannels * 4
  while offset < bytes {
    let w = write(1, UnsafeRawPointer(chunk) + offset, bytes - offset)
    if w < 0 { if errno == EINTR { continue }; exit(0) }
    offset += w
  }
}

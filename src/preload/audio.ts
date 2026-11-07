import { contextBridge, ipcRenderer } from 'electron'
import { AUDIO_IPC, type AudioConfig, type AudioStatus, type Meters, type PlaybackState } from '../shared/types'
import type { MixerConfig } from '../shared/mixer'

// The hidden audio window gets only what it needs: receive config, report status and levels, send PCM.
const api = {
  onApply: (cb: (p: { config: AudioConfig; mixer: MixerConfig }) => void) => {
    ipcRenderer.on(AUDIO_IPC.apply, (_e, p: { config: AudioConfig; mixer: MixerConfig }) => cb(p))
  },
  onMixer: (cb: (m: MixerConfig) => void) => {
    ipcRenderer.on(AUDIO_IPC.mixerPush, (_e, m: MixerConfig) => cb(m))
  },
  onPlayback: (cb: (s: PlaybackState) => void) => {
    ipcRenderer.on(AUDIO_IPC.playback, (_e, s: PlaybackState) => cb(s))
  },
  report: (s: AudioStatus) => ipcRenderer.send(AUDIO_IPC.report, s),
  meters: (m: Meters) => ipcRenderer.send(AUDIO_IPC.metersIn, m),
  pcm: (buf: ArrayBuffer) => ipcRenderer.send(AUDIO_IPC.pcm, buf),
  videoPcm: (buf: ArrayBuffer) => ipcRenderer.send(AUDIO_IPC.videoPcm, buf),
  nativeStart: (name: string): Promise<{ channels: number; id: number } | { error: string }> => ipcRenderer.invoke(AUDIO_IPC.nativeStart, name),
  nativeStop: (name: string, id: number) => ipcRenderer.send(AUDIO_IPC.nativeStop, name, id),
  onNativeData: (cb: (name: string, frames: ArrayBuffer) => void) => {
    ipcRenderer.on(AUDIO_IPC.nativeData, (_e, name: string, frames: ArrayBuffer) => cb(name, frames))
  },
  onNativeEnded: (cb: (name: string, message: string) => void) => {
    ipcRenderer.on(AUDIO_IPC.nativeEnded, (_e, name: string, message: string) => cb(name, message))
  },
}

export type AudioApi = typeof api
contextBridge.exposeInMainWorld('audioBridge', api)

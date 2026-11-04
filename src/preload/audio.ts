import { contextBridge, ipcRenderer } from 'electron'
import { AUDIO_IPC, type AudioConfig, type AudioStatus, type Meters } from '../shared/types'
import type { MixerConfig } from '../shared/mixer'

// The hidden audio window gets only what it needs: receive config, report status and levels, send PCM.
const api = {
  onApply: (cb: (p: { config: AudioConfig; mixer: MixerConfig }) => void) => {
    ipcRenderer.on(AUDIO_IPC.apply, (_e, p: { config: AudioConfig; mixer: MixerConfig }) => cb(p))
  },
  onMixer: (cb: (m: MixerConfig) => void) => {
    ipcRenderer.on(AUDIO_IPC.mixerPush, (_e, m: MixerConfig) => cb(m))
  },
  report: (s: AudioStatus) => ipcRenderer.send(AUDIO_IPC.report, s),
  meters: (m: Meters) => ipcRenderer.send(AUDIO_IPC.metersIn, m),
  pcm: (buf: ArrayBuffer) => ipcRenderer.send(AUDIO_IPC.pcm, buf),
}

export type AudioApi = typeof api
contextBridge.exposeInMainWorld('audioBridge', api)

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dmxPortCandidates, DMX_UNSUPPORTED, isDmxPort } from '../shared/dmx'
import type { DmxDeps, DmxLink, DmxLinkEvents } from './dmx'

/** The sender program (src/native/dmxsend.c, compiled by build.mjs). It sits unpacked next to the asar in an installed app. */
function helperPath(): string {
  return join(__dirname, '../native', 'dmxsend').replace('app.asar', 'app.asar.unpacked')
}

/**
 * The real output: one `dmxsend` process that makes the signal (break, start code, slots) and repeats the newest frame, so a busy
 * app cannot stutter the lights. With `fakeFile` (tests and screenshots) it runs in its raw mode and writes the frame into that file
 * instead of a port, and the interface list is one made-up entry.
 */
export function realDmxDeps(opts: { fakeFile?: string; disabledReason?: string } = {}): DmxDeps {
  const platform = process.platform
  const fakePort = '/dev/cu.usbserial-TEST'
  return {
    listPorts: () => {
      if (opts.fakeFile) return [fakePort]
      try { return dmxPortCandidates(readdirSync('/dev'), platform) } catch { return [] }
    },
    unavailable: () => {
      if (opts.disabledReason) return opts.disabledReason
      if (platform !== 'darwin' && platform !== 'linux') return DMX_UNSUPPORTED
      if (!existsSync(helperPath())) return 'The DMX sender is missing from this build (it is compiled from src/native/dmxsend.c).'
      return null
    },
    now: () => Date.now(),
    open: (port: string, events: DmxLinkEvents): DmxLink => {
      if (!opts.fakeFile && !isDmxPort(port, platform)) {
        queueMicrotask(() => events.failed(`“${port}” is not a USB serial port`))
        return { write() {}, close() {} }
      }
      const proc = spawn(helperPath(), [opts.fakeFile ?? port, ...(opts.fakeFile ? ['raw'] : [])], { stdio: ['pipe', 'ignore', 'pipe'] })
      let log = ''
      let ready = false
      let closed = false
      proc.stdin!.on('error', () => {}) // the helper ending is handled by 'close'
      proc.stderr!.on('data', (d: Buffer) => {
        log = (log + d.toString()).slice(-600)
        if (!ready && /^READY$/m.test(log)) { ready = true; events.ready() }
      })
      proc.on('error', (err) => { if (!closed) events.failed(`The DMX sender could not start: ${err.message}`) })
      proc.on('close', () => {
        if (closed) return
        const why = /^ERROR (.*)$/m.exec(log)?.[1]
        events.failed(why ? `The DMX interface does not work: ${why}` : 'The DMX sender stopped.')
      })
      return {
        write: (slots) => { if (!closed && !proc.stdin!.writableNeedDrain) proc.stdin!.write(slots) },
        close: () => {
          closed = true
          proc.stdin?.end() // the helper ends with its input
          setTimeout(() => proc.kill('SIGKILL'), 2000).unref()
        },
      }
    },
  }
}

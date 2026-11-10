import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { t } from '../shared/i18n'

export interface ZipEntry {
  name: string
  read(): Buffer
}

/** The entries of a .zip held in memory (stored or deflated; no encryption, no zip64): all a songbook export needs. */
export function readZip(buf: Buffer): ZipEntry[] {
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break }
  if (end < 0) throw new Error(t('main.zip.notZip'))
  const count = buf.readUInt16LE(end + 10)
  let p = buf.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(t('main.zip.damaged'))
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const raw = buf.subarray(p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    const name = decodeName(raw, (flags & 0x800) !== 0)
    if (name.endsWith('/')) continue
    entries.push({
      name,
      read: () => {
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
        const data = buf.subarray(start, start + size)
        if (method === 0) return Buffer.from(data)
        if (method === 8) return inflateRawSync(data)
        throw new Error(t('main.zip.compression', { name }))
      },
    })
  }
  return entries
}

/** UTF-8 when the archive says so or the bytes are valid UTF-8; otherwise Latin-1 (names only label a file, the songs' text is inside). */
function decodeName(raw: Buffer, utf8Flag: boolean): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return utf8Flag ? raw.toString('utf8') : raw.toString('latin1')
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
const crc32 = (buf: Buffer): number => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

/** A .zip (deflated, UTF-8 names) of the given files, built in memory. */
export function writeZip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8')
    const body = deflateRawSync(f.data)
    const crc = crc32(f.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(f.data.length, 22); local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(0x800, 8); head.writeUInt16LE(8, 10)
    head.writeUInt32LE(crc, 16); head.writeUInt32LE(body.length, 20); head.writeUInt32LE(f.data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(offset, 42)
    parts.push(local, name, body)
    central.push(head, name)
    offset += 30 + name.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}

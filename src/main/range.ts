/**
 * Parses an HTTP Range header against a file of `size` bytes.
 * Returns null when there is no (usable) range, so the caller serves the whole file;
 * 'unsatisfiable' for a range outside the file (HTTP 416); otherwise the inclusive byte range.
 * Supports "bytes=a-b", "bytes=a-" and the suffix form "bytes=-n" (the last n bytes).
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!m || (m[1] === '' && m[2] === '')) return null
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1])
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start > end || start >= size) return 'unsatisfiable'
  return { start, end }
}

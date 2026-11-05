import { describe, expect, it } from 'vitest'
import { converterPlan, keynoteScript, libreOfficeArgs, powerPointMacScript, powerPointWindowsScript, powerShellArgs, presentationSlides, unsupportedMessage } from '../src/shared/presentation'

describe('presentationSlides', () => {
  const it3 = { id: 'p1', kind: 'presentation' as const, title: 'Sermon', slides: ['a.png', 'b.png', 'c.png'] }
  it('makes one picture slide per file with a unique label', () => {
    const slides = presentationSlides(it3)
    expect(slides.map((s) => s.label)).toEqual(['Slide 1 / 3', 'Slide 2 / 3', 'Slide 3 / 3'])
    expect(slides.map((s) => s.picture?.file)).toEqual(['a.png', 'b.png', 'c.png'])
    expect(slides.every((s) => s.text === '' && s.itemId === 'p1')).toBe(true)
  })
  it('is empty for an empty deck', () => expect(presentationSlides({ ...it3, slides: [] })).toEqual([]))
})

describe('converterPlan', () => {
  it('.pptx and .ppsx are read by PreStreamer itself on every system: no other program is started', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(converterPlan('/a/talk.PPTX', platform)[0]).toBe('builtin')
      expect(converterPlan('/a/talk.ppsx', platform)).toEqual(['builtin', 'libreoffice'])
    }
  })
  it('on a Mac: Keynote for .key; old .ppt via LibreOffice first (no prompts), then PowerPoint, then Keynote', () => {
    expect(converterPlan('/a/talk.key', 'darwin')).toEqual(['keynote'])
    expect(converterPlan('/a/talk.ppt', 'darwin')).toEqual(['libreoffice', 'powerpoint-mac', 'keynote'])
    expect(converterPlan('/a/talk.odp', 'darwin')).toEqual(['libreoffice', 'keynote'])
  })
  it('on Windows: old .ppt via LibreOffice, then PowerPoint; Keynote files are not possible', () => {
    expect(converterPlan('C:\\x\\talk.ppt', 'win32')).toEqual(['libreoffice', 'powerpoint-windows'])
    expect(converterPlan('C:\\x\\talk.key', 'win32')).toEqual([])
    expect(converterPlan('C:\\x\\talk.odp', 'win32')).toEqual(['libreoffice'])
  })
  it('on Linux: LibreOffice only', () => expect(converterPlan('/a/talk.ppt', 'linux')).toEqual(['libreoffice']))
  it('has nothing for other types', () => expect(converterPlan('/a/talk.docx', 'darwin')).toEqual([]))
})

describe('unsupportedMessage', () => {
  it('tells a Windows user how to get a Keynote deck in', () => expect(unsupportedMessage('x.key', 'win32')).toMatch(/Export To > PDF/))
  it('names an unknown type', () => expect(unsupportedMessage('x.docx', 'darwin')).toMatch(/\.docx/))
})

describe('scripts', () => {
  it('AppleScript strings escape quotes and backslashes in paths', () => {
    const s = keynoteScript('/Users/me/My "best" talk\\v2.key', '/tmp/out.pdf')
    expect(s).toContain('POSIX file "/Users/me/My \\"best\\" talk\\\\v2.key"')
    expect(s).toContain('tell application "Keynote"')
    expect(s).toContain('as PDF')
  })
  it('PowerPoint for Mac saves a PDF copy and closes without saving', () => {
    const s = powerPointMacScript('/a/b.pptx', '/tmp/o.pdf')
    expect(s).toContain('tell application "Microsoft PowerPoint"')
    expect(s).toContain('as save as PDF')
    expect(s).toContain('close thePres saving no')
  })
  it('PowerShell strings double their single quotes, and the script travels encoded', () => {
    const s = powerPointWindowsScript("C:\\Users\\O'Neil\\talk.pptx", 'C:\\Temp\\o.pdf')
    expect(s).toContain("'C:\\Users\\O''Neil\\talk.pptx'")
    expect(s).toContain('SaveAs(')
    expect(s).toContain(', 32)')
    const args = powerShellArgs('Write-Output "hi"')
    expect(args.slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'])
    expect(Buffer.from(args[5], 'base64').toString('utf16le')).toBe('Write-Output "hi"')
  })
  it('LibreOffice converts to PDF into the given folder', () => expect(libreOfficeArgs('/a/b.pptx', '/tmp/x')).toEqual(['--headless', '--convert-to', 'pdf', '--outdir', '/tmp/x', '/a/b.pptx']))
})

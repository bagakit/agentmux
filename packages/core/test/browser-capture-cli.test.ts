import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentMuxCliInvocation } from '../src/agentmux-cli-commands.js'
import { browserCaptureCliMetadata, writeBrowserCaptureFile, resolveBrowserCaptureReport } from '../src/browser-capture-cli.js'

const directories: string[] = []
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true }) })
const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCq8AAAAASUVORK5CYII='
const capture = { browserId: 'original-page', navigationId: 'original-navigation', source: { hostOverlays: 'excluded' },
  image: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + data, width: 1, height: 1, byteLength: Buffer.from(data, 'base64').length } }
const report = { outcome: { kind: 'completed' }, result: capture, runOperation: { id: 'original-operation' } }

it('routes capture flags through the original Browser program and retains an explicit export path', async () => {
  const invocation = await parseAgentMuxCliInvocation(['browser', 'capture', '--browser', 'original-page', '--operation-id', 'original-operation',
    '--within', '#report > section', '--pixel-ratio', '2', '--output', 'report.png'])
  expect(invocation.command.method).toBe('browser.run')
  expect(invocation.params).toEqual({ browserId: 'original-page', operationId: 'original-operation',
    code: 'return await captureScreenshot({"within":"#report > section","pixelRatio":2})' })
  expect(invocation.output).toBe('report.png')
  await expect(parseAgentMuxCliInvocation(['browser', 'capture', '--browser', 'B', '--output', 'a.png', '--within', 'main', '--clip', '{}'])).rejects.toThrow('Choose one')
  await expect(parseAgentMuxCliInvocation(['browser', 'capture', '--browser', 'B', '--output', 'a.png', '--pixel-ratio', '0'])).rejects.toThrow('pixel-ratio')
})

it('exports the original PNG once and never overwrites a file or symlink', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amux-capture-')); directories.push(dir)
  const path = join(dir, 'capture.png'), out = await writeBrowserCaptureFile(path, report)
  expect(out.bytes).toBe(capture.image.byteLength)
  expect(await readFile(path)).toEqual(Buffer.from(data, 'base64'))
  await expect(writeBrowserCaptureFile(path, report)).rejects.toMatchObject({ code: 'EEXIST' })
  const alias = join(dir, 'alias.png'); await symlink(path, alias)
  await expect(writeBrowserCaptureFile(alias, report)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path)).toEqual(Buffer.from(data, 'base64'))
  expect(browserCaptureCliMetadata(report)).toMatchObject({ result: { image: { width: 1 }, source: { hostOverlays: 'excluded' } }, runOperation: report.runOperation })
  expect(JSON.stringify(browserCaptureCliMetadata(report))).not.toContain(data)
})

it('keeps the original failed program and refuses malformed pixels without publishing a new file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'amux-capture-')); directories.push(dir)
  await expect(writeBrowserCaptureFile(join(dir, 'bad.png'), { ...report, outcome: { kind: 'indeterminate' } })).rejects.toMatchObject({ code: 'BROWSER_CAPTURE_UNAVAILABLE' })
  await expect(writeBrowserCaptureFile(join(dir, 'bad.png'), { ...report, result: { ...capture, image: { ...capture.image, width: 2 } } })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
})

it('exports a retained large screenshot through bounded reads of its original result without recapture', async () => {
  const largeCapture = { ...capture, source: { ...capture.source, fixtureText: '界🙂'.repeat(20000) } }
  const bytes = Buffer.from(JSON.stringify(largeCapture))
  const reference = { kind: 'browser-result-artifact', id: 'original-result', browserId: capture.browserId,
    workspaceId: 'original-workspace', operationId: 'original-operation', navigationId: capture.navigationId,
    format: 'json', byteLength: bytes.length, maxReadBytes: 65536 }
  let offset = 0
  const read = vi.fn(async (code: string) => {
    expect(code).toBe(`return await readResult(${JSON.stringify(reference)},{offset:${offset},maxBytes:65536})`)
    const data = bytes.subarray(offset, offset + 65536), start = offset
    offset += data.length
    return { outcome: { kind: 'completed' }, result: { reference, encoding: 'base64', data: data.toString('base64'),
      offset: start, returnedBytes: data.length, totalBytes: bytes.length, nextOffset: offset === bytes.length ? null : offset } }
  })
  const original = { ...report, result: reference }
  const resolved = await resolveBrowserCaptureReport(original, capture.browserId, read)
  expect(resolved).toEqual({ ...report, result: largeCapture, resultArtifact: reference })
  expect(original.result).toBe(reference); expect(read).toHaveBeenCalledTimes(3)
  const dir = await mkdtemp(join(tmpdir(), 'amux-capture-')); directories.push(dir)
  const path = join(dir, 'large.png'); await writeBrowserCaptureFile(path, resolved)
  expect(await readFile(path)).toEqual(Buffer.from(data, 'base64'))
  expect(browserCaptureCliMetadata(resolved)).toMatchObject({ resultArtifact: reference, result: { image: { width: 1 } } })
})

it('keeps an inline result unchanged and refuses a wrong or nonprogressing retained continuation', async () => {
  const read = vi.fn()
  expect(await resolveBrowserCaptureReport(report, capture.browserId, read)).toBe(report)
  expect(read).not.toHaveBeenCalled()
  const reference = { kind: 'browser-result-artifact', browserId: capture.browserId, format: 'json', byteLength: 5, maxReadBytes: 65536 }
  await expect(resolveBrowserCaptureReport({ ...report, result: reference }, 'other-page', read)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  const failedRead = vi.fn(async () => ({ outcome: { kind: 'completed' }, result: { reference, encoding: 'base64',
    data: '', offset: 0, returnedBytes: 0, totalBytes: 5, nextOffset: 0 } }))
  await expect(resolveBrowserCaptureReport({ ...report, result: reference }, capture.browserId, failedRead)).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
  expect(failedRead).toHaveBeenCalledTimes(1)
  const readFailure = { outcome: { kind: 'script-failed', message: 'Original result was evicted' }, runOperation: { id: 'original-read-operation' } }
  await expect(resolveBrowserCaptureReport({ ...report, result: reference }, capture.browserId, async () => readFailure)).rejects.toMatchObject({
    code: 'BROWSER_CAPTURE_RESULT_READ_FAILED', message: expect.stringContaining('original-read-operation'),
    detail: JSON.stringify({ readOperationId: readFailure.runOperation.id, outcome: readFailure.outcome })
  })
})

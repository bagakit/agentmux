import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenCapture } from '../src/main/screen-capture'
import type { BrowserPng } from '../src/shared/contracts'
import { readPastedImage } from '../src/main/pasted-image-read'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width: 1, height: 1, byteLength: bytes.length }
const captured = { state: 'captured' as const, screenshot: { format: 'png' as const, data: bytes.toString('base64'), width: 1, height: 1, scale: 2 } }
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'amux-capture-')); homes.push(home)
  const native = { captureScreenshot: vi.fn(async () => captured), writeClipboardImage: vi.fn(async (_image: BrowserPng) => {}) }
  const edit = vi.fn(async (_image: BrowserPng, _attach: boolean, _complete: (png: BrowserPng) => Promise<void>, _issue?: string) => {})
  const reportIssue = vi.fn()
  return { home, native, edit, reportIssue, owner: new ScreenCapture({ home, native: () => native, edit, reportIssue }) }
}

it('copies the same final pixels and saves a durable draft image through the original pasted owner', async () => {
  const f = await fixture(), path = await f.owner.capture(true)
  expect(f.native.captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection', allowEditing: true })
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
  expect(path).toMatch(/\.agentmux\/pasted\/[a-f0-9]{64}\.png$/)
  expect(await readFile(path!)).toEqual(bytes)
  expect(await readPastedImage(f.home, path!)).toEqual({ dataUrl: image.dataUrl })
  expect(f.edit).not.toHaveBeenCalled()
})

it('a clipboard-only capture needs no draft, saved file or editor', async () => {
  const f = await fixture()
  expect(await f.owner.capture(false)).toBeNull()
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
  expect(await readdir(f.home)).toEqual([])
  expect(f.edit).not.toHaveBeenCalled()
})

it('treats only the native cancellation receipt as cancellation and makes no delivery', async () => {
  const f = await fixture()
  f.native.captureScreenshot.mockResolvedValueOnce({ state: 'cancelled' } as never)
  expect(await f.owner.capture(true)).toBeNull()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
})

it('edit intent defers all delivery until the shared editor explicitly completes its final image', async () => {
  const f = await fixture()
  f.native.captureScreenshot.mockResolvedValueOnce({ ...captured, completionAction: 'edit' } as never)
  let finish!: (image: BrowserPng) => Promise<void>, close!: () => void
  f.edit.mockImplementationOnce(async (_image, _attach, complete) => { finish = complete; await new Promise<void>(resolve => { close = resolve }) })
  const pending = f.owner.capture(true)
  await vi.waitFor(() => expect(f.edit).toHaveBeenCalledOnce())
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
  const editedBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const edited = { ...image, dataUrl: 'data:image/png;base64,' + editedBytes.toString('base64'), byteLength: editedBytes.length }
  await finish(edited); close()
  const path = await pending
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
  expect(await readFile(path!)).toEqual(editedBytes)
})

it('closing the editor without completion never delivers the unedited original', async () => {
  const f = await fixture()
  f.native.captureScreenshot.mockResolvedValueOnce({ ...captured, completionAction: 'edit' } as never)
  f.edit.mockResolvedValueOnce(undefined)
  expect(await f.owner.capture(true)).toBeNull()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
})

it('a failed clipboard destination preserves the saved draft image and reports the partial result', async () => {
  const f = await fixture()
  f.native.writeClipboardImage.mockRejectedValueOnce(new Error('Original clipboard outcome unknown'))
  const path = await f.owner.capture(true)
  expect(await readFile(path!)).toEqual(bytes)
  expect(f.reportIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('Clipboard copy was not confirmed') }))
  expect(f.native.captureScreenshot).toHaveBeenCalledOnce()
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
})

it('a failed draft save preserves the independent clipboard result without modifying old resources', async () => {
  const f = await fixture()
  await writeFile(join(f.home, '.agentmux'), 'original user resource')
  expect(await f.owner.capture(true)).toBeNull()
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
  expect(f.reportIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('The image is on the clipboard') }))
  expect(await readFile(join(f.home, '.agentmux'), 'utf8')).toBe('original user resource')
})

it('does not join another draft to an in-flight physical capture', async () => {
  const f = await fixture()
  let finish!: (value: typeof captured) => void
  f.native.captureScreenshot.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.owner.capture(true)
  await expect(f.owner.capture(false)).rejects.toThrow('already in progress')
  finish(captured); await pending
  expect(f.native.captureScreenshot).toHaveBeenCalledOnce()
})

it('preserves original native unknown operations and never automatically captures again', async () => {
  const f = await fixture(), error = Object.assign(new Error('Original capture outcome is unknown'), { operation: { operationId: 'original', instanceId: 'original-instance' } })
  f.native.captureScreenshot.mockRejectedValueOnce(error)
  await expect(f.owner.capture(true)).rejects.toBe(error)
  expect(f.native.captureScreenshot).toHaveBeenCalledOnce()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
})

it('closing an editor cannot erase an already submitted delivery or release its capture early', async () => {
  const f = await fixture()
  f.native.captureScreenshot.mockResolvedValueOnce({ ...captured, completionAction: 'edit' } as never)
  let delivered!: () => void
  f.native.writeClipboardImage.mockImplementationOnce(() => new Promise<void>(resolve => { delivered = resolve }))
  f.edit.mockImplementationOnce(async (_image, _attach, complete) => { void complete(image).catch(() => {}) })
  let settled = false
  const pending = f.owner.capture(true).then(path => { settled = true; return path })
  await vi.waitFor(() => expect(f.native.writeClipboardImage).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  await expect(f.owner.capture(false)).rejects.toThrow('already in progress')
  delivered()
  expect(await readFile((await pending)!)).toEqual(bytes)
})

it('recovery of a failed draft save never repeats the already successful clipboard write', async () => {
  const f = await fixture()
  await writeFile(join(f.home, '.agentmux'), 'original user resource')
  f.edit.mockImplementationOnce(async (_image, _attach, complete, issue) => {
    expect(issue).toContain('on the clipboard')
    await rm(join(f.home, '.agentmux'))
    await complete(image)
  })
  expect(await readFile((await f.owner.capture(true))!)).toEqual(bytes)
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
})

it('unknown clipboard writes retain the original receipt and are not replayed from the recovery editor', async () => {
  const f = await fixture()
  const original = Object.assign(new Error('Clipboard reply lost'), { code: 'operation_unknown', operation: { state: 'unknown', operationId: 'original-copy', instanceId: 'original-native' } })
  f.native.writeClipboardImage.mockRejectedValueOnce(original)
  f.edit.mockImplementationOnce(async (_image, _attach, complete, issue) => {
    expect(issue).toContain('original-copy')
    await expect(complete(image)).rejects.toMatchObject({ cause: original })
  })
  expect(await readFile((await f.owner.capture(true))!)).toEqual(bytes)
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
  expect(f.native.captureScreenshot).toHaveBeenCalledOnce()
})

it.each([{ state: 'captured' }, { ...captured, screenshot: { ...captured.screenshot, width: 2 } }, { state: 'unknown' }])('rejects missing or mismatched evidence %j before delivery', async result => {
  const f = await fixture()
  f.native.captureScreenshot.mockResolvedValueOnce(result as never)
  await expect(f.owner.capture(true)).rejects.toThrow()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
})

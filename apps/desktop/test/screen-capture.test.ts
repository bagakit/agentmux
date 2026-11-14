import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { deriveObjectId } from '@agentmux/core/object-id'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ScreenCapture } from '../src/main/screen-capture'
import type { BrowserPng } from '../src/shared/contracts'
import { readPastedImage } from '../src/main/pasted-image-read'
import type { CaptureSurfaceOutcome, CaptureSurfaceSession } from '../src/main/capture-surface'
import type { ScreenshotEditContext } from '../src/shared/system-screenshot-editor'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const image: BrowserPng = { mimeType: 'image/png', dataUrl: 'data:image/png;base64,' + bytes.toString('base64'), width: 1, height: 1, byteLength: bytes.length }
const captured = { state: 'captured' as const, screenshot: { format: 'png' as const, data: bytes.toString('base64'), width: 1, height: 1, scale: 2 } }
const homes: string[] = []
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const source = { rect: { x: -1200, y: 40, width: 640, height: 360 }, scale: 2, capturedAt: 1_700_000_000_000 }
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'amux-capture-')); homes.push(home)
  const native = { captureScreenshot: vi.fn(async (_target: unknown) => captured), writeClipboardImage: vi.fn(async (_image: BrowserPng) => {}) }
  const edit = vi.fn(async (_image: BrowserPng, _attach: boolean, _complete: (png: BrowserPng) => Promise<void>, _context: ScreenshotEditContext) => {})
  // The surface stand-in: Done delivers once, then the surface closes; Esc resolves cancelled.
  const present = vi.fn(async (session: CaptureSurfaceSession): Promise<CaptureSurfaceOutcome> => { await session.complete(image, source, 'fixture-engine'); return { state: 'completed' } })
  const chooseSource = vi.fn(async (mode: 'display' | 'window') => mode === 'display' ? { mode, displayId: 1 } as const : null)
  const reportIssue = vi.fn()
  const appActive = vi.fn(() => true)
  return { home, native, edit, present, chooseSource, reportIssue, appActive, owner: new ScreenCapture({ home, native: () => native, appActive, edit, present, chooseSource, reportIssue }) }
}

it('a region capture is the capture surface; Done copies and saves the same final pixels for the original draft', async () => {
  const f = await fixture(), path = await f.owner.capture(true)
  expect(f.present).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ attachToDraft: true, expandable: true, returnFocus: false }))
  expect(f.native.captureScreenshot, 'no native picker is involved').not.toHaveBeenCalled()
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  expect(path).toBe(join(f.home, '.agentmux', 'pasted', `paste-${deriveObjectId('pasted-image.v1', JSON.stringify([sha256, 'png']))}.png`))
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

it('cancelling the surface makes no delivery', async () => {
  const f = await fixture()
  f.present.mockResolvedValueOnce({ state: 'cancelled' })
  expect(await f.owner.capture(true)).toBeNull()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
})

it('a failed surface start reports its reason and delivers nothing', async () => {
  const f = await fixture(), error = Object.assign(new Error('The display layout changed'), { code: 'display_configuration_changed' })
  f.present.mockRejectedValueOnce(error)
  await expect(f.owner.capture(true)).rejects.toBe(error)
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
})

it('⌘E opens the window editor on the full frozen frame with the marks, and its later Copy is the only delivery', async () => {
  const f = await fixture(), handoff = { shapes: [{ id: 'mark', kind: 'rect' }] as never, crop: { x: 2, y: 2, width: 4, height: 2 }, tool: 'arrow' as const }
  f.present.mockResolvedValueOnce({ state: 'expanded', image, source, handoff, delivered: vi.fn() })
  let finish!: (png: BrowserPng) => Promise<void>, close!: () => void
  f.edit.mockImplementationOnce(async (_image, _attach, complete) => { finish = complete; await new Promise<void>(resolve => { close = resolve }) })
  const pending = f.owner.capture(true)
  await vi.waitFor(() => expect(f.edit).toHaveBeenCalledOnce())
  expect(f.edit.mock.calls[0]![0]).toBe(image)
  expect(f.edit.mock.calls[0]![3]).toEqual({ source, initialState: { shapes: handoff.shapes, crop: handoff.crop }, initialTool: 'arrow', retake: expect.any(Function) })
  expect(f.native.writeClipboardImage, 'nothing is delivered by expanding').not.toHaveBeenCalled()
  const editedBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const edited = { ...image, dataUrl: 'data:image/png;base64,' + editedBytes.toString('base64'), byteLength: editedBytes.length }
  await finish(edited); close()
  expect(await readFile((await pending)!)).toEqual(editedBytes)
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(edited)
})

it('after the original draft has its image, a retake that expands only copies, and the editor delivery is remembered', async () => {
  const f = await fixture(), handoff = { shapes: [], crop: { x: 2, y: 2, width: 4, height: 2 }, tool: 'rect' as const }
  const firstDelivered = vi.fn(), secondDelivered = vi.fn()
  f.present.mockResolvedValueOnce({ state: 'expanded', image, source, handoff, delivered: firstDelivered })
  f.present.mockResolvedValueOnce({ state: 'expanded', image, source, handoff, delivered: secondDelivered })
  let firstFinish!: (png: BrowserPng) => Promise<void>, retake!: () => Promise<unknown>, closeFirst!: () => void
  let secondAttach: boolean | undefined, secondFinish!: (png: BrowserPng) => Promise<void>, closeSecond!: () => void
  f.edit.mockImplementationOnce(async (_image, _attach, complete, context) => {
    firstFinish = complete; retake = context.retake!; await new Promise<void>(resolve => { closeFirst = resolve })
  })
  f.edit.mockImplementationOnce(async (_image, attach, complete) => {
    secondAttach = attach; secondFinish = complete; await new Promise<void>(resolve => { closeSecond = resolve })
  })
  const pending = f.owner.capture(true)
  await vi.waitFor(() => expect(f.edit).toHaveBeenCalledOnce())
  await firstFinish(image)
  expect(firstDelivered, 'the window editor delivery is the selection the next capture opens on').toHaveBeenCalledOnce()
  const saved = (await readdir(f.home, { recursive: true })).filter(name => String(name).endsWith('.png')).length
  const firstTiming = f.present.mock.calls[0]![0].timing!
  const retakeStartedAt = performance.now()
  void retake()
  await vi.waitFor(() => expect(f.edit).toHaveBeenCalledTimes(2))
  const retakeTiming = f.present.mock.calls[1]![0].timing!
  expect(retakeTiming.requestId, 'each surface has its own diagnostic identity').not.toBe(firstTiming.requestId)
  expect(retakeTiming.startedAt, 'Retake does not include the time spent editing').toBeGreaterThanOrEqual(retakeStartedAt)
  expect(retakeTiming.screenCaptureMs).toBeNull()
  expect(f.present.mock.calls[1]![0].attachToDraft, 'a retaken surface does not attach to the delivered draft again').toBe(false)
  expect(secondAttach, 'a retaken editor does not attach to the delivered draft again').toBe(false)
  await secondFinish(image)
  expect((await readdir(f.home, { recursive: true })).filter(name => String(name).endsWith('.png')).length, 'the draft receives no second saved image').toBe(saved)
  expect(f.native.writeClipboardImage, 'the retake still copies').toHaveBeenCalledTimes(2)
  closeSecond(); closeFirst(); await pending
})

it('closing the expanded editor without completion never delivers the frozen frame', async () => {
  const f = await fixture()
  f.present.mockResolvedValueOnce({ state: 'expanded', image, source, handoff: { shapes: [], crop: { x: 0, y: 0, width: 1, height: 1 }, tool: 'rect' }, delivered: vi.fn() })
  expect(await f.owner.capture(true)).toBeNull()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
  expect(await readdir(f.home)).toEqual([])
})

it('a failed clipboard destination keeps the surface open, preserves the saved draft image and reports the partial result', async () => {
  const f = await fixture()
  f.native.writeClipboardImage.mockRejectedValueOnce(new Error('Original clipboard outcome unknown'))
  f.present.mockImplementationOnce(async session => {
    await expect(session.complete(image, source, 'fixture-engine'), 'the surface shows this reason in place').rejects.toThrow('Clipboard copy was not confirmed')
    await session.complete(image, source, 'fixture-engine')
    return { state: 'completed' }
  })
  const path = await f.owner.capture(true)
  expect(await readFile(path!)).toEqual(bytes)
  expect(f.reportIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('Clipboard copy was not confirmed') }))
  expect(f.native.writeClipboardImage, 'Done retries only the unconfirmed clipboard').toHaveBeenCalledTimes(2)
  expect((await readdir(join(f.home, '.agentmux/pasted'))).length, 'the saved draft image is not written twice').toBe(1)
})

it('a failed draft save preserves the independent clipboard result without modifying old resources', async () => {
  const f = await fixture()
  await writeFile(join(f.home, '.agentmux'), 'original user resource')
  f.present.mockImplementationOnce(async session => {
    await expect(session.complete(image, source, 'fixture-engine')).rejects.toThrow('The image is on the clipboard')
    return { state: 'cancelled' }
  })
  expect(await f.owner.capture(true)).toBeNull()
  expect(f.native.writeClipboardImage).toHaveBeenCalledExactlyOnceWith(image)
  expect(f.reportIssue).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: expect.stringContaining('The image is on the clipboard') }))
  expect(await readFile(join(f.home, '.agentmux'), 'utf8')).toBe('original user resource')
})

it('does not join another draft to an in-flight capture', async () => {
  const f = await fixture()
  let finish!: (value: CaptureSurfaceOutcome) => void
  f.present.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = f.owner.capture(true)
  await expect(f.owner.capture(false)).rejects.toThrow('already in progress')
  finish({ state: 'cancelled' }); await pending
  expect(f.present).toHaveBeenCalledOnce()
})

it('closing the surface cannot erase an already submitted delivery or release the capture early', async () => {
  const f = await fixture()
  let delivered!: () => void
  f.native.writeClipboardImage.mockImplementationOnce(() => new Promise<void>(resolve => { delivered = resolve }))
  f.present.mockImplementationOnce(async session => { void session.complete(image, source, 'fixture-engine').catch(() => {}); return { state: 'cancelled' } })
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
  f.present.mockImplementationOnce(async session => {
    await expect(session.complete(image, source, 'fixture-engine')).rejects.toThrow('on the clipboard')
    await rm(join(f.home, '.agentmux'))
    await session.complete(image, source, 'fixture-engine')
    return { state: 'completed' }
  })
  expect(await readFile((await f.owner.capture(true))!)).toEqual(bytes)
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
})

it('unknown clipboard writes retain the original receipt and are not replayed by a second Done', async () => {
  const f = await fixture()
  const original = Object.assign(new Error('Clipboard reply lost'), { code: 'operation_unknown', operation: { state: 'unknown', operationId: 'original-copy', instanceId: 'original-native' } })
  f.native.writeClipboardImage.mockRejectedValueOnce(original)
  f.present.mockImplementationOnce(async session => {
    await expect(session.complete(image, source, 'fixture-engine')).rejects.toThrow('original-copy')
    await expect(session.complete(image, source, 'fixture-engine')).rejects.toMatchObject({ cause: original })
    return { state: 'cancelled' }
  })
  expect(await readFile((await f.owner.capture(true))!)).toEqual(bytes)
  expect(f.native.writeClipboardImage).toHaveBeenCalledOnce()
})

it('asks the surface to return focus only when another app was active at capture start', async () => {
  const f = await fixture()
  await f.owner.capture(false)
  expect(f.present.mock.calls[0]![0].returnFocus).toBe(false)
  f.appActive.mockReturnValue(false)
  await f.owner.capture(false)
  expect(f.present.mock.calls[1]![0].returnFocus).toBe(true)
  f.present.mockResolvedValueOnce({ state: 'expanded', image, source, handoff: { shapes: [], crop: { x: 0, y: 0, width: 1, height: 1 }, tool: 'rect' }, delivered: vi.fn() })
  await f.owner.capture(false)
  expect(f.edit.mock.calls[0]![3], 'the expanded editor returns focus instead').toMatchObject({ returnFocus: true })
})

it('display and window captures still use the exact native source and open the window editor with it', async () => {
  vi.useFakeTimers({ now: new Date(2026, 0, 2, 3, 4, 5), toFake: ['Date'] })
  try {
    const f = await fixture(), rect = { x: -1200, y: 40, width: 640, height: 360 }
    f.native.captureScreenshot.mockResolvedValueOnce({ ...captured, selectionRect: rect } as never)
    await f.owner.capture(false, 'display')
    expect(f.native.captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'display', displayId: 1 })
    expect(f.present).not.toHaveBeenCalled()
    expect(f.edit.mock.calls[0]![3]).toEqual({ source: { rect, scale: 2, capturedAt: new Date(2026, 0, 2, 3, 4, 5).getTime() } })
    expect(await f.owner.capture(false, 'window'), 'a dismissed source picker captures nothing').toBeNull()
    expect(f.native.captureScreenshot).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})

it.each([{ state: 'captured' }, { ...captured, screenshot: { ...captured.screenshot, width: 2 } }, { state: 'unknown' }])('rejects missing or mismatched display evidence %j before delivery', async result => {
  const f = await fixture()
  f.native.captureScreenshot.mockResolvedValueOnce(result as never)
  await expect(f.owner.capture(true, 'display')).rejects.toThrow()
  expect(f.native.writeClipboardImage).not.toHaveBeenCalled()
})

it('a delayed region capture waits for its countdown and a cancelled countdown captures nothing', async () => {
  const f = await fixture(), countdown = vi.fn(async (_seconds: number) => true)
  const owner = new ScreenCapture({ home: f.home, native: () => f.native, appActive: () => true, edit: f.edit, present: f.present, reportIssue: f.reportIssue, countdown })
  expect(await owner.capture(false, 'selection', { delaySeconds: 5 })).toBeNull()
  expect(countdown).toHaveBeenCalledExactlyOnceWith(5)
  expect(f.present).toHaveBeenCalledOnce()
  expect(countdown.mock.invocationCallOrder[0]).toBeLessThan(f.present.mock.invocationCallOrder[0]!)
  countdown.mockResolvedValueOnce(false)
  expect(await owner.capture(false, 'selection', { delaySeconds: 3 })).toBeNull()
  expect(f.present, 'a cancelled countdown starts no selection').toHaveBeenCalledOnce()
  await expect(owner.capture(false, 'display', { delaySeconds: 3 })).rejects.toThrow('region capture')
  await expect(owner.capture(false, 'selection', { delaySeconds: 4 as never })).rejects.toThrow('3, 5 or 10')
  await expect(f.owner.capture(false, 'selection', { delaySeconds: 3 })).rejects.toThrow('unavailable in this host')
  expect(countdown).toHaveBeenCalledTimes(2)
})

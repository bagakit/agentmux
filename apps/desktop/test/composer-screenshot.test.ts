import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureComposerScreenshot } from '../src/main/composer-screenshot'
import { readPastedImage } from '../src/main/pasted-image-read'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V8AAAAASUVORK5CYII=', 'base64')
const captured = { state: 'captured' as const, screenshot: { format: 'png' as const, data: bytes.toString('base64'), width: 1, height: 1, scale: 2 } }
const homes: string[] = []
async function home() { const value = await mkdtemp(join(tmpdir(), 'amux-native-composer-')); homes.push(value); return value }
afterEach(async () => { await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

it('saves the original native selection through the durable pasted owner and reads the existing preview', async () => {
  const directory = await home(), captureScreenshot = vi.fn(async () => captured)
  const path = await captureComposerScreenshot(directory, { captureScreenshot })
  expect(captureScreenshot).toHaveBeenCalledExactlyOnceWith({ mode: 'selection' })
  expect(path).toMatch(/\.agentmux\/pasted\/[a-f0-9]{64}\.png$/)
  expect(await readFile(path!)).toEqual(bytes)
  expect(await readPastedImage(directory, path!)).toEqual({ dataUrl: 'data:image/png;base64,' + bytes.toString('base64') })
})

it('treats only the native cancellation receipt as cancellation and leaves resources absent', async () => {
  const directory = await home()
  expect(await captureComposerScreenshot(directory, { captureScreenshot: vi.fn(async () => ({ state: 'cancelled' as const })) })).toBeNull()
  await expect(readFile(join(directory, '.agentmux/pasted'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains the actual native failure rather than guessing permissions or cancellation', async () => {
  const directory = await home()
  await expect(captureComposerScreenshot(directory, { captureScreenshot: vi.fn(async () => ({
    state: 'failed' as const, error: { code: 'capture_failed', message: 'Original display disappeared' }
  })) })).rejects.toThrow(/capture_failed.*Original display disappeared.*draft.*remain/)
})

it('preserves the original unknown operation without automatic replay and permits an explicit next request', async () => {
  const directory = await home()
  const failure = Object.assign(new Error('Original capture outcome is unknown'), { code: 'operation_unknown', operation: { operationId: 'original', instanceId: 'original-instance' } })
  const captureScreenshot = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({ state: 'cancelled' })
  await expect(captureComposerScreenshot(directory, { captureScreenshot })).rejects.toBe(failure)
  expect(captureScreenshot).toHaveBeenCalledTimes(1)
  expect(await captureComposerScreenshot(directory, { captureScreenshot })).toBeNull()
  expect(captureScreenshot).toHaveBeenCalledTimes(2)
})

it('does not join another Composer to an in-flight picker or save', async () => {
  const directory = await home()
  let resolve!: (value: typeof captured) => void
  const captureScreenshot = vi.fn(() => new Promise<typeof captured>(done => { resolve = done }))
  const pending = captureComposerScreenshot(directory, { captureScreenshot })
  await expect(captureComposerScreenshot(directory, { captureScreenshot })).rejects.toThrow(/already in progress/)
  expect(captureScreenshot).toHaveBeenCalledTimes(1)
  resolve(captured)
  expect(await pending).not.toBeNull()
})

it.each([
  { state: 'captured', screenshot: undefined },
  { state: 'captured', screenshot: { ...captured.screenshot, width: 2 } },
  { state: 'unknown' }
])('refuses missing or mismatched image evidence %j instead of returning a path', async result => {
  const directory = await home()
  await expect(captureComposerScreenshot(directory, { captureScreenshot: vi.fn(async () => result as never) })).rejects.toThrow()
})

it('reports a failed save without silently switching to a new screenshot or removing old resources', async () => {
  const directory = await home()
  await writeFile(join(directory, '.agentmux'), 'original user resource')
  const captureScreenshot = vi.fn(async () => captured)
  await expect(captureComposerScreenshot(directory, { captureScreenshot })).rejects.toThrow(/save is unconfirmed/)
  expect(captureScreenshot).toHaveBeenCalledTimes(1)
  expect(await readFile(join(directory, '.agentmux'), 'utf8')).toBe('original user resource')
})

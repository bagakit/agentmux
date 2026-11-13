import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { exportScreenshotPng, saveScreenshotPng, screenshotFileName, screenshotFileRevision, writeScreenshotFile } from '../src/main/screenshot-files'

const electron = vi.hoisted(() => ({ saves: [] as Array<{ parent: unknown; options: Record<string, unknown> }> }))
vi.mock('electron', () => ({ nativeImage: {}, dialog: { showSaveDialog: async (parent: unknown, options: Record<string, unknown>) => {
  electron.saves.push({ parent, options }); return { canceled: true } } } }))

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWZkAAAAASUVORK5CYII=', 'base64')
const image = pngFromBytes(bytes)
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'agentmux-image-export-')); directories.push(path); return path }
// A fixed local capture time; the name must follow local wall-clock fields, not UTC.
const capturedAt = new Date(2026, 0, 2, 3, 4, 5).getTime()
const request = { capturedAt }
const keep = () => { throw new Error('A 1x resize must not run for a pixel-exact save') }
const ports = (chooseFile: (name: string) => Promise<string | null>, writeFile = writeScreenshotFile, resize: (bytes: Uint8Array, size: { width: number; height: number }) => Uint8Array = keep) =>
  ({ chooseFile, writeFile, resize })

it('exports the actual processed PNG bytes to the user chosen destination', async () => {
  const root = await directory(), path = join(root, 'processed.png'), original = Buffer.from('existing user file')
  await writeFile(path, original)
  const result = await exportScreenshotPng(image, request, ports(async () => path))
  expect(result).toEqual({ status: 'saved', path, revision: screenshotFileRevision(bytes) })
  expect(await readFile(path), 'the chosen file must contain the exact processed PNG').toEqual(bytes)
  expect(await readdir(root)).toEqual(['processed.png'])
})

it('cancelling the native save choice writes no file and keeps the image', async () => {
  const write = vi.fn(async () => {})
  expect(await exportScreenshotPng(image, request, ports(async () => null, write))).toEqual({ status: 'cancelled' })
  expect(write, 'save cancellation must have no write effect').not.toHaveBeenCalled()
  expect(image.dataUrl).toBe(pngFromBytes(bytes).dataUrl)
})

it('validates image bytes before asking for a destination', async () => {
  const choose = vi.fn(async () => null)
  await expect(exportScreenshotPng({ ...image, width: 20 }, request, ports(choose))).rejects.toThrow('dimensions')
  expect(choose).not.toHaveBeenCalled()
})

it('reports an unconfirmed write with its original path without retrying or losing the source', async () => {
  const root = await directory(), path = join(root, 'result.png'), write = vi.fn(async () => { throw new Error('the original sink lost its reply') })
  const result = await exportScreenshotPng(image, request, ports(async () => path, write))
  expect(result).toMatchObject({ status: 'unknown' })
  expect('message' in result && result.message).toContain(path)
  expect(write).toHaveBeenCalledOnce()
})

it('a failed file preparation leaves the existing chosen file unchanged', async () => {
  const root = await directory(), path = join(root, 'kept.png')
  await writeFile(path, bytes)
  await expect(writeScreenshotFile(join(path, 'invalid-child'), bytes)).rejects.toThrow()
  expect(await readFile(path)).toEqual(bytes)
})

it('names the save choice by the local capture time', async () => {
  const choose = vi.fn(async (_name: string) => null)
  await exportScreenshotPng(image, request, ports(choose))
  expect(choose).toHaveBeenCalledWith('Screenshot 2026-01-02 at 03.04.05.png')
  expect(screenshotFileName(new Date(2026, 10, 30, 23, 59, 9).getTime())).toBe('Screenshot 2026-11-30 at 23.59.09.png')
})

it('saves at 1x logical size by halving a scale 2 image before choosing a destination', async () => {
  const root = await directory(), path = join(root, 'logical.png')
  const source = pngFromBytes(grayPng(4, 2))
  const resize = vi.fn((_bytes: Uint8Array, _size: { width: number; height: number }) => bytes)
  const result = await exportScreenshotPng(source, { capturedAt, logicalScale: 2 }, ports(async () => path, writeScreenshotFile, resize))
  expect(resize).toHaveBeenCalledOnce()
  expect(resize.mock.calls[0]![1], 'the 1x size is the pixel size divided by the display scale').toEqual({ width: 2, height: 1 })
  expect(result).toEqual({ status: 'saved', path, revision: screenshotFileRevision(bytes) })
})

it('a pixel-exact save never resizes', async () => {
  const root = await directory(), path = join(root, 'pixels.png')
  for (const logicalScale of [undefined, 1]) {
    const result = await exportScreenshotPng(image, { capturedAt, ...(logicalScale ? { logicalScale } : {}) }, ports(async () => path))
    expect(result).toMatchObject({ status: 'saved' })
    expect(await readFile(path)).toEqual(bytes)
  }
})

it('the native save sheet names the capture, belongs to the image window and confirms replacing a file', async () => {
  electron.saves.length = 0
  const parent = { isDestroyed: () => false }
  expect(await saveScreenshotPng(image, parent as never, request)).toEqual({ status: 'cancelled' })
  expect(electron.saves).toHaveLength(1)
  expect(electron.saves[0]!.parent).toBe(parent)
  expect(electron.saves[0]!.options).toMatchObject({ defaultPath: 'Screenshot 2026-01-02 at 03.04.05.png', title: 'Save PNG' })
  expect(electron.saves[0]!.options.properties, 'an existing file is replaced only after the sheet confirms it').toContain('showOverwriteConfirmation')
})

function grayPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4)
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body))
    return Buffer.concat([size, body, crc])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0
  const rows = Buffer.alloc((width + 1) * height)
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

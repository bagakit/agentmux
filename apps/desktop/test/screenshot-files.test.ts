import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pngFromBytes } from '@agentmux/native-desktop/image'
import { exportScreenshotPng, screenshotFileRevision, writeScreenshotFile } from '../src/main/screenshot-files'

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cWZkAAAAASUVORK5CYII=', 'base64')
const image = pngFromBytes(bytes)
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function directory() { const path = await mkdtemp(join(tmpdir(), 'agentmux-image-export-')); directories.push(path); return path }

it('exports the actual processed PNG bytes to the user chosen destination', async () => {
  const root = await directory(), path = join(root, 'processed.png'), original = Buffer.from('existing user file')
  await writeFile(path, original)
  const result = await exportScreenshotPng(image, { chooseFile: async () => path, writeFile: writeScreenshotFile })
  expect(result).toEqual({ status: 'saved', path, revision: screenshotFileRevision(bytes) })
  expect(await readFile(path), 'the chosen file must contain the exact processed PNG').toEqual(bytes)
  expect(await readdir(root)).toEqual(['processed.png'])
})

it('cancelling the native save choice writes no file and keeps the image', async () => {
  const write = vi.fn(async () => {})
  expect(await exportScreenshotPng(image, { chooseFile: async () => null, writeFile: write })).toEqual({ status: 'cancelled' })
  expect(write, 'save cancellation must have no write effect').not.toHaveBeenCalled()
  expect(image.dataUrl).toBe(pngFromBytes(bytes).dataUrl)
})

it('validates image bytes before asking for a destination', async () => {
  const choose = vi.fn(async () => null)
  await expect(exportScreenshotPng({ ...image, width: 20 }, { chooseFile: choose, writeFile: writeScreenshotFile })).rejects.toThrow('dimensions')
  expect(choose).not.toHaveBeenCalled()
})

it('reports an unconfirmed write with its original path without retrying or losing the source', async () => {
  const root = await directory(), path = join(root, 'result.png'), write = vi.fn(async () => { throw new Error('the original sink lost its reply') })
  const result = await exportScreenshotPng(image, { chooseFile: async () => path, writeFile: write })
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

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, expect, it, vi } from 'vitest'

const decoder = vi.hoisted(() => ({ createFromBuffer: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: decoder }))
import { validateBrowserOperatorAvatarPng } from '../src/main/browser-operator-avatar.js'

const bytes = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/client-ui/src/assets/agent-icons/gemini.png'))
const dataUrl = (value: Buffer) => `data:image/png;base64,${value.toString('base64')}`
beforeEach(() => { decoder.createFromBuffer.mockReset().mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 64, height: 64 }) }) })

it('preserves actual bundled PNG bytes after the original native decoder confirms 64 by 64', () => {
  const png = dataUrl(bytes)
  expect(validateBrowserOperatorAvatarPng(png)).toBe(png)
  expect(decoder.createFromBuffer).toHaveBeenCalledExactlyOnceWith(bytes)
})

it('rejects noncanonical base64 and oversized bytes before native decoding', () => {
  const png = dataUrl(bytes)
  for (const invalid of [png + '\n', png.replace('base64,', 'base64, '), 'data:image/svg+xml,<svg/>',
    dataUrl(Buffer.concat([bytes, Buffer.alloc(65_537 - bytes.length)])), 'data:image/png;base64,AB==']) {
    expect(validateBrowserOperatorAvatarPng(invalid)).toBeUndefined()
  }
  expect(decoder.createFromBuffer).not.toHaveBeenCalled()
})

it('requires the original PNG signature and IHDR with exact encoded geometry before decoding', () => {
  const width = Buffer.from(bytes); width.writeUInt32BE(32, 16)
  const chunk = Buffer.from(bytes); chunk.write('IDAT', 12, 'ascii')
  const signature = Buffer.from(bytes); signature[0] = 0
  for (const invalid of [width, chunk, signature, bytes.subarray(0, 24)]) expect(validateBrowserOperatorAvatarPng(dataUrl(invalid))).toBeUndefined()
  expect(decoder.createFromBuffer).not.toHaveBeenCalled()
})

it('does not trust IHDR alone when the real decoder is empty, mismatched or unavailable', () => {
  for (const result of [{ isEmpty: () => true, getSize: () => ({ width: 64, height: 64 }) },
    { isEmpty: () => false, getSize: () => ({ width: 32, height: 64 }) }]) {
    decoder.createFromBuffer.mockReturnValue(result)
    expect(validateBrowserOperatorAvatarPng(dataUrl(bytes))).toBeUndefined()
  }
  decoder.createFromBuffer.mockImplementation(() => { throw new Error('Native decoding unavailable') })
  expect(validateBrowserOperatorAvatarPng(dataUrl(bytes))).toBeUndefined()
})

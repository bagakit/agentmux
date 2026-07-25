import { describe, expect, it, vi } from 'vitest'
import {
  browserPngFromNativeImage,
  nativeImageFromBrowserPng
} from '../src/main/browser-image.js'

function png(width = 4, height = 3, trailingBytes = 0): Buffer {
  const value = Buffer.alloc(33 + trailingBytes)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(value)
  value.writeUInt32BE(13, 8)
  value.write('IHDR', 12, 'ascii')
  value.writeUInt32BE(width, 16)
  value.writeUInt32BE(height, 20)
  value[24] = 8
  value[25] = 6
  return value
}

function image(bytes = png(), width = 4, height = 3) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => bytes
  }
}

describe('Browser PNG boundary', () => {
  it('encodes a captured NativeImage into the bounded public contract', () => {
    expect(browserPngFromNativeImage(image() as never)).toEqual({
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${png().toString('base64')}`,
      width: 4,
      height: 3,
      byteLength: png().byteLength
    })
  })

  it('decodes only a matching PNG payload for clipboard delivery', () => {
    const input = browserPngFromNativeImage(image() as never)
    const create = vi.fn(() => image())

    expect(nativeImageFromBrowserPng(input, create as never)).toBe(create.mock.results[0]?.value)
    expect(create).toHaveBeenCalledWith(png())
  })

  it('rejects malformed, mismatched, and oversized image claims', () => {
    const input = browserPngFromNativeImage(image() as never)
    const create = vi.fn(() => image())

    expect(() => nativeImageFromBrowserPng({ ...input, dataUrl: 'data:image/jpeg;base64,eA==' }, create as never))
      .toThrow('PNG data URL')
    expect(() => nativeImageFromBrowserPng({
      ...input,
      dataUrl: `data:image/png;base64,${Buffer.from('not a png').toString('base64')}`,
      byteLength: Buffer.byteLength('not a png')
    }, create as never)).toThrow('not a PNG')
    expect(() => nativeImageFromBrowserPng({ ...input, byteLength: input.byteLength + 1 }, create as never))
      .toThrow('byte length')
    expect(() => nativeImageFromBrowserPng(input, (() => image(png(), 5, 3)) as never))
      .toThrow('dimensions do not match')
    expect(() => browserPngFromNativeImage(image(png(16_385, 1), 16_385, 1) as never))
      .toThrow('dimensions exceed')
    expect(create).not.toHaveBeenCalledWith(Buffer.from('not a png'))
  })

  it('validates IHDR claims before calling the native decoder', () => {
    const encoded = png(16_385, 1)
    const create = vi.fn(() => image(encoded, 16_385, 1))
    const input = {
      mimeType: 'image/png' as const,
      dataUrl: `data:image/png;base64,${encoded.toString('base64')}`,
      width: 16_385,
      height: 1,
      byteLength: encoded.byteLength
    }

    expect(() => nativeImageFromBrowserPng(input, create as never)).toThrow('dimensions exceed')
    expect(create).not.toHaveBeenCalled()
  })
})

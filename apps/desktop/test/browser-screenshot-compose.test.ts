import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/shared/contracts.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/shared/contracts.js')>(),
  BROWSER_PNG_MAX_BYTES: 3
}))

import {
  composeScreenshot,
  dataUrlByteLength,
  screenshotCanvasSize
} from '../src/renderer/src/components/browser-screenshot/compose.js'

let encodedPng = 'data:image/png;base64,AQID'

function fakeCanvas() {
  return {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toBlob: (callback: BlobCallback) => callback({} as Blob)
  }
}

class FakeFileReader {
  result: string | ArrayBuffer | null = null
  error: DOMException | null = null
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null

  readAsDataURL(): void {
    this.result = encodedPng
    this.onload?.({} as ProgressEvent<FileReader>)
  }
}

describe('Browser screenshot composition', () => {
  beforeEach(() => {
    encodedPng = 'data:image/png;base64,AQID'
    vi.stubGlobal('document', { createElement: () => fakeCanvas() })
    vi.stubGlobal('FileReader', FakeFileReader)
  })

  afterEach(() => vi.unstubAllGlobals())

  it('computes bounded output geometry and exact base64 byte counts', () => {
    expect(screenshotCanvasSize(100, 50, 2)).toEqual({ width: 200, height: 100, scale: 2 })
    expect(() => screenshotCanvasSize(0, 50, 1)).toThrow('no drawable area')
    expect(dataUrlByteLength('data:image/png;base64,AQID')).toBe(3)
    expect(dataUrlByteLength('data:image/png;base64,AQ==')).toBe(1)
    expect(dataUrlByteLength('not-a-data-url')).toBe(0)
  })

  it('returns a PNG only when an encoded candidate is within the byte limit', async () => {
    await expect(composeScreenshot({
      image: {} as CanvasImageSource,
      displayWidth: 10,
      displayHeight: 5,
      outputScale: 1,
      shapes: []
    })).resolves.toEqual({
      mimeType: 'image/png',
      dataUrl: encodedPng,
      width: 10,
      height: 5,
      byteLength: 3
    })
  })

  it('fails instead of returning the smallest PNG when every candidate is still oversized', async () => {
    encodedPng = 'data:image/png;base64,AQIDBA=='
    await expect(composeScreenshot({
      image: {} as CanvasImageSource,
      displayWidth: 10,
      displayHeight: 5,
      outputScale: 1,
      shapes: []
    })).rejects.toThrow('remains above the image byte limit')
  })
})

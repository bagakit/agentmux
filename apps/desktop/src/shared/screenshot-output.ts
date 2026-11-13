import type { BrowserPng } from './contracts'

export type ScreenshotFileResult = { status: 'saved'; path: string; revision: string } | { status: 'cancelled' } |
  { status: 'conflict' | 'unknown' | 'failed'; message: string }
export type ScreenshotPngExport = { operationId: string; image: BrowserPng }
/** One processed PNG save. The capture time names the file; each call opens its own save sheet. */
export type ScreenshotPngSave = { image: BrowserPng; capturedAt: number }

import type { BrowserPng } from './contracts'

export type ScreenshotFileResult = { status: 'saved'; path: string; revision: string } | { status: 'cancelled' } |
  { status: 'conflict' | 'unknown' | 'failed'; message: string }
export type ScreenshotPngExport = { operationId: string; image: BrowserPng }

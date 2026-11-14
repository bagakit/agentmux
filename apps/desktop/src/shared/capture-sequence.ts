import type { BrowserPng } from './contracts'
import type { ThemeBootstrap } from './theme-bootstrap'
import type { ScreenshotCaptureSource } from './system-screenshot-editor'

export type CaptureSequenceMode = 'scroll' | 'gif'
export type SequenceFrame = { image: BrowserPng; capturedAt: number; delayMs: number }
export type GifKeyframe = { frameIndex: number; note: string }
export type GifMetadata = { schema: 'agentmux.gif.v1'; width: number; height: number; delays: number[]; keyframes: GifKeyframe[] }
export type SequenceSnapshot = { requestId: string; mode: CaptureSequenceMode; state: 'ready' | 'recording' | 'stopping' | 'review'; frames: SequenceFrame[]; frameOffset?: number; issue: string | null }
export type CaptureSequenceInput = SequenceSnapshot & { theme: ThemeBootstrap; background?: import('./capture-surface').CaptureBackground; source: ScreenshotCaptureSource }
export const CAPTURE_SEQUENCE_CHANNEL = 'capture:sequence'
export type CaptureSequenceApi = {
  load(): Promise<CaptureSequenceInput>
  sample(requestId: string): Promise<SequenceSnapshot>
  start(requestId: string, fps: number): Promise<SequenceSnapshot>
  stop(requestId: string): Promise<SequenceSnapshot>
  inspect(requestId: string, afterFrames?: number): Promise<SequenceSnapshot>
  undo(requestId: string): Promise<SequenceSnapshot>
  finishScroll(requestId: string, image: BrowserPng): Promise<void>
  saveGif(requestId: string, data: number[]): Promise<{ status: 'saved' | 'cancelled'; path?: string }>
  openGif(requestId: string): Promise<number[] | null>
  attachGif(requestId: string, data: number[]): Promise<void>
  cancel(requestId: string): Promise<void>
}

import type { NativeDesktopJson } from './public-rpc-native-desktop.js'

export interface NativeDesktopApp {
  name: string; bundleId: string | null; pid: number; processStartedAt: number | null
  isRunning?: boolean; lastUsedAt?: null; useCount?: null
}
export interface NativeDesktopRect { x: number; y: number; width: number; height: number }
export interface NativeDesktopWindow extends NativeDesktopRect {
  id: number; title: string; isMinimized?: boolean; isOffscreen?: boolean; screenIndex?: number | null
}
export interface NativeDesktopPng { format: 'png'; data: string; width: number; height: number; scale: number }
export interface NativeDesktopSnapshot {
  snapshotId: string
  snapshot: {
    id: string; app: NativeDesktopApp; window: NativeDesktopWindow; coordinateSpace: 'window'
    treeText: string; elementCount: number; elements: Array<{ index: number; actions: string[]; frame: NativeDesktopRect | null }>
    focusedElementId: number | null; truncation: { truncated: boolean; maxNodes: number; maxDepth: number; maxDepthReached: boolean }
  }
  screenshot: NativeDesktopPng | null
  screenshotStatus: { state: 'captured' | 'skipped' | 'failed'; reason?: string; code?: string; message?: string; metadata?: NativeDesktopJson }
}
export interface NativeDesktopActionReceipt {
  path: 'accessibility' | 'synthetic' | 'clipboard'; actionName: string | null; fallbackReason: string | null
  targetWindowId: number
  verification?: {
    state: 'verified' | 'unverified' | 'accepted' | 'failed'; property?: string; reason?: string
    expected?: string | null; actualPreview?: string | null; completedPages?: number; requestedPages?: number
    error?: { code: string; message: string }; clipboardChangeCount?: number
    clipboardRestoration?: 'retained_for_paste'
  }
}
export interface NativeDesktopOperationReceipt {
  operationId: string; instanceId: string; state: 'pending' | 'completed' | 'failed' | 'unknown'
  requestId?: number; method?: string; reason?: string; resultAvailability?: 'retained' | 'expired'
  result?: NativeDesktopJson; error?: { code: string; message: string }
}
export type NativeDesktopPayloadMap = {
  'native.capabilities': { platform: 'darwin'; provider: 'agentmux-native-macos'; providerVersion: string; protocolVersion: 1; instanceId: string; supports: Record<string, Record<string, boolean>> }
  'native.apps.list': { apps: NativeDesktopApp[] }
  'native.displays.list': { displays: Array<NativeDesktopRect & { id: number; scale: number; isMain: boolean }> }
  'native.windows.list': { app: NativeDesktopApp; windows: Array<NativeDesktopWindow & { app: NativeDesktopApp; index: number }> }
  'native.snapshot': NativeDesktopSnapshot
  'native.permissions.inspect': { accessibility: 'granted' | 'not-granted'; screenshots: 'granted' | 'not-granted'; source: 'macOS-preflight'; authoritativeForOperation: false }
  'native.capture': { state: 'captured'; screenshot: NativeDesktopPng; engine: string; selectionRect: NativeDesktopRect }
    | { state: 'cancelled' } | { state: 'failed'; error: { code: string; message: string } }
  'native.clipboard.read': { format: 'text' | 'png'; state: 'read'; data: string; changeCount: number }
    | { format: 'text' | 'png'; state: 'empty'; data: null; changeCount: number }
  'native.clipboard.write': { format: 'text' | 'png'; state: 'written'; byteLength: number; changeCount: number }
  'native.action': (NativeDesktopSnapshot | { observation: { state: 'failed'; error: { code: string; message: string } } }) & { action: NativeDesktopActionReceipt }
  'native.operation.inspect': NativeDesktopOperationReceipt
}

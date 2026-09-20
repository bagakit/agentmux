import type { BrowserReplayTarget } from './browser-operation.js'

export type BrowserTaskParameter = { key: string; label: string; secret: boolean }
export type BrowserTaskStep = {
  id: string
  kind: 'click' | 'fill' | 'navigate' | 'checkpoint'
  /** Redacted page identity, never a stored input value. */
  url: string
  target?: BrowserReplayTarget
  parameterKey?: string
  label?: string
  reviewed: boolean
  warning?: string
}
export type BrowserTaskContent = { name: string; url: string; steps: BrowserTaskStep[]; parameters: BrowserTaskParameter[] }
export type BrowserTaskVersion = BrowserTaskContent & { version: number; savedAt: number }
export type BrowserTaskAsset = {
  id: string
  browserId: string
  sourceRecordingId: string
  revision: number
  draft: BrowserTaskContent
  versions: BrowserTaskVersion[]
  createdAt: number
  updatedAt: number
}
/** Client progress references real journal operations. Waiting is not an approval fact. */
export type BrowserTaskAssetRun = {
  id: string
  assetId: string
  version: number
  browserId: string
  nextStep: number
  status: 'ready' | 'running' | 'waiting-human' | 'completed' | 'interrupted' | 'failed' | 'stopped'
  operationIds: string[]
  pendingCheckpointId?: string
  warning?: string
  startedAt: number
  updatedAt: number
}
export type BrowserTaskAssetDocument = { version: 1; assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[] }
export type BrowserTaskAssetState = { assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[]; warning?: string }
export type BrowserTaskAssetRunInput = {
  assetId: string
  version: number
  browserId: string
  /** Values exist only for this invocation. Secret values must be supplied again after a checkpoint. */
  parameters: Record<string, string>
  mode?: 'run' | 'step'
  runId?: string
}

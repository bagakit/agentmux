import type { BrowserReplayTarget } from './browser-operation.js'
import type { BrowserOutcomeHumanFact } from './browser-outcome-criteria.js'

export type BrowserTaskHumanCheckpoint = BrowserOutcomeHumanFact & { pendingCursor: number }
export type BrowserTaskRunIdentity = { runId: string; browserId: string; assetId: string; version: number }
export type BrowserTaskHumanCheckpointSaved = { saved: boolean; fact: BrowserTaskHumanCheckpoint | null; warning?: string }
export type BrowserTaskHumanCheckpointRead =
  | { status: 'available'; fact: BrowserTaskHumanCheckpoint }
  | { status: 'not-recorded' }
  | { status: 'unavailable'; warning: string }

export type BrowserTaskParameter = { key: string; label: string; secret: boolean }
export type BrowserTaskBranch = {
  condition: { kind: 'page-url-is'; url: string } | { kind: 'element-present'; target: { role: string; name: string } }
  /** Explicit forward step identities; null finishes this path. */
  onTrue: string | null
  onFalse: string | null
}
export type BrowserTaskStep = {
  id: string
  kind: 'click' | 'fill' | 'navigate' | 'checkpoint' | 'branch'
  /** Redacted page identity, never a stored input value. */
  url: string
  target?: BrowserReplayTarget
  parameterKey?: string
  label?: string
  branch?: BrowserTaskBranch
  /** Absent keeps the original ordered next step. Checkpoints retain that order. */
  nextStepId?: string | null
  reviewed: boolean
  warning?: string
}
export type BrowserTaskCompletion = { criteria: (
  | { kind: 'download-readable'; stepId: string; path: string }
  | { kind: 'human-checkpoint'; checkpointId: string }
)[] }
export type BrowserTaskStepExecution = BrowserTaskRunIdentity & { stepId: string; expectedNavigationId?: string; deadlineMillis?: number }
export type BrowserTaskContent = { name: string; url: string; steps: BrowserTaskStep[]; parameters: BrowserTaskParameter[]; completion?: BrowserTaskCompletion }
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
  /** Original journal operations bound to the actual executed step, not a linear index guess. */
  stepExecutions?: { stepId: string; operationId: string }[]
  branchDecisions?: { stepId: string; operationId: string; navigationId: string; result: 'true' | 'false' | 'unknown'; nextStepId?: string | null }[]
  executedMillis?: number
  pendingCheckpointId?: string
  /** Main-created trusted Continue events. Absence means their recording information is unavailable. */
  humanCheckpoints?: BrowserTaskHumanCheckpoint[]
  completionWarning?: string
  warning?: string
  startedAt: number
  updatedAt: number
}
export type BrowserTaskAssetDocument = { version: 1; assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[]; selectedRuns?: { browserId: string; runId: string }[] }
export type BrowserTaskAssetState = { assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[]; selectedRunId?: string | null; warning?: string }
export type BrowserTaskAssetRunInput = {
  assetId: string
  version: number
  browserId: string
  /** Values exist only for this invocation. Secret values must be supplied again after a checkpoint. */
  parameters: Record<string, string>
  mode?: 'run' | 'step'
  runId?: string
}

import type { BrowserTaskParallelRecord, BrowserTaskParallelSelection, BrowserTaskParallelSummary } from './browser-task-parallel.js'
import type { BrowserTaskCreateInput } from '@agentmux/core/control'
import type { BrowserReplayTarget, BrowserOutcomeHumanFact } from '@agentmux/browser/model'

export type BrowserTaskHumanCheckpoint = BrowserOutcomeHumanFact & { pendingCursor: number }
export type BrowserTaskRunIdentity = { runId: string; browserId: string; assetId: string; version: number }
export type BrowserTaskHumanCheckpointSaved = { saved: boolean; fact: BrowserTaskHumanCheckpoint | null; warning?: string }
export type BrowserTaskHumanCheckpointRead =
  | { status: 'available'; fact: BrowserTaskHumanCheckpoint }
  | { status: 'not-recorded' }
  | { status: 'unavailable'; warning: string }

export type BrowserTaskParameter = { key: string; label: string; secret: boolean }
export type BrowserTaskSubflow = { target:
  | { kind: 'local'; assetId: string; version: number }
  | { kind: 'imported'; source: { assetId: string; version: number } }; iteration: 'once' | 'each' }
export type BrowserTaskBranch = {
  condition: { kind: 'page-url-is'; url: string } | { kind: 'element-present'; target: { role: string; name: string } }
  /** Explicit forward step identities; null finishes this path. */
  onTrue: string | null
  onFalse: string | null
}
export type BrowserTaskSemanticTarget = { role: string; name: string }
/** Read-only page facts a wait step polls until they hold or its timeout ends. */
export type BrowserTaskWait = { kind: 'element-present'; target: BrowserTaskSemanticTarget } | { kind: 'url-is'; url: string }
/** Read-only page facts an assert step observes once; it never changes the page. */
export type BrowserTaskAssertion =
  | { kind: 'element-present' | 'element-absent'; target: BrowserTaskSemanticTarget }
  | { kind: 'url-is'; url: string }
  | { kind: 'text-present'; text: string }
/** What a page step does after its script failed and its retries are spent. Absent means stop. */
export type BrowserTaskStepFailure = 'stop' | 'continue' | { goto: string }
export type BrowserTaskStep = {
  id: string
  kind: 'extract' | 'click' | 'fill' | 'upload' | 'navigate' | 'checkpoint' | 'branch' | 'wait' | 'assert' | 'press' | 'hover' | 'scroll' | 'drag' | 'tap' | 'longPress' | 'swipe' | 'pinch' | 'subflow'
  /** Redacted page identity, never a stored input value. */
  url: string
  target?: BrowserReplayTarget
  /** Drag or swipe: the independently resolved semantic destination. */
  destination?: BrowserReplayTarget
  /** Long press only: native contact duration; absent uses 600 ms. */
  durationMs?: number
  /** Pinch only: final contact separation divided by its initial separation. */
  scale?: number
  parameterKey?: string
  /** Upload paths are fresh invocation parameters, never saved file selections. */
  parameterKeys?: string[]
  /** Answer only the dialog opened during this click, in its original operation. */
  dialog?: { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; action: 'accept' | 'dismiss'; promptParameterKey?: string }
  subflow?: BrowserTaskSubflow
  /** Saved schema only; withinRef belongs to one live program and cannot be retained. */
  extraction?: Omit<import('@agentmux/browser/model').BrowserStructuredOutputRequest, 'withinRef'>
  label?: string
  branch?: BrowserTaskBranch
  wait?: BrowserTaskWait
  /** Wait steps only: how long the condition may take to hold. */
  timeoutMs?: number
  assert?: BrowserTaskAssertion
  /** Press steps only: one KeyboardEvent key value sent to the target. */
  key?: string
  /** Page steps only; checkpoints and conditions keep their own continuation rules. */
  onFail?: BrowserTaskStepFailure
  /** Extra attempts after a script failure (0-3). Unknown or stopped results are never retried. */
  retry?: number
  /** Absent keeps the original ordered next step. Checkpoints retain that order. */
  nextStepId?: string | null
  reviewed: boolean
  warning?: string
}
/** The original definition owns all fresh invocation bindings. */
export function browserTaskStepParameterKeys(step: BrowserTaskStep): string[] {
  return step.kind === 'upload' ? step.parameterKeys ?? [] : step.kind === 'fill' && step.parameterKey ? [step.parameterKey]
    : step.kind === 'click' && step.dialog?.promptParameterKey ? [step.dialog.promptParameterKey] : []
}
export function renameBrowserTaskParameter(step: BrowserTaskStep, from: string, to: string): BrowserTaskStep {
  return { ...step, ...(step.parameterKey === from ? { parameterKey: to } : {}),
    ...(step.parameterKeys ? { parameterKeys: step.parameterKeys.map(key => key === from ? to : key) } : {}),
    ...(step.dialog?.promptParameterKey === from ? { dialog: { ...step.dialog, promptParameterKey: to } } : {}) }
}
export type BrowserTaskCompletion = { criteria: (
  | { kind: 'field-equals'; stepId: string; key: string; expected: string | number | boolean }
  | { kind: 'download-readable'; stepId: string; path: string }
  | { kind: 'human-checkpoint'; checkpointId: string }
)[] }
export type BrowserTaskStepExecution = BrowserTaskRunIdentity & { stepId: string; expectedNavigationId?: string; deadlineMillis?: number }
export type BrowserTaskContent = { name: string; url: string; steps: BrowserTaskStep[]; parameters: BrowserTaskParameter[]; completion?: BrowserTaskCompletion }
export type BrowserTaskVersion = BrowserTaskContent & { version: number; savedAt: number }
export type BrowserTaskAsset = {
  id: string
  browserId: string
  sourceRecordingId?: string
  /** Historical package origin, not a local demonstration or approval. */
  importedFrom?: import('@agentmux/core/control').BrowserTaskPortableSource
  revision: number
  /** Original immutable creation binding; later draft edits do not change this intent. */
  creation?: BrowserTaskCreateInput | import('@agentmux/core/control').BrowserTaskPortableBinding
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
  /** Steps whose last attempt ended script-failed, with that attempt's journal operation. Any entry keeps the run from completing. */
  failedSteps?: { stepId: string; operationId: string }[]
  executedMillis?: number
  /** Subflow child only: the exact parent call item that owns this run. */
  parent?: import('@agentmux/core/control').BrowserTaskRunParent
  /** Subflow parent only: item identities and bound child runs, never fresh values or child status. */
  calls?: import('@agentmux/core/control').BrowserTaskCallProgress[]
  orchestration?: import('@agentmux/core/control').BrowserTaskParallelBinding
  pendingCheckpointId?: string
  /** Main-created trusted Continue events. Absence means their recording information is unavailable. */
  humanCheckpoints?: BrowserTaskHumanCheckpoint[]
  completionWarning?: string
  warning?: string
  startedAt: number
  updatedAt: number
}
/** A bounded Client grouping of original runs. Values are never retained in these item records. */
export type BrowserTaskBatchRun = {
  id: string; browserId: string; assetId: string; version: number
  items: { id: string; runId?: string }[]
  nextItem: number
  status: BrowserTaskAssetRun['status']
  operationCount: number; executedMillis: number
  startedAt: number; updatedAt: number; warning?: string
}
export type BrowserTaskBatchInput = {
  browserId: string; assetId: string; version: number; batchId?: string
  items: { id: string; parameters: Record<string, string> }[]
  /** Shared fresh invocation values, including secrets; never saved with batch progress. */
  parameters: Record<string, string>
}
export type BrowserTaskAssetDocument = { version: 1; assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[]; batches?: BrowserTaskBatchRun[]; selectedRuns?: { browserId: string; runId: string }[]; parallel?: BrowserTaskParallelRecord[]; selectedParallel?: BrowserTaskParallelSelection[] }
export type BrowserTaskAssetState = { completion?: import('@agentmux/core/control').BrowserTaskRunCompletion; assets: BrowserTaskAsset[]; runs: BrowserTaskAssetRun[]; batches?: BrowserTaskBatchRun[]; selectedRunId?: string | null; activeBatchId?: string | null; parallel?: BrowserTaskParallelSummary | null; warning?: string }
export type BrowserTaskAssetRunInput = {
  assetId: string
  version: number
  browserId: string
  /** Values exist only for this invocation. Secret values must be supplied again after a checkpoint. */
  parameters: Record<string, string>
  /** Fresh finite subflow items for this invocation only, keyed by subflow step id. */
  calls?: import('@agentmux/core/control').BrowserTaskInvocationCalls
  mode?: 'run' | 'step'
  runId?: string
}

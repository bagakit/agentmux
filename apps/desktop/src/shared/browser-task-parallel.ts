import type { BrowserTaskParallelBinding, BrowserTaskParallelSummary, BrowserTaskParallelTargetProgress, BrowserTaskRunStatus } from '@agentmux/core/control'

/** Only preparation and original bindings persist here; execution state stays on the original runs. */
export type BrowserTaskParallelRecord = {
  operationId: string; browserId: string; assetId: string; version: number; requestedConcurrency: number; concurrency: number
  status: BrowserTaskRunStatus; startedAt: number; updatedAt: number; warning?: string
  targets: { id: string; browserId: string; profileId: string; phase: BrowserTaskParallelTargetProgress['phase']; runId?: string; error?: { code: string; message: string } }[]
}
/** Main-private execution scope. Public callers can never supply this binding to an ordinary run. */
export type BrowserTaskParallelExecution = BrowserTaskParallelBinding & { profileId: string }
export type BrowserTaskParallelSelection = { browserId: string; operationId: string }
export type { BrowserTaskParallelSummary }

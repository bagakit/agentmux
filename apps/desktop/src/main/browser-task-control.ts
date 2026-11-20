import type { BrowserTaskParallelList, BrowserTaskParallelInput, BrowserTaskParallelSummary, BrowserTaskParallelInspection, BrowserTaskParallelContinuationInput, BrowserTaskParallelContinuationReceipt } from '@agentmux/core/control'
import { assertBrowserTaskControlTarget, parseBrowserTaskControlPayload, parseBrowserTaskControlResult, type BrowserTaskControlResult } from '@agentmux/core'
import type { AgentMuxBrowserTaskSource, BrowserTaskCreateInput, BrowserTaskCreateStatus } from '@agentmux/core/control'
import type { BrowserOperation } from '@agentmux/browser/model'
import type { BrowserTaskAsset, BrowserTaskAssetRun, BrowserTaskAssetRunInput, BrowserTaskAssetState, BrowserTaskBatchInput, BrowserTaskBatchRun } from '../shared/browser-task-assets.js'
import { getBrowserTaskReliability } from '../shared/browser-task-reliability.js'

type BrowserTaskControlOwner = {
  exportPortableTask(browserId: string, assetId: string, expectedRevision: number, version?: number): Promise<import('@agentmux/core/control').BrowserTaskPortableBundle>
  importPortableTask(browserId: string, input: import('@agentmux/core/control').BrowserTaskImportInput): Promise<BrowserTaskAsset>
  inspectPortableTaskImport(browserId: string, input: import('@agentmux/core/control').BrowserTaskImportInput): Promise<BrowserTaskCreateStatus>
  getTaskSource(browserId: string): Promise<AgentMuxBrowserTaskSource | null>
  getTaskDraft(browserId: string, assetId: string): Promise<Pick<BrowserTaskAsset, 'id' | 'browserId' | 'revision' | 'sourceRecordingId' | 'importedFrom' | 'draft'> & { warning?: string }>
  importTaskAsset(browserId: string, input: BrowserTaskCreateInput): Promise<BrowserTaskAsset>
  inspectTaskAssetCreation(browserId: string, input: BrowserTaskCreateInput): Promise<BrowserTaskCreateStatus>
  getTaskAssets(browserId: string): Promise<BrowserTaskAssetState>
  stopTaskParallel(browserId: string, operationId: string): Promise<BrowserTaskParallelSummary | null>
  continueControlledTaskParallelTarget(browserId: string, operationId: string, targetId: string, input: BrowserTaskParallelContinuationInput, authorize: (browserId: string, profileId: string) => Promise<void>): Promise<BrowserTaskParallelContinuationReceipt>
  runControlledTaskParallel(browserId: string, assetId: string, version: number, input: BrowserTaskParallelInput, authorize: (browserId: string, profileId: string) => Promise<void>): Promise<BrowserTaskParallelSummary>
  listTaskParallel(browserId: string, before?: string, limit?: number): Promise<BrowserTaskParallelList>
  inspectTaskParallel(browserId: string, operationId?: string, after?: string, limit?: number, continuationId?: string): Promise<BrowserTaskParallelInspection | null>
  inspectTaskRun(browserId: string, runId?: string): Promise<{ rootRunId: string; currentRunId: string; runs: BrowserTaskAssetRun[]; operationCount: number; executedMillis: number } | null>
  saveTaskAssetDraft(browserId: string, assetId: string, expectedRevision: number, content: unknown): Promise<BrowserTaskAsset>
  publishTaskAsset(browserId: string, assetId: string, expectedRevision: number): Promise<BrowserTaskAsset>
  getOperation(operationId: string): Promise<BrowserOperation | null>
  runControlledTaskBatch(input: BrowserTaskBatchInput): Promise<BrowserTaskBatchRun>
  stopTaskBatch(browserId: string, batchId: string): Promise<BrowserTaskBatchRun | null>
  runControlledTaskAsset(input: BrowserTaskAssetRunInput): Promise<BrowserTaskAssetRun>
  stopTaskAsset(browserId: string, runId: string): Promise<BrowserTaskAssetRun | null>
}

/**
 * May this caller start page work on that Browser? Main passes its one automation gate; a plain
 * boolean stands for the global switch alone.
 */
export type BrowserTaskAutomation = boolean | ((browserId: string, caller: { agentSessionId?: string } | undefined, expectedProfileId?: string) => Promise<void>)

async function allowRun(automation: BrowserTaskAutomation, browserId: string, caller: { agentSessionId?: string } | undefined, expectedProfileId?: string): Promise<void> {
  if (typeof automation === 'function') return await automation(browserId, caller, expectedProfileId)
  if (!automation) throw new Error('Browser automation is disabled in settings.')
}

/** The public control path consumes the original Main owners; it is never a human Continue. */
export async function executeBrowserTaskControl(value: unknown, owner: BrowserTaskControlOwner, automation: BrowserTaskAutomation): Promise<BrowserTaskControlResult> {
  // The caller travels beside the payload; the payload parser stays the schema owner for the rest.
  const { caller, ...payload } = (value && typeof value === 'object' ? value : {}) as { caller?: { agentSessionId?: string } }
  const request = parseBrowserTaskControlPayload(value && typeof value === 'object' ? payload : value)
  let raw: unknown
  if (request.operation === 'browser.task.export') {
    raw = { bundle: await owner.exportPortableTask(request.browserId, request.assetId, request.expectedRevision, request.version) }
  } else if (request.operation === 'browser.task.import') {
    const asset = await owner.importPortableTask(request.browserId, request.input)
    raw = { creation: { createOperationId: asset.creation?.createOperationId, assetId: asset.id, browserId: asset.browserId, status: 'created' } }
  } else if (request.operation === 'browser.task.import-inspect') {
    raw = { creation: await owner.inspectPortableTaskImport(request.browserId, request.input) }
  } else if (request.operation === 'browser.task.source') {
    raw = { browserId: request.browserId, source: await owner.getTaskSource(request.browserId) }
  } else if (request.operation === 'browser.task.draft') {
    raw = { asset: await owner.getTaskDraft(request.browserId, request.assetId) }
  } else if (request.operation === 'browser.task.create') {
    const asset = await owner.importTaskAsset(request.browserId, request.input)
    // Creation confirmation does not confirm a later live draft's save/revision.
    raw = { creation: { createOperationId: asset.creation?.createOperationId, assetId: asset.id, browserId: asset.browserId, status: 'created' } }
  } else if (request.operation === 'browser.task.create-inspect') {
    raw = { creation: await owner.inspectTaskAssetCreation(request.browserId, request.input) }
  } else if (request.operation === 'browser.task.assets') {
    // Subflow children belong to their root's bounded tree, read through browser.task.inspect.
    const state = await owner.getTaskAssets(request.browserId)
    raw = { state: { ...state, runs: state.runs.filter(run => !run.parent) } }
  } else if (request.operation === 'browser.task.parallel') {
    raw = { run: await owner.runControlledTaskParallel(request.browserId, request.assetId, request.version, request.input, (target, profileId) => allowRun(automation, target, caller, profileId)) }
  } else if (request.operation === 'browser.task.parallel-stop') {
    raw = { run: await owner.stopTaskParallel(request.browserId, request.operationId) }
  } else if (request.operation === 'browser.task.parallel-continue') {
    raw = await owner.continueControlledTaskParallelTarget(request.browserId, request.operationId, request.targetId, request.input, (target, profileId) => allowRun(automation, target, caller, profileId))
  } else if (request.operation === 'browser.task.parallel-list') {
    raw = { history: await owner.listTaskParallel(request.browserId, request.before, request.limit) }
  } else if (request.operation === 'browser.task.parallel-inspect') {
    raw = { inspection: await owner.inspectTaskParallel(request.browserId, request.operationId, request.after, request.limit, request.continuationId) }
  } else if (request.operation === 'browser.task.inspect') {
    raw = { inspection: await owner.inspectTaskRun(request.browserId, request.runId) }
  } else if (request.operation === 'browser.task.edit') {
    const asset = await owner.saveTaskAssetDraft(request.browserId, request.assetId, request.expectedRevision, request.content)
    // A confirmed write receipt must not grow with the original owner's cumulative history.
    raw = { asset: { id: asset.id, browserId: asset.browserId, revision: asset.revision } }
  } else if (request.operation === 'browser.task.publish') {
    const asset = await owner.publishTaskAsset(request.browserId, request.assetId, request.expectedRevision)
    raw = { asset: { id: asset.id, browserId: asset.browserId, revision: asset.revision }, publishedVersion: asset.versions.at(-1)?.version }
  } else if (request.operation === 'browser.task.reliability') {
    const state = await owner.getTaskAssets(request.browserId)
    const needed = new Set(state.runs.filter(run => run.browserId === request.browserId && run.assetId === request.assetId && run.version === request.version).flatMap(run => run.operationIds))
    const operations: BrowserOperation[] = []
    let historyWarning: string | undefined
    for (const id of needed) {
      try {
        const operation = await owner.getOperation(id)
        if (operation) operations.push(operation)
      } catch {
        historyWarning = 'Bound operation facts could not be read. Retained task progress remains; no successful outcome is inferred.'
      }
    }
    raw = { reliability: getBrowserTaskReliability({ ...request, state, operations, ...(historyWarning ? { historyWarning } : {}) }) }
  } else if (request.operation === 'browser.task.batch-stop') {
    raw = { batch: await owner.stopTaskBatch(request.browserId, request.batchId) }
  } else if (request.operation === 'browser.task.batch') {
    await allowRun(automation, request.browserId, caller)
    raw = { batch: await owner.runControlledTaskBatch(request) }
  } else if (request.operation === 'browser.task.stop') {
    raw = { run: await owner.stopTaskAsset(request.browserId, request.runId) }
  } else {
    await allowRun(automation, request.browserId, caller)
    raw = { run: await owner.runControlledTaskAsset(request) }
  }
  const result = parseBrowserTaskControlResult(request.operation, raw)
  assertBrowserTaskControlTarget(request, result)
  return result
}

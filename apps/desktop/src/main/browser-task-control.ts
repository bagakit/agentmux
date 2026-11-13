import { assertBrowserTaskControlTarget, parseBrowserTaskControlPayload, parseBrowserTaskControlResult, type BrowserTaskControlResult } from '@agentmux/core'
import type { BrowserOperation } from '../shared/browser-operation.js'
import type { BrowserTaskAssetRun, BrowserTaskAssetRunInput, BrowserTaskAssetState, BrowserTaskBatchInput, BrowserTaskBatchRun } from '../shared/browser-task-assets.js'
import { getBrowserTaskReliability } from '../shared/browser-task-reliability.js'

type BrowserTaskControlOwner = {
  getTaskAssets(browserId: string): Promise<BrowserTaskAssetState>
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
export type BrowserTaskAutomation = boolean | ((browserId: string, caller: { agentSessionId?: string } | undefined) => Promise<void>)

async function allowRun(automation: BrowserTaskAutomation, browserId: string, caller: { agentSessionId?: string } | undefined): Promise<void> {
  if (typeof automation === 'function') return await automation(browserId, caller)
  if (!automation) throw new Error('Browser automation is disabled in settings.')
}

/** The public control path consumes the original Main owners; it is never a human Continue. */
export async function executeBrowserTaskControl(value: unknown, owner: BrowserTaskControlOwner, automation: BrowserTaskAutomation): Promise<BrowserTaskControlResult> {
  // The caller travels beside the payload; the payload parser stays the schema owner for the rest.
  const { caller, ...payload } = (value && typeof value === 'object' ? value : {}) as { caller?: { agentSessionId?: string } }
  const request = parseBrowserTaskControlPayload(value && typeof value === 'object' ? payload : value)
  let raw: unknown
  if (request.operation === 'browser.task.assets') {
    raw = { state: await owner.getTaskAssets(request.browserId) }
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

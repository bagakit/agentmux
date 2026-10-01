import { assertBrowserTaskControlTarget, parseBrowserTaskControlPayload, parseBrowserTaskControlResult, type BrowserTaskControlResult } from '@agentmux/core'
import type { BrowserOperation } from '../shared/browser-operation.js'
import type { BrowserTaskAssetRun, BrowserTaskAssetRunInput, BrowserTaskAssetState } from '../shared/browser-task-assets.js'
import { getBrowserTaskReliability } from '../shared/browser-task-reliability.js'

type BrowserTaskControlOwner = {
  getTaskAssets(browserId: string): Promise<BrowserTaskAssetState>
  getOperation(operationId: string): Promise<BrowserOperation | null>
  runControlledTaskAsset(input: BrowserTaskAssetRunInput): Promise<BrowserTaskAssetRun>
  stopTaskAsset(browserId: string, runId: string): Promise<BrowserTaskAssetRun | null>
}

/** The public control path consumes the original Main owners; it is never a human Continue. */
export async function executeBrowserTaskControl(value: unknown, owner: BrowserTaskControlOwner, automation: boolean): Promise<BrowserTaskControlResult> {
  const request = parseBrowserTaskControlPayload(value)
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
  } else if (request.operation === 'browser.task.stop') {
    raw = { run: await owner.stopTaskAsset(request.browserId, request.runId) }
  } else {
    if (!automation) throw new Error('Browser automation is disabled in settings.')
    raw = { run: await owner.runControlledTaskAsset(request) }
  }
  const result = parseBrowserTaskControlResult(request.operation, raw)
  assertBrowserTaskControlTarget(request, result)
  return result
}

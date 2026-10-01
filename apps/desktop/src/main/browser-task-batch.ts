import type { BrowserTaskAssets } from './browser-task-assets.js'
import type { BrowserTaskAssetRun, BrowserTaskAssetRunInput, BrowserTaskBatchInput, BrowserTaskBatchRun } from '../shared/browser-task-assets.js'

export const BROWSER_TASK_BATCH_MAX_ITEMS = 16
export const BROWSER_TASK_BATCH_MAX_OPERATIONS = 256
export const BROWSER_TASK_BATCH_MAX_MILLIS = 120_000
export const BROWSER_TASK_BATCH_MAX_BYTES = 65_536
/** Main-only invocation context, never part of a Client request or persistent parameters. */
export type BrowserTaskRunBudget = { batchId: string; operations: number; timeMillis: number }
export type BrowserTaskBatchHost = {
  runTask(input: BrowserTaskAssetRunInput, budget: BrowserTaskRunBudget): Promise<BrowserTaskAssetRun>
}

/** A Client batch delegates each item to the original task runner and its checkpoint authority. */
export async function runBrowserTaskBatch(assets: BrowserTaskAssets, input: BrowserTaskBatchInput, host: BrowserTaskBatchHost): Promise<BrowserTaskBatchRun> {
  return await assets.runBatch(input, host)
}

export function validateBrowserTaskBatchValues(input: BrowserTaskBatchInput): void {
  if (!input || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > BROWSER_TASK_BATCH_MAX_ITEMS ||
      new Set(input.items.map(item => item?.id)).size !== input.items.length) throw new Error('Provide 1–16 uniquely identified batch items.')
  let bytes = 0
  for (const values of [input.parameters, ...input.items.map(item => item.parameters)]) {
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 32) throw new Error('Batch parameters exceed their budget.')
    for (const [key, value] of Object.entries(values)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || typeof value !== 'string' || value.length > 16_384) throw new Error('Invalid batch parameter.')
      bytes += Buffer.byteLength(key) + Buffer.byteLength(value)
    }
  }
  if (bytes > BROWSER_TASK_BATCH_MAX_BYTES) throw new Error('Batch invocation exceeds its 64 KiB value budget.')
}

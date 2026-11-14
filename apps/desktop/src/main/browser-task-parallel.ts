import { isBrowserTaskRunStatus } from '@agentmux/core/control'
import type { BrowserTaskAsset, BrowserTaskAssetRunInput, BrowserTaskAssetRun } from '../shared/browser-task-assets.js'
import type { BrowserTaskParallelExecution, BrowserTaskParallelRecord } from '../shared/browser-task-parallel.js'

export type BrowserTaskParallelHost = {
  /** The original Manager performs exact target/Profile and caller checks before entering its existing runner. */
  runTask(input: BrowserTaskAssetRunInput, execution: BrowserTaskParallelExecution): Promise<BrowserTaskAssetRun>
}
function named(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid original parallel task record')
  return value as Record<string, unknown>
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid parallel task identity')
  return value
}
function count(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error('Invalid parallel task count')
  return value as number
}
/** No history-size limit: these are accumulated original records, not a single RPC carrier. */
export function normalizeBrowserTaskParallelRecords(value: unknown, assets: BrowserTaskAsset[]): BrowserTaskParallelRecord[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid parallel task records')
  const records = value.map(value => {
    const row = named(value, ['operationId', 'browserId', 'assetId', 'version', 'requestedConcurrency', 'concurrency', 'status', 'startedAt', 'updatedAt', 'warning', 'targets', 'continuations'])
    const browserId = id(row.browserId), assetId = id(row.assetId), version = count(row.version, 1)
    if (!assets.some(asset => asset.id === assetId && asset.browserId === browserId && asset.versions.some(item => item.version === version)) || !isBrowserTaskRunStatus(row.status) || !Array.isArray(row.targets) || !row.targets.length) throw new Error('Parallel task source or status is unavailable')
    const targets = row.targets.map(value => {
      const target = named(value, ['id', 'browserId', 'profileId', 'phase', 'runId', 'error', 'pendingContinuationId'])
      if (!['queued', 'preparing', 'bound', 'failed', 'stopped'].includes(target.phase as string) || (target.phase === 'bound') !== (target.runId !== undefined)) throw new Error('Invalid parallel target preparation binding')
      let error: { code: string; message: string } | undefined
      if (target.error !== undefined) {
        const raw = named(target.error, ['code', 'message'])
        if (typeof raw.message !== 'string' || raw.message.length > 4096) throw new Error('Invalid parallel target error')
        error = { code: id(raw.code), message: raw.message }
      }
      return { id: id(target.id), browserId: id(target.browserId), profileId: id(target.profileId), phase: target.phase as BrowserTaskParallelRecord['targets'][number]['phase'],
        ...(target.runId === undefined ? {} : { runId: id(target.runId) }), ...(target.pendingContinuationId === undefined ? {} : { pendingContinuationId: id(target.pendingContinuationId) }), ...(error ? { error } : {}) }
    })
    if (new Set(targets.map(target => target.id)).size !== targets.length || new Set(targets.map(target => target.browserId)).size !== targets.length) throw new Error('Duplicate original parallel target')
    if (row.continuations !== undefined && !Array.isArray(row.continuations)) throw new Error('Invalid original continuation records')
    const continuations = ((row.continuations ?? []) as unknown[]).map(value => {
      const item = named(value, ['id', 'targetId', 'expectedRevision'])
      if (typeof item.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(item.expectedRevision)) throw new Error('Invalid original continuation revision')
      const targetId = id(item.targetId)
      if (!targets.some(target => target.id === targetId)) throw new Error('Original continuation target is unavailable')
      return { id: id(item.id), targetId, expectedRevision: item.expectedRevision }
    })
    if (new Set(continuations.map(item => item.id)).size !== continuations.length || targets.some(target => target.pendingContinuationId && !continuations.some(item => item.id === target.pendingContinuationId && item.targetId === target.id))) throw new Error('Invalid original continuation binding')
    const requestedConcurrency = count(row.requestedConcurrency, 1), concurrency = count(row.concurrency, 1)
    if (concurrency > Math.min(targets.length, requestedConcurrency) || row.warning !== undefined && (typeof row.warning !== 'string' || row.warning.length > 4096)) throw new Error('Invalid original parallel limits or warning')
    return { operationId: id(row.operationId), browserId, assetId, version, requestedConcurrency, concurrency, targets,
      ...(continuations.length ? { continuations } : {}), status: row.status as BrowserTaskParallelRecord['status'], startedAt: count(row.startedAt), updatedAt: count(row.updatedAt), ...(row.warning === undefined ? {} : { warning: row.warning as string }) }
  })
  if (new Set(records.map(record => record.operationId)).size !== records.length) throw new Error('Duplicate parallel task operation')
  return records
}

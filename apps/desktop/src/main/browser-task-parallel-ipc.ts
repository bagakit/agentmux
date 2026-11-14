import type { IpcMainInvokeEvent } from 'electron'
import { parseBrowserTaskControlPayload } from '@agentmux/core/control'
import type { BrowserViewManager } from './browser-view-manager.js'

/** Main's trusted-frame registrar is the sole human continuation entry; public control stays separate. */
export function registerBrowserTaskParallelIpc(ports: {
  handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>): void
  browsers: Pick<BrowserViewManager, 'stopTaskParallel' | 'continueTaskParallelTarget' | 'runTaskParallel' | 'inspectTaskParallel' | 'listTaskParallel'>
  authorize(browserId: string, profileId: string): Promise<void>
}): void {
  ports.handle('browser:stopTaskParallel', async (_event, browserId: string, operationId: string) => {
    const request = parseBrowserTaskControlPayload({ operation: 'browser.task.parallel-stop', browserId, operationId })
    if (request.operation !== 'browser.task.parallel-stop') throw new Error('Task operation identity changed.')
    return await ports.browsers.stopTaskParallel(request.browserId, request.operationId)
  })
  ports.handle('browser:continueTaskParallelTarget', async (_event, browserId: string, operationId: string, targetId: string, input: unknown) => {
    const request = parseBrowserTaskControlPayload({ operation: 'browser.task.parallel-continue', browserId, operationId, targetId, input })
    if (request.operation !== 'browser.task.parallel-continue') throw new Error('Task operation identity changed.')
    return await ports.browsers.continueTaskParallelTarget(request.browserId, request.operationId, request.targetId, request.input,
      (id, profileId) => ports.authorize(id, profileId))
  })
  ports.handle('browser:runTaskParallel', async (_event, browserId: string, assetId: string, version: number, input: unknown) => {
    const request = parseBrowserTaskControlPayload({ operation: 'browser.task.parallel', browserId, assetId, version, input })
    if (request.operation !== 'browser.task.parallel') throw new Error('Task operation identity changed.')
    return await ports.browsers.runTaskParallel(request.browserId, request.assetId, request.version, request.input,
      (id, profileId) => ports.authorize(id, profileId))
  })
  ports.handle('browser:inspectTaskParallel', async (_event, browserId: string, options: { operationId?: string; after?: string; limit?: number; continuationId?: string } = {}) => {
    const request = parseBrowserTaskControlPayload({ ...options, operation: 'browser.task.parallel-inspect', browserId })
    if (request.operation !== 'browser.task.parallel-inspect') throw new Error('Task operation identity changed.')
    return await ports.browsers.inspectTaskParallel(request.browserId, request.operationId, request.after, request.limit, request.continuationId)
  })
  ports.handle('browser:listTaskParallel', async (_event, browserId: string, options: { before?: string; limit?: number } = {}) => {
    const request = parseBrowserTaskControlPayload({ ...options, operation: 'browser.task.parallel-list', browserId })
    if (request.operation !== 'browser.task.parallel-list') throw new Error('Task operation identity changed.')
    return await ports.browsers.listTaskParallel(request.browserId, request.before, request.limit)
  })
}

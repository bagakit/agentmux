import type { AgentMuxBrowserMode } from '@agentmux/core'
import type { BrowserViewport } from '../shared/contracts.js'
import type { BrowserViewManager } from './browser-view-manager.js'

type Handle = <Args extends unknown[], Result>(channel: string, listener: (...values: Args) => Result | Promise<Result>) => void

/** The ordinary Desktop lifecycle handlers, also consumed by bounded native resource checks. */
export function registerBrowserResourceIpc(input: {
  handle: Handle
  browsers: Pick<BrowserViewManager, 'release' | 'restore'>
  workspace(value: unknown): string | null
}): void {
  const { handle } = input
  handle('browser:release', (id: string, navigationId: string) => input.browsers.release(id, navigationId))
  handle('browser:restore', async (id: string, restore: {
    workspaceId: unknown; profileId: string | null; mode?: AgentMuxBrowserMode; viewport: BrowserViewport
  }) => {
    const workspaceId = input.workspace(restore.workspaceId)
    return await input.browsers.restore(id, { ...restore, workspaceId })
  })
}

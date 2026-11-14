import { AgentMuxError } from '@agentmux/core/control'
import type { AgentMuxControlCaller } from '@agentmux/core/control'
export type BrowserProfileBookmarkOpen = { profileId: string; browserId: string; operationId: string; caller?: AgentMuxControlCaller }
export type BrowserProfileBookmarkOpenPorts = {
  scope(browserId: string): Promise<{ mode: string; profileId: string | null } | null>
  prepare(browserId: string): Promise<unknown>
  authorize(browserId: string, caller: AgentMuxControlCaller): Promise<void>
  navigate(browserId: string, url: string): Promise<unknown>
  run(browserId: string, url: string, operationId: string, caller: AgentMuxControlCaller, authorize: () => Promise<void>): Promise<void>
}
export class BrowserProfileBookmarkRefused extends Error {}
/** Both clients use the original Browser owner. A bookmark never borrows another Profile's page. */
export async function openBrowserProfileBookmark(request: BrowserProfileBookmarkOpen, url: string, ports: BrowserProfileBookmarkOpenPorts): Promise<void> {
  const exact = async () => { const scope = await ports.scope(request.browserId); if (scope?.mode !== 'normal' || scope.profileId !== request.profileId) throw new AgentMuxError('This Browser does not belong to the bookmark’s exact Profile. Its page is kept; choose an original Browser in that Profile.', 'INVALID_CONTROL_REQUEST') }
  const authorize = async () => { await exact(); if (request.caller) await ports.authorize(request.browserId, request.caller); await exact() }
  try { await authorize(); await ports.prepare(request.browserId); await authorize() }
  catch (cause) {
    if (cause instanceof AgentMuxError && ['BROWSER_AUTOMATION_DISABLED', 'BROWSER_PROFILE_AGENT_ACCESS_OFF', 'BROWSER_PROFILE_AGENT_ACCESS_UNKNOWN', 'INVALID_CONTROL_REQUEST'].includes(cause.code)) throw new BrowserProfileBookmarkRefused(cause.message)
    throw new BrowserProfileBookmarkRefused('The exact Browser could not be prepared for this open request. Its original page and bookmark are kept; inspect that Browser before another explicit action.')
  }
  if (request.caller) await ports.run(request.browserId, url, request.operationId, request.caller, authorize)
  else await ports.navigate(request.browserId, url)
}

function knownInputRefusal(cause: unknown): never {
  const value = cause as { code?: unknown; message?: unknown } | null
  if (value && (value.code === 'BROWSER_AGENT_CONTROL_ACTIVE' || value.code === 'BROWSER_HUMAN_CONTROL_ACTIVE')) {
    throw new BrowserProfileBookmarkRefused(typeof value.message === 'string' ? value.message : 'The original Browser input owner refused this open request before dispatch.')
  }
  throw cause
}

/** Production IPC and native consumers bind this same opener to their original Browser service. */
export function createBrowserProfileBookmarkOpener(ports: Omit<BrowserProfileBookmarkOpenPorts, 'run' | 'navigate'> & {
  browsers: Pick<import('./browser-view-manager.js').BrowserViewManager, 'navigate' | 'runScript'>
}): (request: BrowserProfileBookmarkOpen, url: string) => Promise<void> {
  return (request, url) => openBrowserProfileBookmark(request, url, {
    ...ports,
    navigate: async (id, address) => { try { return await ports.browsers.navigate(id, address) } catch (cause) { return knownInputRefusal(cause) } },
    run: async (id, address, operationId, caller, authorize) => {
      let report: Awaited<ReturnType<typeof ports.browsers.runScript>>
      try { report = await ports.browsers.runScript(id, `await gotoUrl(${JSON.stringify(address)})`, undefined, undefined, operationId, undefined, true, undefined, caller, authorize) } catch (cause) { return knownInputRefusal(cause) }
      if (report.outcome.kind !== 'completed') throw new Error('The original bookmark navigation is unconfirmed. Inspect its original Browser operation.')
    }
  })
}

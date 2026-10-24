import { AGENTMUX_CONTROL_SCHEMA_VERSION, AgentMuxError, parseAgentMuxControlRequest,
  type AgentMuxControlRequest, type AgentMuxControlResult, type AgentMuxRpcCallContext, type AgentMuxRpcServiceOptions } from '@agentmux/core'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import type { CapsuleCallContext, CapsuleInspection, CapsuleOpenResult, CapsuleParamsMap } from '@agentmux/core/capsule'
import { browserColdDescriptor } from './browser-cold-descriptor.js'
import { desktopWorkbenchObservationSchema } from '../shared/client-observation.js'
import type { BrowserSnapshot } from '../shared/contracts.js'
import type { BrowserViewManager } from './browser-view-manager.js'

/** The single native Capsule acquisition path, shared by all Desktop page presentations. */
export async function createCapsuleBrowserDocument(ports: { inspect(capsuleId: string): Promise<CapsuleInspection>; browsers: Pick<BrowserViewManager, 'create'> },
  input: { id: string; url: string; workspaceId: string | null; rememberedProfileId?: string | undefined; mode?: import('@agentmux/core').AgentMuxBrowserMode | undefined;
    viewport?: import('../shared/contracts.js').BrowserViewport | undefined; capsuleId: string; operationId?: string | undefined }) {
  if (input.mode === 'private' || input.rememberedProfileId !== undefined) throw new Error('Capsule storage belongs to its original page, independently of Browser user Profiles.')
  const capsule = await ports.inspect(input.capsuleId)
  if (capsule.endpoint.status !== 'available') throw new Error(capsule.endpoint.issue.message)
  const address = new URL(input.url), endpoint = new URL(capsule.endpoint.url)
  if (address.origin !== endpoint.origin) throw new Error('The requested address is not the original Capsule endpoint.')
  return await ports.browsers.create(input.id, address.href, input.workspaceId, undefined, 'normal', input.viewport, {
    capsule, capsuleOrigin: endpoint.origin, ...(input.operationId ? { capsuleOpenOperationIds: [input.operationId] } : {}) })
}

type OpenParams = CapsuleParamsMap['capsule.open']
export interface CapsulePresentationPorts {
  inspect(capsuleId: string): Promise<CapsuleInspection>
  graph(): Promise<AgentMuxSpatialGraph | null>
  current(browserId: string): { url: string } | null
  ensure(browserId: string): Promise<BrowserSnapshot>
  recordOpen(browserId: string, capsuleId: string, operationId: string): BrowserSnapshot
  execute(request: AgentMuxControlRequest, signal?: AbortSignal): Promise<AgentMuxControlResult>
  observe(signal?: AbortSignal): Promise<Record<string, unknown>>
  original: NonNullable<AgentMuxRpcServiceOptions['callOriginalCore']>
}

/** The client acquires original Browser identities; it never owns Capsule content or configuration. */
export function capsulePresentation(ports: CapsulePresentationPorts): NonNullable<AgentMuxRpcServiceOptions['capsules']> {
  const open = async (params: OpenParams, context?: CapsuleCallContext): Promise<CapsuleOpenResult> => {
    const inspection = await ports.inspect(params.capsuleId)
    const unavailable = (reason: string): CapsuleOpenResult => ({ operationId: params.operationId, capsuleId: params.capsuleId,
      endpoint: inspection.endpoint, rendering: { status: 'unavailable', reason } })
    if (inspection.endpoint.status !== 'available') return unavailable(inspection.endpoint.issue.message)
    context?.signal?.throwIfAborted()
    const graph = await ports.graph()
    const origin = new URL(inspection.endpoint.url).origin
    const candidates = graph?.regions.flatMap(region => {
      if (region.kind !== 'browser' || !region.browserId) return []
      try {
        const saved = browserColdDescriptor(graph, region.browserId)
        if (saved.capsuleId !== params.capsuleId) return []
        const current = ports.current(region.browserId)
        if (new URL(current?.url ?? saved.url).origin !== (current ? origin : saved.capsuleOrigin)) return []
        return [{ region, saved }]
      } catch { return [] }
    }) ?? []
    if (candidates.length > 1) return unavailable('Several Browser workfaces contain this Capsule. Inspect its exact Browser and Region before choosing a position; no page was navigated.')
    let location: { browserId: string; regionId: string; tabId: string; workspaceId?: string }
    if (candidates.length === 1) {
      const { region, saved } = candidates[0]!
      const browser = await ports.ensure(region.browserId!)
      if (browser.capsuleId !== params.capsuleId || new URL(browser.url).origin !== origin)
        return unavailable('The original Browser document changed while this Capsule was opening. Its current page is retained.')
      ports.recordOpen(browser.id, params.capsuleId, params.operationId)
      location = { browserId: browser.id, regionId: region.regionId, tabId: region.tabId, workspaceId: saved.workspaceId }
    } else {
      let destination = params.placement
      if (destination === undefined) {
        if (context?.caller?.agentSessionId) destination = { kind: 'new-tab', after: { kind: 'self' } }
        else {
          const observed = desktopWorkbenchObservationSchema.parse(await ports.observe(context?.signal))
          const selected = observed.desktop.selection
          const layout = observed.activeWorkspaceId ? observed.layouts[observed.activeWorkspaceId] : undefined
          const tabId = selected.space?.tabId ?? layout?.groups.find(group => group.id === layout.activeGroupId)?.activeTabId
          if (!tabId) return unavailable('Choose a Tab or an exact placement before opening this Capsule. The original page is retained.')
          destination = { kind: 'new-tab', after: { kind: 'tab', tabId } }
        }
      }
      const request = parseAgentMuxControlRequest({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: params.operationId,
        operation: 'open.browser', url: inspection.endpoint.url, capsuleId: params.capsuleId, destination,
        ...(context?.caller?.agentSessionId ? { caller: { hostId: context.caller.hostId, agentSessionId: context.caller.agentSessionId } } : {}) })
      const result = await ports.execute(request, context?.signal)
      if (result.operation !== 'open.browser' || !result.region.browserId) throw new AgentMuxError('The original Browser owner returned another operation.', 'CONTROL_PROTOCOL_ERROR')
      location = { browserId: result.region.browserId, regionId: result.region.regionId, tabId: result.region.tabId,
        ...(result.region.workspaceId ? { workspaceId: result.region.workspaceId } : {}) }
    }
    context?.signal?.throwIfAborted()
    const result = await ports.execute({ schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: params.operationId + ':show',
      operation: 'focus', target: { kind: 'space', regionId: location.regionId, tabId: location.tabId }, inputPolicy: 'preserve' }, context?.signal)
    if (result.operation !== 'focus' || !['applied', 'unchanged'].includes(result.navigation.state) ||
      result.presentation.provenance !== 'observed' || result.presentation.tabId !== location.tabId ||
      result.presentation.regionId !== location.regionId || result.presentation.blockers.length !== 0 ||
      !['main-visible', 'floating', 'window'].includes(result.presentation.state))
      return unavailable('The original Browser exists, but its presentation is unconfirmed. Inspect the original open operation and Region; no creation was repeated.')
    return { operationId: params.operationId, capsuleId: params.capsuleId, endpoint: inspection.endpoint,
      rendering: { status: 'available', ...location } }
  }
  return { call: async (method, params, context, originalContext) => {
    if (method === 'capsule.open') return await open(params as OpenParams, context) as never
    const origin: AgentMuxRpcCallContext = originalContext ?? { transport: 'unix', ...(context?.principal ? { principal: context.principal } : {}) }
    if (context?.caller && !originalContext?.caller) throw new AgentMuxError('The original Agent transport binding is missing. No authority was inferred from its Session ID.', 'CONTROL_PERMISSION_DENIED')
    return await ports.original('local', method, params as never, origin) as never
  } }
}

/** A saved external address retains its isolated container and never regains the Capsule bridge. */
export function resolveCapsuleColdDocument(saved: ReturnType<typeof browserColdDescriptor>, inspection: CapsuleInspection) {
  if (saved.capsuleId !== inspection.record.capsuleId) throw new AgentMuxError('The saved Capsule identity changed.', 'CONTROL_PROTOCOL_ERROR')
  if (inspection.endpoint.status !== 'available') throw new AgentMuxError(inspection.endpoint.issue.message, 'CONTROL_UNAVAILABLE')
  const original = new URL(saved.url)
  const url = original.origin === saved.capsuleOrigin
    ? new URL(original.pathname + original.search + original.hash, inspection.endpoint.url).href : saved.url
  return { ...saved, url, capsule: inspection }
}

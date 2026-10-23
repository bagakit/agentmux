import { AgentMuxError, type AgentMuxRpcCallContext, type connectAgentMuxRpc } from '@agentmux/core'
import type { CapsuleCallContext, CapsuleInputObservation, CapsuleOpenResult, CapsulePreparedReply, CapsulePresentationPort, CapsuleReplyPort } from '@agentmux/capsule'

/** App-only ports. The independent service owns all Capsule state and HTTP. */
export function createCapsuleDesktopAdapters(desktop: {
  connect(context?: AgentMuxRpcCallContext): ReturnType<typeof connectAgentMuxRpc>
}): (originalContext?: AgentMuxRpcCallContext) => { presentation: CapsulePresentationPort; replies: CapsuleReplyPort } {
  // Each original public call gets its own immutable closure. A delayed callback must
  // never inherit another caller's credentials or recover authority from saved JSON.
  return originalContext => {
    const desktopCall = async <T>(run: (client: Awaited<ReturnType<typeof connectAgentMuxRpc>>) => Promise<T>) => {
      const client = await desktop.connect(originalContext)
      try { return await run(client) }
      finally { await client.dispose() }
    }
    const assertLocalConfirmation = (context: CapsuleCallContext | undefined) => {
      if (context?.caller || context?.principal?.kind !== 'user' || context.principal.id !== `local-user:${process.getuid?.() ?? 'current'}`)
        throw new AgentMuxError('This Capsule reply requires its original local App confirmation. Other principals cannot be relabelled as that person.', 'CONTROL_PERMISSION_DENIED')
    }
    const input = async (prepared: CapsulePreparedReply, phase: 'submit' | 'inspect', context?: CapsuleCallContext): Promise<CapsuleInputObservation | null> => {
      if (phase === 'submit') assertLocalConfirmation(context)
      return await desktopCall(async client => {
        const result = await client.call('capsule.input', { phase, prepared }, context?.signal ? { signal: context.signal } : {})
        if (result.phase !== phase) throw new AgentMuxError('The original Capsule input phase changed.', 'CONTROL_PROTOCOL_ERROR')
        return result.observation
      })
    }
    const replies: CapsuleReplyPort = {
      prepare: async (request, context) => {
        assertLocalConfirmation(context)
        return await desktopCall(async client => {
          const result = await client.call('capsule.input', { phase: 'prepare', request }, context?.signal ? { signal: context.signal } : {})
          if (result.phase !== 'prepare') throw new AgentMuxError('The original Capsule preparation changed.', 'CONTROL_PROTOCOL_ERROR')
          return result.prepared
        })
      },
      submit: async (prepared, context) => {
        const result = await input(prepared, 'submit', context)
        if (!result) throw new AgentMuxError('The original Core input receipt is unknown.', 'CONTROL_UNAVAILABLE')
        return result
      },
      inspect: async (prepared, context) => await input(prepared, 'inspect', context),
    }
    const presentation: CapsulePresentationPort = {
      open: async (params, context, resolved) => {
        const unavailable = (reason: string): CapsuleOpenResult => ({
          operationId: params.operationId, capsuleId: params.capsuleId, endpoint: resolved.endpoint,
          rendering: { status: 'unavailable', reason }
        })
        let client: Awaited<ReturnType<typeof connectAgentMuxRpc>>
        try { client = await desktop.connect(originalContext) }
        catch {
          // Connection failed before any presentation call crossed the boundary.
          return unavailable('The original Desktop is not connected. Page content and its stable link are retained; open the App to display it.')
        }
        try { return await client.call('capsule.open', params, context?.signal ? { signal: context.signal } : {}) }
        catch (error) {
          const failure = error as { code?: unknown; controlFailure?: { disposition?: unknown } } | null
          // RPC connects lazily. Only the transport's original unsent receipt can
          // establish that this presentation never reached the Desktop owner.
          if (failure?.controlFailure?.disposition !== 'not_applied' ||
            !['CONTROL_UNAVAILABLE', 'CONTROL_CONNECTION_FAILED'].includes(String(failure.code))) throw error
          return unavailable('The original Desktop could not receive this presentation. Page content, its stable link and operation are retained; open the App to display it.')
        }
        finally { await client.dispose() }
      },
      inspect: async (params, context): Promise<CapsuleOpenResult | null> => await desktopCall(async client => {
        const options = context?.signal ? { signal: context.signal } : {}
        const { state } = await client.call('space.state', {}, options)
        if (!state) return null
        const matches = state.graph.regions.flatMap(region => {
          if (region.kind !== 'browser' || !region.browserId) return []
          const resource = state.graph.resources['region:' + region.regionId]
          if (!resource || typeof resource !== 'object' || Array.isArray(resource) || resource.capsuleId !== params.capsuleId ||
            !Array.isArray(resource.capsuleOpenOperationIds) || !resource.capsuleOpenOperationIds.includes(params.operationId)) return []
          return [{ browserId: region.browserId, tabId: region.tabId, regionId: region.regionId,
            ...(typeof resource.workspaceId === 'string' ? { workspaceId: resource.workspaceId } : {}) }]
        })
        if (matches.length !== 1) return null
        // The Desktop's non-presentation port forwards this read to the current
        // original Core/service; no App-local Capsule owner is constructed.
        const current = await client.call('capsule.resolve', { capsuleId: params.capsuleId }, options)
        if (current.capsuleId !== params.capsuleId || current.endpoint.status !== 'available') return null
        const { observation } = await client.call('app.inspect', {}, options)
        if (!capsuleCurrentlyVisible(observation, matches[0]!, current.endpoint.url)) return null
        return { operationId: params.operationId, capsuleId: params.capsuleId, endpoint: current.endpoint,
          rendering: { status: 'available', ...matches[0]! } }
      }),
    }
    return { presentation, replies }
  }
}

/** Reconciliation proves the same native document is visible now, never a historical focus receipt. */
export function capsuleCurrentlyVisible(observation: unknown, location: { browserId: string; tabId: string; regionId: string }, endpoint: string): boolean {
  const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
  const client = record(observation)
  if (client?.schema !== 'agentmux.desktop-client-observation.v1') return false
  const workbench = record(client.workbench), desktop = record(workbench?.desktop), presentation = record(desktop?.presentation)
  if (presentation?.provenance !== 'observed' || !['main-visible', 'floating', 'window'].includes(String(presentation.state)) ||
    presentation.tabId !== location.tabId || presentation.regionId !== location.regionId ||
    !Array.isArray(presentation.blockers) || presentation.blockers.length !== 0 || !Array.isArray(workbench?.tabs)) return false
  const tabs = workbench.tabs.map(record).filter(tab => tab?.id === location.tabId)
  if (tabs.length !== 1 || !Array.isArray(tabs[0]!.regions)) return false
  const regions = tabs[0]!.regions.map(record).filter(region => region?.regionId === location.regionId)
  if (regions.length !== 1) return false
  const region = regions[0]!
  if (region.kind !== 'browser' || region.browserId !== location.browserId || region.nativeOwner !== undefined ||
    region.loading !== false || region.error !== null ||
    typeof region.navigationId !== 'string' || !region.navigationId || typeof region.url !== 'string') return false
  try { return new URL(region.url).origin === new URL(endpoint).origin }
  catch { return false }
}

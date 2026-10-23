import { AgentMuxError, type AgentMuxRpcCallContext, type AgentMuxRpcServiceOptions, type connectAgentMuxRpc } from '@agentmux/core'
import type { CapsuleCallContext, CapsuleInputObservation, CapsuleOpenResult, CapsulePreparedReply, CapsuleReplyPort } from '@agentmux/capsule'
import { NodeCapsuleOwner } from '@agentmux/capsule/node'
import { AsyncLocalStorage } from 'node:async_hooks'

/** The original Host owns content. A Capsule failure never prevents Agent startup. */
export function hostCapsules(stateDirectory: string | undefined, presentation?: {
  connect(context?: AgentMuxRpcCallContext): ReturnType<typeof connectAgentMuxRpc>
}) {
  let reserved = false
  let closed = false
  let owner: Promise<NodeCapsuleOwner> | undefined
  // A call-scoped transport binding, never persisted with page metadata or operations.
  const origins = new AsyncLocalStorage<AgentMuxRpcCallContext | undefined>()
  const desktopCall = async <T>(context: CapsuleCallContext | undefined, run: (client: Awaited<ReturnType<typeof connectAgentMuxRpc>>) => Promise<T>) => {
    if (!presentation) throw new AgentMuxError('The original Desktop presentation owner is unavailable. Page content is retained.', 'CONTROL_UNAVAILABLE')
    if (origins.getStore()?.principal?.kind === 'device') throw new AgentMuxError(
      'This Desktop bridge cannot preserve the original device identity. The original page and operation are retained; inspect them from the local App.', 'CONTROL_UNAVAILABLE')
    const client = await presentation.connect(origins.getStore())
    try { return await run(client) }
    finally { await client.dispose() }
  }
  const assertLocalConfirmation = (context: CapsuleCallContext | undefined) => {
    if (context?.caller || context?.principal?.kind !== 'user' || context.principal.id !== `local-user:${process.getuid?.() ?? 'current'}`)
      throw new AgentMuxError('This Capsule reply requires its original local App confirmation. Other principals cannot be relabelled as that person.', 'CONTROL_PERMISSION_DENIED')
  }
  const input = async (prepared: CapsulePreparedReply, phase: 'submit' | 'inspect', context?: CapsuleCallContext): Promise<CapsuleInputObservation | null> => {
    if (phase === 'submit') assertLocalConfirmation(context)
    return await desktopCall(context, async client => {
      const result = await client.call('capsule.input', { phase, prepared })
      if (result.phase !== phase) throw new AgentMuxError('The original Capsule input phase changed.', 'CONTROL_PROTOCOL_ERROR')
      return result.observation
    })
  }
  const replies: CapsuleReplyPort = {
    prepare: async (request, context) => {
      assertLocalConfirmation(context)
      return await desktopCall(context, async client => {
        const result = await client.call('capsule.input', { phase: 'prepare', request })
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
  const acquire = async () => {
    if (closed || !reserved || !stateDirectory) throw new AgentMuxError(
      'Capsule hosting requires the original durable Host store. Existing Agents and workfaces remain available.',
      'CONTROL_UNAVAILABLE')
    if (!owner) {
      const opening = NodeCapsuleOwner.open({ stateDirectory, ...(presentation ? { replies, presentation: {
        open: async (params, context, resolved) => {
          if (origins.getStore()?.principal?.kind === 'device') return {
            operationId: params.operationId, capsuleId: params.capsuleId, endpoint: resolved.endpoint,
            rendering: { status: 'unavailable', reason: 'This Desktop bridge cannot preserve the original device identity. Page content and the original operation are retained; open it from the local App.' }
          }
          let client: Awaited<ReturnType<typeof connectAgentMuxRpc>>
          try { client = await presentation.connect(origins.getStore()) }
          catch {
            // Connection failed before any presentation call crossed the boundary.
            return { operationId: params.operationId, capsuleId: params.capsuleId, endpoint: resolved.endpoint,
              rendering: { status: 'unavailable', reason: 'The original Desktop is not connected. Page content and its stable link are retained; open the App to display it.' } }
          }
          try { return await client.call('capsule.open', params, context?.signal ? { signal: context.signal } : {}) }
          finally { await client.dispose() }
        },
        inspect: async (params, context): Promise<CapsuleOpenResult | null> => await desktopCall(context, async client => {
          const { state } = await client.call('space.state', {})
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
          const current = await (await acquire()).call('capsule.resolve', { capsuleId: params.capsuleId }, context)
          if (current.capsuleId !== params.capsuleId || current.endpoint.status !== 'available') return null
          const { observation } = await client.call('app.inspect', {})
          if (!capsuleCurrentlyVisible(observation, matches[0]!, current.endpoint.url)) return null
          return { operationId: params.operationId, capsuleId: params.capsuleId, endpoint: current.endpoint,
            rendering: { status: 'available', ...matches[0]! } }
        }),
      } } : {}) })
      owner = opening
      void opening.catch(() => { if (owner === opening) owner = undefined })
    }
    try { return await owner }
    catch (error) {
      throw new AgentMuxError(`Capsule storage is unavailable: ${error instanceof Error ? error.message : String(error)}. Preserve the original store and retry after restoring its availability.`, 'CONTROL_UNAVAILABLE')
    }
  }
  const port: NonNullable<AgentMuxRpcServiceOptions['capsules']> = { call: async (method, params, context, originalContext) =>
    await origins.run(originalContext, async () => await (await acquire()).call(method, params, context)) }
  return {
    port,
    async start() {
      reserved = true
      // Registry/content failures belong to this domain, not the semantic Agent owner.
      try { await acquire() } catch { /* The public port retains the precise failure and recovery. */ }
    },
    async close() {
      closed = true
      if (owner) await (await owner.catch(() => undefined))?.close()
    },
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

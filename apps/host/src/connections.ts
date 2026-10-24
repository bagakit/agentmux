import { AgentMuxError, AgentMuxSpatialStateStore, spatialCatalog, type AgentMuxHeadlessRuntime, type AgentMuxClient } from '@agentmux/core'
import { createHash } from 'node:crypto'
import { displayLabel } from '@agentmux/core/spatial-graph'
import { createConnectionServices, createPublicationConversationPort, createHostedIngressCorePort, type ConnectionServices } from '@agentmux/connectors'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import type { ConnectionPort } from '@agentmux/core/connections'
import type { MoteChatPort } from '@agentmux/core/mote-chat'
import { createConnectionExternalInputAuthority } from './external-input-authority.js'
import { createHostMoteChat } from './mote-chat.js'
import { createCredentialAdministration } from './credential-administration.js'
import { createHostMoteConnections } from './mote-connections.js'
import { createHostMoteAvatarRead } from './mote-avatar-read.js'
import { createMoteChatResources, readMoteResourceConfiguration } from './mote-resources.js'

type ExecutionClient = AgentMuxClient | AgentMuxHostedClient
export type HostConnectionOptions = Pick<Parameters<typeof createConnectionServices>[0], 'directory' | 'adapters' | 'moteChat'> & {
  spatial?: AgentMuxSpatialStateStore
  /** Original profile/workspace configuration; read on demand, never a copied Host snapshot. */
  moteConfigurationPath?: string
  /** Original remote execution clients, owned by this Host rather than a GUI window. */
  clients?(): readonly { hostId: string; client: ExecutionClient }[]
}

/** The service is registered before Core starts; its original owner is opened only after Core's lease. */
function servicePort<T extends object>(owner: () => Promise<T>, path: PropertyKey[] = []): T {
  return new Proxy(function () {}, {
    get: (_target, key) => key === 'then' ? undefined : servicePort(owner, [...path, key]),
    apply: async (_target, _this, args) => {
      let target: any = await owner()
      for (const key of path.slice(0, -1)) target = target?.[key]
      const method = target?.[path.at(-1)!]
      if (typeof method !== 'function') throw new AgentMuxError('The original Host connection capability is unavailable. Existing Agents and records are retained.', 'CONTROL_UNAVAILABLE')
      return await method.apply(target, args)
    }
  }) as unknown as T
}

/** One database, ingress authority and publication owner under the original semantic Host. */
export function createHostConnectionOwner(options: HostConnectionOptions) {
  let runtime: AgentMuxHeadlessRuntime | undefined, opened: Promise<ConnectionServices> | undefined, closed = false
  const shutdown = new AbortController()
  const spatial = options.spatial ?? new AgentMuxSpatialStateStore()
  const clients = () => [...(runtime ? [{ hostId: 'local', client: runtime.client }] : []), ...(options.clients?.() ?? [])]
  const authoritySource = (hostId: string, expectedRuntimeId?: string) => {
    if (!runtime || closed) return undefined
    const hostingRuntimeId = runtime.ownerIdentity().runtimeId
    if (expectedRuntimeId) return { hostingRuntimeId, executionRuntimeId: expectedRuntimeId }
    if (hostId === 'local') return { hostingRuntimeId, executionRuntimeId: hostingRuntimeId }
    const exact = options.clients?.().filter(entry => entry.hostId === hostId) ?? []
    const client = exact.length === 1 ? exact[0]!.client : undefined
    const executionRuntimeId = client && 'runtimeOwnerIdentity' in client ? client.runtimeOwnerIdentity()?.runtimeId : undefined
    return executionRuntimeId ? { hostingRuntimeId, executionRuntimeId } : undefined
  }
  const publication = createPublicationConversationPort(clients)
  const resources = options.moteConfigurationPath === undefined ? undefined : createMoteChatResources({
    configuration: resource => readMoteResourceConfiguration(options.moteConfigurationPath!, resource),
    catalog: async () => { const original = await spatial.read(); return original ? spatialCatalog(original.graph) : null }
  })
  const avatars = options.moteConfigurationPath === undefined ? undefined : createHostMoteAvatarRead({ configurationPath: options.moteConfigurationPath })
  const remoteIngress = createHostedIngressCorePort(clients)
  const moteChat = options.moteChat ?? (options.moteConfigurationPath !== undefined ? createHostMoteChat({
    configurationPath: options.moteConfigurationPath, spatial,
    runtime: () => {
      if (!runtime || closed) throw new AgentMuxError('The original Mote Host is unavailable. Existing conversations and saved resources are retained.', 'MOTE_CHAT_HOST_UNAVAILABLE')
      return runtime
    }
  }) : undefined)
  const services = async () => {
    if (closed || !runtime) throw new AgentMuxError('The original Host connection owner is not available. Original records and healthy Agents are retained.', 'CONTROL_UNAVAILABLE')
    const target = runtime.ownerIdentity()
    return await (opened ??= createConnectionServices({ ...options, ...(moteChat ? { moteChat } : {}),
      bindings: {
        spatial,
        executionRuntimeId: hostId => authoritySource(hostId)?.executionRuntimeId,
        checkpoint: reference => publication.checkpoint(reference, shutdown.signal),
        session: async reference => {
          const matches = clients().filter(entry => entry.hostId === reference.hostId)
          if (matches.length !== 1) return null
          const session = await matches[0]!.client.readAgentSession(reference.agentSessionId)
          return session && session.agentSessionId === reference.agentSessionId && (session.hostId === 'local' || session.hostId === reference.hostId)
            ? { hostId: reference.hostId, agentSessionId: session.agentSessionId } : null
        }
      }, publication,
      speaker: async (reference, signal, mote) => {
        signal.throwIfAborted()
        const matches = clients().filter(entry => entry.hostId === reference.hostId)
        if (matches.length !== 1) return {}
        const client = matches[0]!.client, session = await client.readAgentSession(reference.agentSessionId)
        if (!session || session.agentSessionId !== reference.agentSessionId || session.hostId !== 'local' && session.hostId !== reference.hostId) return {}
        const result: import('@agentmux/connectors').PublicationSpeakerDetails = {}
        try {
          if (reference.hostId === 'local') {
            const original = await spatial.readForLayout(), label = original && displayLabel(original.graph, { kind: 'agent-session', id: session.agentSessionId })
            if (label?.value) { result.name = label.value; result.nameRevision = label.nameRevision }
          } else if ('forwardRpc' in client && client.forwardRpc) {
            const original = await client.forwardRpc('agent.inspect', { target: { kind: 'agent-session', agentSessionId: session.agentSessionId } }, { signal })
            if (original.routeHostId === 'local' && original.session.agentSessionId === session.agentSessionId && original.displayName.availability === 'observed' && original.displayName.override) {
              result.name = original.displayName.override; if (original.displayName.nameRevision !== null) result.nameRevision = original.displayName.nameRevision
            }
          }
        } catch { signal.throwIfAborted() /* Original role remains known without a display label. */ }
        if (!mote || !resources || !avatars) return result
        try {
          const original = await resources.read(mote)
          result.name = original.topic.title; result.mote = mote
          const target = { workspaceId: original.workspace.id, topicId: original.topic.id, objectKey: mote.spaceId }
          result.avatar = { target, observation: 'unavailable' }
          try {
            const avatar = await avatars.read(target)
            result.avatar = { target, revision: avatar.revision, observation: avatar.image ? 'available' : avatar.source?.state === 'changed' ? 'changed' : 'unavailable' }
            if (avatar.image) {
              const dataBase64 = avatar.image.dataUrl.slice('data:image/png;base64,'.length), bytes = Buffer.from(dataBase64, 'base64')
              result.avatar.image = { dataBase64, byteLength: bytes.length, mimeType: 'image/png', width: avatar.image.width, height: avatar.image.height,
                sha256: createHash('sha256').update(bytes).digest('hex') }
            }
          } catch (error) { if (error instanceof AgentMuxError) result.avatar.code = error.code }
        } catch { signal.throwIfAborted() /* A missing original Mote resource does not take away its Agent identity. */ }
        signal.throwIfAborted()
        return result
      },
      // Local calls retain the original in-process authority callback, including rejoin.
      // Remote clients preserve the existing public endpoint admission contract.
      ingress: { core: (hostId, executionRuntimeId) => hostId === 'local' ? runtime!.client : remoteIngress(hostId, executionRuntimeId), authoritySource }
    }).then(owner => {
      owner.connections.credential = createCredentialAdministration({ target, secrets: owner.secrets })
      return owner
    }))
  }
  const connections = servicePort<ConnectionPort>(async () => (await services()).connections)
  const moteConnections = options.moteConfigurationPath === undefined ? undefined : createHostMoteConnections({
    configurationPath: options.moteConfigurationPath, spatial,
    connections: servicePort<Pick<ConnectionServices, 'openDatabase' | 'connections'>>(services)
  })
  const authority = createConnectionExternalInputAuthority({ executionHostId: 'local', runtimeId: () => runtime?.ownerIdentity().runtimeId,
    signal: shutdown.signal, clients: () => (options.clients?.() ?? []).flatMap(entry => 'runtimeOwnerIdentity' in entry.client ? [{ hostId: entry.hostId, client: entry.client }] : []), ingress: async () => {
    const ingress = (await services()).connections.ingress
    if (!ingress) throw new AgentMuxError('The original Host ingress owner is unavailable. Original inputs are retained.', 'EXTERNAL_INPUT_AUTHORITY_UNCONFIRMED')
    return ingress
  } })
  return {
    connections, authority, spatial,
    ...(moteConnections ? { moteConnections: moteConnections.moteConnections, motePreferences: moteConnections.motePreferences } : {}),
    ...(moteChat ? { moteChat: servicePort<MoteChatPort>(async () => (await services()).moteChat!) } : {}),
    async start(original: AgentMuxHeadlessRuntime) { runtime = original; await services() },
    async services() { return await services() },
    async close() { closed = true; shutdown.abort(); moteConnections?.close(); const owner = await opened; await owner?.close() }
  }
}

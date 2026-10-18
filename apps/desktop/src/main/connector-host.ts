import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionHost, RoomBindingHost, RoomProvisioningHost, PublicationHost, PublicationStore, DurableIngressHost, ConnectionReceivers, MoteChatHost, composeMoteChatBindings, createBuiltinConnectionAdapters, type DurableIngressOptions, type PublicationConversationPort, type RoomBindingHostOptions, type ConnectionAdapter, type MoteChatAgentPort } from '@agentmux/connectors'
import type { ConnectionPort } from '@agentmux/core/connections'
import type { MoteChatPort, MoteChatTarget } from '@agentmux/core/mote-chat'
import { DesktopConnectorSecrets, type CredentialEncryption } from './connector-secrets.js'

export type DesktopConnectionServices = {
  connections: ConnectionPort
  moteChat?: MoteChatPort
  secrets: Pick<DesktopConnectorSecrets, 'store' | 'inspect'>
  openDatabase(): Promise<DatabaseSync>
  readonly database: DatabaseSync | null
  readonly bindings: RoomBindingHost | null
  readonly rooms: RoomProvisioningHost | null
  readonly publication: PublicationHost | null
  readonly ingress: DurableIngressHost | null
  close(): void
}
type LiveServices = { database: DatabaseSync; connections: ConnectionHost; secrets: DesktopConnectorSecrets; bindings?: RoomBindingHost; rooms?: RoomProvisioningHost; publication?: PublicationHost; ingress?: DurableIngressHost; receivers?: ConnectionReceivers; moteChat?: MoteChatHost }
/** Optional failure stays local. A later exact operation retries storage on the same Host and database. */
export async function createDesktopConnections(options: { directory: string; encryption: CredentialEncryption; adapters?: readonly ConnectionAdapter[]; bindings?: Omit<RoomBindingHostOptions, 'connections'>; publication?: PublicationConversationPort; ingress?: Pick<DurableIngressOptions, 'core'>; moteChat?: { agents: MoteChatAgentPort; assertTarget(target: MoteChatTarget): Promise<void>; assertReady?(target: MoteChatTarget): Promise<void> } }): Promise<DesktopConnectionServices> {
  const adapters = options.adapters ?? createBuiltinConnectionAdapters()
  let live: LiveServices | undefined, opening: Promise<LiveServices> | undefined, closed = false
  const ensure = async (): Promise<LiveServices> => {
    if (closed) throw new AgentMuxError('The original connection owner is closed.', 'CONNECTION_STORAGE_UNAVAILABLE')
    if (live) return live
    opening ??= (async () => {
      let database: DatabaseSync | undefined, publication: PublicationHost | undefined, receivers: ConnectionReceivers | undefined
      try {
        await mkdir(options.directory, { recursive: true, mode: 0o700 })
        const path = join(options.directory, 'connections.sqlite')
        database = new DatabaseSync(path); await chmod(path, 0o600)
        const secrets = new DesktopConnectorSecrets(database, options.encryption)
        const connections = new ConnectionHost({ database, secrets, adapters })
        const publicationStore = options.publication ? new PublicationStore(database) : undefined
        const bindings = options.bindings ? new RoomBindingHost({ ...options.bindings, connections, ...(publicationStore ? { lifecycle: publicationStore } : {}) }) : undefined
        const moteChat = options.moteChat ? new MoteChatHost({ connections, agents: options.moteChat.agents, assertTarget: options.moteChat.assertTarget }) : undefined
        const routing = bindings && moteChat ? composeMoteChatBindings(bindings, moteChat) : bindings
        if (bindings) connections.bindings = moteChat ? {
          bind: (input, context) => bindings.bind(input, context),
          pause: (input, context) => bindings.pause(input, context),
          resume: (input, context) => bindings.resume(input, context),
          detach: (input, context) => bindings.detach(input, context),
          relink: (input, context) => bindings.relink(input, context),
          grant: (input, context) => bindings.grant(input, context),
          list: async input => ({ bindings: [...(await bindings.list(input)).bindings, ...moteChat.listBindings(input)] }),
          inspect: async input => {
            if ('bindingId' in input && input.bindingId) {
              const current = moteChat.readCurrent(input.bindingId)
              if (current) { const binding = input.revision === undefined ? current : moteChat.readExact(input.bindingId, input.revision)
                return { binding, current, operation: null, grants: binding ? moteChat.grants(binding.bindingId, binding.revision) : [] } }
            }
            return await bindings.inspect(input)
          }
        } : bindings
        const rooms = options.bindings ? new RoomProvisioningHost({ connections, spatial: options.bindings.spatial }) : undefined
        if (rooms) connections.rooms = { ...connections.rooms, create: (input, context) => rooms.create(input, context), inspect: input => rooms.inspect(input) }
        const ingress = routing && options.ingress ? new DurableIngressHost({ connections, bindings: routing, authenticators: connections.ingressAuthenticators(), core: options.ingress.core,
          ...(moteChat ? { prepareInput: async (record: import('@agentmux/core/connections').ConnectionIngressMessage) => {
            if (record.conversationKind === 'direct') {
              try { const binding = await moteChat.prepareIncoming({ ...record, conversationKind: 'direct' }); if (binding) publication?.refresh() }
              catch (error) { if (error instanceof AgentMuxError && error.code === 'MOTE_CHAT_QUOTA_EXHAUSTED') return { state: 'refused' as const, code: error.code }; throw error }
            }
            return { state: 'ready' as const }
          } } : {}) }) : undefined
        publication = routing && options.publication ? new PublicationHost({ connections, ...(publicationStore ? { store: publicationStore } : {}), bindings: routing, conversation: options.publication, ...(ingress ? { permissions: ingress.permissions } : {}) }) : undefined
        if (publication) connections.delivery = publication
        if (ingress) connections.ingress = ingress
        receivers = ingress ? new ConnectionReceivers(connections, ingress) : undefined
        if (closed) { receivers?.close(); publication?.close(); database.close(); throw new Error('Owner closed while opening.') }
        return live = { database, connections, secrets, ...(bindings ? { bindings } : {}), ...(rooms ? { rooms } : {}), ...(publication ? { publication } : {}), ...(ingress ? { ingress } : {}), ...(receivers ? { receivers } : {}), ...(moteChat ? { moteChat } : {}) }
      } catch {
        receivers?.close(); publication?.close()
        try { database?.close() } catch { /* Original Host remains usable; connection storage is unconfirmed. */ }
        throw new AgentMuxError('Connection storage is unavailable on this Host. Existing Agents remain available. Restore access to the Host connection storage and retry the original operation.', 'CONNECTION_STORAGE_UNAVAILABLE')
      }
    })().finally(() => { opening = undefined })
    return await opening
  }
  // Warm the optional owner without making its availability a Host startup prerequisite.
  await ensure().catch(() => {})
  return {
    get bindings() { return live?.bindings ?? null },
    get rooms() { return live?.rooms ?? null },
    get publication() { return live?.publication ?? null },
    get ingress() { return live?.ingress ?? null },
    get database() { return live?.database ?? null },
    openDatabase: async () => (await ensure()).database,
    ...(options.moteChat ? { moteChat: {
      configure: async (input, context) => {
        const owner = (await ensure()).moteChat!
        if (input.values.enabled && !(await owner.inspect({ operationId: input.operationId }, context)).operation) await options.moteChat!.assertReady?.(input.target)
        return await owner.configure(input, context)
      },
      inspect: async (input, context) => (await ensure()).moteChat!.inspect(input, context),
      history: async (input, context) => (await ensure()).moteChat!.history(input, context),
      audience: async (input, context) => (await ensure()).moteChat!.audience(input, context),
      allocate: async (input, context) => (await ensure()).moteChat!.allocate(input, context)
    } satisfies MoteChatPort } : {}),
    connections: {
      ownsEnrollmentConnection: async (connectionId, agentSessionId) => (await ensure()).connections.ownsEnrollmentConnection(connectionId, agentSessionId),
      service: {
        get: async () => (await ensure()).connections.service.get(),
        configure: async input => { const owner = await ensure(); const result = await owner.connections.service.configure(input); owner.receivers?.refresh(); owner.publication?.refresh(); return result },
        inspect: async input => (await ensure()).connections.service.inspect(input)
      },
      profile: {
        get: async (input, context) => (await ensure()).connections.profile!.get(input, context),
        inspect: async (input, context) => (await ensure()).connections.profile!.inspect(input, context),
        list: async (input, context) => (await ensure()).connections.profile!.list(input, context)
      },
      setup: {
        begin: async (input, context) => (await ensure()).connections.setup!.begin(input, context),
        advance: async (input, context) => (await ensure()).connections.setup!.advance(input, context),
        inspect: async (input, context) => (await ensure()).connections.setup!.inspect(input, context),
        list: async (input, context) => (await ensure()).connections.setup!.list(input, context)
      },
      enrollment: {
        begin: async (input, context) => (await ensure()).connections.enrollment!.begin(input, context),
        advance: async (input, context) => { const owner = await ensure(); const result = await owner.connections.enrollment!.advance(input, context); if (result.operation?.configuration === 'configured') { owner.receivers?.refresh(); owner.publication?.refresh() }; return result },
        inspect: async (input, context) => (await ensure()).connections.enrollment!.inspect(input, context),
        list: async (input, context) => (await ensure()).connections.enrollment!.list(input, context)
      },
      rooms: {
        list: async input => (await ensure()).connections.rooms!.list!(input),
        search: async input => (await ensure()).connections.rooms!.search!(input),
        get: async input => (await ensure()).connections.rooms!.get!(input),
        members: async input => (await ensure()).connections.rooms!.members!(input),
        createLink: async (input, context) => (await ensure()).connections.rooms!.createLink!(input, context),
        inspectLink: async input => (await ensure()).connections.rooms!.inspectLink!(input),
        ...(options.bindings ? {
          create: async (input, context) => (await ensure()).rooms!.create(input, context),
          inspect: async input => (await ensure()).rooms!.inspect(input)
        } satisfies import('@agentmux/core/connections').RoomProvisioningPort : {})
      } satisfies import('@agentmux/core/connections').RoomPort,
      ...(options.bindings ? { bindings: {
        bind: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.bind(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        inspect: async input => (await ensure()).connections.bindings!.inspect(input),
        list: async input => (await ensure()).connections.bindings!.list(input),
        pause: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.pause(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        resume: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.resume(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        detach: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.detach(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        relink: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.relink(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        grant: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.grant(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result }
      } satisfies import('@agentmux/core/connections').RoomBindingsPort } : {}),
      ...(options.publication && options.bindings ? { delivery: {
        inspect: async input => (await ensure()).publication!.inspect(input),
        list: async input => (await ensure()).publication!.list(input),
        retry: async (input, context) => (await ensure()).publication!.retry(input, context)
      } satisfies import('@agentmux/core/connections').ConnectionDeliveryPort } : {}),
      ...(options.ingress && options.bindings ? { ingress: {
        listAudience: async input => (await ensure()).ingress!.listAudience(input),
        inspect: async input => (await ensure()).ingress!.inspect(input),
        list: async input => (await ensure()).ingress!.list(input),
        authority: async input => (await ensure()).ingress!.authority(input),
        recordAuthority: async input => (await ensure()).ingress!.recordAuthority(input)
      } satisfies import('@agentmux/core/connections').ConnectionIngressReadPort } : {}),
      delete: async (input, context) => { const owner = await ensure(); const result = await owner.connections.delete(input, context); owner.receivers?.refresh(); owner.publication?.refresh(); return result },
      inspectDeletion: async input => (await ensure()).connections.inspectDeletion(input),
      list: async () => (await ensure()).connections.list(),
      inspect: async input => (await ensure()).connections.inspect(input),
      configure: async input => { const owner = await ensure(); const result = await owner.connections.configure(input); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
      test: async input => (await ensure()).connections.test(input)
    },
    secrets: { store: async input => (await ensure()).secrets.store(input), inspect: async operationId => (await ensure()).secrets.inspect(operationId) },
    close: () => { closed = true; live?.receivers?.close(); live?.publication?.close(); live?.connections.close(); live?.database.close(); live = undefined }
  }
}

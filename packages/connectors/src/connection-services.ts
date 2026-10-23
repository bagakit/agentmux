import { openSync, closeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chmod, mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionHost, type ConnectionAdapter } from './connection-host.js'
import { RoomBindingHost, type RoomBindingHostOptions } from './room-binding.js'
import { RoomProvisioningHost } from './room-provisioning.js'
import { PublicationHost, type PublicationConversationPort } from './publication-host.js'
import { PublicationStore } from './publication-store.js'
import { DurableIngressHost, type DurableIngressOptions } from './durable-ingress.js'
import { ConnectionReceivers } from './connection-receivers.js'
import { MoteChatHost, composeMoteChatBindings, type MoteChatAgentPort } from './mote-chat.js'
import { createBuiltinConnectionAdapters } from './platform-adapters.js'
import type { ChannelMetadataChange, ConnectionPort } from '@agentmux/core/connections'
import type { MoteChatPort, MoteChatTarget } from '@agentmux/core/mote-chat'
import { ConnectionSecrets } from './connection-secrets.js'

export type ConnectionServices = {
  connections: ConnectionPort
  onChannelMetadataChanged(listener: (change: ChannelMetadataChange) => void): () => void
  moteChat?: MoteChatPort
  secrets: Pick<ConnectionSecrets, 'store' | 'inspect'>
  openDatabase(): Promise<DatabaseSync>
  readonly database: DatabaseSync | null
  readonly bindings: RoomBindingHost | null
  readonly rooms: RoomProvisioningHost | null
  readonly publication: PublicationHost | null
  readonly ingress: DurableIngressHost | null
  close(): void
}
type LiveServices = { lease?: number; database: DatabaseSync; connections: ConnectionHost; secrets: ConnectionSecrets; bindings?: RoomBindingHost; rooms?: RoomProvisioningHost; publication?: PublicationHost; ingress?: DurableIngressHost; receivers?: ConnectionReceivers; moteChat?: MoteChatHost }
/** Optional failure stays local. A later exact operation retries storage on the same Host and database. */
export async function createConnectionServices(options: { directory: string | undefined; adapters?: readonly ConnectionAdapter[]; bindings?: Omit<RoomBindingHostOptions, 'connections'>; publication?: PublicationConversationPort; ingress?: Pick<DurableIngressOptions, 'core'>; moteChat?: { agents: MoteChatAgentPort; assertTarget(target: MoteChatTarget): Promise<void>; assertReady?(target: MoteChatTarget): Promise<void> } }): Promise<ConnectionServices> {
  const adapters = options.adapters ?? createBuiltinConnectionAdapters()
  let live: LiveServices | undefined, opening: Promise<LiveServices> | undefined, closed = false
  const metadataListeners = new Set<(change: ChannelMetadataChange) => void>()
  const relayMetadata = (change: ChannelMetadataChange) => { for (const listener of metadataListeners) try { listener(change) } catch { /* Display notification does not own native intake. */ } }
  const ensure = async (): Promise<LiveServices> => {
    if (closed) throw new AgentMuxError('The original connection owner is closed.', 'CONNECTION_STORAGE_UNAVAILABLE')
    if (live) return live
    opening ??= (async () => {
      let database: DatabaseSync | undefined, lease: number | undefined, publication: PublicationHost | undefined, ingress: DurableIngressHost | undefined, receivers: ConnectionReceivers | undefined
      try {
        const directory = options.directory
        if (typeof directory !== 'string' || !isAbsolute(directory)) throw new Error('The original absolute connection directory is unavailable.')
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await chmod(directory, 0o700)
        if (options.ingress || options.publication) {
          const fd = openSync(join(directory, 'connections.owner.lock'), 'a+', 0o600)
          const native = createRequire(import.meta.url)('fs-native-extensions') as { tryLock(fd: number): boolean }
          try {
            if (!native.tryLock(fd)) throw new AgentMuxError('The original connection database has another live receive/publication owner. Its records and healthy Agents are retained.', 'CONNECTION_OWNER_BUSY')
            lease = fd
          } catch (error) { closeSync(fd); throw error }
        }
        const path = join(directory, 'connections.sqlite')
        database = new DatabaseSync(path); await chmod(path, 0o600)
        const secrets = new ConnectionSecrets(database)
        const connections = new ConnectionHost({ database, secrets, adapters })
        connections.onChannelMetadataChanged(relayMetadata)
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
        const rooms = options.bindings ? new RoomProvisioningHost({ connections, spatial: options.bindings.spatial, ...(options.bindings.session ? { session: options.bindings.session } : {}) }) : undefined
        if (rooms) connections.rooms = { ...connections.rooms, create: (input, context) => rooms.create(input, context), inspect: input => rooms.inspect(input) }
        ingress = routing && options.ingress ? new DurableIngressHost({ connections, bindings: routing, authenticators: connections.ingressAuthenticators(), core: options.ingress.core,
          ...(publicationStore ? { contextPublications: publicationStore } : {}),
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
        if (closed) { receivers?.close(); ingress?.close(); publication?.close(); database.close(); throw new Error('Owner closed while opening.') }
        return live = { ...(lease === undefined ? {} : { lease }), database, connections, secrets, ...(bindings ? { bindings } : {}), ...(rooms ? { rooms } : {}), ...(publication ? { publication } : {}), ...(ingress ? { ingress } : {}), ...(receivers ? { receivers } : {}), ...(moteChat ? { moteChat } : {}) }
      } catch (error) {
        receivers?.close(); ingress?.close(); publication?.close()
        try { database?.close() } catch { /* Original Host remains usable; connection storage is unconfirmed. */ }
        if (lease !== undefined) closeSync(lease)
        if (error instanceof AgentMuxError && error.code === 'CONNECTION_OWNER_BUSY') throw error
        throw new AgentMuxError('Connection storage is unavailable on this Host. Existing Agents remain available. Restore access to the Host connection storage and retry the original operation.', 'CONNECTION_STORAGE_UNAVAILABLE')
      }
    })().finally(() => { opening = undefined })
    return await opening
  }
  // An old owner can relinquish this exact database after startup. Recover without a GUI read;
  // only an unopened owner is retried, never a healthy receiver or an unknown native effect.
  const recovery = options.ingress || options.publication ? setInterval(() => {
    if (!closed && !live) void ensure().catch(() => {})
  }, 5_000) : undefined
  recovery?.unref()
  // Warm the optional owner without making its availability a Host startup prerequisite.
  await ensure().catch(() => {})
  return {
    onChannelMetadataChanged: listener => { metadataListeners.add(listener); return () => { metadataListeners.delete(listener) } },
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
      metadata: {
        watch: async (changed, ended, context) => (await ensure()).connections.metadata.watch(changed, ended, context),
        get: async (input, context) => (await ensure()).connections.metadata.get(input, context),
        list: async (input, context) => (await ensure()).connections.metadata.list(input, context),
        refresh: async (input, context) => (await ensure()).connections.metadata.refresh(input, context),
        clear: async (input, context) => (await ensure()).connections.metadata.clear(input, context)
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
    secrets: { store: async (input, assertCurrent) => (await ensure()).secrets.store(input, assertCurrent), inspect: async operationId => (await ensure()).secrets.inspect(operationId) },
    close: () => { closed = true; if (recovery) clearInterval(recovery); metadataListeners.clear(); live?.receivers?.close(); live?.ingress?.close(); live?.publication?.close(); live?.connections.close(); live?.database.close(); if (live?.lease !== undefined) closeSync(live.lease); live = undefined }
  }
}

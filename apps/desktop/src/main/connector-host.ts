import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionHost, RoomBindingHost, RoomProvisioningHost, PublicationHost, DurableIngressHost, ConnectionReceivers, createBuiltinConnectionAdapters, type DurableIngressOptions, type PublicationConversationPort, type RoomBindingHostOptions, type ConnectionAdapter } from '@agentmux/connectors'
import type { ConnectionPort } from '@agentmux/core/connections'
import { DesktopConnectorSecrets, type CredentialEncryption } from './connector-secrets.js'

export type DesktopConnectionServices = {
  connections: ConnectionPort
  secrets: Pick<DesktopConnectorSecrets, 'store' | 'inspect'>
  readonly database: DatabaseSync | null
  readonly bindings: RoomBindingHost | null
  readonly rooms: RoomProvisioningHost | null
  readonly publication: PublicationHost | null
  readonly ingress: DurableIngressHost | null
  close(): void
}
type LiveServices = { database: DatabaseSync; connections: ConnectionHost; secrets: DesktopConnectorSecrets; bindings?: RoomBindingHost; rooms?: RoomProvisioningHost; publication?: PublicationHost; ingress?: DurableIngressHost; receivers?: ConnectionReceivers }
/** Optional failure stays local. A later exact operation retries storage on the same Host and database. */
export async function createDesktopConnections(options: { directory: string; encryption: CredentialEncryption; adapters?: readonly ConnectionAdapter[]; bindings?: Omit<RoomBindingHostOptions, 'connections'>; publication?: PublicationConversationPort; ingress?: Pick<DurableIngressOptions, 'core'> }): Promise<DesktopConnectionServices> {
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
        const bindings = options.bindings ? new RoomBindingHost({ ...options.bindings, connections }) : undefined
        if (bindings) connections.bindings = bindings
        const rooms = options.bindings ? new RoomProvisioningHost({ connections, spatial: options.bindings.spatial }) : undefined
        if (rooms) connections.rooms = { ...connections.rooms, create: (input, context) => rooms.create(input, context), inspect: input => rooms.inspect(input) }
        publication = bindings && options.publication ? new PublicationHost({ connections, bindings, conversation: options.publication }) : undefined
        if (publication) connections.delivery = publication
        const ingress = bindings && options.ingress ? new DurableIngressHost({ connections, bindings, authenticators: connections.ingressAuthenticators(), core: options.ingress.core }) : undefined
        if (ingress) connections.ingress = ingress
        receivers = ingress ? new ConnectionReceivers(connections, ingress) : undefined
        if (closed) { receivers?.close(); publication?.close(); database.close(); throw new Error('Owner closed while opening.') }
        return live = { database, connections, secrets, ...(bindings ? { bindings } : {}), ...(rooms ? { rooms } : {}), ...(publication ? { publication } : {}), ...(ingress ? { ingress } : {}), ...(receivers ? { receivers } : {}) }
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
    connections: {
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
        inspect: async input => (await ensure()).bindings!.inspect(input),
        list: async input => (await ensure()).bindings!.list(input),
        pause: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.pause(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        relink: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.relink(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
        grant: async (input, context) => { const owner = await ensure(); const result = await owner.bindings!.grant(input, context); owner.publication?.refresh(); owner.receivers?.refresh(); return result }
      } satisfies import('@agentmux/core/connections').RoomBindingsPort } : {}),
      ...(options.publication && options.bindings ? { delivery: {
        inspect: async input => (await ensure()).publication!.inspect(input),
        list: async input => (await ensure()).publication!.list(input),
        retry: async (input, context) => (await ensure()).publication!.retry(input, context)
      } satisfies import('@agentmux/core/connections').ConnectionDeliveryPort } : {}),
      ...(options.ingress && options.bindings ? { ingress: {
        inspect: async input => (await ensure()).ingress!.inspect(input),
        list: async input => (await ensure()).ingress!.list(input),
        authority: async input => (await ensure()).ingress!.authority(input)
      } satisfies import('@agentmux/core/connections').ConnectionIngressReadPort } : {}),
      list: async () => (await ensure()).connections.list(),
      inspect: async input => (await ensure()).connections.inspect(input),
      configure: async input => { const owner = await ensure(); const result = await owner.connections.configure(input); owner.publication?.refresh(); owner.receivers?.refresh(); return result },
      test: async input => (await ensure()).connections.test(input)
    },
    secrets: { store: async input => (await ensure()).secrets.store(input), inspect: async operationId => (await ensure()).secrets.inspect(operationId) },
    close: () => { closed = true; live?.receivers?.close(); live?.publication?.close(); live?.connections.close(); live?.database.close(); live = undefined }
  }
}

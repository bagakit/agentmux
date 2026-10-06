import { chmod, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import { ConnectionHost, type ConnectionAdapter } from '@agentmux/connectors'
import type { ConnectionPort } from '@agentmux/core/connections'
import { DesktopConnectorSecrets, type CredentialEncryption } from './connector-secrets.js'

export type DesktopConnectionServices = {
  connections: ConnectionPort
  secrets: Pick<DesktopConnectorSecrets, 'store' | 'inspect'>
  readonly database: DatabaseSync | null
  close(): void
}
type LiveServices = { database: DatabaseSync; connections: ConnectionHost; secrets: DesktopConnectorSecrets }
/** Optional failure stays local. A later exact operation retries storage on the same Host and database. */
export async function createDesktopConnections(options: { directory: string; encryption: CredentialEncryption; adapters?: readonly ConnectionAdapter[] }): Promise<DesktopConnectionServices> {
  let live: LiveServices | undefined, opening: Promise<LiveServices> | undefined, closed = false
  const ensure = async (): Promise<LiveServices> => {
    if (closed) throw new AgentMuxError('The original connection owner is closed.', 'CONNECTION_STORAGE_UNAVAILABLE')
    if (live) return live
    opening ??= (async () => {
      let database: DatabaseSync | undefined
      try {
        await mkdir(options.directory, { recursive: true, mode: 0o700 })
        const path = join(options.directory, 'connections.sqlite')
        database = new DatabaseSync(path); await chmod(path, 0o600)
        const secrets = new DesktopConnectorSecrets(database, options.encryption)
        const connections = new ConnectionHost({ database, secrets, ...(options.adapters ? { adapters: options.adapters } : {}) })
        if (closed) { database.close(); throw new Error('Owner closed while opening.') }
        return live = { database, connections, secrets }
      } catch {
        try { database?.close() } catch { /* Original Host remains usable; connection storage is unconfirmed. */ }
        throw new AgentMuxError('Connection storage is unavailable on this Host. Existing Agents remain available. Restore access to the Host connection storage and retry the original operation.', 'CONNECTION_STORAGE_UNAVAILABLE')
      }
    })().finally(() => { opening = undefined })
    return await opening
  }
  // Warm the optional owner without making its availability a Host startup prerequisite.
  await ensure().catch(() => {})
  return {
    get database() { return live?.database ?? null },
    connections: {
      list: async () => (await ensure()).connections.list(),
      inspect: async input => (await ensure()).connections.inspect(input),
      configure: async input => (await ensure()).connections.configure(input),
      test: async input => (await ensure()).connections.test(input)
    },
    secrets: { store: async input => (await ensure()).secrets.store(input), inspect: async operationId => (await ensure()).secrets.inspect(operationId) },
    close: () => { closed = true; live?.connections.close(); live?.database.close(); live = undefined }
  }
}

import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { AgentMuxControlServer, connectAgentMuxRpc } from '@agentmux/core'
import type { ConnectionConfig } from '@agentmux/core/connections'
import { createDesktopConnections } from '../../../../apps/desktop/src/main/connector-host.js'
import { enrollmentEncryption } from './connection-enrollment.js'
import {
  objectCliEnvironment,
  runCompiledObjectCli
} from '../../../core/test/helpers/object-cli-rpc.js'
export type ProfileRequest = {
  url?: string
  method?: string
  params?: Record<string, unknown>
  data?: Record<string, unknown>
  signal?: AbortSignal
}
export async function profileFixture(appResponse?: () => unknown) {
  const root = await mkdtemp(join(tmpdir(), 'profile-read-')),
    directory = join(root, 'connections'),
    socketPath = join(root, 'owner.sock'),
    calls: ProfileRequest[] = []
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(
    async (request) => {
      const r = request as ProfileRequest
      if (r.url?.includes('/auth/v3/'))
        return {
          code: 0,
          tenant_access_token: 'fixture-tenant-access',
          app_access_token: 'fixture-app-access',
          expire: 3600
        }
      calls.push(r)
      if (r.url?.endsWith('/bot/v3/info'))
        return {
          code: 0,
          bot: {
            open_id: 'native-bot',
            app_name: 'Online name',
            avatar_url: 'https://images.example.invalid/online.png'
          }
        }
      if (r.url?.includes('/app_versions/'))
        return {
          code: 0,
          data: {
            app_version: {
              app_id: 'cli_profile',
              version_id: 'online-original',
              description: 'Exact online description',
              status: 1
            }
          }
        }
      if (appResponse) return appResponse()
      return {
        code: 0,
        data: {
          app: {
            app_id: 'cli_profile',
            description: 'Draft metadata description',
            online_version_id: 'online-original',
            unaudit_version_id: 'reviewing-original'
          }
        }
      }
    }
  )
  const encryption = enrollmentEncryption()
  let services: Awaited<ReturnType<typeof createDesktopConnections>>,
    server: AgentMuxControlServer,
    sdk: Awaited<ReturnType<typeof connectAgentMuxRpc>>
  const open = async () => {
    services = await createDesktopConnections({ directory, encryption })
    server = new AgentMuxControlServer({
      socketPath,
      connections: services.connections,
      coreClients: () => {
        throw Error('Profile reads cannot borrow an Agent Runtime')
      }
    })
    await server.start()
    sdk = await connectAgentMuxRpc({
      endpoint: { transport: 'unix', path: socketPath }
    })
  }
  const closeOwner = async () => {
    sdk.dispose()
    await server.stop()
    services.close()
  }
  await open()
  const stored = await services.secrets.store({
    operationId: 'profile-read-credential',
    secret: 'private-profile-secret'
  })
  const config: ConnectionConfig = {
    connectionId: 'profile-connection',
    adapterId: 'feishu',
    application: { domain: 'open.feishu.cn', appId: 'cli_profile' },
    label: 'Original profile bot',
    enabled: true,
    credentialRef: stored.credentialRef
  }
  await sdk.call('connection.configure', {
    operationId: 'profile-original-save',
    expectedRevision: null,
    connection: config
  })
  return {
    root,
    config,
    calls,
    get services() {
      return services
    },
    get sdk() {
      return sdk
    },
    cli: (args: string[], body?: unknown) =>
      runCompiledObjectCli(
        ['--endpoint', 'unix:' + socketPath, 'connection', 'profile', ...args],
        objectCliEnvironment(root),
        body === undefined ? '' : JSON.stringify(body)
      ),
    closeOwner,
    reopen: open,
    close: async () => {
      await closeOwner()
      await rm(root, { recursive: true, force: true })
    }
  }
}

import { dirname, join } from 'node:path'
import { AgentMuxClient, AgentMuxControlServer, AgentMuxFileAgentSessionStore, AgentMuxError,
  AgentMuxHostedRuntimeService, connectAgentMuxRpc, defaultAgentMuxControlSocketPath,
  type AgentMuxAgentSessionStore, type AgentMuxRpcCallContext, type AgentMuxRpcMethod,
  type AgentMuxRpcParams, type AgentMuxRpcResult, type AgentMuxRpcStreamMethod,
  type AgentMuxRpcStreamParams, type AgentMuxRpcSubscriptionOptions,
  type AgentProvider, type AgentMuxRpcHttpOptions } from '@agentmux/core'
import { DeviceAuthority } from './device-authority.js'
import { PrivateAccess } from './private-access.js'
import { readPrivateTls, type PrivateTlsIdentity } from './private-tls.js'
import { loadPrivateMobileAssets } from './private-access-assets.js'
import type { PrivateAccessConfiguration } from './private-access-configuration.js'
import { createDeviceAdministration } from './device-administration.js'
import type { MacDeviceConfirmation } from './mac-device-confirmation.js'

export type AgentMuxHostOptions = {
  store: AgentMuxAgentSessionStore
  providers?: readonly AgentProvider[]
  socketPath?: string
  desktopSocketPath?: string
  privateAccess?: PrivateAccessConfiguration
  /** A startup manifest failure belongs to mobile access, never Core startup. */
  privateAccessIssue?: string
  /** A Host-owned OS collaborator; never accepted from public RPC params. */
  deviceConfirmation?: MacDeviceConfirmation
}

export type AgentMuxPrivateAccessState = { state: 'unconfigured' | 'unavailable'; message: string } | {
  state: 'listening'; message: string; origin: string; issuerHostId: string;
  certificateFingerprint: string; expiresAt: number; mobileBuildDigest?: string; assetIssue?: string
}

/** The Node Host owns the original Core. Desktop and phones only own client connections. */
export async function startAgentMuxHost(options: AgentMuxHostOptions) {
  const path = options.socketPath ?? defaultAgentMuxControlSocketPath()
  const desktopPath = options.desktopSocketPath ?? `${path}.desktop`
  let client: AgentMuxClient | undefined, hosted: AgentMuxHostedRuntimeService | undefined
  let resolveOwner!: (owner: AgentMuxClient) => void, rejectOwner!: (error: unknown) => void
  const ready = new Promise<AgentMuxClient>((resolve, reject) => { resolveOwner = resolve; rejectOwner = reject })
  void ready.catch(() => {})
  let authority: DeviceAuthority | undefined, access: PrivateAccess | undefined
  let assets: Awaited<ReturnType<typeof loadPrivateMobileAssets>> | undefined, assetIssue: string | undefined
  let privateIssue = options.privateAccessIssue, tls: PrivateTlsIdentity | undefined
  let resolvePrivate!: () => void
  const privateReady = new Promise<void>(resolve => { resolvePrivate = resolve })
  let resolveAuthority!: (value: DeviceAuthority) => void, rejectAuthority!: (error: unknown) => void
  const authorityReady = new Promise<DeviceAuthority>((resolve, reject) => { resolveAuthority = resolve; rejectAuthority = reject })
  void authorityReady.catch(() => {})
  const mobileUnavailable = () => new Response(JSON.stringify({ error: { code: 'CONTROL_UNAVAILABLE',
    message: 'Private mobile access is unavailable. The original Unix Host and Agent Sessions remain available.' } }),
  { status: 503, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
  let http: AgentMuxRpcHttpOptions | undefined
  if (options.privateAccess && !privateIssue) {
    try {
      tls = await readPrivateTls(options.privateAccess)
      if (!Buffer.isBuffer(tls.tls.key) || !Buffer.isBuffer(tls.tls.cert)) throw new Error('Private certificate bytes are unavailable.')
      // Retain the verified TLS policy while adapting the common server's string key/cert port.
      const wireTls = { ...tls.tls, key: tls.tls.key.toString('utf8'), cert: tls.tls.cert.toString('utf8') }
      http = { host: tls.host, port: tls.port, tls: wireTls,
        route: async request => { await privateReady; return access ? await access.route(request) ?? assets?.route(request) ?? null : mobileUnavailable() },
        authorize: async request => { await privateReady; return access?.authorize(request) ?? null } }
    } catch (error) { privateIssue = error instanceof Error ? error.message : 'Private TLS preparation is unavailable.' }
  }
  const desktopClient = async (context: AgentMuxRpcCallContext) => await connectAgentMuxRpc({
    endpoint: { transport: 'unix', path: desktopPath },
    ...(context.caller ? { credentials: context.caller } : {})
  })
  const server = new AgentMuxControlServer({ socketPath: path, ...(http ? { http } : {}),
    deviceAdministration: createDeviceAdministration(authorityReady, options.deviceConfirmation),
    coreClients: async () => [{ hostId: 'local', client: await ready }],
    hostedRuntime: async () => { await ready; return hosted! },
    forwardControl: async <M extends AgentMuxRpcMethod>(method: M, params: AgentMuxRpcParams<M>, context: AgentMuxRpcCallContext): Promise<AgentMuxRpcResult<M>> => {
      const desktop = await desktopClient(context)
      try { return await desktop.call(method, params, context.signal ? { signal: context.signal } : {}) }
      finally { await desktop.dispose() }
    },
    forwardSubscription: async <M extends AgentMuxRpcStreamMethod>(method: M, params: AgentMuxRpcStreamParams<M>, handlers: AgentMuxRpcSubscriptionOptions<M>, context: AgentMuxRpcCallContext) => {
      const desktop = await desktopClient(context)
      try {
        const subscription = await desktop.subscribe(method, params, { ...handlers,
          ...(context.signal ? { signal: context.signal } : {}) })
        let closed = false
        return { ...subscription, dispose: async () => {
          if (closed) return; closed = true
          try { await subscription.dispose() }
          finally { await desktop.dispose() }
        } }
      } catch (error) { await desktop.dispose(); throw error }
    }
  })
  try {
    // Reserve the public endpoint before constructing/loading any Core owner. A live old owner
    // is never displaced or adopted by speculative workflow probes.
    await server.start()
    if (options.store instanceof AgentMuxFileAgentSessionStore) {
      try {
        authority = await DeviceAuthority.open(join(dirname(options.store.path), 'agentmux-devices.json'))
        resolveAuthority(authority)
      } catch (error) {
        privateIssue = 'The original device authority cannot be read. Its bytes are retained; restore that identity to recover mobile access. Unix and Agent Sessions remain available.'
        rejectAuthority(error)
      }
    } else {
      rejectAuthority(new AgentMuxError('Device access requires the original durable File Store.', 'CONTROL_UNAVAILABLE'))
      if (options.privateAccess) privateIssue = 'Mobile access requires the original durable File Store. The existing Unix Host remains available.'
    }
    client = new AgentMuxClient({ store: options.store,
      ...(options.providers ? { providers: options.providers } : {}) })
    await client.connect()
    hosted = new AgentMuxHostedRuntimeService(client,
      options.store instanceof AgentMuxFileAgentSessionStore ? options.store.path : null)
    resolveOwner(client)
    if (tls && authority && !privateIssue && !server.httpUnavailable) {
      try {
        access = new PrivateAccess(authority, tls)
        if (options.privateAccess?.mobileBuildDirectory) {
          try { assets = await loadPrivateMobileAssets(options.privateAccess.mobileBuildDirectory, access.origin) }
          catch { assetIssue = 'The selected mobile build cannot be read. Authenticated RPC and the original Unix Host remain available; rebuild the explicit mobile artifact to restore its page.' }
        }
      } catch {
        privateIssue = 'Private device access could not be initialized. The original Unix Host and Agent Sessions remain available; inspect the retained private identity and TLS configuration.'
      }
    }
    resolvePrivate()
  } catch (error) {
    rejectOwner(error)
    rejectAuthority(error); resolvePrivate()
    await server.stop()
    await client?.dispose()
    throw error
  }
  let disposed = false
  const privateAccessState = (): AgentMuxPrivateAccessState => {
    const failure = privateIssue ?? server.httpUnavailable?.message
    if (failure) return { state: 'unavailable', message: failure }
    if (!access || !tls || !authority || !server.httpAddress) return { state: 'unconfigured',
      message: 'Private mobile access is not configured. Prepare the explicit private IP/TLS manifest to enable it; Unix and Agent Sessions remain available.' }
    return { state: 'listening', message: 'Private HTTPS is listening. Device approval and phone system trust require their own confirmation.',
      origin: access.origin, issuerHostId: authority.hostId, certificateFingerprint: tls.certificateFingerprint,
      expiresAt: tls.expiresAt, ...(assets ? { mobileBuildDigest: assets.buildDigest } : {}), ...(assetIssue ? { assetIssue } : {}) }
  }
  return { client, hosted, server, privateAccessState, deviceAuthority: () => authorityReady, async dispose() {
    if (disposed) return; disposed = true
    await server.stop()
    await hosted?.dispose()
    await client?.dispose()
  } }
}

export function agentMuxHostStore(path: string): AgentMuxFileAgentSessionStore {
  return new AgentMuxFileAgentSessionStore(path)
}

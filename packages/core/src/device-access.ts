import { access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exportPublicKey } from '@agentmux/relay/e2ee'
import { AgentMuxFileAgentSessionStore, type AgentMuxAgentSessionStore } from './agent-session-store.js'
import { DeviceAuthority } from './device-authority.js'
import { loadOrCreateRelayKeyPair } from './rpc-relay-keypair.js'
import { AgentMuxError } from './errors.js'
import type { AgentMuxMeshEndpointSource } from './public-rpc-relay-gateway.js'
import type { AgentMuxRpcCallContext } from './public-rpc-service.js'
import type { AgentOperationDevice } from './types.js'

export { DeviceAuthority } from './device-authority.js'
export { createDeviceAdministration } from './device-administration.js'

/** One lazy original endpoint identity, shared by headless and Host transports. */
export function createAgentMuxDeviceAccess(store: AgentMuxAgentSessionStore) {
  let authority: DeviceAuthority | undefined, authorityOpening: Promise<DeviceAuthority> | undefined
  let authorityAttempted = false, closed = false
  let key: Awaited<ReturnType<typeof loadOrCreateRelayKeyPair>> | undefined
  let keyOpening: ReturnType<typeof loadOrCreateRelayKeyPair> | undefined
  const shutdown = new AbortController(), mutations = new Set<Promise<void>>()
  const observeMutation = (work: Promise<void>) => {
    mutations.add(work); void work.then(() => mutations.delete(work), () => mutations.delete(work))
  }
  const observe = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const aborted = () => reject(new AgentMuxError('The original endpoint identity observation stopped.', 'CONTROL_CANCELLED'))
    shutdown.signal.addEventListener('abort', aborted, { once: true })
    work.then(resolve, reject).finally(() => shutdown.signal.removeEventListener('abort', aborted))
    if (shutdown.signal.aborted) aborted()
  })
  const getAuthority = (): Promise<DeviceAuthority> => {
    if (closed) return Promise.reject(new AgentMuxError('The original device owner is closed. Existing Runs are retained.', 'CONTROL_CANCELLED'))
    if (authority) return Promise.resolve(authority)
    if (!(store instanceof AgentMuxFileAgentSessionStore)) return Promise.reject(new AgentMuxError('An endpoint identity requires its original durable File Store.', 'CONTROL_UNAVAILABLE'))
    if (!authorityOpening) {
      const firstAttempt = !authorityAttempted, directory = dirname(store.path)
      authorityAttempted = true
      authorityOpening = (async () => {
        // A retained key or operation archive proves this is not first enrollment.
        const evidence = await Promise.all(['agentmux-relay-keypair.json', 'agentmux-devices-operations.jsonl'].map(name => access(join(directory, name)).then(() => true, error => {
          if (error.code === 'ENOENT') return false
          throw new AgentMuxError('The original endpoint identity source is unconfirmed. Preserve its files.', 'CONTROL_UNAVAILABLE')
        })))
        shutdown.signal.throwIfAborted()
        return await DeviceAuthority.open(join(directory, 'agentmux-devices.json'), Date.now, {
          createIfMissing: firstAttempt && !evidence.some(Boolean), signal: shutdown.signal, observeMutation
        })
      })().then(async value => {
        if (closed) { value.close(); await value.flush(); throw new AgentMuxError('The original endpoint closed before its identity was acquired.', 'CONTROL_CANCELLED') }
        authority = value; return value
      }).finally(() => { authorityOpening = undefined })
    }
    return observe(authorityOpening)
  }
  const getKey = async (): ReturnType<typeof loadOrCreateRelayKeyPair> => {
    const owner = await getAuthority()
    if (key) return key
    // getAuthority established this exact durable Store, never another namespace.
    const path = join(dirname((store as AgentMuxFileAgentSessionStore).path), 'agentmux-relay-keypair.json')
    keyOpening ??= loadOrCreateRelayKeyPair(path, { signal: shutdown.signal,
      createIfMissing: owner.daemonPublicKeyB64 === undefined && !owner.devices().some(device => device.keyFingerprint !== undefined), observeMutation
    }).then(async value => {
      shutdown.signal.throwIfAborted()
      await owner.adoptDaemonPublicKey(exportPublicKey(value.publicKey))
      shutdown.signal.throwIfAborted()
      key = value; return value
    }).catch(error => { keyOpening = undefined; throw error })
    return await observe(keyOpening)
  }
  const endpoint: AgentMuxMeshEndpointSource = async signal => {
    const owner = await getAuthority(); signal?.throwIfAborted()
    const keyPair = await getKey(); signal?.throwIfAborted()
    return { serverId: owner.hostId, keyPair, authorize: async publicKey => {
      // The Mesh owner independently checks the explicit RPC client-key pin first.
      const device = await owner.authorizeKey(publicKey), observation = owner.observe(device)
      return { principal: { kind: 'device' as const, id: `${owner.hostId}:${device.deviceId}` }, signal: observation.signal,
        assertCurrent: () => owner.assertCurrentKey(device, publicKey), dispose: () => observation.dispose() }
    } }
  }
  return {
    authority: getAuthority, keyPair: getKey, endpoint, current: () => authority,
    operationSource: (context: AgentMuxRpcCallContext) => context.caller || context.routeDelegation ? undefined : authority?.operationSource(context.principal),
    async recordDeviceOperation(source: AgentOperationDevice, method: string, args: unknown[], result: 'confirmed' | 'failed' | 'unknown', operationId: string) {
      if (!authority) return
      try { await authority.recordOperation(source, method, args, result, operationId) }
      catch { authority.noteActivityIssue(source.deviceId) }
    },
    close() { closed = true; shutdown.abort(); authority?.close() },
    async flush() { await authority?.flush(); await Promise.allSettled([...mutations]) }
  }
}

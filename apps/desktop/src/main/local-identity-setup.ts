import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as wait } from 'node:timers/promises'
import { AgentMuxError, connectAgentMuxRpc, defaultAgentMuxControlSocketPath, inspectSemanticRuntimeIdentity, type AgentMuxRpcParams } from '@agentmux/core'
import { parseMeshNetworkResult, type MeshNetworkMethod, type MeshNetworkParams, type MeshOwner } from '@agentmux/core/mesh-network'
import { ensureDesktopHost } from './desktop-host.js'

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error })
  const entry = await lstat(path)
  if (!entry.isDirectory() || (process.getuid && entry.uid !== process.getuid()) || (entry.mode & 0o077) !== 0) {
    throw new AgentMuxError('The separate identity directory cannot be verified.', 'MESH_IDENTITY_DIRECTORY_UNCONFIRMED')
  }
}

export async function localMeshIdentityNamespace(originalUserData: string) {
  const profile = await realpath(originalUserData) + '.new-identity'
  const key = createHash('sha256').update(profile).digest('hex').slice(0, 20)
  const runtime = join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), `amux-setup-${process.getuid?.()}-${key}`)
  const state = join(profile, 'runtime-state')
  const environment = { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: state }
  return {
    profile, runtime, state, environment, socketPath: defaultAgentMuxControlSocketPath(environment),
    storePath: join(profile, 'agent-sessions.json')
  }
}

/** One existing Host namespace for the separate Mesh identity. The App and its original Host stay bound. */
export function localMeshIdentity(originalUserData: string) {
  let preparing: Promise<MeshOwner> | undefined
  async function start(expectedRuntimeId?: string) {
    const scope = await localMeshIdentityNamespace(originalUserData)
    const source = { storePath: scope.storePath, stateDirectory: dirname(scope.storePath) }
    const inspectIdentity = () => inspectSemanticRuntimeIdentity(source, { environment: scope.environment })
    const previous = await inspectIdentity()
    if (expectedRuntimeId && expectedRuntimeId !== previous) throw new AgentMuxError(
      'This Mac could not verify the previously selected Mesh identity. Restore that identity or use the original identity.', 'RUNTIME_OWNER_MISMATCH')
    for (const path of [scope.profile, scope.runtime, scope.state]) await ensurePrivateDirectory(path)
    await ensureDesktopHost(scope.storePath, scope.socketPath, {
      path: join(scope.profile, 'agentmux.config.json'), connectorDirectory: join(scope.profile, 'connectors'), environment: scope.environment
    })

    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
    const signal = AbortSignal.timeout(10_000)
    try {
      const durable = await inspectIdentity()
      const { owner } = await rpc.call('runtime.owner.identity', {}, { signal })
      if (!durable || owner.runtimeId !== durable || (previous && previous !== durable) || owner.availability !== 'connected') {
        throw new AgentMuxError('The separate Host has not confirmed its saved Runtime identity. Check this identity again.', 'RUNTIME_OWNER_MISMATCH')
      }
      const runtimeFence = { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId }
      for (;;) {
        const settings = await rpc.call('settings.mesh.inspect', {}, { runtimeFence, signal })
        if (settings.identity) return parseMeshNetworkResult('settings.mesh.inspect', settings, {}, runtimeFence).owner
        const mesh = await rpc.call('mesh.inspect', {}, { runtimeFence, signal })
        if (mesh.apply.issue?.code === 'MESH_IDENTITY_UNCONFIRMED') throw new AgentMuxError(
          'The separate Host’s original Mesh identity needs recovery. Its saved data is retained.', mesh.apply.issue.code)
        await wait(150, undefined, { signal })
      }
    } finally { await rpc.dispose() }
  }

  return {
    async prepare(expectedRuntimeId?: string): Promise<MeshOwner> {
      preparing ??= start(expectedRuntimeId).finally(() => { preparing = undefined })
      const owner = await preparing
      if (expectedRuntimeId && owner.runtimeId !== expectedRuntimeId) throw new AgentMuxError(
        'The original selected Mesh identity has changed. Check its saved identity again.', 'RUNTIME_OWNER_MISMATCH')
      return owner
    },
    async call<M extends MeshNetworkMethod>(runtimeId: string, method: M, params: MeshNetworkParams[M], context: { signal: AbortSignal; runtimeFence?: MeshOwner }) {
      const scope = await localMeshIdentityNamespace(originalUserData)
      const { signal } = context
      let runtimeFence = context.runtimeFence
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: scope.socketPath } })
      try {
        if (!runtimeFence) {
          const { owner } = await rpc.call('runtime.owner.identity', {}, { signal })
          if (owner.runtimeId !== runtimeId || owner.availability !== 'connected') throw new AgentMuxError(
            'The selected Mesh identity is unconfirmed. Check this identity again.', 'RUNTIME_OWNER_MISMATCH')
          runtimeFence = { runtimeId, ownerInstanceId: owner.ownerInstanceId }
        }
        return parseMeshNetworkResult(method, await rpc.call(method, params as AgentMuxRpcParams<M>, { signal, runtimeFence }), params, runtimeFence)
      } finally { await rpc.dispose() }
    }
  }
}

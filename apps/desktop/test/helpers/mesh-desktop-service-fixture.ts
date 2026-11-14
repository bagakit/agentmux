import { EventEmitter } from 'node:events'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxControlServer, AgentMuxFileAgentSessionStore, connectAgentMuxRpc, type AgentMuxRpcCallContext, type AgentMuxRpcParams } from '@agentmux/core'
import type { MeshNetworkMethod, MeshNetworkResults } from '@agentmux/core/mesh-network'
import { mobileWebFixture } from '../../../host/test/helpers/mobile-web-fixture.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../../packages/core/test/helpers/object-cli-rpc.js'
import { desktopRpcMethods } from '../../src/main/desktop-rpc-exposure.js'
import { callOriginalDesktopHost, connectDesktopAgentMuxHost } from '../../src/main/desktop-host.js'
import { registerMeshNetworkIpc } from '../../src/main/mesh-network-ipc.js'
import { createRendererMeshNetwork } from '../../src/renderer/src/lib/mesh-network-client.js'

/** Real presentation service borrowing the original private Host, with no Mesh state owner. */
export async function meshDesktopServiceFixture() {
  const original = await mobileWebFixture({ nativeRecord: true })
  const savedEnvironment = new Map<string, string | undefined>()
  for (const [name, value] of Object.entries(original.native.env)) if (name.startsWith('AGENTMUX_') && value !== undefined) {
    savedEnvironment.set(name, process.env[name]); process.env[name] = value
  }
  const calls: Array<{ hostId: string; method: string; params: unknown; context: AgentMuxRpcCallContext }> = []
  const socketPath = join(original.native.env.AGENTMUX_RUNTIME_DIRECTORY!, 'desktop-mesh.sock')
  let desktop: AgentMuxControlServer | undefined
  let core: Awaited<ReturnType<typeof connectDesktopAgentMuxHost>> | undefined
  let rpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  let originalRpc: Awaited<ReturnType<typeof connectAgentMuxRpc>> | undefined
  let ipc: ReturnType<typeof registerMeshNetworkIpc> | undefined
  let heldOperationId: string | undefined
  let heldReceipt: unknown
  const reopen = async () => {
    desktop = new AgentMuxControlServer({ socketPath, exposedMethods: desktopRpcMethods(),
      forwardingPeer: { authoritySocketPath: original.native.socketPath },
      coreClients: () => [{ hostId: 'local', client: core! }],
      callOriginalCore: async (hostId, method, params, context) => {
        calls.push({ hostId, method, params, context })
        // RuntimeController.callOriginalCore preserves this same fifth argument.
        const result = await callOriginalDesktopHost(core!, method, params, context, context.runtimeFence)
        if (method === 'settings.mesh.configure' && (params as { operationId?: string }).operationId === heldOperationId) {
          heldReceipt = result
          // The original Core has returned its real save. Lose only the Desktop
          // reply, without resending or replacing that save operation.
          await desktop!.stop()
        }
        return result
      } })
    await desktop.start()
  }
  const close = async () => {
    ipc?.dispose(); await rpc?.dispose(); await originalRpc?.dispose(); await desktop?.stop(); await core?.dispose()
    try { await original.close() } finally {
      for (const [name, value] of savedEnvironment) if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  }
  try {
    const store = new AgentMuxFileAgentSessionStore(original.native.env.AGENTMUX_AGENT_SESSION_STORE!)
    core = await connectDesktopAgentMuxHost({ id: 'local', kind: 'local', label: 'Private original Host' }, store)
    await core.readAgentSessions()
    originalRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: original.native.socketPath } })
    await reopen()
    rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
    const handlers = new Map<string, (...args: any[]) => any>()
    ipc = registerMeshNetworkIpc({ handle: (name, handler) => { handlers.set(name, handler) },
      call: (method, params, context) => rpc!.call<MeshNetworkMethod>(method, params as AgentMuxRpcParams<MeshNetworkMethod>, context) as Promise<MeshNetworkResults[typeof method]> })
    class Sender extends EventEmitter { id = 67; isDestroyed() { return false } }
    const sender = new Sender()
    let sequence = 0
    const renderer = createRendererMeshNetwork({ call: async (method, params, context) =>
      await handlers.get('mesh:call')!({ sender }, 'desktop-mesh-' + (++sequence), method, params, context?.expectedOwner) })
    const env = objectCliEnvironment(original.native.root, { HOME: original.native.env.HOME! })
    const cli = (args: string[], input?: unknown, managed = false) => runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, ...args],
      { ...env, ...(managed ? original.managedEnv : {}) }, input === undefined ? '' : JSON.stringify(input), 30000)
    return { original, originalRpc, core, rpc, renderer, cli, calls, socketPath, reopen, close,
      get desktop() { return desktop! },
      holdReply(operationId: string) { heldOperationId = operationId },
      get heldReceipt() { return heldReceipt },
      async cleanupReceipt() { return { root: original.native.root, absent: await access(original.native.root).then(() => false, () => true) } } }
  } catch (error) { await close(); throw error }
}

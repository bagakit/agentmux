import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectAgentMuxRpc, type ContinuousProgressLoop } from '@agentmux/core'
import { AgentMuxControlServer } from '../../../../packages/core/src/public-rpc-server.js'
import { ContinuousProgressLoopManager, type FutureProgressInputOwner } from '@agentmux/host/continuous-progress-loop-manager'
import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store'

/** Real original Store/Main/RPC boundary. No Agent, Runtime or model is created;
 * tests explicitly provide any controlled future-intent owner they need. */
export async function createScheduleRpcFixture(options: {
  records?: readonly ContinuousProgressLoop[]
  now?: () => number
  futureInputs?: FutureProgressInputOwner
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'schedule-rpc-'))
  const store = new ContinuousProgressLoopStore(join(directory, 'loops.json'))
  const manager = new ContinuousProgressLoopManager(store,
    async () => { throw new Error('This fixture has no Agent input owner.') }, options.now ?? (() => 0),
    async () => { throw new Error('This fixture does not observe or start a Run.') }, options.futureInputs)
  const server = new AgentMuxControlServer({ socketPath: join(directory, 'control.sock'), schedules: manager, coreClients: () => [] })
  try {
    if (options.records) await store.save(options.records)
    await manager.start(); await server.start()
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
    return { directory, store, manager, server, rpc,
      async dispose() {
        try { await rpc.dispose() }
        finally { try { await server.stop() } finally { try { await manager.stop() } finally { await rm(directory, { recursive: true, force: true }) } } }
      } }
  } catch (error) {
    try { await server.stop(); await manager.stop() } finally { await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}

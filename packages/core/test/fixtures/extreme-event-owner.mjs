import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapStatistics } from 'node:v8'
import { startHeadlessAgentMux, AgentMuxClient, AgentMuxError, AgentMuxSpatialStateStore } from '../../dist/index.js'
import { CtxmuxRunAdapter } from '../../dist/ctxmux-run-adapter.js'

const state = process.env.AGENTMUX_STATE_DIRECTORY
const journal = value => appendFileSync(join(state, 'fault-native-operations.ndjson'), JSON.stringify({ pid: process.pid, ...value }) + '\n')
const connect = AgentMuxClient.prototype.connect
AgentMuxClient.prototype.connect = function () {
  if (!this.hookServer.isRunning()) Object.defineProperty(this.hookServer, 'port', { value: 0 })
  return connect.call(this)
}
for (const method of ['start', 'input']) {
  const original = CtxmuxRunAdapter.prototype[method]
  CtxmuxRunAdapter.prototype[method] = async function (...args) {
    const request = method === 'start' ? { operation: args[0].operationKey } : { runId: args[0], operation: args[1].operationId }
    journal({ phase: 'request', method, ...request })
    const fail = join(state, 'not-dispatched-reply')
    if (method === 'input' && existsSync(fail)) {
      unlinkSync(fail)
      journal({ phase: 'not-applied', method, ...request })
      throw new AgentMuxError('Test-owned transport did not dispatch this optional reply.', 'CTXMUX_io', undefined,
        { disposition: 'not_applied', confirmedInputBytes: 0 })
    }
    const result = await original.apply(this, args)
    journal({ phase: 'ack', method, ...request, result })
    return result
  }
}
const owner = await startHeadlessAgentMux({ socketPath: join(process.env.AGENTMUX_RUNTIME_DIRECTORY, 'headless.sock'),
  service: { spatialState: new AgentMuxSpatialStateStore(join(state, 'spatial-state.json')) } })
process.stdout.write(JSON.stringify({ owner: owner.ownerIdentity(), socketPath: owner.socketPath }) + '\n')
process.once('SIGTERM', () => { void owner.stop() })
process.once('SIGINT', () => { void owner.stop() })
// Only this private child allocates. The parent arms the trigger after it has
// independently verified real original Native/Store/context/workface progress.
const memory = []
setInterval(() => {
  const path = join(state, 'actual-heap-exhaustion')
  if (!existsSync(path) || JSON.parse(readFileSync(path, 'utf8')).pid !== process.pid) return
  unlinkSync(path)
  writeFileSync(join(state, 'oom-entered.json'), JSON.stringify({ pid: process.pid, heap: getHeapStatistics(),
    memory: process.memoryUsage(), limit: process.execArgv }))
  for (;;) memory.push(new Array(128 * 1024).fill(memory.length))
}, 10).unref()

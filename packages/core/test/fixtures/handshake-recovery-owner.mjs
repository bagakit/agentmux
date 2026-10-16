import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CtxmuxRunAdapter } from '../../dist/ctxmux-run-adapter.js'
import { AgentMuxClient } from '../../dist/index.js'

// Observation only: retain exact attempted operation metadata, never input bodies.
const input = CtxmuxRunAdapter.prototype.input
CtxmuxRunAdapter.prototype.input = async function (runId, operation) {
  appendFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'observed-inputs.ndjson'), JSON.stringify({ runId,
    operationId: operation.operationId, expectedByte: operation.expectedByte, bytes: Buffer.byteLength(operation.data) }) + '\n')
  return await input.call(this, runId, operation)
}
const connect = AgentMuxClient.prototype.connect
AgentMuxClient.prototype.connect = async function () {
  if (!this.hookServer.isRunning()) Object.defineProperty(this.hookServer, 'port', { value: 0 })
  try {
    const result = await connect.call(this)
    writeFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'original-observation.json'), JSON.stringify({ state: 'observed', pid: process.pid }))
    return result
  } catch (error) {
    writeFileSync(join(process.env.AGENTMUX_STATE_DIRECTORY, 'original-observation.json'), JSON.stringify({ state: 'failed', code: error.code, pid: process.pid }))
    throw error
  }
}
await import('./headless-runtime-worker.mjs')

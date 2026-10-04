import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { connectLocalAgentMuxRuntime, connectLocalAgentMux, AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
import { connectLocalAgentMuxRuntime as subpathFactory } from '@agentmux/core/runtime-client'
assert.equal(connectLocalAgentMuxRuntime, subpathFactory)
const [phase, identityPath] = process.argv.slice(2)
class Store extends AgentMuxMemoryAgentSessionStore {
  loads = 0
  pending = false
  failed = false
  resolve
  async load() {
    this.loads++
    if (this.pending) await new Promise(resolve => { this.resolve = resolve })
    if (this.failed) throw new Error('private catalog observation failure')
    return super.load()
  }
}
const store = new Store()
const client = await connectLocalAgentMuxRuntime({ providers: [], store })
assert.equal(store.loads, 0, 'Runtime-first factory awaited full observation')
const events = []
client.onEvent(event => { events.push(event) })
let run
const waitFor = async test => {
  for (let attempt = 0; attempt < 200; attempt++) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
  throw new Error('Private consumer observation did not arrive')
}
const output = async () => (await client.readRunReplay(run, 0)).replay.map(event => event.data).join('')
const input = async data => {
  const current = (await client.listRuns()).find(item => item.runId === run.runId)
  await client.writeTerminal(run, { ownerInstanceId: client.runtimeIdentity().instanceId,
    operationId: crypto.randomUUID(), expectedByte: current.acceptedInputBytes, data })
}
try {
  if (phase === 'first') {
    run = await client.createTerminal({ workspacePath: process.cwd(), command: process.execPath,
      args: ['-e', 'process.stdout.write(`ready:${process.pid}\\n`);process.stdin.on("data",d=>process.stdout.write("received:"+d));process.stdin.resume()'] })
    await client.attachTerminal(run.runId)
    await waitFor(async () => (await output()).includes(`ready:${run.pid}`))
    store.pending = true
    const observing = client.connect()
    await waitFor(() => Boolean(store.resolve))
    await input('while-pending\n')
    await waitFor(async () => (await output()).includes('received:while-pending'))
    store.failed = true;store.pending = false;store.resolve()
    await assert.rejects(observing, /private catalog observation failure/)
    assert(events.some(event => event.type === 'agent-error' && event.code === 'CTXMUX_CONNECTION_OBSERVATION_FAILED'))
    assert.equal((await client.runtimeDiagnostics()).ctxmux.ready, true)
    assert(events.some(event => event.type === 'connection-state' && event.diagnostic?.code === 'CTXMUX_CONNECTION_OBSERVATION_FAILED'))
    await input('after-failure\n')
    await waitFor(async () => (await output()).includes('received:after-failure'))
    store.failed = false
    await client.connect()
    assert.equal((await client.listRuns()).find(item => item.runId === run.runId).pid, run.pid)
    await writeFile(identityPath, JSON.stringify({ runId: run.runId, pid: run.pid }))
    process.stdout.write(JSON.stringify({ phase, runId: run.runId, pid: run.pid, pendingInput: true, failureInput: true, sameClientRefresh: true })+'\n')
  } else {
    run = JSON.parse(await readFile(identityPath, 'utf8'))
    const attached = await client.attachTerminal(run.runId)
    assert.equal(attached.run.pid, run.pid, 'Original physical process was replaced')
    assert((await output()).includes('received:after-failure'))
    await input('after-process-reopen\n')
    await waitFor(async () => (await output()).includes('received:after-process-reopen'))
    const failureStore = new Store();failureStore.failed = true
    await assert.rejects(connectLocalAgentMux({ providers: [], store: failureStore }), /private catalog observation failure/)
    assert(failureStore.loads > 0, 'Full factory returned before observation')
    assert.equal((await client.listRuns()).find(item => item.runId === run.runId).pid, run.pid)
    await client.stopTerminal(run)
    process.stdout.write(JSON.stringify({ phase, runId: run.runId, pid: run.pid, originalProcess: true, fullFactoryRejects: true })+'\n')
  }
} finally { await client.dispose() }

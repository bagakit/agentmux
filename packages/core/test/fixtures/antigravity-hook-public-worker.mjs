import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  AgentMuxClient, AgentMuxFileAgentSessionStore, AgentProviderRegistry,
  defaultAgentMuxHookPort, loadAgentSessions
} from '../../dist/index.js'

// An ordinary consumer process with a private SDK transport. The real compiled Client,
// Provider, authenticated HTTP ingress, FileStore and input admission all execute.
// No daemon, vendor CLI, user configuration or user Agent Run is used.
const request = JSON.parse(await readFile(process.argv[2], 'utf8'))
const root = resolve(request.root)
assert.match(root, /\/amx-antigravity-public-[^/]+$/)
for (const [key, path] of Object.entries({
  AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
  AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
  AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'),
  AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json')
})) assert.equal(process.env[key], path)

const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
const [seed] = await loadAgentSessions(store)
assert.ok(seed)
const counts = { start: 0, input: 0, resize: 0, stop: 0, attach: 0, status: 0 }
const input = []
const run = {
  id: seed.run.runId,
  spec: { program: 'private-synthetic-antigravity', args: [], cwd: root, env: {} },
  lineage: null, pid: null, state: { type: 'running' }, latest_output_bytes: 42,
  durable_output_bytes: 42, first_available_byte: 0, attachments: 0,
  applied_input_bytes: 0, current_size: { cols: 80, rows: 24 }
}
const base = new AgentProviderRegistry().get('antigravity')
const contexts = []
const provider = {
  ...base,
  normalizeHook(envelope, context) {
    const normalized = base.normalizeHook(envelope, context)
    contexts.push({
      frozen: Object.isFrozen(context),
      handleFrozen: !context.nativeHandle || Object.isFrozen(context.nativeHandle),
      nativeHandle: context.nativeHandle ?? null,
      eventName: envelope.eventName,
      semanticState: normalized.semanticState,
      lifecycleEvent: normalized.lifecycleEvent ?? null
    })
    return normalized
  }
}
const client = new AgentMuxClient({ store, providers: [provider] })
const forbidden = name => async () => {
  counts[name]++
  throw new Error(`Unexpected private ${name} operation`)
}
Object.assign(client.kernel, {
  client: {
    list: async () => [{ id: run.id }],
    status: async id => { assert.equal(id, run.id); counts.status++; return run },
    start: forbidden('start'), stop: forbidden('stop'), resize: forbidden('resize'),
    attach: forbidden('attach'),
    recoverableInput: async operation => {
      assert.equal(operation.runId, run.id)
      assert.equal(operation.expectedByte, run.applied_input_bytes)
      counts.input++
      input.push(operation.data)
      const start = run.applied_input_bytes
      run.applied_input_bytes += Buffer.byteLength(operation.data)
      return { run, receipt: { start_byte: start, end_byte: run.applied_input_bytes, data: operation.data } }
    }
  },
  runtime: { daemonInstanceId: 'private-synthetic-antigravity-daemon', protocolVersion: 18 }
})
const published = []
client.onEvent(event => published.push(event))
try {
  await client.connect()
  const before = client.agentSessions()
  assert.equal(before.length, 1)
  const statuses = []
  for (const [index, hook] of (request.hooks ?? []).entries()) {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hook.badToken ? 'invalid-private-token' : seed.hookToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: `${request.label}-${index}`, eventName: hook.eventName, payload: hook.payload })
    })
    statuses.push(response.status)
  }
  const restored = client.agentSessions()
  const stored = await loadAgentSessions(store)
  const timeline = await client.sessionTimeline(seed.agentSessionId)
  const inputAck = request.write === undefined ? null : await client.writeAgent({
    agentSessionId: seed.agentSessionId, expectedRun: seed.run, data: request.write, source: 'user'
  })
  process.stdout.write(JSON.stringify({
    pid: process.pid, before, restored, stored, timeline, contexts, statuses,
    inputAck, input, counts, published
  }) + '\n')
} finally {
  await client.dispose()
}

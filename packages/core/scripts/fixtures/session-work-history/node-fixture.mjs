import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, normalizeStoredAgentSession } from '@agentmux/core'
import { projectAgentWorkHistory } from '@agentmux/core/timeline'

// Ordinary SDK processes; only producer ports are isolated. No Runtime, user Run, input or lifecycle command is invoked.
const [phase, directory, output] = process.argv.slice(2)
assert(['produce', 'reread'].includes(phase))
process.env.AGENTMUX_RUNTIME_DIRECTORY = join(directory, 'runtime-unused')
process.env.AGENTMUX_STATE_DIRECTORY = join(directory, 'state-unused')
const path = join(directory, 'agent-sessions.json')
const sid = 'ordinary-history-agent'
const store = new AgentMuxFileAgentSessionStore(path)
const provider = defineAgentProvider({ catalog: {
  id: 'ordinary-history-protocol', label: 'Isolated native history protocol', executable: 'unused-agent', expectedProcess: 'unused-agent',
  promptDelivery: 'positional-argv', readySignal: { kind: 'foreground-process', expectedProcess: 'unused-agent' },
  hookStrategy: { kind: 'native', installation: 'unmanaged' }, resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
  capabilities: { terminal: true, timeline: 'complete-events', permission: 'none', providerResume: false, replyCorrelation: 'none' }
}, buildArgs: (_prompt, args) => [...args], hook: { rules: [
  { events: ['work'], state: 'working' }, { events: ['wait'], state: 'waiting' }, { events: ['done'], state: 'done' }
] } })
const client = new AgentMuxClient({ store, providers: [provider] })
let receipt
try {
  if (phase === 'produce') {
    await client.hookServer.start()
    const binding = client.hookServer.createBinding(sid, provider.catalog.id)
    await store.compareAndSwap(null, normalizeStoredAgentSession({ kind: 'agent', agentSessionId: sid,
      providerId: provider.catalog.id, executorId: 'ordinary-history-executor', hostId: 'local', workspacePath: directory,
      run: { runId: 'ordinary-first-run' }, retiredRuns: [], hookBindingId: binding.bindingId, hookToken: binding.endpoint.token,
      createdAt: Date.now(), updatedAt: Date.now() }))
    await client.registry.load('local')
    await binding.bindRun('ordinary-first-run')
    const hook = async (eventName, receiptId) => {
      const response = await fetch(binding.endpoint.url, { method: 'POST',
        headers: { authorization: `Bearer ${binding.endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ eventName, receiptId }) })
      assert.equal(response.status, 204)
    }
    await hook('work', 'native-round-one')
    await hook('wait', 'native-wait-one')
    await hook('work', 'native-round-two')
    await hook('done', 'native-done-two')
    assert.equal(client.agentSession(sid).semanticStatus.state, 'done')
    await hook('work', 'native-round-one')
    assert.equal(client.agentSession(sid).semanticStatus.state, 'done')
    let emit
    let closed = 0
    await client.acp.bind(sid, { adapterId: 'ordinary-history-acp', sessionId: 'ordinary-history-native',
      onEvent: listener => { emit = listener; return () => {} }, respondPermission: async () => {}, close: async () => { closed++ } })
    const acp = async state => {
      emit({ type: 'status', state })
      await client.acp.bindings.get(sid).eventTail
    }
    await acp('working'); await acp('waiting'); await acp('working'); await acp('done')
    assert.equal(closed, 0)
    const previous = (await store.load())[0]
    const { hookReceipt: _oldReceipt, ...continuity } = previous
    const next = normalizeStoredAgentSession({ ...continuity, run: { runId: 'ordinary-second-run' },
      retiredRuns: [previous.run], updatedAt: Date.now() })
    await store.compareAndSwap(previous, next)
    await client.registry.load('local')
    await acp('working')
    const endedAt = Date.now()
    client.acceptKernelEvent({ type: 'exit', runId: next.run.runId, observedAt: endedAt,
      state: { type: 'interrupted', reason: 'isolated-process-observation' } })
    // Wait for the original accepted boundary commit, never re-seed or fabricate a reader fact.
    for (let attempt = 0; attempt < 200; attempt++) {
      const items = (await client.sessionTimeline(sid)).items
      if (items.some(item => item.activityState?.boundary === 'interrupted')) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const beforeRetire = (await store.load())[0]
    const reservation = { kind: 'stop', reservationId: 'ordinary-history-retirement', ownerId: 'ordinary-history-owner',
      ownerPid: process.pid, agentSessionId: sid, expectedRun: beforeRetire.run, operationId: 'ordinary-history-retirement',
      expiresAt: Date.now() + 60_000,
      stopOperation: { daemonInstance: 'isolated-unused-runtime', operationKey: 'ordinary-history-retirement', runId: beforeRetire.run.runId } }
    await store.reserveLifecycle(reservation)
    await store.commitLifecycle(reservation, null)
    const history = await client.sessionTimeline(sid)
    const projection = projectAgentWorkHistory(history.items)
    assert.equal(projection.segments.length, 5)
    assert.equal(projection.segments.at(-1).end, 'run-ended')
    assert.equal(projection.segments.at(-1).endAt, endedAt)
    assert(history.items.some(item => item.source === 'acp' && item.activityState))
    assert(history.items.some(item => item.source === 'native-hook' && item.activityState))
    receipt = { phase, pid: process.pid, seedCount: 1, producers: ['native-http-original-ingress', 'acp-original-binding'],
      runtimeConnected: false, history, projection, descriptor: (await client.sessionHistorySources())[0], latestSemanticState: beforeRetire.semanticStatus.state }
  } else {
    const mainBefore = await readFile(path)
    const timelinePath = join(directory, 'agent-timelines', `${createHash('sha256').update(sid).digest('base64url')}.jsonl`)
    const timelineBefore = await readFile(timelinePath)
    const history = await client.sessionTimeline(sid)
    const projection = projectAgentWorkHistory(history.items)
    const descriptor = (await client.sessionHistorySources()).find(source => source.agentSessionId === sid)
    assert.equal(descriptor.state, 'retired')
    assert.equal((await client.readAgentSessions()).length, 0)
    assert.equal(projection.segments.length, 5)
    assert.equal(projection.segments.at(-1).end, 'run-ended')
    assert.deepEqual(await readFile(path), mainBefore)
    assert.deepEqual(await readFile(timelinePath), timelineBefore)
    receipt = { phase, pid: process.pid, seedCount: 0, runtimeConnected: false, readOnly: true, history, projection, descriptor }
  }
} finally { await client.dispose() }
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`)

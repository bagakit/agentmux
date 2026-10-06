import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore as SourceFileStore, AgentMuxMemoryAgentSessionStore as SourceMemoryStore } from '../src/agent-session-store.js'
import { AgentMuxControlServer as SourceServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc as SourceConnect } from '../src/public-rpc-client.js'
import type { AgentMuxStoredAgentSession, AgentNativePromptInputPlan } from '../src/types.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { AgentMuxHostedRuntimeService as SourceHostedService } from '../src/hosted-runtime-service.js'
import { connectHostedAgentMux as SourceConnectHosted } from '../src/hosted-client.js'
import { hostedTestOwner } from './helpers/hosted-runtime-port.js'

const entry = process.env.AGENTMUX_TEST_RPC_CORE_ENTRY
const compiled = entry ? await import(entry) : null
const serverEntry = entry ? await import(new URL('./public-rpc-server.js', entry.startsWith('file:') ? entry : pathToFileURL(entry)).href) : null
const hostedEntry = entry ? await import(new URL('./hosted-runtime-service.js', entry.startsWith('file:') ? entry : pathToFileURL(entry)).href) : null
const AgentMuxFileAgentSessionStore: typeof SourceFileStore = compiled ? compiled.AgentMuxFileAgentSessionStore : SourceFileStore
const AgentMuxMemoryAgentSessionStore: typeof SourceMemoryStore = compiled ? compiled.AgentMuxMemoryAgentSessionStore : SourceMemoryStore
const AgentMuxControlServer: typeof SourceServer = serverEntry ? serverEntry.AgentMuxControlServer : SourceServer
const connectAgentMuxRpc: typeof SourceConnect = compiled ? compiled.connectAgentMuxRpc : SourceConnect
const AgentMuxHostedRuntimeService: typeof SourceHostedService = hostedEntry ? hostedEntry.AgentMuxHostedRuntimeService : SourceHostedService
const connectHostedAgentMux: typeof SourceConnectHosted = compiled ? compiled.connectHostedAgentMux : SourceConnectHosted

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const plan: AgentNativePromptInputPlan = { kind: 'native-rpc', protocolId: 'controlled-native-contract', operation: 'start-or-steer',
  sourceId: 'original-source', actorId: 'original-peer', threadId: 'original-thread' }
const body = 'Original opaque body\n{"human":true,"cancelled":true} is user text.'

function stored(root: string, id = 'A'): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: 'original', providerId: 'codex', executorId: 'codex', hostId: 'local', workspacePath: root,
    hookBindingId: 'private-hook', hookToken: 'private-token', run: { runId: 'original-run' }, retiredRuns: [], createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1),
    promptCompletionAdmission: { transport: 'native', operationId: id, submissionId: id, native: { plan, outcome: 'unknown' },
      intent: { run: { runId: 'original-run' }, ownerInstanceId: 'original-runtime', prompt: body + id, plan,
        execution: 'immediate', message: { userContent: body + id, authorHuman: true } } } }
}

for (const kind of ['memory', 'file'] as const) {
  it(`${kind} refuses an ordinary write that restarts a historical Native claim`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'am-admission-immutable-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const a = stored(root), b = { ...stored(root, 'B'), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
    try {
      await store.compareAndSwap(null, a)
      const original = await store.readPromptAdmission('original', a.run, 'A')
      await store.compareAndSwapMetadata(a, b)
      const admission = a.promptCompletionAdmission!
      if (admission.transport !== 'native') throw new Error('Test requires its original Native record')
      const restarted = { ...a, promptCompletionAdmission: { ...admission, native: { plan, outcome: 'claimed' as const } } }
      const restart = await store.compareAndSwapMetadata(b, restarted).then(() => ({ applied: true }), error => ({ error }))
      expect(restart).toMatchObject({ error: { code: 'AGENT_PROMPT_OPERATION_CONFLICT' } })
      expect(await store.readPromptAdmission('original', a.run, 'A')).toEqual(original)
      expect(await store.readMetadata('original')).toEqual(b)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['metadata', 'complete', 'delete', 'lifecycle'] as const)(`${kind} preserves original Native facts across %s writes`, async path => {
    const root = await mkdtemp(join(tmpdir(), 'am-admission-owner-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const a = stored(root)
    try {
      await store.compareAndSwap(null, a)
      const original = await store.readPromptAdmission('original', a.run, 'A')
      if (kind === 'file') {
        // An existing validated v1 database written by the old owner has no
        // history table. Only its original latest slot remains to be preserved.
        const old = new DatabaseSync(join(root, 'sessions.json')); old.exec('DROP TABLE prompt_admissions'); old.close()
      }
      if (path === 'delete') await store.compareAndSwap(a, null)
      else if (path === 'lifecycle') {
        const reservation = { kind: 'resume' as const, agentSessionId: a.agentSessionId, expectedRun: a.run,
          reservationId: 'original-reservation', operationId: 'original-resume', ownerId: 'original-owner', ownerPid: process.pid, expiresAt: Date.now() + 60_000 }
        await store.reserveLifecycle(reservation)
        const next = { ...a, run: { runId: 'next-run' }, retiredRuns: [a.run], updatedAt: reshapeFixtureEpoch(0, 0, 2) }
        delete next.promptCompletionAdmission
        await store.commitLifecycle(reservation, next)
      } else {
        const b = { ...stored(root, 'B'), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
        if (path === 'metadata') await store.compareAndSwapMetadata(a, b)
        else await store.compareAndSwap(a, b)
      }
      const reopened = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')) : store
      expect(await reopened.readPromptAdmission('original', a.run, 'A')).toEqual(original)
      expect(original?.admission).not.toHaveProperty('inputKey')
      expect(original?.admission?.intent).not.toHaveProperty('admissionIntent')
      expect(await reopened.loadMetadata()).not.toContainEqual(expect.objectContaining({ promptAdmissionHistory: expect.anything() }))
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it(`${kind} settles a late exact receipt without replacing a later input`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'am-admission-late-'))
    const store = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const a = stored(root), b = { ...stored(root, 'B'), updatedAt: reshapeFixtureEpoch(0, 0, 2) }
    try {
      await store.compareAndSwap(null, a)
      const original = (await store.readPromptAdmission('original', a.run, 'A'))!
      await store.compareAndSwapMetadata(a, b)
      if (original.admission?.transport !== 'native') throw new Error('Test requires its original Native record')
      const settled = { ...original, admission: { ...original.admission, acknowledged: true,
        native: { plan, outcome: 'admitted' as const, turnId: 'original-A-turn' } } }
      await store.settlePromptAdmission(original, settled)
      expect(await store.readPromptAdmission('original', a.run, 'A')).toEqual(settled)
      expect((await store.readMetadata('original'))?.promptCompletionAdmission).toEqual(b.promptCompletionAdmission)
      await expect(store.settlePromptAdmission(original, settled)).rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
}


/** Original records are data fixtures. No removed Provider writer manufactures history. */
async function historicalOwner(outcome: 'admitted' | 'not-applied' | 'unknown' = 'unknown') {
  const h = await rpcOwnerFixture()
  const current = (await h.store.readMetadata('recipient'))!
  const original = stored(h.root).promptCompletionAdmission!
  if (original.transport !== 'native') throw new Error('Fixture requires its original Native data')
  const admission = { ...original, inputKey: { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: current.run, submissionId: 'A' }, native: { plan, outcome, ...(outcome === 'admitted' ? { turnId: 'original-turn' } : {}) },
    ...(outcome === 'admitted' ? { acknowledged: true } : outcome === 'not-applied' ? { notApplied: true } : {}) }
  await h.store.compareAndSwapMetadata(current, { ...current, promptCompletionAdmission: { ...admission,
    intent: { ...admission.intent!, run: current.run, admissionIntent: { kind: 'manual-actor', expectedRun: current.run } } } })
  await h.inner.registry.load('local')
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: current.run, submissionId: 'A' }
  return { ...h, key, original: (await h.store.readPromptAdmission('recipient', current.run, 'A'))! }
}

it.each(['admitted', 'not-applied', 'unknown'] as const)('SDK and actual public history preserve original Native %s without a writer or Runtime connection', async outcome => {
  const h = await historicalOwner(outcome), server = new AgentMuxControlServer({ socketPath: join(h.root, 'history.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const input = h.inner.kernel.input as ReturnType<typeof vi.fn>
    const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('History must not connect Runtime'))
    expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(h.original)
    expect(await rpc.call('agent.input.inspect', { key: h.key })).toEqual({ record: h.original })
    expect((await h.store.readPromptAdmission('recipient', h.key.expectedRun, 'A'))?.admission?.native?.plan).toEqual(plan)
    expect(input).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled()
    expect(h.inner.kernel.stop).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

it('a new current-terminal input archives old Native unknown without changing or replaying that original data', async () => {
  const h = await historicalOwner()
  try {
    const result = await h.client.submitAgentPrompt({ agentSessionId: 'recipient', expectedRun: h.key.expectedRun, operationId: 'B',
      admissionIntent: { kind: 'manual-actor' }, execution: 'immediate', prompt: 'Independent current terminal input', authorHuman: true })
    expect(result).toMatchObject({ persistence: 'confirmed' })
    await Reflect.get(h.client, 'inputWaitingRecipients').get('recipient')?.pending
    expect(await h.client.inspectAgentInput({ key: { ...h.key, submissionId: 'B' } })).toMatchObject({ status: 'terminal-confirmed' })
    expect(await h.store.readPromptAdmission('recipient', h.key.expectedRun, 'A')).toEqual(h.original)
    expect(await h.client.inspectAgentPromptSubmission(h.key)).toEqual(h.original)
    const calls = (h.inner.kernel.input as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.map((call: unknown[]) => (call[1] as { data: string }).data).join('')).toContain('Independent current terminal input')
    expect(calls.map((call: unknown[]) => (call[1] as { data: string }).data).join('')).not.toContain(body)
  } finally { await h.close() }
})

it('Hosted reads old original Native history offline and still enforces the actual owner fence', async () => {
  const h = await historicalOwner()
  let ownerId = 'original-owner'
  const service = new AgentMuxHostedRuntimeService(h.client, h.store.path, () => ({ ...hostedTestOwner(h.client), ownerInstanceId: ownerId }))
  const server = new AgentMuxControlServer({ socketPath: join(h.root, 'hosted-history.sock'), coreClients: h.coreClients, hostedRuntime: () => service })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  const reader = await connectHostedAgentMux({ rpc })
  try {
    expect(await reader.inspectAgentPromptSubmission(h.key)).toEqual(h.original)
    const connect = vi.spyOn(h.client, 'connect').mockRejectedValue(new Error('Offline history retains its original owner'))
    expect(await reader.inspectAgentPromptSubmission(h.key)).toEqual(h.original)
    expect(connect).not.toHaveBeenCalled(); expect(h.inner.kernel.input).not.toHaveBeenCalled()
    ownerId = 'replacement-owner'
    await expect(reader.inspectAgentPromptSubmission(h.key)).rejects.toMatchObject({ code: 'RUNTIME_OWNER_CHANGED' })
    expect(await h.store.readPromptAdmission('recipient', h.key.expectedRun, 'A')).toEqual(h.original)
  } finally { await reader.dispose(); await rpc.dispose(); await server.stop(); await service.dispose(); await h.close() }
})

it.each(['outer-run', 'input-run', 'frozen-intent-run', 'location-session', 'location-id', 'mixed-terminal-id'] as const)('SDK refuses %s record drift without deleting original history', async fault => {
  const h = await historicalOwner()
  try {
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'A' }
    const wrong = structuredClone((await h.client.inspectAgentPromptSubmission(key))!)
    const admission = wrong.admission!
    if (fault === 'outer-run') wrong.run = { runId: 'other-run' }
    if (fault === 'input-run') admission.inputKey!.expectedRun = { runId: 'other-run' }
    if (fault === 'frozen-intent-run') admission.intent!.admissionIntent = { kind: 'manual-actor', expectedRun: { runId: 'other-run' } }
    if (fault === 'location-session') { wrong.agentSessionId = 'other-session'; admission.inputKey!.agentSessionId = 'other-session' }
    if (fault === 'location-id') { delete admission.inputKey; admission.submissionId = 'B'; admission.operationId = 'B' }
    if (fault === 'mixed-terminal-id') wrong.terminalPromptSubmission = { run: wrong.run, submissionId: 'B', promptDigest: 'a'.repeat(43), outputCursorBytes: 1,
      payload: { operationId: 'payload-B', inputByteRange: { startByte: 0, endByte: 3 }, acknowledged: true },
      submit: { operationId: 'submit-B', inputByteRange: { startByte: 3, endByte: 4 }, acknowledged: false } }
    const db = new DatabaseSync(join(h.root, 'sessions.json'))
    const bytes = JSON.stringify(wrong)
    try {
      db.prepare('UPDATE prompt_admissions SET json=? WHERE session_id=? AND run_id=? AND record_id=?')
        .run(bytes, 'recipient', 'run-recipient', JSON.stringify(['submission', 'A']))
      await expect(h.client.inspectAgentPromptSubmission(key)).rejects.toMatchObject({ code: 'INVALID_AGENT_SESSION_STORE' })
      expect(db.prepare('SELECT json FROM prompt_admissions WHERE session_id=? AND run_id=? AND record_id=?')
        .get('recipient', 'run-recipient', JSON.stringify(['submission', 'A']))!.json).toBe(bytes)
      expect(h.inner.kernel.input).not.toHaveBeenCalled()
    } finally { db.close() }
  } finally { await h.close() }
})

it('the public consumer rejects a legacy record returned for another logical ID', async () => {
  const h = await historicalOwner(), server = new AgentMuxControlServer({ socketPath: join(h.root, 'control.sock'), coreClients: h.coreClients })
  await server.start()
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: { runId: 'run-recipient' }, submissionId: 'A' }
    const original = (await h.client.inspectAgentPromptSubmission(key))!
    const wrong = structuredClone(original)
    delete wrong.admission!.inputKey; wrong.admission!.submissionId = 'B'; wrong.admission!.operationId = 'B'
    // Controlled wrong reply at the owning SDK port; actual public service,
    // JSON-RPC transport and consumer codec remain unmodified.
    vi.spyOn(h.client, 'inspectAgentPromptSubmission').mockResolvedValueOnce(wrong)
    await expect(rpc.call('agent.input.inspect', { key })).rejects.toMatchObject({ code: 'CONTROL_PROTOCOL_ERROR' })
    expect(await h.client.inspectAgentPromptSubmission(key)).toEqual(original)
    expect(h.inner.kernel.input).not.toHaveBeenCalled()
  } finally { await rpc.dispose(); await server.stop(); await h.close() }
})

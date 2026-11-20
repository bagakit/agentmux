import { fileURLToPath } from 'node:url'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { crossHostOwner, type CrossHostCleanup } from './helpers/goal-cross-host-fixture.js'
import { sessionSemanticResumeSourceRuns, type AgentMuxAgentSession } from '@agentmux/core'
import { nativeInputCorrelationKey } from '../../../packages/core/src/native-input-correlation.js'

// The private listener is independent of shared dist writes during concurrent builds.
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, fork: ((path: string | URL, args: readonly string[], options: import('node:child_process').ForkOptions) =>
    actual.fork(String(path).endsWith('/control-endpoint-listener-worker.js')
      ? fileURLToPath(new URL('../../../packages/core/src/control-endpoint-listener-worker.ts', import.meta.url)) : path, args, options)) as typeof actual.fork }
})

const cleanup: CrossHostCleanup = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
type Owner = Awaited<ReturnType<typeof crossHostOwner>>
const currentCapabilities = new WeakMap<Owner, Map<string, string>>()
async function semanticOwner(name: string, ids: string[]) {
  const h = await crossHostOwner(cleanup, name, ids), capabilities = new Map<string, string>()
  currentCapabilities.set(h, capabilities)
  const cli = h.cli
  h.cli = (who, args, input, capability) => cli(who, args, input, capability ?? (who ? capabilities.get(who) : undefined) ?? h.original.capability)
  h.call = async (who, args, input) => {
    const receipt = await h.cli(who, args, input)
    expect(receipt.code, receipt.stderr || receipt.stdout).toBe(0)
    const data = JSON.parse(receipt.stdout); expect(data.ok).toBe(true); return data.result
  }
  const config = JSON.parse(await readFile(h.configurationPath, 'utf8'))
  config.executors.claude = { providerId: 'claude', label: 'Private test Agent', command: 'claude', args: [], env: {}, injectAgentMuxGuide: false }
  await writeFile(h.configurationPath, JSON.stringify(config))
  return h
}
async function pin(source: Owner, target: Owner) {
  const a = await source.client().agentMessageAuthority(), b = await target.client().agentMessageAuthority()
  await target.client().trustMessageSource({ sourceRuntimeId: a.runtimeId, publicKey: a.publicKey,
    targetRuntimeId: b.runtimeId, targetKeyFingerprint: b.fingerprint }, { kind: 'user', id: 'test-person' })
}
/** Real Core semantic lifecycle; only process/PTY and native Hook I/O are private deterministic ports. */
async function resume(h: Owner, id = 'same-session') {
  const client = h.client(), inner = client as any
  const old = await h.original.store.readMetadata(id)
  if (!old?.nativeHandle) throw Error('The original private native context is required')
  const currentRun = 'resumed-' + old.run.runId
  const originalStatus = inner.kernel.status
  const run = (runId: string) => ({ ...h.original.run(runId), pid: 1234,
    state: runId === old.run.runId ? { type: 'exited' as const, code: 0, signal: null } : { type: 'running' as const } })
  inner.kernel.status = vi.fn(async (runId: string) => runId === old.run.runId || runId === currentRun ? run(runId) : originalStatus(runId))
  inner.kernel.start = vi.fn(async (launch: { env: Record<string, string> }) => {
    expect(launch.env.AGENTMUX_AGENT_CAPABILITY).toBeTruthy()
    currentCapabilities.get(h)!.set(id, launch.env.AGENTMUX_AGENT_CAPABILITY!)
    return run(currentRun)
  }); inner.kernel.startPrepared = inner.kernel.start
  inner.kernel.creationRuntimeIdentity = () => ({ runtimeId: 'private-runtime-' + h.identity.runtimeId, instanceId: 'private-instance', buildIdentity: 'private-build', protocolVersion: 1 })
  inner.kernel.list = async () => [run(currentRun)]
  inner.hookServer.isRunning = () => true
  inner.hookServer.createBinding = (_sessionId: string, _providerId: string, bindingId: string) => ({ bindingId, endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
  inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (session: AgentMuxAgentSession) => session
  const builtin = client.providers.get('claude'), { discoverNativeSession: _discover, observeSessionStatus: _observe, ...provider } = builtin
  client.providers.replace(provider)
  vi.spyOn(inner, 'probePreparedAgent').mockResolvedValue({ providerId: 'claude', executable: 'claude', installed: true, capabilities: builtin.catalog.capabilities })
  const result = await client.resumeAgent({ agentSessionId: id, operationId: 'resume-' + currentRun, prompt: 'Continue the original private test context.' })
  expect(result.continuity).toMatchObject({ kind: 'resumed', previousRun: old.run, newRun: result.run, nativeTarget: old.nativeHandle })
  expect(result.run.runId).toBe(currentRun)
  expect(sessionSemanticResumeSourceRuns(result)).toContain(old.run.runId)
  return result
}
async function goal(h: Owner, worker = 'same-session', workerHostId = 'worker-host') {
  const goalId = (await h.call('same-session', ['goal', 'create', '--title', 'Continue the original work', '--session', 'same-session',
    '--assignees', JSON.stringify([...new Set(['same-session', worker])]), '--supervisor', 'same-session', '--risk', 'low', '--confirm', 'user', '--operation-id', 'create-semantic-goal'])).goal.id
  const aligned = await h.call(null, ['goal', 'update', '--goal', goalId, '--alignment', JSON.stringify({ summary: 'Original scope', criteria: [{ id: 'criterion', text: 'Deliver original evidence' }], openQuestions: [] })])
  const intent = { operationId: 'delegation', sourceMessageId: 'source', hostId: 'local', workerHostId, ownerAgentSessionId: 'same-session', workerAgentSessionId: worker,
    ownerRunId: 'run-same-session', workerRunId: 'run-' + worker, threadId: 'thread', text: 'Deliver original evidence', alignmentRevision: aligned.goal.alignment.revision, criterionIds: ['criterion'] }
  const report = { operationId: 'report', replyMessageId: 'reply', authorAgentSessionId: worker, grounding: { alignmentRevision: intent.alignmentRevision, summary: 'Evidence delivered', checks: [{ criterionId: 'criterion', outcome: 'met', evidence: ['checks/result.log'], note: '' }] } }
  return { goalId, intent, report }
}

async function idleNotifications(h: Owner) {
  const client = h.client(), original = (await h.original.store.readMetadata('same-session'))!
  const { semanticStatus: _status, ...idle } = original
  await h.original.store.compareAndSwapMetadata(original, idle); await (client as any).registry.load('local')
  const native = vi.fn(async (_wire: string, plan: any) => {
    const key = nativeInputCorrelationKey(plan.clientCorrelation)
    if (key?.kind !== 'prompt') throw Error('The private native notice requires its original prompt key')
    expect(key.expectedRun.runId).toBe(original.run.runId)
    return { outcome: 'admitted' as const, queuedSubmissionId: 'private-notice-' + key.submissionId }
  })
  const provider = client.providers.get('claude')
  client.providers.replace({ ...provider, catalog: { ...provider.catalog, capabilities: { ...provider.catalog.capabilities, nativeConversationInput: { ...provider.catalog.capabilities.nativeConversationInput, managedRuns: true, idleQueue: true } } },
    readPromptExecutionEvidence: async () => ({ state: 'idle', sourceId: 'private-native-source', id: 'idle-' + original.run.runId }),
    async prepareNativeInput(_context, target) { return {
      plan: { kind: 'native-rpc', protocolId: 'private-notice-protocol', sourceId: JSON.stringify([target.providerId, target.nativeSessionId]), threadId: target.nativeSessionId, actorId: 'private-writer', operation: target.idleOnly ? 'queue-idle' : 'start-or-steer' },
      assertCurrent: async () => {}, send: native, dispose: async () => {}
    } }
  })
  return native
}

async function settleNotifications(h: Owner) {
  const notices = Reflect.get(h.client(), 'messageNotifications')
  await Reflect.get(notices, 'observation')?.ready
  const drains = Reflect.get(notices, 'drains') as Map<string, { pending: Promise<void> }>
  while (drains.size) await Promise.all([...drains.values()].map(item => item.pending))
}

it('the public CLI carries a resumed worker report and Dispatch fact through the original signed thread and collection after both owners restart', async () => {
  const a = await semanticOwner('semantic-owner', ['same-session']), b = await semanticOwner('semantic-worker', ['same-session'])
  await pin(a, b); await pin(b, a)
  const g = await goal(a)
  a.routes([{ hostId: 'worker-host', client: b.reader }]); b.routes([])
  await a.call('same-session', ['goal', 'delegate', '--input', '-'], { goalId: g.goalId, intent: g.intent })
  const original = (await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'source'])).message
  await resume(b); const worker = await resume(b), owner = await resume(a)
  const nativeNotices = await idleNotifications(a)
  const submitted = await b.call('same-session', ['goal', 'report', '--input', '-'], { goalId: g.goalId, operationId: 'delegation', sourceMessageId: 'source', report: g.report })
  expect(submitted.submission.envelope).toMatchObject({ senderRunId: worker.run.runId, recipientRunId: 'run-same-session', replyTo: 'source', threadId: 'thread' })
  expect(submitted.submission.provenance.source).toMatchObject({ runtimeId: b.identity.runtimeId, agentSessionId: 'same-session', runId: worker.run.runId })
  await b.call('same-session', ['message', 'dispatch', 'report', '--source-message', 'source', '--reply-message', 'reply', '--kind', 'worker_done'])
  const collected = await a.call('same-session', ['goal', 'collect', '--input', '-'], { goalId: g.goalId, operationId: 'delegation', collection: { operationId: 'collect', replyMessageId: 'reply' } })
  expect(collected.delegations[0]).toMatchObject({ report: g.report, collection: { replyMessageId: 'reply' } })
  expect(collected.observations[0].communication.dispatch.events[0]).toMatchObject({ kind: 'worker_done', authority: { provenance: { source: { runId: worker.run.runId } } } })
  await settleNotifications(a)
  expect(nativeNotices).toHaveBeenCalledTimes(1)
  await a.call('same-session', ['goal', 'delegations', '--goal', g.goalId]); await settleNotifications(a); expect(nativeNotices).toHaveBeenCalledTimes(1)
  const queue = Reflect.get(a.client(), 'messageQueue')
  expect(await queue.pendingNotificationPosition('same-session', sessionSemanticResumeSourceRuns(owner))).toBe(0)
  expect((await queue.readByMessageId('reply')).notification.state).toBe('submitted')
  const authorityA = a.identity.runtimeId, authorityB = b.identity.runtimeId
  await a.stop(); await b.stop(); await b.start(); await a.start(); a.routes([{ hostId: 'worker-host', client: b.reader }]); b.routes([])
  expect(a.identity.runtimeId).toBe(authorityA); expect(b.identity.runtimeId).toBe(authorityB)
  const restored = await a.call('same-session', ['goal', 'delegations', '--goal', g.goalId])
  expect(restored.delegations[0]).toMatchObject({ report: g.report, collection: { replyMessageId: 'reply' } })
  expect(restored.observations[0].communication.source.provenance).toEqual(original.provenance)
  expect(restored.observations[0].communication.replies[0].envelope.senderRunId).toBe(worker.run.runId)
  expect(a.native.stop).not.toHaveBeenCalled(); expect(b.native.stop).not.toHaveBeenCalled()
})

it('the signing Core refuses old-thread replies and Dispatch facts from new context, missing, ambiguous and retired-only recovery while preserving healthy new messages', async () => {
  const a = await semanticOwner('negative-owner', ['same-session']), b = await semanticOwner('negative-worker', ['same-session'])
  await pin(a, b); await pin(b, a); a.routes([{ hostId: 'worker-host', client: b.reader }]); b.routes([])
  await a.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'agent-session', agentSessionId: 'same-session', hostId: 'worker-host' }, operationId: 'source-op', messageId: 'source', threadId: 'thread', text: 'Original task' })
  const resumed = await resume(b)
  await b.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: 'source' }, operationId: 'allowed-op', messageId: 'allowed', text: 'Original evidence' })
  const retained = (await b.original.store.readMetadata('same-session'))!
  const variants = ['new-context', 'missing', 'ambiguous', 'retired-only', 'native-changed']
  for (const variant of variants) {
    const changed = structuredClone(retained)
    if (variant === 'new-context') changed.nativeBinding = { ...changed.nativeBinding!, source: 'process-witness' }
    if (variant === 'missing' || variant === 'retired-only') { delete changed.continuity; delete changed.continuityOperations }
    if (variant === 'retired-only') changed.retiredRuns = [{ runId: 'run-same-session' }]
    if (variant === 'ambiguous') changed.continuityOperations = { ...changed.continuityOperations, conflict: { ...changed.continuity!, operationId: 'conflict', previousRun: { runId: 'unrelated-run' } } }
    if (variant === 'native-changed') {
      if (changed.nativeHandle?.kind !== 'provider') throw Error('The private provider identity is required')
      changed.nativeHandle = { ...changed.nativeHandle, sessionId: 'another-native' }
    }
    const before = await b.original.store.readMetadata('same-session')
    await b.original.store.compareAndSwapMetadata(before, changed); await (b.client() as any).registry.load('local')
    const refused = await b.cli('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: 'source' }, operationId: 'op-' + variant, messageId: variant, text: 'Must not impersonate old context' })
    expect(refused.code, variant + refused.stderr).toBe(1); expect(refused.stderr).toContain('MESSAGE_PARTICIPANT_MISMATCH')
    const fact = await b.cli('same-session', ['message', 'dispatch', 'report', '--source-message', 'source', '--reply-message', 'allowed', '--kind', 'question'])
    expect(fact.code, variant + fact.stderr).toBe(1); expect(fact.stderr).toContain('AGENT_CAPABILITY_STALE_RUN')
    const fresh = await b.client().prepareFederatedMessage({ caller: { agentSessionId: 'same-session', capability: currentCapabilities.get(b)!.get('same-session')! }, target: { runtimeId: a.identity.runtimeId, agentSessionId: 'same-session', runId: 'run-same-session' }, targetKeyFingerprint: (await a.client().agentMessageAuthority()).fingerprint, operationId: 'fresh-op-' + variant, messageId: 'fresh-' + variant, text: 'Independent new message' })
    expect(fresh.packet.envelope.senderRunId).toBe(resumed.run.runId)
    expect((await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', variant])).message).toBeNull()
  }
  expect(b.native.stop).not.toHaveBeenCalled()
})

it('the local Goal owner validates both original Core recovery chains before a resumed unsigned report and collection', async () => {
  const a = await semanticOwner('local-semantic', ['same-session', 'worker'])
  const g = await goal(a, 'worker', 'local')
  await a.call('same-session', ['goal', 'delegate', '--input', '-'], { goalId: g.goalId, intent: g.intent })
  const worker = await resume(a, 'worker'), owner = await resume(a)
  const reported = await a.call('worker', ['goal', 'report', '--input', '-'], { goalId: g.goalId, operationId: 'delegation', report: g.report })
  expect(reported.delegations[0].report).toMatchObject(g.report)
  const reply = reported.observations[0].communication.replies[0]
  expect(reply.provenance).toBeUndefined()
  expect(reply.envelope).toMatchObject({ senderRunId: worker.run.runId, recipientRunId: owner.run.runId, threadId: 'thread', replyTo: 'source' })
  const collected = await a.call('same-session', ['goal', 'collect', '--input', '-'], { goalId: g.goalId, operationId: 'delegation', collection: { operationId: 'local-collect', replyMessageId: 'reply' } })
  expect(collected.delegations[0].collection.replyMessageId).toBe('reply')
  const changed = structuredClone((await a.original.store.readMetadata('worker'))!); delete changed.continuity; delete changed.continuityOperations
  await a.original.store.compareAndSwapMetadata(await a.original.store.readMetadata('worker'), changed); await (a.client() as any).registry.load('local')
  const refused = await a.cli('worker', ['goal', 'report', '--input', '-'], { goalId: g.goalId, operationId: 'delegation', report: g.report })
  expect(refused.code).toBe(1); expect(refused.stderr).toContain('CONTROL_PERMISSION_DENIED')
  const forgedCollect = await a.cli('same-session', ['goal', 'collect', '--input', '-'], { goalId: g.goalId, operationId: 'delegation', collection: { operationId: 'another-collect', replyMessageId: 'reply' } })
  expect(forgedCollect.code).toBe(1); expect(forgedCollect.stderr).toContain('actual worker reply')
  expect(a.native.stop).not.toHaveBeenCalled()
})

it('retains a signed reply addressed to history without notifying an unrelated new context, and keeps the exact original receipt', async () => {
  const a = await semanticOwner('retained-owner', ['same-session']), b = await semanticOwner('retained-worker', ['same-session'])
  await pin(a, b); await pin(b, a); a.routes([{ hostId: 'worker-host', client: b.reader }])
  await a.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'agent-session', agentSessionId: 'same-session', hostId: 'worker-host' }, operationId: 'source-op', messageId: 'source', text: 'Original task' })
  await resume(a); const changed = structuredClone((await a.original.store.readMetadata('same-session'))!)
  delete changed.continuity; delete changed.continuityOperations
  await a.original.store.compareAndSwapMetadata(await a.original.store.readMetadata('same-session'), changed); await (a.client() as any).registry.load('local')
  const submission = await b.call('same-session', ['agent', 'send', '--input', '-'], { target: { kind: 'reply', sourceMessageId: 'source' }, operationId: 'reply-op', messageId: 'reply', text: 'Original report remains readable' })
  const outbox = (await b.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'reply'])).message
  const queue = Reflect.get(a.client(), 'messageQueue')
  const events: Array<{ type: string; code?: string }> = []; a.client().onEvent(event => events.push(event))
  const intake = await a.client().intakeFederatedMessage({ envelope: outbox.envelope, execution: 'default', sourceChannel: outbox.sourceChannel, provenance: outbox.provenance })
  await settleNotifications(a)
  expect(await queue.pendingNotificationPosition('same-session', sessionSemanticResumeSourceRuns(changed))).toBe(0)
  expect(await queue.excludedNotificationPosition('same-session', sessionSemanticResumeSourceRuns(changed))).toBeGreaterThan(0)
  expect((await a.call('same-session', ['message', 'read', '--host', 'local', '--message-id', 'reply'])).message.envelope).toEqual(submission.envelope)
  expect(events.filter(event => event.type === 'agent-error' && event.code === 'A2A_NOTIFICATION_UNCONFIRMED')).toHaveLength(1)
  expect(await a.client().intakeFederatedMessage({ envelope: outbox.envelope, execution: 'default', sourceChannel: outbox.sourceChannel, provenance: outbox.provenance })).toEqual(intake)
  expect(events.filter(event => event.type === 'agent-error' && event.code === 'A2A_NOTIFICATION_UNCONFIRMED')).toHaveLength(1)
  expect(a.native.stop).not.toHaveBeenCalled()
})

import { fixtureEpoch as reshapeFixtureEpoch } from './helpers/fixture-values.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentMuxFileAgentSessionStore, AgentMuxMemoryAgentSessionStore, type AgentMuxAgentSessionStore } from '../src/agent-session-store.js'
import { hashAgentCapability, issueAgentCapability, type AgentCapabilityBinding } from '../src/agent-capability.js'
import type { AgentMuxStoredAgentSession, AgentNativePromptInputPlan } from '../src/types.js'

async function fixture(kind: 'memory' | 'file') {
  const root = await mkdtemp(join(tmpdir(), 'am-native-authority-'))
  const store: AgentMuxAgentSessionStore = kind === 'memory' ? new AgentMuxMemoryAgentSessionStore() : new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  const record = (id: string): AgentMuxStoredAgentSession => ({ kind: 'agent', agentSessionId: id, providerId: 'codex', executorId: 'codex',
    hostId: 'local', workspacePath: root, run: { runId: 'run-' + id }, retiredRuns: [], hookBindingId: 'hook-' + id,
    hookToken: 'private-token', capabilityHash: hashAgentCapability(issueAgentCapability()), createdAt: reshapeFixtureEpoch(0, 0, 1), updatedAt: reshapeFixtureEpoch(0, 0, 1) })
  const author = record('author'), recipient = record('recipient')
  await store.compareAndSwap(null, author); await store.compareAndSwap(null, recipient)
  const binding: AgentCapabilityBinding = { agentSessionId: author.agentSessionId, workspacePath: author.workspacePath,
    runId: author.run.runId, capabilityHash: author.capabilityHash! }
  return { root, store, author, recipient, binding, close: async () => await rm(root, { recursive: true, force: true }) }
}

// The original authenticated scope is the input to this storage boundary. Public
// raw credential authentication and actual Native dispatch are tested separately.
for (const kind of ['memory', 'file'] as const) {
  it.each(['capability', 'run', 'workspace', 'lifecycle'] as const)(`${kind} metadata owner refuses author %s drift without committing recipient`, async change => {
    const f = await fixture(kind)
    try {
      if (change === 'lifecycle') await f.store.reserveLifecycle({ kind: 'resume', reservationId: 'private-author-reservation',
        agentSessionId: f.author.agentSessionId, expectedRun: f.author.run, operationId: 'private-resume', ownerId: 'private-owner',
        ownerPid: process.pid, expiresAt: Date.now() + 60_000 })
      else await f.store.compareAndSwapMetadata(f.author, { ...f.author, updatedAt: reshapeFixtureEpoch(0, 0, 2),
        ...(change === 'capability' ? { capabilityHash: hashAgentCapability(issueAgentCapability()) }
          : change === 'run' ? { run: { runId: 'replacement-run' }, retiredRuns: [f.author.run] } : { workspacePath: join(f.root, 'other') }) })
      await expect(f.store.compareAndSwapMetadata(f.recipient, { ...f.recipient, updatedAt: reshapeFixtureEpoch(0, 0, 2) }, undefined, undefined, f.binding))
        .rejects.toMatchObject({ code: change === 'capability' ? 'AGENT_CAPABILITY_INVALID' : change === 'lifecycle' ? 'AGENT_SESSION_BUSY' : 'AGENT_CAPABILITY_STALE_RUN' })
      expect(await f.store.readMetadata(f.recipient.agentSessionId)).toEqual(f.recipient)
    } finally { await f.close() }
  })

  it(`${kind} commits the original recipient only while the author scope still matches`, async () => {
    const f = await fixture(kind)
    try {
      await f.store.compareAndSwapMetadata(f.recipient, { ...f.recipient, updatedAt: reshapeFixtureEpoch(0, 0, 2) }, undefined, undefined, f.binding)
      expect(await f.store.readMetadata(f.recipient.agentSessionId)).toEqual({ ...f.recipient, updatedAt: reshapeFixtureEpoch(0, 0, 2) })
      expect(await f.store.readMetadata(f.author.agentSessionId)).toEqual(f.author)
    } finally { await f.close() }
  })

  it.each(['old-exact-turn', 'start-or-steer'] as const)(`${kind} retains %s Native admission and original intent across reads`, async variant => {
    const f = await fixture(kind)
    try {
      const common = { kind: 'native-rpc' as const, protocolId: 'qualified-contract', actorId: 'original-actor', sourceId: 'original-source', threadId: 'original-thread' }
      const plan: AgentNativePromptInputPlan = variant === 'old-exact-turn' ? { ...common, expectedTurnId: 'original-turn' } : { ...common, operation: 'start-or-steer' }
      const turnId = variant === 'old-exact-turn' ? 'original-turn' : 'new-idle-turn'
      const admitted: AgentMuxStoredAgentSession = { ...f.recipient, promptCompletionAdmission: {
        transport: 'native', submissionId: 'original-input', operationId: 'original-input', acknowledged: true, notApplied: false,
        native: { plan, outcome: 'admitted', turnId }, intent: { run: f.recipient.run, ownerInstanceId: 'original-runtime',
          prompt: 'Original input', plan, execution: 'immediate', message: { userContent: 'Original input', authorHuman: true } } } }
      await f.store.compareAndSwapMetadata(f.recipient, admitted)
      const reopened = kind === 'file' ? new AgentMuxFileAgentSessionStore(join(f.root, 'sessions.json')) : f.store
      expect((await reopened.readMetadata(f.recipient.agentSessionId))?.promptCompletionAdmission).toEqual(admitted.promptCompletionAdmission)
    } finally { await f.close() }
  })
}

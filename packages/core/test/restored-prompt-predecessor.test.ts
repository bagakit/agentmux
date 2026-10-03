import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore, normalizeAgentSession } from '../src/agent-session-store.js'
import { AgentProviderRegistry, type AgentProviderPromptExecutionContext } from '../src/agent-provider.js'
import { readCodexPromptExecutionEvidence } from '../src/providers/codex-prompt-execution-evidence.js'
import type { AgentMuxAgentSession, AgentMuxStoredAgentSession, AgentPromptExecutionEvidence } from '../src/types.js'

let root: string | undefined
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); if (root) await rm(root, { recursive: true, force: true }); root = undefined })
const previous = (directory: string): AgentMuxStoredAgentSession => ({ kind: 'agent', agentSessionId: 'original', providerId: 'claude', executorId: 'claude',
  hostId: 'local', workspacePath: directory, run: { runId: 'old-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
  hookBindingId: 'private-binding', hookToken: 'private-token', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'same-native' } })
const nativeRecord = (ordinal: number, type: string, turn: string) => JSON.stringify({ type: 'event_msg', ordinal, payload: { type, turn_id: turn } }) + '\n'

async function rollout() {
  root = await mkdtemp(fixturePath("tmp/amux-resume-evidence-"))
  const path = join(root, 'rollout.jsonl'), body = JSON.stringify({ type: 'session_meta', payload: { id: 'same-native', cli_version: '0.159.0' } }) + '\n' + nativeRecord(1, 'task_started', 'old-working')
  await writeFile(path, body)
  const context: AgentProviderPromptExecutionContext = { args: [], workspacePath: root,
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'same-native', transcriptPath: path } }
  const evidence = (await readCodexPromptExecutionEvidence(context))!
  context.nativePromptPredecessor = { run: { runId: 'new-run' }, previousRun: { runId: 'old-run' }, sourceId: evidence.sourceId, evidenceId: evidence.id }
  return { path, body, context, evidence }
}

describe('exact native resume predecessor', () => {
  it('distinguishes the retained unfinished old turn from this new writer initial idle', async () => {
    const f = await rollout(); expect(f.evidence.state).toBe('working')
    const initial = (await readCodexPromptExecutionEvidence(f.context))!
    expect(initial.state).toBe('idle'); expect(initial.nativeTurnId).toBeUndefined(); expect(initial.id).not.toBe(f.evidence.id)
    expect(await readCodexPromptExecutionEvidence(f.context)).toEqual(initial)
    const withoutBoundary = { ...f.context }; delete withoutBoundary.nativePromptPredecessor
    expect((await readCodexPromptExecutionEvidence(withoutBoundary))!.state).toBe('working')
  })
  it('does not ignore a genuine new working turn or its exact native completion', async () => {
    const f = await rollout(); await writeFile(f.path, f.body + nativeRecord(2, 'task_started', 'new-working'))
    expect(await readCodexPromptExecutionEvidence(f.context)).toMatchObject({ state: 'working', nativeTurnId: 'new-working' })
    await writeFile(f.path, f.body + nativeRecord(2, 'task_started', 'new-working') + nativeRecord(3, 'task_complete', 'new-working'))
    expect(await readCodexPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: 'new-working', endReason: 'completed' })
  })
  it('does not use a different old evidence identity as an idle exception', async () => {
    const f = await rollout(); f.context.nativePromptPredecessor = { ...f.context.nativePromptPredecessor!, evidenceId: 'not-the-retained-event' }
    expect(await readCodexPromptExecutionEvidence(f.context)).toMatchObject({ state: 'working', nativeTurnId: 'old-working' })
  })
  it('keeps a replacement source unknown even when it copies the complete old native records', async () => {
    const f = await rollout(); const replacement = join(root!, 'replacement.jsonl')
    await writeFile(replacement, f.body); await rename(replacement, f.path)
    expect(await readCodexPromptExecutionEvidence(f.context)).toBeNull()
  })
  it('binds initial evidence identity to the new Run rather than sharing it across resumes', async () => {
    const f = await rollout(), a = await readCodexPromptExecutionEvidence(f.context)
    const b = await readCodexPromptExecutionEvidence({ ...f.context, nativePromptPredecessor: { ...f.context.nativePromptPredecessor!, run: { runId: 'another-new-run' } } })
    expect(a!.id).not.toBe(b!.id)
  })
  it('rejects persisted predecessor belonging to a different current or prior Run', () => {
    const session = { ...previous(fixturePath("tmp/private")), run: { runId: 'new-run' }, retiredRuns: [{ runId: 'old-run' }],
      nativePromptPredecessor: { run: { runId: 'new-run' }, previousRun: { runId: 'old-run' }, sourceId: 'source', evidenceId: 'old-evidence' } }
    expect(normalizeAgentSession(session).nativePromptPredecessor).toEqual(session.nativePromptPredecessor)
    expect(() => normalizeAgentSession({ ...session, run: { runId: 'other-current' } })).toThrow('exact resumed Run')
    expect(() => normalizeAgentSession({ ...session, retiredRuns: [{ runId: 'other-prior' }] })).toThrow('exact resumed Run')
  })
  it.each([['claude', false], ['codex', false], ['codex', true]] as const)('captures opaque %s evidence before Core launch, failure=%s, without blocking restoration', async (providerId, readFailure) => {
    root = await mkdtemp(fixturePath("tmp/amux-resume-core-"))
    vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime')); vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
    vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
    const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
    const old = { ...previous(root), providerId, executorId: providerId, nativeHandle: { kind: 'provider' as const, providerId, sessionId: 'same-native' } }
    await store.compareAndSwap(null, old)
    const start = vi.fn(), nativeEvidence: AgentPromptExecutionEvidence = { id: 'opaque-old-working', sourceId: 'opaque-source', state: 'working', nativeTurnId: 'old-native-turn' }
    const provider = { ...new AgentProviderRegistry().get(providerId), readPromptExecutionEvidence: vi.fn(async (context: AgentProviderPromptExecutionContext) => {
      expect(start).not.toHaveBeenCalled(); expect(context.nativeHandle).toEqual(old.nativeHandle); expect(context.nativePromptPredecessor).toBeUndefined()
      if (readFailure) throw new Error('PRIVATE_NATIVE_SOURCE_UNAVAILABLE')
      return nativeEvidence
    }) }
    const core = new AgentMuxClient({ store, providers: [provider] })
    const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown>;
      hookServer: Record<string, unknown>; ensureManagedHooks: unknown; ensureTerminalHandshakeOrDegrade: unknown }
    await inner.registry.load('local'); inner.connected = true
    const run = (id: string) => ({ runId: id, nativeService: null, lifecycleOperationId: null, program: providerId, args: [], workspacePath: root!, pid: id === 'old-run' ? null : 321,
      state: id === 'old-run' ? { type: 'exited', code: 1, signal: null } : { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: 0 })
    start.mockImplementation(async () => run('new-run'))
    Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'private-daemon', protocolVersion: 22, buildIdentity: 'private-io' }),
      status: async (id: string) => run(id), start, stop: vi.fn(), input: vi.fn() })
    inner.hookServer.isRunning = () => true
    inner.hookServer.createBinding = () => ({ bindingId: 'b'.repeat(43), endpoint: { url: 'http://127.0.0.1:0', token: 't'.repeat(43) }, bindRun: async () => {}, close: async () => {} })
    vi.spyOn(core, 'probeAgent').mockResolvedValue({ providerId, executable: providerId, installed: true, capabilities: provider.catalog.capabilities })
    inner.ensureManagedHooks = async () => {}; inner.ensureTerminalHandshakeOrDegrade = async (s: AgentMuxAgentSession) => s
    try {
      const resumed = await core.resumeAgent({ agentSessionId: old.agentSessionId, operationId: 'resume-exact', prompt: 'private at-launch input' })
      expect(resumed.nativePromptPredecessor).toEqual(readFailure ? undefined : { run: { runId: 'new-run' }, previousRun: old.run, sourceId: nativeEvidence.sourceId, evidenceId: nativeEvidence.id })
      const cold = normalizeAgentSession((await new AgentMuxFileAgentSessionStore(store.path).load())[0])
      expect(cold.nativePromptPredecessor).toEqual(resumed.nativePromptPredecessor); expect(cold.nativeHandle).toEqual(old.nativeHandle)
      expect(start).toHaveBeenCalledTimes(1); expect(provider.readPromptExecutionEvidence).toHaveBeenCalledTimes(1)
    } finally { await core.dispose() }
  })
})

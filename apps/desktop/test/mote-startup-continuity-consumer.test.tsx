// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { normalizeAgentContinuityPolicy, type AgentMuxContinuityOperation } from '../../../packages/core/src/agent-session-recovery/continuity-contract.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import type { AgentMuxAgentContinuityResult } from '../../../packages/core/src/agent-session-recovery/continuity-contract.js'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { beginMoteStartupRecovery, recoverMoteConversationAtStartup, useMoteConversationRecovery } from '../src/renderer/src/lib/mote-session-recovery'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { createMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customAgent, customTab, customMoteId, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { createClientUiRoot } from './helpers/client-ui-render'

let app: MoteAppFixture, endStartup: () => void
let root: ReturnType<typeof createClientUiRoot> | undefined, host: HTMLDivElement | undefined
const closes: Array<() => Promise<void>> = []
beforeEach(() => { app = createMoteApp(); endStartup = beginMoteStartupRecovery() })
afterEach(async () => {
  if (root) { await act(async () => root!.unmount()); root = undefined }
  host?.remove(); host = undefined
  endStartup()
  for (const close of closes.splice(0).reverse()) await close()
  await app.dispose()
})

async function fixture(options: { timing?: 'startup' | 'on-open'; cancelled?: boolean; healthy?: boolean } = {}) {
  const ended = { ...customAgent, processState: options.healthy ? 'running' as const : 'exited' as const }
  const conversation = { hostId: ended.control.hostId, sessionId: ended.control.agentSessionId,
    displayWorkspaceId: SCRATCH_WORKSPACE_ID, groupId: 'mote-group', tabId: customTab.id, regionId: customTab.layout.activeRegionId }
  const topics = moteTopics.map(topic => ({ ...topic, quickMode: topic.id === customMoteId
    ? { status: 'saved' as const, defaults: { conversation, recovery: options.timing ?? 'startup' as const }, version: 'original-setting' }
    : { status: 'missing' as const } }))
  useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === ended.id ? ended : session),
    scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics, reading: false, error: null } } })
  const f = await rpcOwnerFixture([ended.control.agentSessionId], { AgentMuxClient, AgentMuxFileAgentSessionStore }, () => ({
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native-conversation' } }))
  closes.push(f.close)
  const before = (await f.store.readMetadata(ended.control.agentSessionId))!
  const operation: AgentMuxContinuityOperation = { operationId: 'previous-application-startup', agentSessionId: before.agentSessionId,
    trigger: 'startup', previousRun: { runId: 'previous-runtime-run' }, newRun: ended.control.run,
    policy: normalizeAgentContinuityPolicy({ recheckMaxAttempts: 0 }), admittedAt: 1, observedAt: 1, rechecks: 0,
    kind: 'resumed', reason: 'confirmed-idle', nativeTarget: before.nativeHandle!,
    evidence: { kind: 'run-ended', state: 'interrupted', observedAt: 1 },
    supervision: { phase: options.cancelled ? 'cancelled' : 'paused', reason: options.cancelled ? 'explicit-cancel' : 'exit-outcome-unverified',
      activeAttemptOperationId: 'previous-application-startup', attemptCount: 1, attemptLimit: 4, observedAt: 1 } }
  const current = { ...before, run: ended.control.run, workspacePath: ended.workspacePath,
    continuity: operation, continuityOperations: { [operation.operationId]: operation } }
  await f.store.compareAndSwap(before, current)
  await f.inner.registry.load('local')
  f.inner.kernel.status = vi.fn(async (id: string) => ({ ...f.run(id), workspacePath: ended.workspacePath,
    state: options.healthy ? { type: 'running' as const } : { type: 'interrupted' as const, reason: 'daemon_restart' } }))
  f.inner.kernel.start = vi.fn(async () => { throw Error('Unexpected replacement Run') })
  const results: AgentMuxAgentContinuityResult[] = []
  const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async (control, _workspacePath, operationId, request) => {
    if (control.kind !== 'agent') throw Error('Expected the original Agent target')
    const result = await f.client.ensureAgentContinuity({ agentSessionId: control.agentSessionId, expectedRun: control.run,
      operationId, ...request, policy: { resumeAfterExit: false, recheckMaxAttempts: 0 } })
    if (result.kind !== 'pending') throw Error('Expected a policy or retained-intent receipt, not a new Run')
    results.push(result)
    return result
  })
  const state = useAppStore.getState(), preserved = { tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts,
    focus: state.agentFocus, workspace: state.activeWorkspaceId, surface: state.mainSurface }
  const assertPreserved = async () => {
    const after = useAppStore.getState(), saved = (await f.store.readMetadata(ended.control.agentSessionId))!
    expect(after.sessions.find(session => session.id === ended.id)?.control).toEqual(ended.control)
    expect({ tabs: after.tabs, layouts: after.layouts, drafts: after.agentComposerDrafts, focus: after.agentFocus,
      workspace: after.activeWorkspaceId, surface: after.mainSurface }).toEqual(preserved)
    expect(saved.run).toEqual(ended.control.run)
    expect(saved.nativeHandle).toEqual(before.nativeHandle)
    const retained = saved.continuityOperations?.[operation.operationId]
    expect(retained).toBeDefined()
    // Rejoining the original owner may record a fresh Runtime observation; its
    // original receipt, target and durable attempt budget are not rewritten.
    const { observedAt: _originalObservation, supervision: originalSupervision, ...originalReceipt } = operation
    const { observedAt: _currentObservation, supervision, ...receipt } = retained!
    const { observedAt: _originalSupervisionObservation, ...originalBudget } = originalSupervision!
    expect(receipt).toEqual(originalReceipt)
    expect(supervision).toMatchObject(originalBudget)
    expect(f.inner.kernel.start).not.toHaveBeenCalled()
    expect(f.inner.kernel.input).not.toHaveBeenCalled()
    expect(f.rawInput).not.toHaveBeenCalled()
    expect(f.inner.kernel.stop).not.toHaveBeenCalled()
    expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  }
  return { ...f, ended, operation, results, recover, assertPreserved }
}

it('fixed application startup reaches current Core policy after the original Runtime restart', async () => {
  const f = await fixture()
  await recoverMoteConversationAtStartup(f.ended)
  expect(f.results).toHaveLength(1)
  expect(f.results[0]).toMatchObject({ kind: 'pending', reason: 'resume-disabled', continuity: {
    trigger: 'startup', timingOverride: 'startup', policy: { resumeAfterExit: false } } })
  expect(useAppStore.getState().sessions.find(session => session.id === f.ended.id)).toMatchObject({ continuity: {
    operationId: f.results[0]!.continuity!.operationId, reason: 'resume-disabled' } })
  expect(f.results[0]!.continuity!.operationId).not.toBe(f.operation.operationId)
  await recoverMoteConversationAtStartup(f.ended)
  expect(f.results).toHaveLength(1)
  await f.assertPreserved()
})

it('on-open is deferred at startup and rejoins its original intent when the actual workface opens', async () => {
  const f = await fixture({ timing: 'on-open' })
  await recoverMoteConversationAtStartup(f.ended)
  expect(f.recover).not.toHaveBeenCalled()
  function OpenConversation() {
    const topic = useAppStore(state => state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.find(item => item.id === customMoteId))
    useMoteConversationRecovery(topic, SCRATCH_WORKSPACE_ID, true)
    return null
  }
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  await act(async () => root!.render(createElement(OpenConversation)))
  await vi.waitFor(() => expect(f.results).toHaveLength(1))
  expect(f.recover.mock.calls[0]![3]).toEqual({ trigger: 'workspace-open', timingOverride: 'on-open' })
  expect(f.results[0]).toMatchObject({ kind: 'pending', reason: 'recovery-supervised', continuity: {
    operationId: f.operation.operationId, trigger: 'startup' } })
  await f.assertPreserved()
})

it('a new fixed startup preserves the original explicit cancellation and durable budget', async () => {
  const f = await fixture({ cancelled: true })
  await recoverMoteConversationAtStartup(f.ended)
  expect(f.results).toHaveLength(1)
  expect(f.results[0]).toMatchObject({ kind: 'pending', reason: 'intent-cancelled', continuity: {
    operationId: f.operation.operationId, supervision: { phase: 'cancelled', attemptCount: 1, attemptLimit: 4 } } })
  await f.assertPreserved()
})

it('a healthy original Run keeps its workface and does not create a recovery request', async () => {
  const f = await fixture({ healthy: true })
  await recoverMoteConversationAtStartup(f.ended)
  expect(f.recover).not.toHaveBeenCalled()
  expect(f.results).toHaveLength(0)
  await f.assertPreserved()
})

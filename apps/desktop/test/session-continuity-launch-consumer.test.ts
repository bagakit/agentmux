// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true) })
import { DEFAULT_AGENT_CONTINUITY_POLICY } from '@agentmux/core/agent-session-recovery'
import type { AgentMuxAgentSession } from '@agentmux/core'
import type { AgentMuxContinuityOperation } from '@agentmux/core/agent-session-recovery'
import { composeAgentPrompt } from '../../../packages/core/src/agent-outbound-message'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { pendingSteerInput } from '../src/renderer/src/lib/steer-queue-delivery'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'


const initial = useAppStore.getState()
const body = 'Original fresh recovery input'
const old = { ...composerSession('launch-consumer'), processState: 'exited' as const }
const fresh = { ...old, processState: 'running' as const, control: { ...old.control, run: { runId: 'launch-consumer-resumed' } } }
function launched(operationId: string, input: NonNullable<Parameters<typeof api.sessions.recover>[3]>['input']) {
  if (!input) throw new Error('The original frozen input is required')
  const op: AgentMuxContinuityOperation = { operationId, agentSessionId: old.id, trigger: 'input', policy: { ...DEFAULT_AGENT_CONTINUITY_POLICY },
    previousRun: old.control.run, newRun: fresh.control.run, admittedAt: _historyFixtureEpoch(0, 0, 1), observedAt: _historyFixtureEpoch(0, 0, 2), rechecks: 0, kind: 'resumed', reason: 'explicit-request',
    evidence: { kind: 'run-ended', state: 'exited', observedAt: _historyFixtureEpoch(0, 0, 1) },
    launchInput: { input: structuredClone(input), prompt: composeAgentPrompt(input.prompt, input.agentMuxNote).text, digest: 'fixture-source-digest',
      message: { userContent: input.prompt, authorHuman: true, sourceChannel: 'message-tool' },
      delivery: 'launch', lifecycleOperationId: 'original-runtime-launch', state: 'launch-carried',
      key: { kind: 'prompt', agentSessionId: old.id, expectedRun: fresh.control.run, submissionId: input.submissionId },
      receipt: { kind: 'runtime-launch', operationId: 'original-runtime-launch', run: fresh.control.run, observedAt: _historyFixtureEpoch(0, 0, 2) } } }
  return { ...fresh, continuity: op, continuityOperations: { [operationId]: op } }
}
beforeEach(async () => {
  const dispose = await useAppStore.getState().initialize(); dispose()
  useAppStore.setState(initial, true)
  const tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'original-region', sessionId: old.id })
  useAppStore.setState({ sessions: [old], config: composerConfig, loading: false, tabs: { [tab.id]: tab }, layouts: {},
    agentComposerDrafts: { [old.id]: 'Independent unsent draft' }, agentSteerQueues: {}, error: null })
})
afterEach(() => { useAppStore.setState(initial, true); vi.restoreAllMocks() })

it('carries the first fresh recovery input once through actual Store recovery without a second PTY submission', async () => {
  const recover = vi.spyOn(api.sessions, 'recover').mockImplementation(async (_control, _cwd, operationId, request) => ({ kind: 'resumed', session: launched(operationId!, request?.input) }))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  expect(useAppStore.getState().send(old.id, body, undefined, 'manual', undefined, { execution: 'immediate' })).toBe(true)
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.resumeInputReceipt?.state).toBe('launch-carried'))
  const entry = useAppStore.getState().agentSteerQueues[old.id]![0]!
  expect(recover).toHaveBeenCalledOnce()
  expect(recover.mock.calls[0]![3]?.input).toEqual({ submissionId: entry.operationId, prompt: body, authorHuman: true, sourceChannel: 'message-tool' })
  expect(entry.archived).toBe(true)
  expect(entry.inputReceipt).toBeUndefined()
  expect(pendingSteerInput(entry)).toBe(false)
  expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[old.id]).toBe('Independent unsent draft')
})

it('keeps the original launch input unknown instead of reissuing PTY after a lost recovery reply', async () => {
  const recover = vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Lost original recovery reply'))
  vi.spyOn(api.sessions, 'refresh').mockRejectedValue(new Error('Original lookup unavailable'))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  expect(useAppStore.getState().send(old.id, body, undefined, 'manual', undefined, { execution: 'immediate' })).toBe(true)
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.awaitingExplicitSend).toBe(true))
  const entry = useAppStore.getState().agentSteerQueues[old.id]![0]!
  expect(entry.resumeInputIntent?.control).toEqual(old.control)
  expect(entry.resumeInputIntent?.input.submissionId).toBe(entry.operationId)
  expect(entry.inputIntakeStarted).toBe(true)
  expect(entry.archived).not.toBe(true)
  expect(recover).toHaveBeenCalledOnce()
  expect(submit).not.toHaveBeenCalled()
})

it('settles the original lost reply through actual Core event projection without creating a new input', async () => {
  vi.spyOn(api.sessions, 'recover').mockRejectedValue(new Error('Lost original recovery reply'))
  vi.spyOn(api.sessions, 'refresh').mockRejectedValue(new Error('Lookup unavailable'))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  useAppStore.getState().send(old.id, body, undefined, 'manual', undefined, { execution: 'immediate' })
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.resumeInputIntent).toBeDefined())
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.awaitingExplicitSend).toBe(true))
  const entry = useAppStore.getState().agentSteerQueues[old.id]![0]!, restored = launched(entry.operationId, entry.resumeInputIntent!.input)
  const core: AgentMuxAgentSession = { kind: 'agent', agentSessionId: old.id, providerId: old.providerId, executorId: old.executorId,
    hostId: 'local', workspacePath: old.workspacePath, run: fresh.control.run, retiredRuns: [old.control.run], createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 2),
    continuity: restored.continuity, continuityOperations: restored.continuityOperations }
  useAppStore.getState().applyEvent({ type: 'core', hostId: 'local', event: { type: 'agent-session', session: core } })
  expect(useAppStore.getState().agentSteerQueues[old.id]![0]!.resumeInputReceipt?.key).toEqual(restored.continuity!.launchInput!.key)
  expect(useAppStore.getState().agentSteerQueues[old.id]![0]!.archived).toBe(true)
  expect(submit).not.toHaveBeenCalled()
})

it('rechecks the exact original recovery and frozen input after a lost reply without changing its identity', async () => {
  const recover = vi.spyOn(api.sessions, 'recover').mockRejectedValueOnce(new Error('Lost original reply'))
    .mockImplementation(async (_control, _cwd, operationId, request) => ({ kind: 'resumed', session: launched(operationId!, request?.input) }))
  vi.spyOn(api.sessions, 'refresh').mockRejectedValue(new Error('Original lookup unavailable'))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  useAppStore.getState().send(old.id, body, undefined, 'manual', undefined, { execution: 'immediate' })
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.awaitingExplicitSend).toBe(true))
  const original = useAppStore.getState().agentSteerQueues[old.id]![0]!
  await expect(useAppStore.getState().sendQueuedAgentSteer(old.id, original.operationId)).resolves.toBe('submitted')
  expect(recover).toHaveBeenCalledTimes(2)
  expect(recover.mock.calls[1]).toEqual(recover.mock.calls[0])
  expect(useAppStore.getState().agentSteerQueues[old.id]![0]!.resumeInputReceipt?.input).toEqual(original.resumeInputIntent!.input)
  expect(submit).not.toHaveBeenCalled()
})

it('does not settle a different launch body even when its metadata repeats the original input key', async () => {
  vi.spyOn(api.sessions, 'recover').mockImplementation(async (_control, _cwd, operationId, request) => {
    const session = launched(operationId!, request?.input)
    session.continuity!.launchInput!.prompt = 'Different actually carried body'
    return { kind: 'resumed', session }
  })
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  useAppStore.getState().send(old.id, body, undefined, 'manual', undefined, { execution: 'immediate' })
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.awaitingExplicitSend).toBe(true))
  const entry = useAppStore.getState().agentSteerQueues[old.id]![0]!
  expect(entry.resumeInputReceipt).toBeUndefined()
  expect(entry.archived).not.toBe(true)
  expect(submit).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[old.id]).toBe('Independent unsent draft')
})

it('keeps confirmed unapplied recovery input distinct and lets the user move its original body to the draft', async () => {
  vi.spyOn(api.sessions, 'recover').mockImplementation(async (_control, _cwd, operationId, request) => {
    const session = launched(operationId!, request?.input), operation = session.continuity!
    operation.kind = 'conflict'; operation.reason = 'session-run-changed'; delete operation.newRun
    operation.launchInput!.state = 'not-applied'; delete operation.launchInput!.key; delete operation.launchInput!.receipt
    return { kind: 'reattachable', session }
  })
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  useAppStore.getState().send(old.id, body, undefined, 'manual', undefined, { execution: 'immediate' })
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerQueues[old.id]?.[0]?.resumeInputReceipt?.state).toBe('not-applied'))
  await vi.waitFor(() => expect(useAppStore.getState().agentSteerInFlight[old.id]).toBeUndefined())
  const entry = useAppStore.getState().agentSteerQueues[old.id]![0]!
  expect(entry.errorCode).toBe('AGENT_PROMPT_CONDITION_CHANGED')
  expect(entry.error).toContain('not applied')
  expect(submit).not.toHaveBeenCalled()
  await useAppStore.getState().moveQueuedAgentSteerToDraft(old.id, entry.operationId, body, fresh.control.run.runId)
  expect(useAppStore.getState().agentComposerDrafts[old.id]).toBe('Independent unsent draft\n\n' + body)
  expect(useAppStore.getState().agentSteerQueues[old.id]![0]!.movedToDraft).toBe(true)
  expect(pendingSteerInput(useAppStore.getState().agentSteerQueues[old.id]![0]!)).toBe(false)
})

import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentMuxError, type AgentMuxAgentSession } from '@agentmux/core'
import type { MoteChatPreparedLaunch } from '@agentmux/connectors'
import { createMoteChatAgents, type MoteChatAgentOptions } from '../src/mote-chat-agents.js'

function fixture() {
  const prepared: MoteChatPreparedLaunch = { executionHostId: 'local', input: {
    agentSessionId: 'original-chat', createOperationId: 'original-create', providerId: 'claude', executorId: 'saved-chat',
    workspacePath: '/mote', commandOverride: 'original-cli', args: ['--saved'], env: { ORIGINAL: 'saved' }, injectAgentMuxGuide: false
  } }
  const session = { kind: 'agent', agentSessionId: 'original-chat', hostId: 'local', providerId: 'claude', executorId: 'saved-chat',
    workspacePath: '/mote', run: { runId: 'original-run' }, retiredRuns: [], createdAt: 1, updatedAt: 1,
    creation: { createOperationId: 'original-create', agentMuxContext: 'confirmed', initialPrompt: 'not-requested' }
  } as AgentMuxAgentSession
  const operationId = `mote-chat-recovery-${createHash('sha256').update(JSON.stringify([session.agentSessionId, session.run.runId])).digest('hex')}`
  const client = {
    inspectAgentCreation: vi.fn(async () => structuredClone(session)), readAgentSession: vi.fn(),
    runtimeSubject: vi.fn(async () => ({ run: { ...session.run, workspacePath: session.workspacePath, kind: 'terminal', agentSessionId: null, providerId: null, executorId: null, state: 'running' } })),
    ensureAgentContinuity: vi.fn(async () => ({ kind: 'resumed', session: { ...session, run: { runId: 'resumed-run' } }, run: { runId: 'resumed-run' } })),
    listHostExecutors: vi.fn(), createHostAgentWithDelivery: vi.fn()
  }
  const resources = { read: vi.fn(), prepare: vi.fn() }
  const agents = createMoteChatAgents({ resources, clients: () => [{ hostId: 'local', client }] } as unknown as MoteChatAgentOptions)
  return { agents, prepared, session, client, resources, operationId }
}

it('keeps healthy and observation-unavailable input on the original path without an executor or recovery read', async () => {
  const f = fixture()
  await f.agents.prepareInput(f.prepared)
  f.client.runtimeSubject.mockRejectedValueOnce(new AgentMuxError('Runtime observation unavailable', 'CTXMUX_DISCONNECTED'))
  await f.agents.prepareInput(f.prepared)
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  expect(f.client.listHostExecutors).not.toHaveBeenCalled()
  expect(f.resources.read).not.toHaveBeenCalled()
  expect(f.client.createHostAgentWithDelivery).not.toHaveBeenCalled()
})

it('retains the exact recovery and original logical executor across an unavailable result and owner reopen', async () => {
  const f = fixture()
  f.client.runtimeSubject.mockResolvedValue({ run: { ...f.session.run, workspacePath: f.session.workspacePath, kind: 'terminal', agentSessionId: null, providerId: null, executorId: null, state: 'interrupted' } })
  f.client.ensureAgentContinuity.mockImplementationOnce(async input => {
    expect(input).toMatchObject({ expectedRun: f.session.run, commandOverride: 'original-cli', args: ['--saved'], env: { ORIGINAL: 'saved' } })
    expect(input).not.toHaveProperty('input')
    f.session.continuity = { operationId: f.operationId, agentSessionId: f.session.agentSessionId, previousRun: { ...f.session.run },
      kind: 'pending', trigger: 'input', reason: 'runtime-unverified' } as AgentMuxAgentSession['continuity']
    f.session.continuityOperations = { [f.operationId]: f.session.continuity! }
    return { kind: 'pending' } as never
  })
  await expect(f.agents.prepareInput(f.prepared)).rejects.toMatchObject({ code: 'MOTE_CHAT_RECOVERY_PENDING' })
  // Persisted Core receipt, even if creation projects the new Run before completion.
  f.session.continuity!.newRun = { runId: 'prepared-run' }
  f.session.run = { runId: 'prepared-run' }
  f.client.runtimeSubject.mockClear()
  const reopened = createMoteChatAgents({ resources: f.resources, clients: () => [{ hostId: 'local', client: f.client }] } as unknown as MoteChatAgentOptions)
  await reopened.prepareInput(f.prepared)
  const retry = f.client.ensureAgentContinuity.mock.calls[1]![0]
  expect(retry).toEqual({ agentSessionId: f.session.agentSessionId, expectedRun: { runId: 'original-run' }, operationId: f.operationId, trigger: 'input' })
  expect(f.client.runtimeSubject).not.toHaveBeenCalled()
})

it('keeps revision-owned executor recovery with Core and exposes unavailable native history', async () => {
  const f = fixture()
  f.session.creation!.executorRevision = 'saved-revision'
  const { commandOverride: _command, args: _args, env: _env, injectAgentMuxGuide: _guide, ...input } = f.prepared.input
  const prepared = { executionHostId: 'local', executorRevision: 'saved-revision', input } as MoteChatPreparedLaunch
  f.client.runtimeSubject.mockRejectedValueOnce(new AgentMuxError('Original Run missing', 'CTXMUX_run_not_found'))
  f.client.ensureAgentContinuity.mockResolvedValueOnce({ kind: 'unavailable', reason: 'native-handle-unavailable' } as never)
  await expect(f.agents.prepareInput(prepared)).rejects.toMatchObject({ code: 'MOTE_CHAT_RECOVERY_UNAVAILABLE' })
  expect(f.client.ensureAgentContinuity.mock.calls[0]![0]).toEqual({ agentSessionId: f.session.agentSessionId,
    expectedRun: { runId: 'original-run' }, operationId: f.operationId, trigger: 'input' })
  expect(f.client.createHostAgentWithDelivery).not.toHaveBeenCalled()
})

it('refuses an actual wrong Runtime target without recovering it or changing the original session', async () => {
  const f = fixture()
  f.client.runtimeSubject.mockResolvedValueOnce({ run: { runId: 'another-run', workspacePath: f.session.workspacePath, kind: 'terminal', agentSessionId: null, providerId: null, executorId: null, state: 'running' } })
  await expect(f.agents.prepareInput(f.prepared)).rejects.toMatchObject({ code: 'MOTE_CHAT_TARGET_UNCONFIRMED' })
  expect(f.client.ensureAgentContinuity).not.toHaveBeenCalled()
  expect(f.session.run).toEqual({ runId: 'original-run' })
})

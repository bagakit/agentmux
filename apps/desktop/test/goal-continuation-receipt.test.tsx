// @vitest-environment happy-dom
import { bridge, client, runtime, root, session, manager, writes } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'
import { createGoalRuntime } from '@agentmux/host/goal-runtime'

it('actual Goal continuation accepts its original Core receipt with platform notes and rejects another operation, Run, provider or body', async () => {
  await act(async () => root.render(null))
  const rpc = new AgentMuxRpcService({ execute: (...args) => bridge.controlOptions.execute(...args), coreClients: () => [{ hostId: 'local', client }] })
  await rpc.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'original-guided-start',
    continuation: { intervalMs: 60_000, alignmentRevision: 1 } }, { principal: { kind: 'user', id: 'fixture-human' } })
  const loop = manager.list()[0]!, initial = loop.initialDelivery!
  // The Host Goal owner inspects the initial continuation input through its own runtime port, over the same Core client.
  const owner = createGoalRuntime({ clients: () => runtime.rpcClients(), checkIn: async () => ({ known: false, reason: 'Not observed by this test.' }) })
  expect(loop.status).toBe('active')
  const original = await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: loop.agentSessionId,
    expectedRun: initial.condition.expectedRun, submissionId: initial.operationId })
  expect(original?.admission?.intent?.message).toMatchObject({ userContent: initial.prompt, systemContext: expect.any(String) })
  expect(original?.admission?.intent?.prompt).not.toBe(initial.prompt)
  expect(await owner.inspectContinuousProgressInitial(loop)).toBe('confirmed')
  const accepted = [...writes]
  for (const changed of [
    { ...loop, providerId: 'another-provider' },
    { ...loop, workspacePath: loop.workspacePath + '/another-place' },
    { ...loop, initialDelivery: { ...initial, operationId: 'another-operation' } },
    { ...loop, initialDelivery: { ...initial, condition: { ...initial.condition, expectedRun: { runId: 'another-run' } } } },
    { ...loop, initialDelivery: { ...initial, prompt: 'Different user request' } }
  ]) expect(await owner.inspectContinuousProgressInitial(changed)).toBe('unconfirmed')
  const read = vi.spyOn(client, 'inspectAgentPromptSubmission')
  read.mockResolvedValueOnce({ ...original!, agentSessionId: 'another-agent' })
  expect(await owner.inspectContinuousProgressInitial(loop)).toBe('unconfirmed')
  read.mockResolvedValueOnce({ ...original!, run: { runId: 'another-original-run' } })
  expect(await owner.inspectContinuousProgressInitial(loop)).toBe('unconfirmed')
  const { inputKey, ...unattributed } = original!.admission!
  read.mockResolvedValueOnce({ ...original!, admission: unattributed })
  expect(await owner.inspectContinuousProgressInitial(loop)).toBe('unconfirmed')
  for (const changed of [{ kind: 'message', agentSessionId: loop.agentSessionId, expectedRun: initial.condition.expectedRun, messageId: initial.operationId }, { ...inputKey!, agentSessionId: 'another-agent' },
    { ...inputKey!, expectedRun: { runId: 'another-run' } }, { ...inputKey!, submissionId: 'another-operation' }]) {
    read.mockResolvedValueOnce({ ...original!, admission: { ...original!.admission!, inputKey: changed as NonNullable<typeof inputKey> } })
    expect(await owner.inspectContinuousProgressInitial(loop)).toBe('unconfirmed')
  }
  const { terminalPromptSubmission, ...withoutTerminal } = original!
  read.mockResolvedValueOnce({ ...withoutTerminal, admission: { ...original!.admission!, acknowledged: false } })
  expect(await owner.inspectContinuousProgressInitial(loop)).toBe('pending')
  expect(writes).toEqual(accepted)
})

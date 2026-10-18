// @vitest-environment happy-dom
import { bridge, client, runtime, root, session, manager, writes } from './helpers/current-demand-product'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentMuxRpcService } from '../../../packages/core/src/public-rpc-service'

it('actual Goal continuation accepts its original Core receipt with platform notes and rejects another operation, Run, provider or body', async () => {
  await act(async () => root.render(null))
  const rpc = new AgentMuxRpcService({ execute: (...args) => bridge.controlOptions.execute(...args), coreClients: () => [{ hostId: 'local', client }] })
  await rpc.call('goal.start', { goalId: 'goal', sessionId: session.agentSessionId, operationId: 'original-guided-start',
    continuation: { intervalMs: 60_000, alignmentRevision: 1 } }, { principal: { kind: 'user', id: 'fixture-human' } })
  const loop = manager.list()[0]!, initial = loop.initialDelivery!
  expect(loop.status).toBe('active')
  const original = await client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: loop.agentSessionId,
    expectedRun: initial.condition.expectedRun, submissionId: initial.operationId })
  expect(original?.admission?.intent?.message).toMatchObject({ userContent: initial.prompt, systemContext: expect.any(String) })
  expect(original?.admission?.intent?.prompt).not.toBe(initial.prompt)
  expect(await runtime.inspectContinuousProgressInitial(loop)).toBe('confirmed')
  const accepted = [...writes]
  for (const changed of [
    { ...loop, providerId: 'another-provider' },
    { ...loop, workspacePath: loop.workspacePath + '/another-place' },
    { ...loop, initialDelivery: { ...initial, operationId: 'another-operation' } },
    { ...loop, initialDelivery: { ...initial, condition: { ...initial.condition, expectedRun: { runId: 'another-run' } } } },
    { ...loop, initialDelivery: { ...initial, prompt: 'Different user request' } }
  ]) expect(await runtime.inspectContinuousProgressInitial(changed)).toBe('unconfirmed')
  const read = vi.spyOn(client, 'inspectAgentPromptSubmission')
  read.mockResolvedValueOnce({ ...original!, agentSessionId: 'another-agent' })
  expect(await runtime.inspectContinuousProgressInitial(loop)).toBe('unconfirmed')
  read.mockResolvedValueOnce({ ...original!, run: { runId: 'another-original-run' } })
  expect(await runtime.inspectContinuousProgressInitial(loop)).toBe('unconfirmed')
  read.mockResolvedValueOnce({ ...original!, admission: { ...original!.admission!, acknowledged: false }, terminalPromptSubmission: undefined })
  expect(await runtime.inspectContinuousProgressInitial(loop)).toBe('pending')
  expect(writes).toEqual(accepted)
})

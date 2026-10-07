// @vitest-environment happy-dom
import { createElement } from 'react'
import { expect, it } from 'vitest'
import { AGENTMUX_GOAL_SKILL_ENTRY, goalRoleGuidance } from '@agentmux/core/goal-role-guidance'
import { fixture, mount, container, evidence } from './helpers/goal-responsibility-product'
import { GoalDelegationWork } from '../src/renderer/src/components/GoalDelegationWork'
import { useAppStore } from '../src/renderer/src/store'

it('actual compiled delegation preserves the original authenticated Core source and canonical executor role through the mounted consumer', async () => {
  const f = await fixture(), returned = await f.delegate('worker-a')
  const goal = (await f.demands.get('goal'))!, original = goal.delegations![0]!
  const source = await f.client.readMessage({ operationId: original.operationId })
  expect(returned).toMatchObject({ ok: true, operation: 'goal.delegate' })
  expect(source!.envelope).toMatchObject({ operationId: 'delegate-worker-a', messageId: 'source-worker-a',
    senderSessionId: 'owner', senderRunId: 'owner-run', recipientSessionId: 'worker-a', recipientRunId: 'worker-a-run', threadId: 'thread-worker-a' })
  expect(source!.envelope.body).toBe(original.text)
  expect(original.requestText).toBe('Original task for worker-a')
  expect(original.text.startsWith(original.requestText! + '\n\n')).toBe(true)
  const marker = '[AgentMux delegation]\n', offset = source!.envelope.body.lastIndexOf(marker)
  expect(offset).toBeGreaterThan(0)
  const coordination = JSON.parse(source!.envelope.body.slice(offset + marker.length))
  const canonical = goalRoleGuidance({ role: 'executor', goalId: 'goal', agentSessionId: 'worker-a', runId: 'worker-a-run',
    source: { kind: 'goal-delegation', operationId: 'delegate-worker-a', sourceMessageId: 'source-worker-a', threadId: 'thread-worker-a' } })
  expect(coordination).toMatchObject({ schema: 'agentmux.goal-delegation.v1', goalId: 'goal', operationId: original.operationId,
    sourceMessageId: original.sourceMessageId, workerAgentSessionId: original.workerAgentSessionId, roleGuidance: canonical })
  expect(canonical).toContain('Required module: ' + AGENTMUX_GOAL_SKILL_ENTRY)
  expect(f.nativeInputs).toMatchObject([{ operationId: original.operationId, messageId: original.sourceMessageId, recipient: 'worker-a', body: original.text }])
  await f.publish(); await mount(createElement(GoalDelegationWork, { demand: useAppStore.getState().demands.goal! }))
  expect(useAppStore.getState().demands.goal!.responsibility!.executions[0]).toMatchObject({
    binding: 'confirmed', phase: 'executing', execution: { operationId: original.operationId, agentSessionId: 'worker-a', runId: 'worker-a-run' } })
  expect(container.querySelector('[data-goal-responsibility="goal"]')!.textContent).toContain('worker-a')
  expect(f.stop).not.toHaveBeenCalled()
  await evidence('original-delegation-core-source-canonical-executor-role', { ...await f.proof(), originalCoreMessage: source }, 'patrol')
}, 30_000)

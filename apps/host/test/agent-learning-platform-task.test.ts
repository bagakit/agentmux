import { afterEach, expect, it, vi } from 'vitest'
import { composeAgentExtraction, composeAgentLearning } from '../src/agent-learning-prompts.js'
import { learningCore } from './agent-learning-fixture.js'
import type { AgentLearningBinding, AgentLearningOperation } from '@agentmux/core/agent-learning'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const operation: AgentLearningOperation = { operationId: 'original-learning', ownerRuntimeId: 'original-owner', source: { hostId: 'local', agentSessionId: 'source' }, revision: 2,
  proposer: { agentSessionId: 'proposer', createOperationId: 'extract-create', executorId: 'codex', state: 'created', initialPrompt: 'not-requested', context: 'confirmed' },
  candidate: { content: 'Source source; inspect its bounded original evidence. Unknown outcomes stay unknown.', author: 'proposer' }, approved: null, learner: null, issues: [], unavailable: [] }
const binding: AgentLearningBinding = { operationId: operation.operationId, ownerRuntimeId: operation.ownerRuntimeId, source: operation.source,
  candidateRevision: 2, candidateDigest: 'a'.repeat(64), executorId: 'codex', target: { kind: 'topic', topicId: 'selected-topic', spaceId: 'selected-space', zoneId: 'selected-home',
    expectedResource: { hostId: 'local', workspaceId: 'original-resource', workspacePath: (new URL('file:///').pathname + "fixture/resource") } } }

it.each(['extract', 'learn'] as const)('starts the actual %s producer task in the final Runtime wire without inventing a human body', async stage => {
  const h = await learningCore(); cleanups.push(h.close)
  const task = stage === 'extract' ? composeAgentExtraction(operation) : composeAgentLearning(binding, operation.candidate!.content)
  const input = { agentSessionId: 'created-task', createOperationId: 'task-create', providerId: 'codex', executorId: 'codex', workspacePath: h.root,
    injectAgentMuxGuide: true, agentMuxTask: task, agentMuxNote: 'Original separate destination context.' }
  const result = await h.client.createAgentWithDelivery(input), stored = (await h.store.readMetadata(input.agentSessionId))!
  expect(result.creation).toMatchObject({ initialPrompt: 'not-requested', agentMuxContext: 'confirmed' })
  expect(stored.initialInput!.prompt).toContain('Begin that task within its stated scope')
  expect(stored.initialInput!.prompt).toContain(task.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'))
  expect(stored.initialInput!.prompt).not.toContain('No request yet.')
  expect(stored.initialInput!.message).toEqual({ systemContext: expect.stringContaining(task) })
  expect(h.started[0].args).toContain(stored.initialInput!.prompt)
  expect((await h.store.loadTimeline(input.agentSessionId)).items.filter(item => item.kind === 'user_message')).toEqual([])
  expect((await h.client.createAgentWithDelivery(input)).session.run).toEqual(result.session.run)
  await expect(h.client.createAgentWithDelivery({ ...input, agentMuxTask: task + '\nAnother task.' })).rejects.toMatchObject({ code: 'AGENT_FORK_OPERATION_CONFLICT' })
  expect(h.started).toHaveLength(1); expect(h.inner.kernel.stop).not.toHaveBeenCalled()
})

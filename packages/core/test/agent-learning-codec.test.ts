import { expect, it } from 'vitest'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseAgentLearningParams, type AgentLearningOperation } from '../src/agent-learning.js'

const operation: AgentLearningOperation = { operationId: 'original-operation', ownerRuntimeId: 'owner-a', source: { hostId: 'local', agentSessionId: 'original-source' }, revision: 1,
  proposer: { agentSessionId: 'original-proposer', createOperationId: 'original-create', executorId: 'configured-executor', state: 'created',
    runId: 'original-run', initialPrompt: 'not-requested', context: 'confirmed' }, candidate: null, approved: null, learner: null, issues: [], unavailable: [] }
const input = { hostId: 'local', operationId: operation.operationId }

it('refuses array/string-coercion wire states in the actual public native codec', () => {
  for (const replacement of [{ state: ['created'] }, { initialPrompt: ['confirmed'] }, { context: ['confirmed'] }]) {
    expect(() => parseRpcNativeResult('agent.learning.inspect', { operation: { ...operation, proposer: { ...operation.proposer, ...replacement } } }, input))
      .toThrowError(expect.objectContaining({ code: 'CONTROL_PROTOCOL_ERROR' }))
  }
  expect(parseRpcNativeResult('agent.learning.inspect', { operation }, input)).toEqual({ operation })
})

it('keeps complete multi-line original diagnostics readable independently of control identities', () => {
  const multiline = { ...operation, issues: [{ step: 'extraction', code: 'ORIGINAL_PROVIDER_FAILURE', message: 'first original step\nsecond original detail\r\nretained boundary' }],
    unavailable: [{ step: 'extraction', code: 'CURRENT_OBSERVATION_UNKNOWN', message: 'Current read unavailable\nKeep the same operation.' }] }
  expect(parseRpcNativeResult('agent.learning.inspect', { operation: multiline }, input)).toEqual({ operation: multiline })
  const empty = { ...operation, issues: [{ step: 'extraction', code: 'EMPTY_DIAGNOSTIC', message: '' }], unavailable: [{ step: 'learning', code: 'EMPTY_DIAGNOSTIC', message: '' }] }
  expect(parseRpcNativeResult('agent.learning.inspect', { operation: empty }, input)).toEqual({ operation: empty })
})

it('preserves exact legal resource path bytes and refuses undeclared approval fields', () => {
  const target = { kind: 'topic', topicId: 'target-topic', spaceId: 'target-space', zoneId: 'target-zone',
    expectedResource: { hostId: 'local', workspaceId: 'scratch', workspacePath: (new URL('file:///').pathname + "synthetic/original\nresource") } }
  const request = { ...input, expectedRevision: 1, ownerRuntimeId: 'owner-a', candidateDigest: 'a'.repeat(64), target, executorId: 'configured-executor', confirmationId: 'native-action' }
  expect(parseAgentLearningParams('agent.learning.confirm', request)).toEqual(request)
  expect(() => parseAgentLearningParams('agent.learning.confirm', { ...request, approved: true })).toThrow()
})

import { expect, it } from 'vitest'
import { parseRoomBinding, parseRoomBindingOperation, parseRoomBindingParams, parseRecordedRoomBindingInput } from '../src/room-binding-codec.js'

const input = { operationId: 'original-group', bindingId: 'group-binding', connectionId: 'group-bot', expectedConnectionRevision: 1,
  executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: 'original-room',
  expectedSource: { providerId: 'sample', nativeSessionId: 'original-native' }, scope: { input: 'mentions-and-replies', publication: 'future-native-user-facing' } }
const binding = { bindingId: input.bindingId, revision: 1, state: 'active', connectionId: input.connectionId,
  application: { domain: 'chat.example', appId: 'original-app' }, externalConversationId: input.externalConversationId,
  executionHostId: input.executionHostId, agentSessionId: input.agentSessionId, scope: input.scope,
  sourceCheckpoints: [{ agentSessionId: input.agentSessionId, source: input.expectedSource, cursor: 'original-cut' }], authorizedBy: { kind: 'user', id: 'original-owner' } }

it.each(['connection.bind', 'connection.binding.relink'] as const)('requires complete public sharing only for a new %s request', method => {
  const original = { ...input, ...(method === 'connection.binding.relink' ? { expectedRevision: 1 } : {}) }
  expect(parseRecordedRoomBindingInput(method, original)).toEqual(original)
  expect(() => parseRoomBindingParams(method, original)).toThrowError(expect.objectContaining({ code: 'INVALID_ROOM_BINDING_DATA' }))
  const complete = { ...original, scope: { ...input.scope, publication: 'future-shared-conversation' } }
  expect(parseRoomBindingParams(method, complete)).toEqual(complete)
  expect(() => parseRecordedRoomBindingInput(method, { ...original, authorizedBy: binding.authorizedBy })).toThrow()
})

it('keeps original scope, receipts, private origins and unchanged lifecycle inputs readable', () => {
  expect(parseRoomBinding(binding).scope.publication).toBe('future-native-user-facing')
  expect(parseRoomBindingOperation({ operationId: input.operationId, action: 'bind', state: 'applied', binding })).toMatchObject({ binding })
  const privateBinding = { ...binding, sourceCheckpoints: [], publicationOrigin: { createOperationId: 'private-original-creation' } }
  expect(parseRoomBinding(privateBinding)).toEqual(privateBinding)
  expect(() => parseRoomBinding({ ...privateBinding, scope: { ...input.scope, publication: 'future-shared-conversation' } })).toThrow()
  for (const method of ['connection.binding.pause', 'connection.binding.resume', 'connection.binding.detach'] as const) {
    const lifecycle = { operationId: method.replaceAll('.', '-'), bindingId: input.bindingId, expectedRevision: 1 }
    expect(parseRoomBindingParams(method, lifecycle)).toEqual(lifecycle)
  }
})

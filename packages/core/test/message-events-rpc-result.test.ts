import { expect, it } from 'vitest'
import { parseRpcNativeResult } from '../src/rpc-native-codec'

const query = { participantSessionId: 'reader', messageId: 'original-mid' }
function result(hostId: string) {
  return { hostId, ...query, afterSequence: 0, latest: false, beforeSequence: null, throughSequence: 1,
    incarnation: 'original-journal', broadcastOperationId: null, nextAfterSequence: null, nextBeforeSequence: null,
    events: [{ sequence: 1, kind: 'message', at: 1, messages: [{ messageId: 'original-mid', senderSessionId: 'sender', recipientSessionId: 'reader', threadId: 'original-thread', replyTo: null }] }] }
}
it.each(['local', 'original-remote'])('decodes a valid original message event page with explicit transport Host %s', hostId => {
  const page = result(hostId)
  expect(parseRpcNativeResult('message.events', page, { ...query, hostId })).toEqual(page)
})
it('retains exact Host, original message and authenticated participant validation', () => {
  expect(() => parseRpcNativeResult('message.events', result('another-host'), { ...query, hostId: 'local' })).toThrow()
  expect(() => parseRpcNativeResult('message.events', result('local'), { ...query, hostId: 'local' },
    { agentSessionId: 'foreign-agent', capability: 'not-the-participant' })).toThrow()
  const wrong = result('local'); wrong.events[0]!.messages[0]!.messageId = 'another-mid'
  expect(() => parseRpcNativeResult('message.events', wrong, { ...query, hostId: 'local' })).toThrow()
  expect(() => parseRpcNativeResult('message.events', result('local'), { ...query, hostId: 'local', unsupported: true })).toThrow()
})

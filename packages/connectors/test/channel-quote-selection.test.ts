import { afterEach, expect, it, vi } from 'vitest'
import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { channelContextFixture } from './fixtures/channel-context.js'
import { formatGroupDiagnosis } from '../../core/src/connection-diagnosis.js'
import { parseConnectionIngressRecord, parseIngressContextObservation } from '../../core/src/ingress-codec.js'
import { parseAgentMuxMessagePrefix } from '../../core/src/agent-message-render.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function published(f: Awaited<ReturnType<typeof channelContextFixture>>) {
  await appendFile(join(f.root, 'native.jsonl'), JSON.stringify({ type: 'assistant', sessionId: 'context-native', uuid: 'known-progress', message: { role: 'assistant', content: [{ type: 'text', text: 'Same displayed content' }] } }) + '\n')
  f.services.publication!.refresh()
  await vi.waitFor(() => expect(f.services.publication!.store.list({ bindingId: f.binding.bindingId, revision: 1 }).find(op => op.reference.source.recordId === 'known-progress')?.state).toBe('confirmed'))
  return f.services.publication!.store.list({ bindingId: f.binding.bindingId, revision: 1 }).find(op => op.reference.source.recordId === 'known-progress')!
}
it('quote selection excludes exact confirmed recipient-native output and preserves same-text peer users and bots across reopen', async () => {
  const f = await channelContextFixture(cleanup, 'native', true)
  await f.receive('baseline', 1000, 'Unmentioned baseline', false)
  const original = await published(f), nativeId = original.mapping!.messageId
  f.addNative(nativeId, 1500, 'Same displayed content', { sender: { id: 'original-app', id_type: 'app_id', sender_type: 'app' } })
  f.addNative('peer-bot', 2000, 'Same displayed content', { sender: { id: 'peer-app', id_type: 'app_id', sender_type: 'app' } })
  f.addNative('peer-user', 2500, 'Same displayed content')
  const first = await f.receive('first-request', 3000, 'Current request'), receipt = await f.wait(first.ingressId, 'admitted')
  expect(receipt.context).toMatchObject({ coverage: 'complete', quotedMessages: 3, positionMessageId: 'first-request' })
  const input = receipt.ingress!.input!
  if (!('messageId' in input)) throw Error('Original Core input required')
  const message = await f.client.readMessage({ messageId: input.messageId })
  expect(message!.envelope.channelQuote!.records.map(record => record.messageId)).toEqual(['baseline', 'peer-bot', 'peer-user'])
  expect(message!.envelope.channelQuote!.range).toEqual({ from: { messageId: 'baseline', inclusive: true }, throughMessageId: 'first-request', origin: 'first-observed' })
  const wire = f.nativeSend.mock.calls[0]![0], reading = parseAgentMuxMessagePrefix(wire)
  expect(reading?.kind).toBe('content')
  if (reading?.kind !== 'content') throw Error('Actual Core reader required')
  expect(reading.declaredChannelQuote!.quote).toEqual(message!.envelope.channelQuote)
  expect(f.remote!.messageCalls().some(call => call.body.includes('Same displayed content'))).toBe(true)
  await f.reopen(); await f.services.ingress!.dispatch(first.ingressId)
  expect(f.nativeSend).toHaveBeenCalledTimes(1)
  f.addNative('next-peer', 3500, 'Useful next interval')
  const second = await f.receive('second-request', 4000, 'Next request'), next = await f.wait(second.ingressId, 'admitted')
  expect(next.context).toMatchObject({ coverage: 'complete', quotedMessages: 1, positionMessageId: 'second-request' })
  expect(next.ingress!.input).toMatchObject({ channelQuote: { range: { from: { messageId: 'first-request', inclusive: false }, origin: 'admitted-input' }, records: [{ messageId: 'next-peer' }] } })
  expect(f.nativeSend).toHaveBeenCalledTimes(2)
  expect((await f.client.readMessage({ messageId: input.messageId }))!.envelope).toEqual(message!.envelope)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)
it('quote selection observation failure retains complete native history and admitted position with an exact public diagnostic', async () => {
  const f = await channelContextFixture(cleanup, 'native', true)
  await f.receive('baseline', 1000, 'Original baseline', false)
  const original = await published(f)
  f.addNative(original.mapping!.messageId, 1500, 'Same displayed content', { sender: { id: 'original-app', id_type: 'app_id', sender_type: 'app' } })
  f.services.publication!.store.database.exec('DROP INDEX connector_publication_context_message')
  const received = await f.receive('healthy-request', 2000, 'Still accepted'), receipt = await f.wait(received.ingressId, 'admitted')
  expect(receipt.context).toMatchObject({ coverage: 'complete', gapCount: 0, quotedMessages: 2, positionMessageId: 'healthy-request', observation: 'observed', code: 'known-publications-unavailable' })
  expect(receipt.ingress!.input).toMatchObject({ contextObservation: 'known-publications-unavailable', channelQuote: { coverage: 'complete', gaps: [], records: [{ messageId: 'baseline' }, { messageId: original.mapping!.messageId }] } })
  const diagnosis = await f.rpc.call('connection.diagnose', { executionHostId: 'local', agentSessionId: 'original-agent', bindingId: f.binding.bindingId })
  const group = diagnosis.groups.value!.items[0]!
  expect(group.incoming.value!.rows.find(row => row.ingressId === received.ingressId)?.context).toEqual(receipt.context)
  expect(formatGroupDiagnosis({ ...group, service: diagnosis.service })).toContain('known-message deduplication observation unavailable')
  expect(() => parseConnectionIngressRecord({ ...receipt.ingress, input: { ...receipt.ingress!.input, contextObservation: 'admitted' } })).toThrow()
  expect(() => parseIngressContextObservation({ ...receipt.context, code: 'admitted' })).toThrow()
  await f.reopen(); await f.services.ingress!.dispatch(received.ingressId)
  expect((await f.inspect(received.ingressId)).context).toEqual(receipt.context)
  expect(f.nativeSend).toHaveBeenCalledOnce(); expect(f.inner.kernel.stop).not.toHaveBeenCalled()
}, 30000)

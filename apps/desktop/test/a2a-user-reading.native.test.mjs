import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertA2aReferenceUserReading } from '../scripts/lib/a2a-inbox-product-proof.mjs'

function fixture() {
  const recipient = { agentSessionId: 'original-recipient' }, native = { providerId: 'codex', nativeSessionId: 'original-native' }
  const notification = { key: { kind: 'prompt', agentSessionId: recipient.agentSessionId, expectedRun: { runId: 'original-run' }, submissionId: 'original-notice' }, wire: 'original notification protocol' }
  const reading = { reference: { hostId: 'local', agentSessionId: recipient.agentSessionId },
    mailbox: { agentSessionId: recipient.agentSessionId, queueId: 'original-queue', coverage: { kind: 'recorded-inputs' },
      items: [{ kind: 'item', item: { kind: 'submission', key: notification.key, record: { admission: { inputKey: notification.key,
        intent: { prompt: notification.wire, message: { a2aNotificationId: notification.key.submissionId, systemContext: notification.wire } } } } } }] },
    history: ['captured', 'native'].map(source => ({ source, hostId: 'local', agentSessionId: recipient.agentSessionId, kind: 'user-message', userMessages: [], availability: 'empty', scan: { complete: true }, ...(source === 'native' ? { nativeSource: native } : {}) })),
    view: { busy: 'false', busyTransitions: ['false', 'true', 'false'], inputScope: JSON.stringify(['local', recipient.agentSessionId]), sourceCount: 2,
      coverage: ['Loaded inputs · Partial history Sources Journal: 0 loaded; earlier coverage unconfirmed. Available history checked for this read.'], errors: [] } }
  reading.history = reading.history.map(value => ({ ok: true, value }))
  return { recipient, native, notification, reading }
}
const verify = f => assertA2aReferenceUserReading(f.reading, f.recipient, f.native, f.notification)

test('an empty user face requires the exact platform inventory and completed original source reads', () => {
  verify(fixture())
  const missing = fixture(); missing.reading.mailbox.items = []
  assert.throws(() => verify(missing), /retain this exact original platform input/u)
})

test('an unopened empty panel cannot stand in for an observed refresh read cycle', () => {
  const f = fixture(); f.reading.view.busyTransitions = ['false']
  assert.throws(() => verify(f), { name: 'AssertionError' })
})

test('failed, unavailable or incomplete original history cannot sign user-message absence', () => {
  const failed = fixture(); failed.reading.history[1] = { ok: false, error: { code: 'CONTROL_UNAVAILABLE', message: 'Original source unavailable' } }
  assert.throws(() => verify(failed), /Original history IPC read must succeed/u)
  const unavailable = fixture(); unavailable.reading.history[1].value.availability = 'unavailable'
  assert.throws(() => verify(unavailable), { name: 'AssertionError' })
  const partial = fixture(); partial.reading.history[1].value.scan.complete = false
  assert.throws(() => verify(partial), { name: 'AssertionError' })
})

test('the source reader must display its checked coverage and no read error', () => {
  const unchecked = fixture(); unchecked.reading.view.coverage = ['Loaded inputs · Partial history']
  assert.throws(() => verify(unchecked), { name: 'AssertionError' })
  const error = fixture(); error.reading.view.errors = ['Original source unavailable']
  assert.throws(() => verify(error), { name: 'AssertionError' })
})

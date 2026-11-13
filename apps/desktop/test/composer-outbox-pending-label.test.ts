import { expect, it } from 'vitest'
import { queuedMessageState, type ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'

// While an Agent request is pending, only an entry the queue will wake by itself may say it sends after
// the request ends. Rows that wait for a manual Send, have an unknown result or cannot be delivered keep
// their own honest label, and no row asks a user who may already have answered to answer again.
const queued = (overrides: Partial<ComposerQueuedMessage> = {}): ComposerQueuedMessage =>
  ({ id: 'message', text: 'Original message', status: 'queued', deliverable: true, ...overrides })

it('a plain queued entry says it sends after the request ends, without asking for an answer', () => {
  const state = queuedMessageState(queued(), true)
  expect(state.label).toBe('请求结束后发送')
  expect(state.detail).not.toContain('先回答')
  expect(state.busy).toBe(false)
})

it.each([
  ['an entry waiting for a manual Send', queued({ awaitingExplicitSend: true }), '待手动发送'],
  ['an entry whose earlier result is unknown', queued({ unconfirmed: true }), '发送结果待核实'],
  ['an entry bound to a Run that cannot take it', queued({ deliverable: false }), '原 Run 不可投递']
])('%s keeps its own label while a request is pending', (_case, entry, label) => {
  expect(queuedMessageState(entry, true).label).toBe(label)
})

it('without a pending request the same entry is ordinary queued work', () => {
  expect(queuedMessageState(queued(), false).label).toBe('排队中')
})

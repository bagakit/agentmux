import { expect, it } from 'vitest'
import { queuedMessageState, type ComposerQueuedMessage } from '../src/renderer/src/components/ComposerOutbox'

// While an Agent request is pending, only an entry the queue will wake by itself may say it sends after
// the request ends. Rows that wait for a manual Send, have an unknown result, cannot be delivered, belong
// to an older Run or carry an earlier failure keep their own honest label, and no row asks a user who may
// already have answered to answer again.
const queued = (overrides: Partial<ComposerQueuedMessage> = {}): ComposerQueuedMessage =>
  ({ id: 'message', text: 'Original message', status: 'queued', deliverable: true, wakesItself: true, ...overrides })

it('a plain queued entry says it sends after the request ends, without asking for an answer', () => {
  const state = queuedMessageState(queued(), true)
  expect(state.label).toBe('请求结束后发送')
  expect(state.detail).not.toContain('先回答')
  // The row offers copy and archive; it has no move-to-draft action, so the copy must not name one.
  expect(state.detail).not.toContain('移至草稿')
  expect(state.busy).toBe(false)
})

it.each([
  ['an entry waiting for a manual Send', queued({ awaitingExplicitSend: true }), '待手动发送'],
  ['an entry whose earlier result is unknown', queued({ unconfirmed: true }), '发送结果待核实'],
  ['an entry bound to a Run that cannot take it', queued({ deliverable: false }), '原 Run 不可投递'],
  // Editable and so still deliverable by an explicit Send, but the queue never picks it up by itself.
  ['an editable entry bound to an older Run', queued({ wakesItself: false }), '排队中'],
  ['an entry whose previous turn end is unconfirmed', queued({ errorCode: 'AGENT_TURN_END_UNCONFIRMED' }), '等待当轮确认'],
  ['an entry behind a busy previous submission', queued({ errorCode: 'AGENT_PROMPT_SUBMISSION_BUSY' }), '等待前条提交'],
  ['an entry whose delivery failed', queued({ status: 'failed', error: 'Delivery failed.' }), '待处理']
])('%s keeps its own label while a request is pending', (_case, entry, label) => {
  expect(queuedMessageState(entry, true).label).toBe(label)
})

it('without a pending request the same entry is ordinary queued work', () => {
  expect(queuedMessageState(queued(), false).label).toBe('排队中')
})

// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { SessionMailbox } from '../src/renderer/src/components/SessionMailbox'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { feedbackMessage, feedbackSessionId } from './helpers/mailbox-delivery-feedback-fixture'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
const dom = composerDOM(), session = composerSession(feedbackSessionId)
const system = { available: true, notices: [], unread: [], acknowledge: vi.fn() }
async function show(message: ReturnType<typeof feedbackMessage>) {
  const read = vi.spyOn(api.sessions, 'inputMailbox').mockImplementation(async (_target, options) => ({
    agentSessionId: feedbackSessionId, queueId: 'original-mailbox', cut: { incarnation: 'original-cut', throughSequence: 0 },
    budgetBytes: options?.maxBytes ?? 65536, items: [], nextCursor: null, coverage: { kind: 'recorded-inputs', unrecorded: 'unconfirmed' }
  }))
  const inspect = vi.spyOn(api.sessions, 'inspectInput'), rejoin = vi.spyOn(api.sessions, 'rejoinInputWaiting'), submit = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<SessionMailbox control={session.control} system={system} queued={[]} userMessages={[message]} />)
  const event = new Event('toggle'); Object.defineProperty(event, 'newState', { value: 'open' })
  await act(async () => dom.container.querySelector('.composer-mailbox')!.dispatchEvent(event))
  await dom.click('[role="tab"][id$="-user-tab"]')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 15)) })
  return { read, inspect, rejoin, submit }
}

it.each([
  ['waiting', '已保存 · 等待确认', 'saved-waiting'],
  ['not-applied', '尚未送出', 'not-applied'],
  ['unknown', '发送结果待核实', 'unknown'],
  ['terminal-confirmed', '终端输入已确认', 'terminal-confirmed'],
  ['admitted', '输入已确认', 'admitted'],
  ['stopped', '已停止等待', 'stopped']
] as const)('the actual history consumer presents Core %s without guessing from captured deliveryStatus', async (status, title, kind) => {
  const calls = await show(feedbackMessage('original', status))
  const row = dom.container.querySelector<HTMLButtonElement>('[data-record-key="timeline:original"]')!
  expect(row.closest('.composer-mailbox__record')!.textContent).toContain(title)
  expect(row.closest('.composer-mailbox__record')!.textContent).not.toContain('Delivery not confirmed')
  await act(async () => row.click())
  expect(dom.container.querySelector('[data-input-observation]')?.getAttribute('data-input-observation')).toBe(kind)
  expect(dom.container.textContent).not.toContain('Check the Agent’s response before sending again')
  if (status === 'waiting') expect(dom.container.textContent).not.toContain('自动继续首次投递')
  if (status === 'not-applied') {
    expect(dom.container.textContent).not.toContain('新消息')
    expect(dom.container.textContent).not.toContain('正在重试')
  }
  expect(calls.read).toHaveBeenCalledTimes(1)
  expect(calls.inspect).not.toHaveBeenCalled(); expect(calls.rejoin).not.toHaveBeenCalled(); expect(calls.submit).not.toHaveBeenCalled()
})

it('keeps missing original input observation unknown without claiming non-application', async () => {
  const calls = await show(feedbackMessage('unavailable'))
  await dom.click('[data-record-key="timeline:unavailable"]')
  expect(dom.container.textContent).toContain('Original delivery receipt is unavailable')
  expect(dom.container.textContent).not.toContain('尚未送出')
  expect(calls.inspect).not.toHaveBeenCalled(); expect(calls.rejoin).not.toHaveBeenCalled()
})

it('keeps a native record separate from a terminal delivery receipt', async () => {
  await show(feedbackMessage('native-original', 'terminal-confirmed', true))
  await dom.click('[data-record-key="native:native-original"]')
  await dom.click('[aria-label="Message details"]')
  expect(dom.container.textContent).toContain('Recorded · not a delivery receipt')
  expect(dom.container.querySelector('[data-input-observation]')).toBeNull()
  expect(dom.container.textContent).not.toContain('终端输入已确认')
})

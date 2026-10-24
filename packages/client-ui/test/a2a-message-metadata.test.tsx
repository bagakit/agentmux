// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationMessage } from '../src/components/ConversationMessage.js'
import { ConversationA2ATiming, ConversationA2ADetails } from '../src/components/ConversationA2AMetadata.js'

const sentAt = 1
const confirmedAt = sentAt + 25 * 60_000 + 29_000
const clockText = (at: number) => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(at)
const datedClockText = (at: number) => new Date(at).toLocaleDateString('zh-CN') + ' ' + clockText(at)
const scope = { hostId: 'original-host', agentSessionId: 'recipient' }
const wire = renderAgentMuxMessageReferences([{ senderSessionId: 'sender', messageId: 'original-mid' }])
function original(): Omit<DurableAgentMuxMessage, 'notification' | 'envelope'> & { envelope: DurableAgentMuxMessage['envelope']; notification?: DurableAgentMuxMessage['notification'] } {
  return { sequence: 1, delivery: { state: 'queued', at: sentAt }, deliveryMode: 'reference', execution: 'default',
    notification: { state: 'submitted', notificationId: 'notice-one', mode: 'idle', preparedAt: confirmedAt - 200, resultRecordedAt: confirmedAt },
    envelope: { schema: 'agentmux.a2a.v1', messageId: 'original-mid', operationId: 'original-operation', createdAt: sentAt,
      sender: { kind: 'agent-session', agentSessionId: 'sender' }, recipient: { kind: 'agent-session', agentSessionId: 'recipient' },
      senderSessionId: 'sender', senderRunId: 'sender-run', recipientSessionId: 'recipient', recipientRunId: 'recipient-run',
      threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null, body: '**完整原文**\n\n保留原工作面。' } }
}
const read = vi.fn<NonNullable<ClientUiPlatform['readA2AMessage']>>()
const copy = vi.fn(async () => true)
const platform: ClientUiPlatform = { copyText: copy, readA2AMessage: read, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: () => null, renderProjectIcon: () => null,
  renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); read.mockReset(); copy.mockClear(); read.mockResolvedValue(original())
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
function notice(id = 'notice-one') {
  return <ConversationMessage speaker={{ role: 'system', id: 'agentmux' }} messageId="captured-notice" a2aNotificationId={id}
    itemRef={{ ...scope, source: { kind: 'captured', recordId: 'captured-notice' } }} content={wire} createdAt={confirmedAt + 5000} />
}
async function click(selector: string) {
  const button = host.querySelector<HTMLElement>(selector); expect(button).not.toBeNull()
  await act(async () => button!.click())
}

it('reads the exact notice through the original card and separates sending from notification confirmation', async () => {
  await render(notice())
  expect(read).toHaveBeenCalledExactlyOnceWith(scope, 'original-mid', 'notice-one')
  const card = host.querySelector('[data-a2a-original-message-id="original-mid"]')!
  expect(card).not.toBeNull()
  const timing = card.querySelector('.conversation-a2a-timing')!
  expect(timing.textContent).toBe(`发送${clockText(sentAt)}通知确认${clockText(confirmedAt)}空闲后通知`)
  expect([...timing.querySelectorAll('time')].map(t => t.dateTime)).toEqual([new Date(sentAt).toISOString(), new Date(confirmedAt).toISOString()])
  expect(card.querySelector('.log-turn__sender-id')?.textContent).toContain('sender')
  expect(card.querySelector('.log-turn__body')?.textContent).toContain('完整原文')
  expect(card.querySelector('.conversation-a2a-metadata')).toBeNull()
  await click('[data-a2a-original-message-id] [aria-label="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith(original().envelope.body, expect.any(Function))
  await click('[data-a2a-original-message-id] .conversation-input-details__toggle')
  expect(card.querySelector('.conversation-a2a-metadata')?.textContent).toContain('原消息创建时间')
  expect(card.querySelector('.conversation-a2a-metadata')?.textContent).toContain('默认发送')
  expect(card.querySelector('.conversation-a2a-metadata')?.textContent).not.toContain('发送至确认间隔')
  expect(read).toHaveBeenCalledTimes(1)
})

it('does not borrow later manual notification metadata for an older card', async () => {
  const newer = original(); newer.notification = { ...newer.notification!, notificationId: 'notice-two', mode: 'steer' }
  read.mockResolvedValue(newer)
  await render(notice())
  expect(host.querySelector('.conversation-a2a-timing')?.textContent).toBe(`发送${clockText(sentAt)}通知信息未关联模式未记录核对通知`)
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('完整原文')
  await render(notice('notice-two'))
  expect(read.mock.calls).toEqual([[scope, 'original-mid', 'notice-one'], [scope, 'original-mid', 'notice-two']])
  expect(host.querySelector('.conversation-a2a-timing')?.textContent).toContain('立即通知')
})

it('does not invent notification timestamps from captured time, message time or the current clock', async () => {
  const message = original(); message.notification = { ...message.notification!, preparedAt: null, resultRecordedAt: null }
  read.mockResolvedValue(message)
  await render(notice())
  const timing = host.querySelector('.conversation-a2a-timing')!
  expect(timing.textContent).toBe(`发送${clockText(sentAt)}通知时间未记录空闲后通知`)
  expect(timing.querySelectorAll('time')).toHaveLength(1)
  await click('[data-a2a-original-message-id] .conversation-input-details__toggle')
  expect(host.querySelector('.conversation-a2a-metadata')?.textContent).not.toContain('发送至确认间隔')
})

it.each([['pending', '等待通知'], ['unconfirmed', '通知待核实'], ['not-applied', '本次未通知']] as const)(
  'keeps %s separate from confirmed delivery even when a result timestamp exists', async (state, label) => {
    const message = original(); message.notification = { ...message.notification!, state }
    await render(<ConversationA2ATiming message={message} notificationId="notice-one" />)
    expect(host.textContent).toBe(`发送${clockText(sentAt)}${label}空闲后通知`)
    expect(host.querySelectorAll('time')).toHaveLength(1)
  })

it('shows missing association without hiding the original and does not assert reading or acceptance', async () => {
  const message = original(); message.notification = { state: 'unassociated', notificationId: 'notice-one', reason: 'notification-not-associated' }
  await render(<><ConversationA2ATiming message={message} notificationId="notice-one" />
    <ConversationA2ADetails message={message} notificationId="notice-one" hostId={scope.hostId} /></>)
  expect(host.querySelector('.conversation-a2a-timing')?.textContent).toContain('通知信息未关联')
  expect(host.querySelector('.conversation-a2a-metadata')?.textContent).toContain('不代表 Agent 已阅读、接单或完成')
  expect(host.querySelector('.conversation-a2a-metadata')?.textContent).not.toContain('发送至确认间隔')
})

it('keeps original send intent when a person explicitly notifies later', async () => {
  const message = original(); message.notification = { ...message.notification!, mode: 'steer' }
  await render(<ConversationA2ADetails message={message} notificationId="notice-one" hostId={scope.hostId} />)
  expect(host.textContent).toContain('默认发送 · 入箱后引用通知')
  expect(host.textContent).toContain('立即通知')
  expect(host.textContent).not.toContain('立即执行请求')
})

it('includes dates across days and does not turn reversed clocks into zero wait', async () => {
  const message = original(); message.notification = { ...message.notification!, resultRecordedAt: sentAt + 86400000 }
  await render(<ConversationA2ATiming message={message} notificationId="notice-one" />)
  expect(host.textContent).toContain(datedClockText(sentAt))
  expect(host.textContent).toContain(datedClockText(sentAt + 86400000))
  message.notification = { ...message.notification!, resultRecordedAt: sentAt - 1 }
  await render(<ConversationA2ADetails message={message} notificationId="notice-one" hostId={scope.hostId} />)
  expect(host.textContent).not.toContain('发送至确认间隔')
})


it('keeps the original body readable when a recorded timestamp is outside the Date display range', async () => {
  const message = original(); message.envelope = { ...message.envelope, createdAt: 1e20 }
  read.mockResolvedValue(message)
  await render(notice())
  expect(host.querySelector('.conversation-a2a-timing')?.textContent).toContain('时间值无法显示')
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('完整原文')
  await click('[data-a2a-original-message-id] .conversation-input-details__toggle')
  expect(host.querySelector('.conversation-a2a-metadata')?.textContent).toContain('100000000000000000000')
})

it('rechecks a late notification result without clearing the original body or replaying input', async () => {
  const pending = original(); pending.notification = { ...pending.notification!, state: 'pending', resultRecordedAt: null }
  let finish!: (message: DurableAgentMuxMessage) => void
  read.mockResolvedValueOnce(pending).mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await render(notice())
  const body = host.querySelector('[data-a2a-original-message-id] .log-turn__body')!
  expect(body).not.toBeNull(); expect(host.textContent).toContain('等待通知')
  await click('[aria-label="核对通知状态"]')
  expect(host.textContent).toContain('正在核对')
  expect(host.querySelector('[data-a2a-original-message-id] .log-turn__body')).toBe(body)
  await click('[data-a2a-original-message-id] [aria-label="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith(pending.envelope.body, expect.any(Function))
  await act(async () => finish(original()))
  expect(host.querySelector('[data-a2a-original-message-id] .log-turn__body')).toBe(body)
  expect(host.querySelector('.conversation-a2a-timing')?.textContent).toContain(`通知确认${clockText(confirmedAt)}`)
  expect(host.querySelector('[aria-label="核对通知状态"]')).toBeNull()
  expect(read.mock.calls).toEqual([[scope, 'original-mid', 'notice-one'], [scope, 'original-mid', 'notice-one']])
})

it('retains verified content and a retry after notification recheck fails', async () => {
  const message = original(); message.notification = { ...message.notification!, state: 'unconfirmed' }
  read.mockResolvedValueOnce(message).mockRejectedValueOnce(new Error('Owner unavailable')).mockResolvedValueOnce(original())
  await render(notice())
  const body = host.querySelector('[data-a2a-original-message-id] .log-turn__body')!
  expect(body).not.toBeNull()
  await click('[aria-label="核对通知状态"]')
  expect(host.querySelector('[data-a2a-original-message-id] .log-turn__body')).toBe(body)
  expect(host.querySelector('.conversation-a2a-timing__issue')?.textContent).toContain('Owner unavailable')
  await click('[aria-label="核对通知状态"]')
  expect(host.querySelector('[data-a2a-original-message-id] .log-turn__body')).toBe(body)
  expect(host.querySelector('.conversation-a2a-timing__issue')).toBeNull()
  expect(host.querySelector('.conversation-a2a-timing')?.textContent).toContain(`通知确认${clockText(confirmedAt)}`)
  expect(read).toHaveBeenCalledTimes(3)
})

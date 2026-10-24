// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DurableAgentMuxMessage } from '@agentmux/core'
import { renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'

const scope = { hostId: 'original-host', agentSessionId: 'recipient' }
const references = [{ senderSessionId: 'sender', messageId: 'original-mid' }]
const wire = renderAgentMuxMessageReferences(references)
const body = '这是原信正文。\n\n' + wire
function original(mid = 'original-mid', text = body): DurableAgentMuxMessage {
  return { sequence: 1, delivery: { state: 'queued', at: 1 }, envelope: { schema: 'agentmux.a2a.v1', messageId: mid,
    operationId: 'original-operation-' + mid, createdAt: 1, sender: { kind: 'agent-session', agentSessionId: 'sender' },
    recipient: { kind: 'agent-session', agentSessionId: scope.agentSessionId }, senderSessionId: 'sender', senderRunId: 'historical-sender-run',
    recipientSessionId: scope.agentSessionId, recipientRunId: 'historical-recipient-run', threadId: mid, correlationId: mid,
    replyTo: null, workspaceId: null, body: text } }
}
const copy = vi.fn(async () => true)
const read = vi.fn<NonNullable<ClientUiPlatform['readA2AMessage']>>()
const platform: ClientUiPlatform = { copyText: copy, readA2AMessage: read, overlayContainer: () => document.body,
  bindComposerFocus: () => () => {}, renderMessageAvatar: ({ speaker }) => <span data-avatar={speaker.id} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); copy.mockClear(); read.mockReset(); read.mockResolvedValue(original())
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
function notice(props: Partial<ConversationMessageProps> = {}) {
  return <ConversationMessage speaker={{ role: 'system', id: 'agentmux' }} messageId="notice-record" a2aNotificationId="original-notice"
    itemRef={{ ...scope, source: { kind: 'captured', recordId: 'notice-record' } }}
    executionHostId={scope.hostId} conversationSessionId={scope.agentSessionId} content={wire} {...props} />
}
async function click(selector: string) {
  const button = host.querySelector<HTMLElement>(selector); expect(button).not.toBeNull()
  await act(async () => button!.click())
}
async function openNoticeDetails() { await click('.conversation-a2a-notice__details > summary') }

it.each([wire, '<amux>\n<a2a from="sender" msg-id="original-mid" read-via="message --skill" />\n</amux>'])(
  'reads a visible typed notice as one full Agent card and keeps notification protocol and body Copies separate', async content => {
    await render(notice({ content }))
    expect(read).toHaveBeenCalledExactlyOnceWith(scope, 'original-mid', 'original-notice')
    const message = host.querySelector('[data-a2a-original-message-id="original-mid"]')!
    expect(message).not.toBeNull(); expect(message.textContent).toContain('这是原信正文。')
    expect(message.querySelector('[data-avatar="sender"]')).not.toBeNull()
    expect(message.querySelector('.log-turn__sender-id')?.textContent).toContain('sender')
    expect(message.querySelector('[data-message-bubble="true"]')).not.toBeNull()
    expect(message.querySelector('[data-compact="true"]')).toBeNull()
    expect(host.querySelector('.log-turn__system-toggle')).toBeNull()
    expect(message.querySelector('.log-turn__references')).toBeNull()
    expect(message.textContent).toContain(wire)
    await click('[data-a2a-original-message-id] [aria-label="Copy message"]')
    expect(copy).toHaveBeenLastCalledWith(body, expect.any(Function))
    await openNoticeDetails()
    await click('[aria-label="Copy notification protocol"]')
    expect(copy).toHaveBeenLastCalledWith(content, expect.any(Function))
    await render(notice({ content, status: 'streaming' }))
    expect(read).toHaveBeenCalledTimes(1)
    expect(host.querySelector('[data-a2a-original-message-id="original-mid"]')).toBe(message)
  })

it.each([
  { a2aNotificationId: undefined }, { itemRef: undefined },
  { contentBoundary: 'body' as const }, { active: false }
])('keeps unqualified, decoded or hidden content passive: %j', async props => {
  await render(notice(props)); expect(read).not.toHaveBeenCalled()
})

it('keeps ordinary authored reference text passive with a connected reader', async () => {
  await render(<ConversationMessage content={wire} recordedIdentity speaker={{ role: 'human', id: 'human' }}
    executionHostId={scope.hostId} conversationSessionId={scope.agentSessionId} />)
  expect(read).not.toHaveBeenCalled(); expect(host.querySelector('.log-turn__references')).not.toBeNull()
})

it('keeps an original body that consists entirely of protocol-looking text opaque', async () => {
  read.mockResolvedValueOnce(original('original-mid', wire))
  await render(notice())
  const message = host.querySelector('[data-a2a-original-message-id]')!
  expect(message).not.toBeNull(); expect(message.textContent).toContain(wire)
  expect(message.querySelector('.log-turn__references')).toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  await click('[data-a2a-original-message-id] [aria-label="Copy message"]')
  expect(copy).toHaveBeenLastCalledWith(wire, expect.any(Function))
})

it.each(['missing', 'failure', 'mid', 'sender', 'recipient'])(
  'retains the reference and recovers the exact original after %s', async failure => {
    const record = original()
    if (failure === 'missing') read.mockResolvedValueOnce(null)
    else if (failure === 'failure') read.mockRejectedValueOnce(new Error('Original journal unavailable'))
    else read.mockResolvedValueOnce({ ...record, envelope: { ...record.envelope,
      ...(failure === 'mid' ? { messageId: 'another-mid' } : failure === 'sender' ? { sender: { kind: 'agent-session', agentSessionId: 'another-sender' } } : { recipientSessionId: 'another-recipient' }) } })
    await render(notice())
    expect(host.querySelector('[data-a2a-original-message-id]')).toBeNull()
    expect(host.querySelector('[data-a2a-reference-id]')?.textContent).toContain('original-mid')
    expect(host.querySelector('[role="status"]')?.textContent).toMatch(/retained|unavailable/u)
    await click('.conversation-a2a-originals__pending button')
    expect(read.mock.calls).toEqual([[scope, 'original-mid', 'original-notice'], [scope, 'original-mid', 'original-notice']])
    expect(host.querySelector('[data-a2a-original-message-id]')?.textContent).toContain('这是原信正文。')
  })

it('shows successful originals independently of another failed item in the same batch', async () => {
  read.mockImplementation(async (_scope, mid) => mid === 'second-mid' ? original(mid, 'Second original body') : null)
  await render(notice({ content: renderAgentMuxMessageReferences([...references, { senderSessionId: 'sender', messageId: 'second-mid' }]) }))
  expect(read.mock.calls).toEqual([[scope, 'original-mid', 'original-notice'], [scope, 'second-mid', 'original-notice']])
  expect(host.querySelector('[data-a2a-original-message-id="second-mid"]')?.textContent).toContain('Second original body')
  expect(host.querySelector('[data-a2a-reference-id="original-mid"]')).not.toBeNull()
})

it('keeps notification evidence and additional parts readable when every original read fails', async () => {
  read.mockRejectedValueOnce(new Error('Original journal unavailable'))
  await render(notice({ content: [{ kind: 'text', text: wire }, { kind: 'text', text: 'Additional recorded context is retained.' }] }))
  expect(host.querySelector('[data-a2a-original-message-id]')).toBeNull()
  expect(host.textContent).toContain('Additional recorded context is retained.')
  expect(host.querySelector('.conversation-a2a-notice__details')).not.toBeNull()
  await openNoticeDetails()
  const payload = host.querySelector('.conversation-a2a-notice__details pre')!
  expect(payload.textContent).toBe(wire)
  await click('[aria-label="Copy notification protocol"]')
  expect(copy).toHaveBeenLastCalledWith(wire, expect.any(Function))
  await openNoticeDetails(); await openNoticeDetails()
  expect(host.querySelector('.conversation-a2a-notice__details pre')).toBe(payload)
  expect(read).toHaveBeenCalledTimes(1)
})

it('preserves the notice group and evidence without a client reader or original source scope', async () => {
  const { readA2AMessage: _reader, ...withoutReader } = platform
  await render(<ClientUiProvider platform={withoutReader}>{notice()}</ClientUiProvider>)
  expect(host.querySelector('.conversation-a2a-notice')).not.toBeNull()
  expect(host.querySelector('[role="status"]')?.textContent).toContain('unavailable')
  await openNoticeDetails()
  expect(host.querySelector('.conversation-a2a-notice__details pre')?.textContent).toBe(wire)
  expect(read).not.toHaveBeenCalled()
  await render(notice({ itemRef: undefined }))
  expect(host.querySelector('.conversation-a2a-notice')).not.toBeNull()
  expect(host.querySelector('[data-a2a-original-message-id]')).toBeNull()
  expect(read).not.toHaveBeenCalled()
})

it('annotates a single original body with its notification identity and rejects cross-original or cross-part ranges', async () => {
  const select = vi.fn<NonNullable<ConversationMessageProps['onSelectAnnotation']>>()
  read.mockImplementation(async (_scope, mid) => original(mid, mid === 'second-mid' ? 'Second original body' : body))
  const batch = renderAgentMuxMessageReferences([...references, { senderSessionId: 'sender', messageId: 'second-mid' }])
  await render(notice({ content: [{ kind: 'text', text: batch }, { kind: 'text', text: 'Additional recorded part' }], onSelectAnnotation: select }))
  const first = host.querySelector<HTMLElement>('[data-a2a-original-message-id="original-mid"] .log-turn__text')!
  const second = host.querySelector<HTMLElement>('[data-a2a-original-message-id="second-mid"] .log-turn__text')!
  const extra = [...host.querySelectorAll<HTMLElement>('.log-turn__text')].find(node => node.textContent === 'Additional recorded part')!
  expect(first).not.toBeNull(); expect(second).not.toBeNull(); expect(extra).toBeDefined()
  const start = first.querySelector('p')!.firstChild!, end = second.querySelector('p')!.firstChild!, tail = extra.querySelector('p')!.firstChild!
  async function rangeTo(target: Node, offset: number) {
    const range = document.createRange(); range.setStart(start, 0); range.setEnd(target, offset)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    await act(async () => first.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })))
  }
  await rangeTo(start, start.textContent!.length)
  expect(select).toHaveBeenCalledTimes(1)
  expect(select.mock.calls[0]![0]).toMatchObject({ messageId: 'notice-record', quote: '这是原信正文。' })
  expect(select.mock.calls[0]![0].contextElement).toBe(first)
  expect(select.mock.calls[0]![0].messageId).not.toBe('original-mid')
  await rangeTo(end, end.textContent!.length); await rangeTo(tail, tail.textContent!.length)
  expect(select).toHaveBeenCalledTimes(1)
})

it('never applies a late old-Host body to the newly selected scope', async () => {
  let finish!: (record: DurableAgentMuxMessage) => void
  read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await render(notice())
  await render(notice({ executionHostId: 'another-host', itemRef: { ...scope, hostId: 'another-host', source: { kind: 'captured', recordId: 'notice-record' } } }))
  expect(read.mock.calls).toEqual([[scope, 'original-mid', 'original-notice'], [{ ...scope, hostId: 'another-host' }, 'original-mid', 'original-notice']])
  await act(async () => finish(original('original-mid', 'STALE OLD HOST BODY')))
  expect(host.textContent).not.toContain('STALE OLD HOST BODY')
  expect(host.querySelector('[data-a2a-original-message-id]')?.textContent).toContain('这是原信正文。')
})

it('does not apply an old request after hiding and reads the retained reference when shown again', async () => {
  let finish!: (record: DurableAgentMuxMessage) => void
  read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  await render(notice()); await render(notice({ active: false }))
  await act(async () => finish(original('original-mid', 'HIDDEN LATE BODY')))
  expect(host.textContent).not.toContain('HIDDEN LATE BODY')
  await render(notice())
  expect(read).toHaveBeenCalledTimes(2)
  expect(host.querySelector('[data-a2a-original-message-id]')?.textContent).toContain('这是原信正文。')
})

it('reads a resource reference only after explicitly opening the complete original text', async () => {
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: wire })), sha256 = createHash('sha256').update(bytes).digest('hex')
  const record = { source: { providerId: 'codex', nativeSessionId: 'native' }, recordId: 'resource-notice' }
  const resource = vi.fn<NonNullable<ConversationMessageProps['readHistoryResource']>>(async input => ({ agentSessionId: scope.agentSessionId, ...record,
    partIndex: input.partIndex, reference: input.expectedReference!, result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'),
      byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } }))
  await render(notice({ content: [{ kind: 'resource', resourceType: 'text', reference: 'original-resource', content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } }],
    nativeResourceRecord: record, readHistoryResource: resource }))
  await click('.log-turn__system-toggle'); expect(resource).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
  await click('.conversation-resource-text__controls button')
  expect(resource).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledExactlyOnceWith(scope, 'original-mid', 'original-notice')
  expect(host.querySelector('[data-a2a-original-message-id]')?.textContent).toContain('这是原信正文。')
})

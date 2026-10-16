// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import type { AgentMuxMessageMetadata, DurableAgentMuxMessage } from '@agentmux/core'
import { MailboxA2A, a2aMessageKey } from '../src/renderer/src/components/MailboxA2A'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const original: DurableAgentMuxMessage = { sequence: 1, envelope: { schema: 'agentmux.a2a.v1', messageId: 'message-one', operationId: 'control-one', createdAt: _tailFixtureEpoch(0, 0, 1),
  sender: { kind: 'agent-session', agentSessionId: 'peer' }, recipient: { kind: 'agent-session', agentSessionId: 'subject' },
  senderSessionId: 'peer', senderRunId: 'run-peer', recipientSessionId: 'subject', recipientRunId: null,
  threadId: 'thread', correlationId: 'correlation', replyTo: null, workspaceId: null,
  body: '  First original line\n\n' + Array.from({ length: 80 }, (_, i) => `Original line ${i + 1}`).join('\n') + '\n  ' },
  delivery: { state: 'queued', at: _tailFixtureEpoch(0, 0, 1), reason: 'Original Input ACK missing' } }
function metadata(record = original): AgentMuxMessageMetadata {
  const { body, ...envelope } = record.envelope
  return { sequence: record.sequence, envelope, delivery: record.delivery, bodyPreview: body.slice(0, 240), bodyBytes: new TextEncoder().encode(body).byteLength }
}
function props() {
  return { reference: { hostId: 'local', agentSessionId: 'subject' }, direction: 'incoming' as const, items: [metadata()], selectedKey: null as string | null,
    active: true, loading: false, error: null, observationError: null, nextCursor: null,
    refresh: vi.fn(), loadEarlier: vi.fn(), readMessage: vi.fn(async () => original), onOpen: vi.fn(),
    onCopy: vi.fn(async () => true), onFill: vi.fn(async () => 'Inserted as a draft') }
}

it('browses the original bounded body without parsing it as a new envelope or reading full content', async () => {
  const p = props(), bodyPreview = '<amux>Authored sample</amux>\nLiteral peer body'
  p.items = [{ ...metadata(), bodyPreview }]
  await dom.render(<MailboxA2A {...p} />)
  expect(dom.container.querySelector('.composer-mailbox__preview')?.textContent).toBe(bodyPreview)
  expect(dom.container.textContent).toContain('Delivery unconfirmed')
  expect(dom.container.textContent).not.toContain('Original line 80')
  expect(p.readMessage).not.toHaveBeenCalled()
  await dom.click('[data-record-key="a2a:message-one"]')
  expect(p.onOpen).toHaveBeenCalledWith('a2a:message-one', expect.anything())
  expect(p.readMessage).not.toHaveBeenCalled()
})

it('reads exactly one selected original and copies its unchanged body, independently of Input or ack', async () => {
  const p = props()
  await dom.render(<MailboxA2A {...p} selectedKey={a2aMessageKey(p.items[0]!)} />)
  expect(p.readMessage).toHaveBeenCalledExactlyOnceWith('message-one')
  expect(dom.container.textContent).toContain('Original line 80')
  expect(dom.container.textContent).toContain('Reading does not acknowledge this message or accept its task')
  const copy = dom.container.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')
  expect(copy).not.toBeNull()
  await act(async () => copy!.click())
  expect(p.onCopy).toHaveBeenCalledExactlyOnceWith(original.envelope.body)
  expect(p.refresh).not.toHaveBeenCalled(); expect(p.loadEarlier).not.toHaveBeenCalled()
})

const authoredSamples = [
  ['complete A2A example', '<amux:a2a from="authored-inner-sender" msg-id="authored-inner-message">\nAUTHORED INNER BODY\n<reminder>AUTHORED REMINDER SAMPLE</reminder>\n</amux:a2a>'],
  ['complete context example', '<amux>AUTHORED CONTEXT SAMPLE</amux>\n\nAUTHORED TAIL'],
  ['incomplete example', '<amux:a2a from="authored-inner-sender" msg-id="authored-inner-message">\nUNFINISHED AUTHORED SAMPLE']
] as const

it.each((['incoming', 'outgoing'] as const).flatMap(direction => authoredSamples.map(([sample, body]) => ({ direction, sample, body }))))(
  'reads the $direction selected original $sample as authored body, preserving its record and actions', async ({ direction, body }) => {
    const p = props(), sender = direction === 'incoming' ? 'peer' : 'subject', recipient = direction === 'incoming' ? 'subject' : 'peer'
    const record = { ...original, envelope: { ...original.envelope, body, senderSessionId: sender, recipientSessionId: recipient,
      sender: { kind: 'agent-session' as const, agentSessionId: sender }, recipient: { kind: 'agent-session' as const, agentSessionId: recipient } } }
    await dom.render(<MailboxA2A {...p} direction={direction} items={[metadata(record)]} selectedKey={a2aMessageKey(metadata(record))} readMessage={async () => record} />)
    const turn = dom.container.querySelector('.log-turn')!, reader = turn.querySelector('.log-turn__body')!
    for (const paragraph of body.split('\n\n')) expect(reader.textContent).toContain(paragraph)
    expect(reader.querySelector('.log-turn__reminder')).toBeNull()
    expect(reader.querySelector('.log-turn__declared-context')).toBeNull()
    expect(turn.getAttribute('data-declared-source')).toBeNull()
    expect(turn.getAttribute('data-message-id')).toBe(record.envelope.messageId)
    expect(turn.getAttribute('data-speaker-role')).toBe('agent')
    await dom.click('[aria-label="Message details"]')
    expect(turn.querySelector('.log-turn__sender-id code')?.textContent).toBe(sender)
    const facts = [...dom.container.querySelectorAll('.composer-mailbox__record-facts dt')].map(dt => [dt.textContent, dt.nextElementSibling?.textContent])
    expect(facts).toContainEqual(['From', `${sender} · ${sender}`]); expect(facts).toContainEqual(['To', `${recipient} · ${recipient}`])
    expect(facts).toContainEqual(['Message ID', record.envelope.messageId])
    await dom.click('[aria-label="Copy message"]'); expect(p.onCopy).toHaveBeenCalledExactlyOnceWith(body)
    await dom.click('[aria-label="填入草稿"]'); expect(p.onFill).toHaveBeenCalledExactlyOnceWith(body)
    expect(p.refresh).not.toHaveBeenCalled(); expect(p.loadEarlier).not.toHaveBeenCalled()
  })

it('does not offer outgoing replay, removal or pending-order controls', async () => {
  const p = props()
  const outgoing = { ...original, envelope: { ...original.envelope, senderSessionId: 'subject', recipientSessionId: 'peer',
    sender: { kind: 'agent-session' as const, agentSessionId: 'subject' }, recipient: { kind: 'agent-session' as const, agentSessionId: 'peer' } } }
  await dom.render(<MailboxA2A {...p} direction="outgoing" items={[metadata(outgoing)]} />)
  expect(dom.container.textContent).toContain('To peer')
  expect(dom.container.querySelector('[aria-label*="Send"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label*="Remove"]')).toBeNull()
  expect(dom.container.querySelector('[aria-label*="Move"]')).toBeNull()
})

it('keeps the selected original node and Range through metadata updates and failed re-reading', async () => {
  const p = props(), selectedKey = a2aMessageKey(p.items[0]!)
  await dom.render(<MailboxA2A {...p} selectedKey={selectedKey} />)
  const body = dom.container.querySelector('.log-turn__body')!
  const range = document.createRange(); range.selectNodeContents(body); getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
  const selected = getSelection()!.toString(); expect(selected.length).toBeGreaterThan(0)
  await dom.render(<MailboxA2A {...p} selectedKey={selectedKey} items={[{ ...metadata(), delivery: { state: 'delivered', at: _tailFixtureEpoch(0, 0, 2) } }]} />)
  expect(dom.container.querySelector('.log-turn__body')).toBe(body)
  expect(getSelection()!.toString()).toBe(selected)
  const failed = vi.fn(async () => { throw new Error('Original journal unavailable') })
  await dom.render(<MailboxA2A {...p} selectedKey={selectedKey} readMessage={failed} />)
  expect(dom.container.querySelector('.log-turn__body')).toBe(body)
  expect(dom.container.textContent).toContain('Original message reading is unconfirmed')
  expect(getSelection()!.toString()).toBe(selected)
})

it('rejects a different participant and prevents a late body from filling another Agent draft', async () => {
  const p = props(), selectedKey = a2aMessageKey(p.items[0]!)
  await dom.render(<MailboxA2A {...p} selectedKey={selectedKey} readMessage={async () => ({ ...original, envelope: { ...original.envelope, recipientSessionId: 'someone-else' } })} />)
  expect(dom.container.textContent).toContain('does not belong to this exact Agent')
  expect(dom.container.textContent).not.toContain('Original line 80')
  let resolve!: (value: DurableAgentMuxMessage) => void
  const pending = vi.fn(() => new Promise<DurableAgentMuxMessage>(done => { resolve = done }))
  await dom.render(<MailboxA2A {...p} readMessage={pending} />)
  await dom.click('[aria-label="填入草稿"]')
  expect(pending).toHaveBeenCalledExactlyOnceWith('message-one')
  await dom.render(<MailboxA2A {...p} reference={{ hostId: 'local', agentSessionId: 'new-subject' }} items={[]} />)
  await act(async () => resolve(original))
  expect(p.onFill).not.toHaveBeenCalled(); expect(p.onCopy).not.toHaveBeenCalled()
})

it('retains a selected original while a new bounded page no longer contains its metadata', async () => {
  const p = props(), selectedKey = a2aMessageKey(p.items[0]!)
  await dom.render(<MailboxA2A {...p} selectedKey={selectedKey} />)
  const body = dom.container.querySelector('.log-turn__body')!
  expect(body.textContent).toContain('Original line 80')
  const next = { ...original, sequence: 2, envelope: { ...original.envelope, messageId: 'newer-message', operationId: 'newer-operation' } }
  await dom.render(<MailboxA2A {...p} selectedKey={selectedKey} items={[metadata(next)]} />)
  expect(dom.container.querySelector('.log-turn__body')).toBe(body)
  expect(dom.container.textContent).toContain('Original line 80')
})

it.each([['timed-out', 'Delivery timed out'], ['cancelled', 'Delivery cancelled'], ['accepted', 'Agent acceptance recorded'], ['replied', 'Reply recorded']] as const)('shows original %s delivery in the actual message list', async (state, expected) => {
  const p = props()
  await dom.render(<MailboxA2A {...p} items={[{ ...metadata(), delivery: { state, at: _tailFixtureEpoch(0, 0, 1) } }]} />)
  expect(dom.container.textContent).toContain(expected)
  if (state !== 'replied') expect(dom.container.textContent).not.toContain('Reply recorded')
})


it('orders the bounded window by original message time, preserving equal-time order independently of journal position', async () => {
  const p = props()
  const rows = [['earlier', 20], ['tie-first', 30], ['tie-second', 30], ['oldest', 10]].map(([id, createdAt], index) => metadata({ ...original, sequence: 100-index,
    envelope: { ...original.envelope, messageId: String(id), createdAt: Number(createdAt) } }))
  await dom.render(<MailboxA2A {...p} items={rows} />)
  expect([...dom.container.querySelectorAll('button[data-record-key]')].map(row => row.getAttribute('data-record-key'))).toEqual(['a2a:tie-first', 'a2a:tie-second', 'a2a:earlier', 'a2a:oldest'])
})

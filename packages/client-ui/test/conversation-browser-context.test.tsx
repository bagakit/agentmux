// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { InputMailboxRecords } from '../src/components/InputMailboxRecords.js'
import { projectConversationReading } from '../src/lib/conversation-records.js'
import type { useAgentInputMailbox } from '../src/lib/use-agent-input-mailbox.js'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import type { AgentInputMailboxItem } from '@agentmux/core/agent-input-mailbox'
import { authoredExample, body, capturedItem, context, mailboxItem, wire } from './fixtures/browser-context-reading.js'

const copy = vi.fn<ClientUiPlatform['copyText']>(async () => true)
const images = vi.fn(), navigate = vi.fn()
const { markdownInputs } = vi.hoisted(() => ({ markdownInputs: [] as string[] }))
vi.mock('../src/components/AgentMarkdown.js', async original => {
  const actual = await original<typeof import('../src/components/AgentMarkdown.js')>()
  return { ...actual, AgentMarkdown: (props: Parameters<typeof actual.AgentMarkdown>[0]) => {
    markdownInputs.push(props.content); return <actual.AgentMarkdown {...props} />
  } }
})
const platform: ClientUiPlatform = {
  copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker }) => <span data-avatar-role={speaker.role} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null
}
let element: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  copy.mockClear(); images.mockClear(); navigate.mockClear(); markdownInputs.length = 0
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => { await act(async () => root.unmount()); element.remove(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
function find(selector: string): HTMLElement {
  const found = element.querySelector<HTMLElement>(selector)
  expect(found, `Actual mounted ${selector}`).not.toBeNull(); expect(found!.isConnected).toBe(true); return found!
}
async function click(selector: string) { await act(async () => find(selector).click()) }
function message(props: Partial<ConversationMessageProps> = {}) {
  return <ConversationMessage messageId="original-input" recordedIdentity speaker={{ role: 'unknown', id: 'unknown' }}
    content={wire} readPastedImage={images} openHttpLink={navigate} {...props} />
}

it('reads the Core-parsed Browser declaration while preserving the unknown author and exact original Copy', async () => {
  await render(message())
  expect(find('.conversation-browser-context').dataset.browserContextSource).toBe('caller-declared')
  expect(find('.conversation-browser-context > summary').textContent).toContain('Declared context')
  expect(find('.log-turn__who').textContent).toBe('Author unknown')
  expect(markdownInputs).toContain(body)
  await click('.conversation-browser-context > summary')
  expect(find('.conversation-browser-context__body').textContent).toContain(context.page.url)
  expect(find('.conversation-browser-context__selection').textContent).toContain('selection-navigation')
  expect(find('.conversation-browser-context__selection').textContent).toContain('Observed during · Step 2')
  expect(find('.conversation-browser-context__selection').textContent).not.toContain('Exact step')
  expect(element.querySelector('.conversation-browser-context a, .conversation-browser-context img')).toBeNull()
  expect(images).not.toHaveBeenCalled(); expect(navigate).not.toHaveBeenCalled()
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire, expect.any(Function))
})

it('consumes the actual captured conversation projection without reparsing its confirmed authored body', async () => {
  const item = capturedItem(authoredExample)
  const reading = projectConversationReading({ agentSessionId: 'recipient', timeline: { agentSessionId: 'recipient', revision: 1, items: [item] } })
  await render(<ConversationView sessionId="recipient" records={reading.records} originalRecords={reading.originalRecords} expandSubmissions />)
  expect(element.querySelectorAll('.conversation-browser-context')).toHaveLength(1)
  expect(find('.conversation-browser-context').dataset.browserContextSource).toBe('host-capture')
  expect(find('.conversation-browser-context > summary').textContent).toContain('Browser capture')
  expect(markdownInputs).toContain(authoredExample)
  expect(find('[data-conversation-author]').dataset.conversationAuthor).toContain('unknown')
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(authoredExample, expect.any(Function))
})

it('qualifies only the matching structured observation and keeps a different wire declaration separate', async () => {
  await render(message({ inputContext: context, inputContextSource: 'host-capture' }))
  expect(element.querySelectorAll('.conversation-browser-context')).toHaveLength(1)
  expect(find('.conversation-browser-context').dataset.browserContextSource).toBe('host-capture')
  await render(message({ inputContext: { ...context, page: { url: 'https://different.invalid/', title: 'Other observation' } }, inputContextSource: 'host-capture' }))
  expect([...element.querySelectorAll<HTMLElement>('.conversation-browser-context')].map(node => node.dataset.browserContextSource)).toEqual(['host-capture', 'caller-declared'])
  expect(find('.log-turn__who').textContent).toBe('Author unknown')
})

it.each(['wire', 'body'] as const)('uses the same reading face for explicitly loaded complete %s resources and copies their original bytes', async boundary => {
  const original = boundary === 'wire' ? wire : authoredExample
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: original })), hash = createHash('sha256').update(bytes).digest('hex')
  const record = { source: { providerId: 'codex', nativeSessionId: 'original-native' }, recordId: 'original-record' }
  const part = { kind: 'resource', resourceType: 'text', reference: 'original:complete', content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256: hash } } as const
  const read = vi.fn<NonNullable<ConversationMessageProps['readHistoryResource']>>(async input => ({ agentSessionId: 'recipient', ...record,
    partIndex: input.partIndex, reference: part.reference, result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'), byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256: hash, nextOffsetBytes: null } }))
  await render(message({ content: [part], contentBoundary: boundary, readHistoryResource: read, nativeResourceRecord: record, inputContext: context, inputContextSource: 'host-capture' }))
  expect(read).not.toHaveBeenCalled()
  await click('.conversation-resource-text__controls button')
  expect(read).toHaveBeenCalledOnce()
  expect(find('.conversation-resource-text .conversation-browser-context').dataset.browserContextSource).toBe('host-capture')
  expect(markdownInputs).toContain(boundary === 'wire' ? body : authoredExample)
  await click('.conversation-resource-text__controls button')
  expect(copy).toHaveBeenCalledExactlyOnceWith(original, expect.any(Function))
})

it.each(['controlled', 'submission'] as const)('reads the original %s mailbox context beside its body and copies the existing frozen wire', async kind => {
  const controlled = mailboxItem(), run = { runId: 'original-run' }
  const key = { kind: 'prompt' as const, agentSessionId: 'recipient', expectedRun: run, submissionId: 'original-input' }
  const item: AgentInputMailboxItem = kind === 'controlled' ? controlled : {
    kind: 'submission', key, sequence: controlled.sequence, recordedAt: controlled.recordedAt,
    record: { agentSessionId: key.agentSessionId, run, admission: {
      submissionId: key.submissionId, inputKey: key, operationId: 'original-dispatch', startByte: 0, endByte: wire.length, outputCursorBytes: 0,
      intent: { run, ownerInstanceId: 'original-owner', prompt: wire, plan: { kind: 'single-phase', data: wire },
        message: { userContent: body, inputContext: context, inputContextSource: 'host-capture' } }
    } }
  }
  const mailbox: ReturnType<typeof useAgentInputMailbox> = { scope: 'recipient', items: [item], failures: [], page: null,
    loading: false, error: null, refresh: vi.fn(async () => {}), loadEarlier: vi.fn(async () => {}), hasMore: false }
  await render(<InputMailboxRecords mailbox={mailbox} hostId="local" />)
  await click('[data-input-mailbox-key] > details > summary')
  expect(find('.conversation-browser-context').dataset.browserContextSource).toBe('host-capture')
  expect(find('[data-mailbox-author]').textContent).toBe('Author unknown')
  expect(markdownInputs).toContain(body)
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire, expect.any(Function))
})

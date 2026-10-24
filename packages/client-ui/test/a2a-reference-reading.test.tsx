// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, AgentSessionHistoryPage } from '@agentmux/core'
import { projectConversationReading } from '../src/lib/conversation-records.js'
import { normalizeAgentTimelineItem } from '../../core/src/session-timeline.js'
import { createNativeInputCorrelation } from '../../core/src/native-input-correlation.js'
import { renderAgentMuxMessageEnvelope, renderAgentMuxMessageReferences } from '@agentmux/core/agent-message-render'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { ClientUiProvider, type ClientUiPlatform } from '../src/platform.js'
import { ConversationMessage, type ConversationMessageProps } from '../src/components/ConversationMessage.js'
import { CapturedConversationMessage } from '../src/components/CapturedConversationMessage.js'
import { ConversationResourceText } from '../src/components/ConversationResourceText.js'
import { ConversationView } from '../src/components/ConversationView.js'
import { conversationAgentReference } from '../src/lib/conversation-speaker.js'
import { parseAgentMuxMessagePrefix } from '@agentmux/core/agent-message-render'
import { conversationMessageSourceKey } from '../src/lib/conversation-message-location.js'

const { markdownInputs } = vi.hoisted(() => ({ markdownInputs: [] as string[] }))
vi.mock('../src/components/AgentMarkdown.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/components/AgentMarkdown.js')>()
  return { ...actual, AgentMarkdown: (props: Parameters<typeof actual.AgentMarkdown>[0]) => {
    markdownInputs.push(props.content)
    return <actual.AgentMarkdown {...props} />
  } }
})

const records = [{ senderSessionId: 'referenced-first', messageId: 'original-first' }, { senderSessionId: 'referenced-second', messageId: 'original-second' }]
const batch = renderAgentMuxMessageReferences(records)
const copy = vi.fn<ClientUiPlatform['copyText']>(async () => true)
const describe = vi.fn(() => undefined), openHttp = vi.fn(), openFile = vi.fn()
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker }) => <span data-avatar-role={speaker.role} data-avatar-id={speaker.id} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  copy.mockClear(); describe.mockClear(); openHttp.mockClear(); openFile.mockClear()
  markdownInputs.length = 0
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges(); vi.unstubAllGlobals() })
async function render(node: ReactNode) { await act(async () => root.render(<ClientUiProvider platform={platform}>{node}</ClientUiProvider>)) }
async function click(selector: string) {
  const button = host.querySelector<HTMLButtonElement>(selector); expect(button).not.toBeNull()
  await act(async () => button!.click())
}
function message(props: Partial<ConversationMessageProps> = {}) {
  return <ConversationMessage messageId="original-record" recordedIdentity speaker={{ role: 'unknown', id: 'unknown' }} content={batch}
    status="complete" describeSpeaker={describe} openHttpLink={openHttp} openWorkspaceFile={openFile} {...props} />
}
const notice: AgentTimelineItem = normalizeAgentTimelineItem({ id: 'notice-record', agentSessionId: 'recipient', kind: 'system_message', source: 'agentmux',
  status: 'complete', title: 'AgentMux context', content: batch, a2aNotificationId: 'independent-notice-input',
  inputRef: { kind: 'prompt', agentSessionId: 'recipient', expectedRun: { runId: 'original-run' }, submissionId: 'independent-notice-input' },
  createdAt: fixtureEpoch(0), updatedAt: fixtureEpoch(0) })
const ordinaryNotice = { ...notice }; delete ordinaryNotice.a2aNotificationId
function captured(item = notice) { return <CapturedConversationMessage item={item} speaker={{ role: 'system', id: 'agentmux' }} describeSpeaker={describe} /> }
function textResource(wire = batch) {
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: wire })), sha256 = createHash('sha256').update(bytes).digest('hex')
  const record = { source: { providerId: 'codex', nativeSessionId: 'original-native' }, recordId: 'original-record', turnId: 'original-turn' }
  const part = { kind: 'resource', resourceType: 'text', reference: 'original:reference-wire', content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } } as const
  const read = vi.fn<NonNullable<ConversationMessageProps['readHistoryResource']>>(async input => ({ agentSessionId: 'recipient', ...record,
    partIndex: input.partIndex, reference: input.expectedReference!, result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'),
      byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } }))
  return { record, part, read }
}

it.each([
  renderAgentMuxMessageReferences(records.slice(0, 1)),
  '<amux>\n<a2a from="referenced-first" msg-id="original-first" read-via="message --skill" />\n</amux>',
  batch, renderAgentMuxMessageReferences(records, 'Separate <platform> reminder & text')
])('reads original reference wire without acquiring its authors or acting on its discovery hint', async wire => {
  await render(message({ content: wire }))
  const reading = parseAgentMuxMessagePrefix(wire)!
  expect(host.querySelectorAll('.log-turn__references li')).toHaveLength(reading.references!.length)
  expect(host.querySelector('.log-turn__references')?.textContent).toContain('"$AGENTMUX_CLI" message --skill')
  expect(host.querySelector('.log-turn__who')?.textContent).toBe('Author unknown')
  expect(host.querySelector('[data-avatar-id]')?.getAttribute('data-avatar-id')).toBe('unknown')
  expect(conversationAgentReference({ role: 'unknown', id: 'unknown' }, reading)).toBeUndefined()
  expect(describe).not.toHaveBeenCalled(); expect(openHttp).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled()
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire, expect.any(Function))
})

it('retains typed notification evidence without an extra system message card', async () => {
  await render(captured())
  expect(host.querySelector('[data-a2a-notification-id]')?.getAttribute('data-a2a-notification-id')).toBe('independent-notice-input')
  expect(host.querySelector('.log-turn__system-toggle')).toBeNull()
  await click('.conversation-a2a-notice__details > summary')
  expect(host.querySelector('.conversation-a2a-notice__details')?.textContent).toContain(batch)
  await click('[aria-label="Copy notification protocol"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(batch, expect.any(Function))
  expect(describe).not.toHaveBeenCalled()
})

it.each([false, true])('reads qualified native platform input through the production Conversation projection with captured=%j', async capturedSource => {
  const source = { providerId: 'codex', nativeSessionId: 'original-native' }
  const page: AgentSessionHistoryPage = { agentSessionId: 'recipient', sourceHostId: 'original-host', source: { providerId: 'codex', nativeSessionId: 'original-native' }, nextCursor: null,
    items: [{ id: 'native-notification', kind: 'user-message', turnId: 'original-turn', contentParts: [{ kind: 'text', text: batch }],
      conversation: { nativeInput: { source, semanticItemId: 'native-notification', turnId: 'original-turn', clientCorrelation: createNativeInputCorrelation(notice.inputRef!) },
        adoptedInput: { key: notice.inputRef!, purpose: 'a2a-notification' } } }] }
  const timeline = { agentSessionId: 'recipient', sourceHostId: 'original-host', revision: 1, items: capturedSource ? [notice] : [] }
  const projection = projectConversationReading({ agentSessionId: 'recipient', historyPage: page, timeline })
  expect(projection.inputs).toHaveLength(0)
  expect(projection.records).toHaveLength(1)
  expect(projection.records[0]!.original.kind).toBe('native')
  expect(projection.records[0]!.role).toBe('notice')
  await render(<ConversationView page={page} timeline={timeline} sessionId="recipient" records={projection.records} originalRecords={projection.originalRecords} describeSpeaker={describe} />)
  expect(host.querySelector('[data-a2a-notification-id]')?.getAttribute('data-a2a-notification-id')).toBe('independent-notice-input')
  expect(host.querySelector('.log-turn__system-toggle')).toBeNull()
  await click('.conversation-a2a-notice__details > summary')
  expect(host.querySelector('.conversation-a2a-notice__details')?.textContent).toContain(batch)
  await click('[aria-label="Copy notification protocol"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(batch, expect.any(Function))
  expect(describe).not.toHaveBeenCalled()
})

it('does not turn ordinary native adoption into a platform notification from its wire text', async () => {
  const source = { providerId: 'codex', nativeSessionId: 'original-native' }
  const page: AgentSessionHistoryPage = { agentSessionId: 'recipient', sourceHostId: 'original-host', source: { providerId: 'codex', nativeSessionId: 'original-native' }, nextCursor: null,
    items: [{ id: 'ordinary-native', kind: 'user-message', turnId: 'original-turn', contentParts: [{ kind: 'text', text: batch }], conversation: {
      nativeInput: { source, semanticItemId: 'ordinary-native', turnId: 'original-turn', clientCorrelation: createNativeInputCorrelation(notice.inputRef!) }, adoptedInput: { key: notice.inputRef! } } }] }
  const projection = projectConversationReading({ agentSessionId: 'recipient', historyPage: page })
  await render(<ConversationView page={page} sessionId="recipient" records={projection.records} originalRecords={projection.originalRecords} />)
  expect(host.querySelector('[data-a2a-notification-id]')).toBeNull()
  expect(host.querySelector('.log-turn__system-toggle')).toBeNull()
})

it('locates the captured contributor of a native resource notice without opening Info or prefetching its resource', async () => {
  const resource = textResource(), source = resource.record.source
  const page: AgentSessionHistoryPage = { agentSessionId: 'recipient', sourceHostId: 'original-host', source, nextCursor: null,
    items: [{ id: 'native-notification', kind: 'user-message', turnId: 'original-turn', contentParts: [resource.part],
      conversation: { nativeInput: { source, semanticItemId: 'native-notification', turnId: 'original-turn', clientCorrelation: createNativeInputCorrelation(notice.inputRef!) },
        adoptedInput: { key: notice.inputRef!, purpose: 'a2a-notification' } } }] }
  const timeline = { agentSessionId: 'recipient', sourceHostId: 'original-host', revision: 1, items: [notice] }
  const projection = projectConversationReading({ agentSessionId: 'recipient', historyPage: page, timeline })
  expect(projection.records).toHaveLength(1); expect(projection.records[0]!.original.kind).toBe('native')
  expect(projection.records[0]!.records).toHaveLength(2)
  const locatedMessageKey = conversationMessageSourceKey('recipient', { kind: 'captured', recordId: notice.id })!
  await render(<ConversationView page={page} timeline={timeline} sessionId="recipient" records={projection.records} originalRecords={projection.originalRecords}
    locatedMessageKey={locatedMessageKey} readHistoryResource={resource.read} />)
  const evidence = host.querySelector<HTMLDetailsElement>('.conversation-a2a-notice__details')!
  expect(evidence).not.toBeNull(); expect(evidence.open).toBe(true)
  const original = [...evidence.querySelectorAll<HTMLDetailsElement>('[data-original-contribution]')].find(node => node.getAttribute('data-message-source-key') === locatedMessageKey)!
  expect(original).toBeDefined(); expect(original.open).toBe(true)
  expect(original.querySelector('pre')?.textContent).toContain(notice.id)
  expect(host.querySelector('[aria-label="Message details"]')?.getAttribute('aria-expanded')).not.toBe('true')
  expect(resource.read).not.toHaveBeenCalled()
})

it.each([
  ordinaryNotice,
  { ...notice, source: 'native-hook' as const },
  { ...notice, kind: 'user_message' as const, source: 'user' as const }
])('does not use platform-looking text or an unrelated marker as typed notice provenance', async item => {
  await render(captured(item))
  expect(host.querySelector('[data-a2a-notification-id]')).toBeNull()
  await click('.log-turn__system-toggle')
  expect(host.querySelectorAll('.log-turn__references li')).toHaveLength(2)
  expect(host.querySelector('.conversation-protocol__original pre')?.textContent).toBe(batch)
  expect(host.querySelector('.log-turn')?.getAttribute('data-speaker-role')).toBe('system')
  expect(openHttp).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled()
})

it.each([batch, renderAgentMuxMessageEnvelope({ sender: { kind: 'agent-session', agentSessionId: 'inner' }, senderSessionId: 'inner', messageId: 'inner-message', body: 'AUTHORED INNER BODY' })])(
  'keeps decoded authored body literal even when it is a complete protocol example', async body => {
    await render(message({ content: body, contentBoundary: 'body', speaker: { role: 'agent', id: 'recorded-author' }, conversationSessionId: 'recipient' }))
    expect(host.querySelector('.log-turn__references')).toBeNull()
    expect(host.querySelector('.log-turn__reminder')).toBeNull()
    expect(host.querySelector('.log-turn__body')?.textContent).toContain(body)
    await click('[aria-label="Copy message"]')
    expect(copy).toHaveBeenCalledExactlyOnceWith(body, expect.any(Function))
  })

it('keeps the original reference nodes and selected Range on status-only updates', async () => {
  await render(message())
  const original = host.querySelector('.log-turn__references li code')!
  expect(original).not.toBeNull()
  const range = document.createRange()
  range.selectNodeContents(original); window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString(), anchor = window.getSelection()!.anchorNode
  await render(message({ status: 'streaming' }))
  expect(host.querySelector('.log-turn__references li code')).toBe(original)
  expect(window.getSelection()!.anchorNode).toBe(anchor)
  expect(window.getSelection()!.toString()).toBe(selected)
})

const fullBody = 'Original authored body\n\n' + batch
const fullShort = renderAgentMuxMessageEnvelope({ sender: { kind: 'agent-session', agentSessionId: 'declared-author' }, senderSessionId: 'declared-author', messageId: 'full-original', body: fullBody })
const fullLong = '<amux>\n' + fullShort.replace(/^<amux:a2a/u, '<a2a').replace(/<\/amux:a2a>$/u, '</a2a>') + '\n</amux>'
it.each([fullShort, fullLong])('uses the same opaque full-content reading for long and short envelopes', async wire => {
  await render(message({ content: wire }))
  expect(host.querySelector('.log-turn__references')).toBeNull()
  expect(markdownInputs).toContain(fullBody)
  expect(host.querySelector('.log-turn__body')?.textContent).toContain(batch)
  expect(host.querySelector('.log-turn__reminder')).not.toBeNull()
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(wire, expect.any(Function))
})

it('uses the same long full-content grammar on explicitly opened original resources', async () => {
  const resource = textResource(fullLong)
  await render(<ConversationResourceText {...resource} readResource={resource.read} partIndex={0} inputMode />)
  expect(resource.read).not.toHaveBeenCalled()
  await click('.conversation-resource-text__controls button')
  expect(host.querySelector('.log-turn__references')).toBeNull()
  expect(markdownInputs).toContain(fullBody)
  expect(host.querySelector('.log-turn__text')?.textContent).toContain(batch)
  expect(host.querySelector('.log-turn__reminder')).not.toBeNull()
  await click('[aria-label="Copy complete content"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(fullLong, expect.any(Function))
})

it('uses the same typed-notice reading only after an explicit complete resource read and copies its raw bytes', async () => {
  const resource = textResource()
  await render(message({ content: [resource.part], speaker: { role: 'system', id: 'agentmux' }, a2aNotificationId: 'independent-notice-input',
    nativeResourceRecord: resource.record, readHistoryResource: resource.read }))
  expect(resource.read).not.toHaveBeenCalled()
  await click('.log-turn__system-toggle')
  expect(resource.read).not.toHaveBeenCalled()
  await click('.conversation-resource-text__controls button')
  expect(resource.read).toHaveBeenCalledExactlyOnceWith({ ...resource.record, partIndex: 0, expectedReference: resource.part.reference, offsetBytes: 0, maxBytes: 128 * 1024 })
  expect(host.querySelectorAll('.log-turn__references li')).toHaveLength(2)
  await click('[aria-label="Copy complete content"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(batch, expect.any(Function))
})

it.each([{ contentBoundary: 'body' as const, partIndex: 0 }, { contentBoundary: 'wire' as const, partIndex: 1 }])(
  'preserves body and original part qualification on complete reference resources', async boundary => {
    const resource = textResource()
    await render(<ConversationResourceText {...resource} readResource={resource.read} partIndex={boundary.partIndex} contentBoundary={boundary.contentBoundary}
      inputMode a2aNotificationId="independent-notice-input" />)
    await click('.conversation-resource-text__controls button')
    expect(host.querySelector('.log-turn__references')).toBeNull()
    expect(host.querySelector('.log-turn__text')?.textContent).toContain(batch)
  })

it('does not interpret a reference in a nonprimary text part', async () => {
  await render(message({ content: [{ kind: 'text', text: 'Original first part' }, { kind: 'text', text: batch }] }))
  expect(host.querySelector('.log-turn__references')).toBeNull()
  expect(host.querySelectorAll('.log-turn__text')[1]?.textContent).toContain(batch)
})

it('does not attach a late prior reference resource to the replacement original', async () => {
  const resource = textResource()
  let finish!: (value: Awaited<ReturnType<typeof resource.read>>) => void
  const pending = vi.fn(() => new Promise<Awaited<ReturnType<typeof resource.read>>>(resolve => { finish = resolve }))
  await render(<ConversationResourceText {...resource} readResource={pending} partIndex={0} inputMode />)
  await click('.conversation-resource-text__controls button')
  await render(<ConversationResourceText {...resource} record={{ ...resource.record, recordId: 'replacement-record' }} readResource={resource.read} partIndex={0} inputMode />)
  await act(async () => finish(await resource.read({ ...resource.record, partIndex: 0, expectedReference: resource.part.reference })))
  expect(host.querySelector('.log-turn__references')).toBeNull()
  expect(host.textContent).not.toContain('referenced-first')
})

it('leaves a wrong read-via literal and never opens its destination', async () => {
  const body = batch.replaceAll('message --skill', 'https://invalid.example/arbitrary')
  await render(message({ content: body }))
  expect(host.querySelector('.log-turn__references')).toBeNull()
  expect(host.querySelector('.log-turn__body')?.textContent).toContain(body)
  expect(openHttp).not.toHaveBeenCalled(); expect(openFile).not.toHaveBeenCalled()
})

import { fixtureEpoch as _tailRefreshFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryPage } from '@agentmux/core'
import { projectConversationRecords, type ConversationRecord } from '@agentmux/client-ui/conversation-records'
import { createSpeakerResolver } from '@agentmux/client-ui/conversation-speaker'
import { FocusMessagePreview } from '../src/renderer/src/components/FocusMessagePreview'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { conversationRulerRecords } from '../src/renderer/src/lib/conversation-ruler'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

const initial = useAppStore.getState(), now = _tailRefreshFixtureEpoch(0, 36000)
const body = '  Original runtime instructions 中🙂\n\nKeep the complete second paragraph.\n'
const source = { providerId: 'fixture-provider', nativeSessionId: 'original-native' }
const describeSpeaker = createSpeakerResolver()
let container: HTMLDivElement, anchorHost: HTMLElement, anchor: HTMLButtonElement, root: Root
let controls: { mock: { calls: unknown[][] } }[]
const close = vi.fn(), select = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} })
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  useAppStore.setState({ config: composerConfig, sessions: [composerSession()], timelines: {}, agentNames: {},
    agentComposerDrafts: { 'agent-1': 'Original unsent input' }, error: null })
  controls = ['write', 'submitPrompt', 'resume', 'recover', 'stop'].map(name => vi.spyOn(api.sessions, name as 'stop'))
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
  anchorHost = document.createElement('section'); anchorHost.className = 'recent-focus'
  const header = document.createElement('header'); header.className = 'recent-focus__header'
  anchor = document.createElement('button'); anchor.className = 'recent-focus__message'
  anchorHost.append(header, anchor); document.body.append(anchorHost)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); anchorHost.remove(); document.getElementById('agentmux-window-overlay-host')?.remove()
  for (const control of controls) expect(control).not.toHaveBeenCalled()
  useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
  close.mockClear(); select.mockClear()
})

function page(contentParts: AgentSessionHistoryContentPart[] = [{ kind: 'text', text: body }]): AgentSessionHistoryPage {
  return { agentSessionId: 'original-session', source, nextCursor: null, items: [
    { id: 'system-record', turnId: 'original-turn', kind: 'system-message', title: 'Runtime context', contentParts },
    { id: 'user-record', kind: 'user-message', contentParts: [{ kind: 'text', text: '<environment_context>Original user text</environment_context>' }] }
  ] }
}
const overlay = () => document.querySelector<HTMLElement>('.recent-focus__message-preview')!
async function renderPreview(message: ConversationRecord, messages = [message], interactive = true, recipientName = 'Original Context') {
  await act(async () => root.render(<FocusMessagePreview message={message} sender={undefined} recipient={undefined}
    lane={undefined} hierarchy={undefined} interactive={interactive} anchor={anchor} recipientName={recipientName}
    describeSpeaker={describeSpeaker} onSelect={select} onClose={close}
    {...(interactive ? { reader: { selectionOnly: true as const, messages, loading: false, coverage: 'Original source order', error: null, onMessage: vi.fn() } } : {})} />))
}
async function click(selector: string) {
  const button = overlay().querySelector<HTMLButtonElement>(selector)
  expect(button, selector).not.toBeNull()
  await act(async () => button!.click())
}

it.each(['original-host', undefined])('Focus reads and copies complete short system records with Host %s without calling input controls', async executionHostId => {
  const original = page(), records = projectConversationRecords({ agentSessionId: original.agentSessionId, executionHostId, historyPage: original })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const read = vi.spyOn(api.sessions, 'historyResource')
  await renderPreview(records[0]!, records)
  expect(overlay().querySelector('.recent-focus__message-caption')?.textContent).toContain('In Original Context · System message')
  expect(overlay().querySelector('.log-turn__system-title')?.textContent).toBe('fixture-provider · Runtime context')
  expect(overlay().querySelector('[data-speaker-role="system"]')).not.toBeNull()
  expect(overlay().querySelector('[data-record-raw-id="system-record"]')?.getAttribute('aria-label')).toContain('System message from fixture-provider')
  expect(overlay().querySelector('[data-record-raw-id="user-record"]')?.getAttribute('aria-label')).toContain('Input, sender not recorded')
  expect(overlay().querySelector('.log-turn__body')).toBeNull()
  await click('[title="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(body)
  expect(read).not.toHaveBeenCalled()
  await click('.log-turn__system-toggle')
  expect(overlay().querySelector('.log-turn__body')?.textContent).toContain('Keep the complete second paragraph.')
  await renderPreview(records[0]!, records, false)
  expect(overlay().querySelector('.recent-focus__author-kind')?.textContent).toBe('System message')
  expect(overlay().querySelector('.recent-focus__message-caption')?.textContent).toBe('System record in Original Context')
  expect(overlay().querySelector('[aria-label="To"]')).toBeNull()
  expect(records[0]!.original.item).toBe(original.items[0])
  expect(records[0]!.contentParts).toBe(original.items[0]!.contentParts)
})

it('Focus keeps ordinary user XML as original input with its usual reading and copy behavior', async () => {
  const original = page(), message = projectConversationRecords({ agentSessionId: original.agentSessionId,
    executionHostId: 'original-host', historyPage: original })[1]!
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await renderPreview(message)
  expect(overlay().querySelector('.log-turn__system-toggle')).toBeNull()
  expect(overlay().querySelector('.recent-focus__message-caption')?.textContent).toContain('To Original Context · Prompt · Sender not recorded')
  await click('[title="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith('<environment_context>Original user text</environment_context>')
  expect(message.input?.rawId).toBe('user-record')
})

it('Focus reads and copies system resources through the exact public Host/Session/record and retains loaded text across rerenders', async () => {
  const exact = body.repeat(6000), bytes = Buffer.from(JSON.stringify({ kind: 'text', text: exact }))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const part: AgentSessionHistoryContentPart = { kind: 'resource', resourceType: 'text', reference: 'original:system-content',
    content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } }
  const original = page([part]), message = projectConversationRecords({ agentSessionId: original.agentSessionId,
    executionHostId: 'original-host', historyPage: original })[0]!
  const read = vi.spyOn(api.sessions, 'historyResource').mockImplementation(async (reference, input) => {
    expect(reference).toEqual({ hostId: 'original-host', agentSessionId: 'original-session' })
    const offset = input.offsetBytes ?? 0, chunk = bytes.subarray(offset, offset + (input.maxBytes ?? 128 * 1024))
    return { agentSessionId: reference.agentSessionId, source, recordId: 'system-record', turnId: 'original-turn',
      partIndex: input.partIndex, reference: part.reference, result: { status: 'fragment', encoding: 'json-utf8',
        dataBase64: chunk.toString('base64'), byteLength: chunk.length, offsetBytes: offset, totalBytes: bytes.length,
        sha256, nextOffsetBytes: offset + chunk.length === bytes.length ? null : offset + chunk.length } }
  })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await renderPreview(message)
  expect(read).not.toHaveBeenCalled()
  await click('[title="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(exact)
  expect(read.mock.calls[0]).toEqual([{ hostId: 'original-host', agentSessionId: 'original-session' },
    { source, recordId: 'system-record', turnId: 'original-turn', partIndex: 0, expectedReference: part.reference, offsetBytes: 0, maxBytes: 128 * 1024 }])
  expect(read.mock.calls.length).toBeGreaterThan(1)
  await click('.log-turn__system-toggle')
  await click('.conversation-resource-text__controls button')
  expect(overlay().querySelector('.conversation-resource-text .log-turn__text')?.textContent).toContain('Keep the complete second paragraph.')
  const loaded = overlay().querySelector('.conversation-resource-text .log-turn__text'), before = read.mock.calls.length
  await renderPreview(message, [message], true, 'Renamed Context')
  expect(overlay().querySelector('.conversation-resource-text .log-turn__text')).toBe(loaded)
  expect(read).toHaveBeenCalledTimes(before)
  expect(message.original.item).toBe(original.items[0])
  expect(message.contentParts).toBe(original.items[0]!.contentParts)
})

it('Focus keeps an unknown resource Host unknown without substituting the current local Host', async () => {
  const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: body }))
  const part: AgentSessionHistoryContentPart = { kind: 'resource', resourceType: 'text', reference: 'original:system-content',
    content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } }
  const original = page([part]), message = projectConversationRecords({ agentSessionId: original.agentSessionId, historyPage: original })[0]!
  const read = vi.spyOn(api.sessions, 'historyResource')
  await renderPreview(message)
  await click('.log-turn__system-toggle')
  await click('.conversation-resource-text__controls button')
  expect(overlay().querySelector('[role="alert"]')?.textContent).toContain('original conversation Host is unknown')
  expect(read).not.toHaveBeenCalled()
  expect(overlay().querySelector('.log-turn__system-title')?.textContent).toBe('fixture-provider · Runtime context')
})

it('conversation Ruler preserves the native system identity and original objects without turning them into user inputs', () => {
  const original = page(), result = conversationRulerRecords(original.agentSessionId, original, [])
  expect(result[0]!.speaker).toEqual({ role: 'system', id: 'fixture-provider' })
  expect(result[0]!.record).toBe(original.items[0])
  expect(result[0]!.target).toEqual({ kind: 'native', source: JSON.stringify([source.providerId, source.nativeSessionId]), recordId: 'system-record' })
  expect(result[1]!.speaker?.role).toBe('unknown')
  expect(result[1]!.record).toBe(original.items[1])
})

it.each(['system-only', 'mixed'] as const)('the actual Recent Focus timeline marks %s groups with accurate system counts and direction', async mode => {
  const bounds = HTMLElement.prototype.getBoundingClientRect
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('recent-focus__time-scale') ? new DOMRect(0, 0, 864, 18) : bounds.call(this)
  })
  const id = 'agent-1', at = now - 10_000
  const native: AgentSessionHistoryPage = { agentSessionId: id, source, nextCursor: null, items: [
    { id: 'first-system', kind: 'system-message', title: 'Runtime context', startedAt: at, contentParts: [{ kind: 'text', text: 'First original system message' }] },
    { id: 'second', kind: mode === 'mixed' ? 'user-message' : 'system-message', startedAt: at, contentParts: [{ kind: 'text', text: 'Second original message' }] },
    { id: 'third-system', kind: 'system-message', startedAt: at, contentParts: [{ kind: 'text', text: 'Third original system message' }] }
  ] }
  const timeline = { agentSessionId: id, revision: 1, items: [] }
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'historyPage').mockResolvedValue(native)
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue(timeline)
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source, dispose: () => {} })
  useAppStore.setState({ timelines: { [id]: timeline }, agentFocus: { execution: { sessionId: id, history: [] }, pmo: { sessionId: null } } })
  const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
  await act(async () => root.render(<RecentFocusTimeline entries={[]} currentSessionId={id} currentContext={{ id, hostId: 'local' }}
    contexts={contexts} onSelect={select} />))
  await vi.waitFor(() => expect(container.querySelectorAll('.recent-focus__message')).toHaveLength(2))
  const single = container.querySelector<HTMLElement>('.recent-focus__message[data-record-count="1"]')!
  const group = container.querySelector<HTMLButtonElement>('.recent-focus__message--group')!
  expect(single.dataset.recordKind).toBe('system-message')
  expect(single.getAttribute('aria-label')).toContain('System message in')
  expect(single.getAttribute('aria-label')).toContain('from fixture-provider')
  expect(single.querySelector('.recent-focus__message-direction')).toBeNull()
  expect(group.dataset.recordKind).toBe(mode === 'mixed' ? 'mixed' : 'system-message')
  expect(group.getAttribute('aria-label')).toContain(mode === 'mixed' ? '1 inputs, 0 replies and 1 system messages' : '0 inputs, 0 replies and 2 system messages')
  if (mode === 'system-only') expect(group.querySelector('.recent-focus__message-direction')).toBeNull()
  else expect(group.querySelector('.recent-focus__message-direction')).not.toBeNull()
  await act(async () => group.click())
  expect(overlay().querySelector('[data-record-raw-id="third-system"]')?.getAttribute('aria-label')).toContain('System message from fixture-provider')
  expect(native.items.map(item => item.id)).toEqual(['first-system', 'second', 'third-system'])
})

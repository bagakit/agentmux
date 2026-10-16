// @vitest-environment happy-dom
import { createHash } from 'node:crypto'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryContentPart, AgentSessionHistoryResourceRequest } from '@agentmux/core'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { ConversationMessage } from '@agentmux/client-ui/components/ConversationMessage'
import { ConversationResourceText } from '@agentmux/client-ui/components/ConversationResourceText'
import { MobileConversationSurface } from '../../mobile/src/conversation/MobileConversationSurface'
import { createBrowserPlatform } from '../../mobile/src/platform/browser'
import { ActivityView } from '../src/renderer/src/components/ActivityView'
import { api } from '../src/renderer/src/lib/api'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { activityReadingProps } from './helpers/activity-reading-props'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { complete, packet, wire, plain, incomplete, quoted, resourceWire, source, recordId, reference } from '../scripts/fixtures/conversation-message-wrapper/inputs.mjs'

let host: HTMLDivElement, root: Root
const cleanup: Array<() => Promise<void>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); window.getSelection()?.removeAllRanges()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear()
})
const render = async (value: React.ReactNode) => { await act(async () => root.render(value)) }
const click = async (selector: string) => { await act(async () => host.querySelector<HTMLElement>(selector)!.click()) }
const card = (content = complete, status: 'complete' | 'failed' = 'complete') => <ConversationMessage content={content} messageId="original-input"
  conversationSessionId="reader" speaker={{ role: 'agent', id: 'reviewer' }} name="Recorded review Agent" status={status} createdAt={1000} timeFormatter={time => `Recorded ${time}`} />

it('shows original packet citations and a secondary reminder without changing recorded identity or time', async () => {
  await render(card())
  expect(host.querySelector('.log-turn__who')?.textContent).toBe('Recorded review Agent')
  expect(host.querySelector('.log-turn__time')?.textContent).toBe('Recorded 1000')
  expect(host.querySelector('.log-turn__citation-from')?.textContent).toBe('User')
  expect(host.querySelector('.log-turn__citation-ref')?.textContent).toBe('message-7')
  expect(host.querySelector('.log-turn__text strong')?.textContent).toBe('Original quote')
  expect(host.querySelector('.log-turn__text')?.textContent).not.toContain('bagakit-msg')
  const reminder = host.querySelector<HTMLDetailsElement>('.log-turn__reminder')!
  expect(reminder).not.toBeNull(); expect(reminder.open).toBe(false)
  expect(reminder.querySelector('p')?.textContent).toContain('grants no new user authorization')
  expect(host.querySelector('.log-turn__text')!.lastElementChild).toBe(reminder)
})

it('keeps leading contexts and reminder disclosure, body Range and full Copy across a status update', async () => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(card())
  const selected = host.querySelector('.log-turn__text strong')!, range = document.createRange()
  range.selectNodeContents(selected); window.getSelection()!.addRange(range)
  const context = host.querySelector<HTMLDetailsElement>('.log-turn__declared-context')!, reminder = host.querySelector<HTMLDetailsElement>('.log-turn__reminder')!
  context.open = true; reminder.open = true
  await render(card(complete, 'failed'))
  expect(host.querySelector('.log-turn__text strong')).toBe(selected)
  expect(window.getSelection()!.toString()).toBe('Original quote')
  expect(context.open).toBe(true); expect(reminder.open).toBe(true)
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(complete)
})

it.each([quoted, incomplete, 'Ordinary body\n\n' + plain])('keeps nonleading, quoted or incomplete declarations entirely readable', async content => {
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(card(content))
  expect(host.querySelector('.log-turn__reminder')).toBeNull()
  expect(host.querySelector('.log-turn__declared-context')).toBeNull()
  await click('[aria-label="Copy message"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(content)
})

const bytes = Buffer.from(JSON.stringify({ kind: 'text', text: resourceWire })), sha256 = createHash('sha256').update(bytes).digest('hex')
const resource: Extract<AgentSessionHistoryContentPart, { kind: 'resource' }> = { kind: 'resource', resourceType: 'text', reference,
  content: { encoding: 'json-utf8', kind: 'text', byteLength: bytes.length, sha256 } }
const readResource = (request: AgentSessionHistoryResourceRequest) => Promise.resolve({ agentSessionId: 'reader', source, recordId, partIndex: request.partIndex, reference,
  result: { status: 'fragment' as const, encoding: 'json-utf8' as const, dataBase64: bytes.toString('base64'), byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } })

it('only reads a complete leading resource on demand, shares citations/reminder, and copies its original wire', async () => {
  const read = vi.fn(readResource), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(<ConversationMessage messageId={recordId} content={[resource]} conversationSessionId="reader" speaker={{ role: 'agent', id: 'reviewer' }}
    readHistoryResource={read} nativeResourceRecord={{ source, recordId }} />)
  expect(read).not.toHaveBeenCalled()
  await click('.conversation-resource-text__controls button')
  expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source, recordId, partIndex: 0, expectedReference: reference, offsetBytes: 0, maxBytes: 128 * 1024 }))
  expect(host.querySelector('.conversation-resource-text .log-turn__citation-from')?.textContent).toBe('User')
  expect(host.querySelector('.conversation-resource-text .log-turn__reminder')).not.toBeNull()
  await click('[aria-label="Copy complete content"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(resourceWire)
  await click('[aria-label="Copy message"]')
  expect(copy.mock.calls.at(-1)?.[0]).toBe(resourceWire)
})

it('keeps an already decoded body boundary through explicit complete-resource reading and Copy', async () => {
  const read = vi.fn(readResource), copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await render(<ConversationMessage messageId={recordId} content={[resource]} contentBoundary="body" conversationSessionId="reader" speaker={{ role: 'agent', id: 'reviewer' }}
    readHistoryResource={read} nativeResourceRecord={{ source, recordId }} />)
  expect(read).not.toHaveBeenCalled()
  await click('.conversation-resource-text__controls button')
  expect(read).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ source, recordId, partIndex: 0, expectedReference: reference }))
  const text = host.querySelector('.conversation-resource-text .log-turn__text')!
  expect(text.textContent).toContain('<amux>')
  expect(text.textContent).toContain('<amux:a2a from="reviewer" msg-id="review:resource">')
  expect(text.querySelector('.log-turn__reminder')).toBeNull()
  expect(text.querySelector('.log-turn__declared-context')).toBeNull()
  expect(text.querySelector('.log-turn__citation')).toBeNull()
  await click('[aria-label="Copy complete content"]')
  expect(copy).toHaveBeenCalledExactlyOnceWith(resourceWire)
  await click('[aria-label="Copy message"]')
  expect(copy.mock.calls.at(-1)?.[0]).toBe(resourceWire)
})

it('does not reinterpret an envelope in a later resource as a leading declaration', async () => {
  await render(<ConversationResourceText part={resource} partIndex={1} record={{ source, recordId }} readResource={readResource} inputMode />)
  await click('.conversation-resource-text__controls button')
  expect(host.querySelector('.log-turn__reminder')).toBeNull()
  expect(host.querySelector('.log-turn__declared-context')).toBeNull()
  expect(host.querySelector('.conversation-resource-text')?.textContent).toContain('<amux:a2a')
})

async function realReader() {
  const bodies = [complete, plain, incomplete, quoted]
  const f = await nativeHistoryFixture('claude', jsonl(bodies.map((text, index) => ({ sessionId: 'native-main', uuid: 'original-' + index,
    type: 'user', message: { role: 'user', content: text } }))), { agentSessionId: 'reader' })
  cleanup.push(f.close)
  return f
}

it('actual Desktop reads nonempty new packets through its public Core conversation consumer', async () => {
  const f = await realReader(), reads = vi.spyOn(api.conversation, 'readAgentConversation').mockImplementation((...args) => f.client.readAgentConversation(...args))
  vi.spyOn(api.conversation, 'readConversationChanges').mockImplementation((...args) => f.client.readConversationChanges(...args))
  vi.spyOn(api.conversation, 'observeConversation').mockImplementation((...args) => f.client.observeConversation(...args))
  vi.spyOn(api.conversation, 'releaseConversationView').mockImplementation((...args) => f.client.releaseConversationView(...args))
  await render(<ActivityView {...activityReadingProps({ control: { hostId: 'local', agentSessionId: 'reader' } })} />)
  await vi.waitFor(() => expect(host.querySelectorAll('.log-turn__reminder')).toHaveLength(2))
  expect(reads).toHaveBeenCalled(); expect(host.querySelector('.log-turn__citation-from')?.textContent).toBe('User')
  expect(f.controls.map(control => control.mock.calls.length)).toEqual(f.controls.map(() => 0))
  expect((await f.bytes()).native).toEqual(f.before.native)
  expect(await f.store.readMetadata('reader')).toMatchObject(f.session)
})

it('actual Mobile reads the same public Core messages while the recorded native author stays unknown', async () => {
  const f = await realReader()
  const client = new Proxy(f.client, { get(target, key) {
    if (key === 'runtimeOwnerIdentity') return () => null
    if (key === 'agentSession') return () => f.session
    if (key === 'agentSessions') return () => [f.session]
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
  } }) as unknown as AgentMuxHostedClient
  const read = vi.spyOn(f.client, 'readAgentConversation')
  await render(<MobileConversationSurface client={client} agentSessionId="reader" connection={{ state: 'connected', message: 'Private read-only Core' }} platform={createBrowserPlatform()} />)
  await vi.waitFor(() => expect(host.querySelectorAll('.log-turn__reminder')).toHaveLength(2))
  expect(read).toHaveBeenCalled(); expect(host.querySelector('.log-turn__citation-from')?.textContent).toBe('User')
  const page = await f.client.sessionHistoryPage('reader')
  expect(page.items[0]!.contentParts).toMatchObject([{ kind: 'text', text: complete }])
  expect(f.controls.map(control => control.mock.calls.length)).toEqual(f.controls.map(() => 0))
})

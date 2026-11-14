// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineItem, DurableAgentMuxMessageQueue } from '@agentmux/core'
import { renderAgentMuxMessageEnvelope } from '@agentmux/core/agent-message-render'
import { consumeConversationWindowPage, CONVERSATION_MAX_READ_BYTES, type ConversationWindowAssembly } from '@agentmux/core/conversation'
import { ClientUiProvider, type ClientUiPlatform } from '@agentmux/client-ui/platform'
import { ConversationView as Reader } from '@agentmux/client-ui/components/ConversationView'
import { projectConversationWindow } from '@agentmux/client-ui/conversation-records'
import { nativeHistoryFixture, jsonl } from '../../../packages/core/test/fixtures/native-history-session'
import { isolateCoreFixtureEnvironment } from './helpers/isolate-core-environment'
import { StaticConversationView, StaticActivityView } from './helpers/conversation-static-fixture'

const sid = 'a2a-reading', sender = 'recorded-sender'
const wire = renderAgentMuxMessageEnvelope({ sender: { kind: 'agent-session', agentSessionId: 'declared-sender' }, senderSessionId: 'declared-sender',
  messageId: 'original-mid', body: 'Original **request**.\n\nKeep the complete final paragraph.' })
const copy = vi.fn(async (_text: string) => true)
const platform: ClientUiPlatform = { copyText: copy, overlayContainer: () => document.body, bindComposerFocus: () => () => {},
  renderMessageAvatar: ({ speaker }) => <span data-original-author={speaker.id} />,
  renderProjectIcon: () => null, renderProjectLabel: () => null, renderIcon: () => null }
let host: HTMLDivElement, root: Root
const closes: Array<() => unknown | Promise<unknown>> = []
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); copy.mockClear()
})
afterEach(async () => {
  getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove()
  try { for (const close of closes.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs() }
})
const input = (key: 'message' | 'prompt' = 'message'): AgentTimelineItem => ({ id: 'original-input', agentSessionId: sid, kind: 'user_message', source: 'user',
  status: 'complete', createdAt: 1000, updatedAt: 1000, title: 'Original input', content: wire, publicContent: 'confirmed', authorAgentSessionId: sender,
  inputRef: { agentSessionId: sid, expectedRun: { runId: 'original-run' }, ...(key === 'message' ? { kind: 'message', messageId: 'original-mid' } : { kind: 'prompt', submissionId: 'original-input' }) } })
const draw = (body: ReactNode) => act(async () => root.render(<ClientUiProvider platform={platform}>{body}</ClientUiProvider>))
async function readWindow(f: Awaited<ReturnType<typeof nativeHistoryFixture>>) {
  let pending: ConversationWindowAssembly | undefined, cursor: string | undefined
  for (;;) {
    const page = await f.client.readAgentConversation({ hostId: 'local', agentSessionId: sid, maxBytes: CONVERSATION_MAX_READ_BYTES, ...(cursor ? { cursor } : {}) })
    const accepted = consumeConversationWindowPage(page, pending)
    if (accepted.kind === 'complete') {
      const snapshot = accepted.snapshot
      closes.push(() => f.client.releaseConversationView({ hostId: 'local', agentSessionId: sid, view: snapshot.window.view! }))
      return projectConversationWindow(snapshot)
    }
    pending = accepted.pending; cursor = page.nextCursor!
  }
}
async function expectWireReading() {
  const card = host.querySelector<HTMLElement>('[data-protocol-kind="a2a"]')!
  expect(card).not.toBeNull(); expect(card.textContent).toContain('Keep the complete final paragraph.')
  expect(card.querySelector('.log-turn__reminder > summary')?.textContent).toBe('Collaboration reminder')
  expect(card.querySelector<HTMLDetailsElement>('.log-turn__reminder')?.open).toBe(false)
  expect(host.querySelector('[data-original-author]')?.getAttribute('data-original-author')).toBe(sender)
  const row = card.closest<HTMLElement>('.log-turn')!
  expect(JSON.parse(row.dataset.conversationAuthor!)).toEqual({ kind: 'agent', agentSessionId: sender })
  const original = card.querySelector<HTMLDetailsElement>('.conversation-protocol__original')!
  expect(original).not.toBeNull()
  await act(async () => { original.open = true; original.dispatchEvent(new Event('toggle')) })
  expect(original.querySelector('pre')?.textContent).toBe(wire)
  await act(async () => row.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenLastCalledWith(wire, expect.any(Function))
}

it.each(['shared', 'desktop'])('reads a captured message-key producer wire without changing author or raw Copy in %s', async surface => {
  const timeline = { agentSessionId: sid, sourceHostId: 'local', revision: 1, items: [input()] }
  await draw(surface === 'shared' ? <StaticConversationView sessionId={sid} executionHostId="local" timeline={timeline} />
    : <StaticActivityView sessionId={sid} executionHostId="local" timelineSnapshot={timeline} items={timeline.items} capability="complete-events" />)
  await expectWireReading()
})

it('keeps an actual prompt original body opaque even when it is a complete A2A envelope example', async () => {
  await draw(<StaticConversationView sessionId={sid} executionHostId="local" timeline={{ agentSessionId: sid, revision: 1, items: [input('prompt')] }} />)
  expect(host.querySelector('.conversation-protocol')).toBeNull()
  expect(host.querySelector('.log-turn__body')?.textContent).toContain('<amux:a2a from="declared-sender"')
  expect(host.querySelector('[data-original-author]')?.getAttribute('data-original-author')).toBe(sender)
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenLastCalledWith(wire, expect.any(Function))
})

it('the real public Core reader retains the original message key and wire through shared projection and rendering', async () => {
  const directory = await mkdtemp('/tmp/amx-a2a-reading-'); closes.push(() => rm(directory, { recursive: true, force: true }))
  isolateCoreFixtureEnvironment(directory)
  const f = await nativeHistoryFixture('claude', jsonl([{ type: 'user', uuid: 'native-original', sessionId: 'native-main', message: { role: 'user', content: 'Separate native input.' } }]), { agentSessionId: sid })
  closes.push(f.close)
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: sid, item: { ...input(), inputRef: { kind: 'message', agentSessionId: sid, expectedRun: f.session.run, messageId: 'original-mid' } } })
  const value = await readWindow(f)
  await draw(<Reader sessionId={sid} executionHostId="local" records={value.records} originalRecords={value.originalRecords} page={value.historyPage ?? null} timeline={value.captured} />)
  await expectWireReading()
  expect(host.querySelectorAll('[data-conversation-event-id]')).toHaveLength(2)
  expect(await readFile(f.path)).toEqual(f.before.native)
  expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
})

it('keeps a real external journal captured body opaque through the public Core reader even with a message key', async () => {
  const directory = await mkdtemp('/tmp/amx-a2a-reading-'); closes.push(() => rm(directory, { recursive: true, force: true }))
  isolateCoreFixtureEnvironment(directory)
  const f = await nativeHistoryFixture('claude', '', { agentSessionId: sid }); closes.push(f.close)
  const queue = Reflect.get(f.client, 'messageQueue') as DurableAgentMuxMessageQueue
  const external = { kind: 'external' as const, connectionId: 'original-connection', actor: { application: { domain: 'example.test', appId: 'original-app' }, idType: 'user-id', userId: 'original-external-author' },
    externalConversationId: 'original-room', externalMessageId: 'original-external-message', bindingId: 'original-binding', bindingRevision: 1, grantId: 'original-grant', grantRevision: 1 }
  await queue.append({ messageId: 'external-mid', operationId: 'external-operation', createdAt: 1000, sender: external,
    senderSessionId: null, senderRunId: null, recipient: { kind: 'agent-session', agentSessionId: sid }, recipientSessionId: sid, recipientRunId: f.session.run.runId,
    threadId: 'original-thread', correlationId: 'original-correlation', replyTo: null, workspaceId: null, body: wire,
    admissionIntent: { kind: 'manual-actor', expectedRun: f.session.run }, execution: 'immediate' }, { inputEnvironment: { providerId: 'claude', executorId: 'claude' } })
  const value = await readWindow(f)
  expect(value.captured.items).toHaveLength(1)
  expect(value.captured.items[0]).toMatchObject({ content: wire, publicContent: 'confirmed', authorExternal: { kind: 'external', actor: external.actor },
    inputRef: { kind: 'message', messageId: 'external-mid' }, inputOrigin: { sequence: expect.any(Number) }, inputSubmission: { status: 'waiting' } })
  await draw(<Reader sessionId={sid} executionHostId="local" records={value.records} originalRecords={value.originalRecords} page={value.historyPage ?? null} timeline={value.captured} />)
  const toggle = host.querySelector<HTMLButtonElement>('.conversation-send-receipt__toggle')
  if (toggle?.getAttribute('aria-expanded') === 'false') await act(async () => toggle.click())
  expect(host.querySelector('.conversation-protocol')).toBeNull()
  const turn = host.querySelector<HTMLElement>('.log-turn')!
  expect(JSON.parse(turn.dataset.conversationAuthor!)).toMatchObject({ kind: 'external', actor: external.actor })
  expect(turn.querySelector('.log-turn__body')?.textContent).toContain('<amux:a2a from="declared-sender"')
  expect(turn.querySelector('.log-turn__body')?.textContent).toContain('Keep the complete final paragraph.')
  await act(async () => turn.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')!.click())
  expect(copy).toHaveBeenLastCalledWith(wire, expect.any(Function))
  expect(await readFile(f.path)).toEqual(f.before.native)
  expect(f.controls.flatMap(control => control.mock.calls)).toEqual([])
})

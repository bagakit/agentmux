// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient, AgentMuxFileAgentSessionStore } from '@agentmux/core'
import { composerDOM } from './helpers/composer-dom-fixture'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { retainedFocusContext } from '../src/renderer/src/lib/focus-context'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import type { FocusContext } from '../src/renderer/src/lib/focus-context'

const dom = composerDOM(), cleanup: Array<() => Promise<unknown>> = []
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture(_unused?: unknown, count = 2) {
  const directory = await mkdtemp(join(tmpdir(), 'focus-original-port-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const store = new AgentMuxFileAgentSessionStore(join(directory, 'sessions.json'))
  for (let index = 0; index < count; index++) {
    const id = `archived-${index}`, path = join(directory, `${id}.jsonl`), at = Date.now() - 3_600_000
    await writeFile(path, JSON.stringify({ sessionId: `native-${id}`, uuid: `other-${index}`, type: 'user', message: { role: 'user', content: `Original source body ${index}` }, timestamp: new Date(at).toISOString() }) + '\n')
    await store.compareAndSwap(null, { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'claude', hostId: 'private-host', workspacePath: directory,
      run: { runId: `not-controlled-${id}` }, retiredRuns: [], createdAt: at, updatedAt: at, hookBindingId: `binding-${id}`, hookToken: 'private-secret',
      nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: `native-${id}`, transcriptPath: path } })
  }
  const client = new AgentMuxClient({ store })
  const wait = async (check: () => void) => { for (let i = 0; i < 120; i++) { await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) }); try { check(); return } catch (error) { if (i === 119) throw error } } }
  return { client, root: { render: (node: React.ReactNode) => dom.render(node) }, get element() { return dom.container }, wait,
    markers: () => Array.from(dom.container.querySelectorAll<HTMLElement>('[data-message-id]')) }
}

it('the production Timeline uses and retains each original source port and Runtime, never its presentation id or local same-SID metadata', async () => {
  const h = await fixture(undefined, 2)
  const local = vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(Error('Local reader must not be used'))
  const localObserve = vi.spyOn(api.conversation, 'observeConversation').mockRejectedValue(Error('Local observation must not be used'))
  const resync = vi.fn(async () => {})
  const ports = [0, 1].map(() => ({
    readAgentConversation: vi.fn(h.client.readAgentConversation.bind(h.client)),
    readConversationChanges: vi.fn(h.client.readConversationChanges.bind(h.client)),
    observeConversation: vi.fn(h.client.observeConversation.bind(h.client)),
    releaseConversationView: vi.fn(h.client.releaseConversationView.bind(h.client))
  }))
  const contexts = ports.map((port, i): FocusContext => ({ ...retainedFocusContext({ hostId: 'private-host', agentSessionId: `archived-${i}`, state: 'retained', history: null } as never, `Original task ${i}`),
    id: `presentation-runtime-${i}`, hostId: 'source-carrier', access: { identity: { runtimeId: `original-runtime-${i}`, agentSessionId: `archived-${i}` },
      locations: [], select() {}, open() {}, refresh() {}, conversationReference: { hostId: 'private-host', agentSessionId: `archived-${i}` }, conversationPort: port } }))
  useAppStore.setState({ agentNames: { 'presentation-runtime-0': 'WRONG LOCAL NAME', 'archived-0': 'WRONG LOCAL AUTHOR' },
    timelines: { 'presentation-runtime-0': { agentSessionId: 'presentation-runtime-0', revision: 1, items: [] } }, resyncTimeline: resync })
  const render = (current: number) => act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts, entries: [], currentContext: contexts[current], currentSessionId: contexts[current]!.id, onSelect: vi.fn(),
    catalogue: { sources: [], loading: false, error: null, refresh() {} } as never })))
  await render(0)
  await h.wait(() => expect(ports[0]!.readAgentConversation).toHaveBeenCalled())
  await h.wait(() => expect(h.markers().length).toBeGreaterThan(0))
  expect(h.element.textContent).not.toContain('WRONG LOCAL')
  expect(h.element.querySelector('[data-focus-timeline-id="presentation-runtime-0"]')).not.toBeNull()
  await render(1)
  await h.wait(() => expect(ports[1]!.readAgentConversation).toHaveBeenCalled())
  await h.wait(() => expect(h.markers().some(marker => marker.dataset.messageRawId === 'other-1')).toBe(true))
  await render(0)
  await h.wait(() => expect(h.element.textContent).toContain('Original task 0'))
  for (let i = 0; i < ports.length; i++) {
    for (const call of ports[i]!.readAgentConversation.mock.calls) expect(call[0]).toMatchObject({ hostId: 'private-host', agentSessionId: `archived-${i}` })
    for (const call of ports[i]!.observeConversation.mock.calls) expect(call[0]).toMatchObject({ hostId: 'private-host', agentSessionId: `archived-${i}` })
  }
  expect(local).not.toHaveBeenCalled(); expect(localObserve).not.toHaveBeenCalled(); expect(resync).not.toHaveBeenCalled()
})

it('an unconfirmed original-source reader never falls back to local API even when local state has the same id', async () => {
  const h = await fixture(undefined, 1)
  const read = vi.spyOn(api.conversation, 'readAgentConversation').mockRejectedValue(Error('Wrong local target'))
  const context = { ...retainedFocusContext({ hostId: 'private-host', agentSessionId: 'archived-0', state: 'retained', history: null } as never),
    access: { identity: { runtimeId: 'original-runtime', agentSessionId: 'archived-0' }, locations: [], select() {}, open() {}, refresh() {}, issue: 'Original conversation owner unavailable' } }
  await act(async () => h.root.render(createElement(RecentFocusTimeline, { contexts: [context], entries: [], currentContext: context, currentSessionId: context.id, onSelect: vi.fn(), catalogue: { sources: [], loading: false, error: null, refresh() {} } as never })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(read).not.toHaveBeenCalled()
})

it('accepted partitions retain their own original port when two Runtime scopes share the exact Host and SID', async () => {
  const h = await fixture(undefined, 1)
  const ports = ['runtime-a', 'runtime-b'].map(() => ({
    readAgentConversation: vi.fn(h.client.readAgentConversation.bind(h.client)),
    readConversationChanges: vi.fn(h.client.readConversationChanges.bind(h.client)),
    observeConversation: vi.fn(h.client.observeConversation.bind(h.client)),
    releaseConversationView: vi.fn(h.client.releaseConversationView.bind(h.client))
  }))
  const contexts = ports.map((port, i): FocusContext => ({ ...retainedFocusContext({ hostId: 'private-host', agentSessionId: 'archived-0', state: 'retained', history: null } as never, `Runtime task ${i}`),
    id: `qualified-runtime-${i}`, hostId: 'source-carrier', access: { identity: { runtimeId: `runtime-${i}`, agentSessionId: 'archived-0' }, locations: [], select() {}, open() {}, refresh() {},
      conversationReference: { hostId: 'private-host', agentSessionId: 'archived-0' }, conversationPort: port } }))
  const render = (current: number) => dom.render(createElement(RecentFocusTimeline, { contexts, entries: [], currentContext: contexts[current], currentSessionId: contexts[current]!.id, onSelect: vi.fn(), catalogue: { sources: [], loading: false, error: null, refresh() {} } as never }))
  await render(0); await h.wait(() => expect(h.element.querySelector('.recent-focus')?.getAttribute('data-read-source-count')).toBe('1'))
  await render(1); await h.wait(() => expect(h.element.querySelector('.recent-focus')?.getAttribute('data-read-source-count')).toBe('2'))
  const bReads = ports[1]!.readAgentConversation.mock.calls.length
  await render(0); await h.wait(() => expect(h.element.querySelectorAll('[data-focus-timeline-id]')).toHaveLength(2))
  expect(ports[1]!.readAgentConversation).toHaveBeenCalledTimes(bReads)
  for (const port of ports) {
    expect(port.readAgentConversation).toHaveBeenCalled()
    for (const [reference] of port.readAgentConversation.mock.calls) expect(reference).toMatchObject({ hostId: 'private-host', agentSessionId: 'archived-0' })
  }
})

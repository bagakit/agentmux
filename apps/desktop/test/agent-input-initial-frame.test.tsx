// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
const dom = composerDOM({ agentInformation: true }), agent = composerSession('inspection-agent')
const source = { providerId: 'codex', nativeSessionId: 'inspection-native' }
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'inspection-reply', agentSessionId: agent.id,
 kind: 'assistant_message' as const, source: 'native-hook' as const, status: 'complete' as const, title: 'Reply',
 content: 'Original reply remains available.\n\n'.repeat(80), createdAt: 1, updatedAt: 1 }] }
const page: AgentSessionHistoryPage = { agentSessionId: agent.id, source, nextCursor: null,
 items: [1, 2].map(index => ({ id: 'inspection-input-' + index, kind: 'user-message' as const, startedAt: index,
 contentParts: [{ kind: 'text' as const, text: 'Original native input ' + index }] })) }
let resolveNative!: (value: AgentSessionHistoryPage) => void
let conversation: Awaited<ReturnType<typeof agentCardConversationFixture>>
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')!
const inputs = () => [...panel().querySelectorAll<HTMLElement>('[data-hover-input-id]')]
beforeEach(async () => {
 for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
 useAppStore.setState({ sessions: [agent], timelines: { [agent.id]: timeline }, demands: {}, agentNames: {} })
 vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
 vi.spyOn(api.sessions, 'historyPage').mockImplementation(() => new Promise(done => { resolveNative = done }))
 vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source, dispose() {} }))
 conversation = await agentCardConversationFixture(() => source)
})
afterEach(async () => {
 for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
 await agentBookmarks.flush()
})
it.each(['peek', 'pin', 'protected-before-pin'] as const)('shows the accepted original input frame after delayed loading: %s', async scenario => {
 await dom.render(<button id="original-invoker">Original Agent</button>)
 const anchor = dom.container.querySelector<HTMLButtonElement>('button')!
 await act(async () => { agentInformationPreview.show({ token: {}, id: 'inspection-reader', anchor,
 context: agentContextForSession(agent, timeline, undefined, composerConfig.workspaces[0]!, null), enterReading: false,
 keepOpen() {}, restoreFocus() {}, openWorkface() {} }) })
 await waitForAgentCardReading(() => expect(resolveNative).toBeTypeOf('function'))
 const original = panel(), originalReading = original.querySelector<HTMLElement>('.agent-information-reader__reading')!
 expect(inputs()).toHaveLength(0)
 if (scenario === 'protected-before-pin') {
  await act(async () => { originalReading.scrollTop = 42; originalReading.dispatchEvent(new Event('scroll', { bubbles: true })) })
 }
 if (scenario !== 'peek') await act(async () => original.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
 await act(async () => resolveNative(page))
 await waitForAgentCardReading(() => expect(vi.mocked(api.conversation.readAgentConversation).mock.settledResults[0]?.type).toBe('fulfilled'))
 await act(async () => { await new Promise(done => setTimeout(done, 180)) })
 const accepted = await vi.mocked(api.conversation.readAgentConversation).mock.results[0]!.value
 expect(JSON.stringify(accepted.items)).toContain('Original native input 1')
 expect(inputs()).toHaveLength(2)
 expect(original.textContent).not.toContain('Loading recent messages')
 expect(panel()).toBe(original)
 expect(original.querySelector('.agent-information-reader__reading')).toBe(originalReading)
 expect(original.hidden).toBe(false)
 expect(useAppStore.getState().sessions[0]!.control).toBe(agent.control)
})

it.each([false, true])('settles and parks a protected accepted empty frame; captured-only=%s', async capturedOnly => {
 const observe = vi.mocked(api.conversation.observeConversation).getMockImplementation()!, parked = vi.fn()
 vi.mocked(api.conversation.observeConversation).mockImplementation(async (...args) => {
  const handle = await observe(...args)
  return { ...handle, dispose() { parked(); handle.dispose() } }
 })
 if (capturedOnly) {
  const store = conversation.storeFor('local'), prior = (await store.loadMetadata()).find(session => session.agentSessionId === agent.control.agentSessionId)
  const next = { ...prior! }; delete next.nativeHandle
  await store.compareAndSwap(prior!, next)
 }
 await dom.render(<button>Original Agent</button>)
 const anchor = dom.container.querySelector<HTMLButtonElement>('button')!
 await act(async () => { agentInformationPreview.show({ token: {}, id: 'empty-input-reader', anchor,
 context: agentContextForSession(agent, timeline, undefined, composerConfig.workspaces[0]!, null), enterReading: false,
 keepOpen() {}, restoreFocus() {}, openWorkface() {} }) })
 if (!capturedOnly) await waitForAgentCardReading(() => expect(resolveNative).toBeTypeOf('function'))
 const original = panel(), reading = original.querySelector<HTMLElement>('.agent-information-reader__reading')!
 await act(async () => { reading.scrollTop = 42; reading.dispatchEvent(new Event('scroll', { bubbles: true })) })
 await act(async () => original.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
 if (!capturedOnly) await act(async () => resolveNative({ ...page, items: [] }))
 await waitForAgentCardReading(() => {
  expect(original.textContent, original.querySelector('.agent-input-recall')?.textContent ?? 'Missing recap').toContain(capturedOnly ? 'Recent message reading unavailable' : 'No inputs in the current reading window')
  expect(original.textContent).not.toContain('Loading recent messages')
 })
 const accepted = await vi.mocked(api.conversation.readAgentConversation).mock.results[0]!.value
 await waitForAgentCardReading(() => expect(parked).toHaveBeenCalled())
 const reads = vi.mocked(api.conversation.readConversationChanges).mock.calls.length
 await act(async () => { await new Promise(done => setTimeout(done, 180)) })
 expect(api.conversation.readConversationChanges).toHaveBeenCalledTimes(reads)
 expect(api.conversation.releaseConversationView).not.toHaveBeenCalled()
 expect(accepted.window).toBeTruthy()
 expect(inputs()).toHaveLength(0)
 if (!capturedOnly) expect(original.textContent).not.toContain('unavailable')
 if (capturedOnly) expect(api.sessions.historyPage).not.toHaveBeenCalled()
})

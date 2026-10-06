// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAgentSessionHistory, type AgentSessionHistoryDescriptor, type AgentTimelineItem, type AgentSessionHistoryPage } from '@agentmux/core'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteAgent, moteConfig, seedMoteWorkface } from './fixtures/mote-workface'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('output') }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
const initial = useAppStore.getState(), reference = { hostId: 'local', agentSessionId: 'OriginalSession' }
const source: AgentSessionHistoryDescriptor = { ...reference, state: 'retired', history: { providerId: 'generic', executorId: 'generic', workspacePath: fixturePath('history-search'), createdAt: _newTailFixtureEpoch(0, 0, 1), nativeHandle: { kind: 'provider', providerId: 'generic', sessionId: 'OriginalNative' } } }
const message = (id: string, content: string): AgentTimelineItem => ({ id, agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Recorded reply', content, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) })
let items: AgentTimelineItem[], container: HTMLDivElement, root: Root
const owner = {
 sessionHistorySources: async () => [source],
 sessionTimeline: async () => ({ agentSessionId: reference.agentSessionId, revision: 1, items }),
 sessionHistoryPage: async (): Promise<AgentSessionHistoryPage> => ({ agentSessionId: reference.agentSessionId, source: { providerId: 'generic', nativeSessionId: 'OriginalNative' }, items: [{ id: 'native-reply', kind: 'assistant-message' as const, contentParts: [{ kind: 'text' as const, text: 'Native hidden needle original reply' }] }], nextCursor: null })
}
async function mount(visible = true) { await act(async () => root.render(<GlobalFocusSurface visible={visible} workspaceOpen={false} />)) }
async function query(value: string) { await act(async () => { const e = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function enter() { await act(async () => container.querySelector('[aria-label="Search contexts"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))) }
async function settle() { for (let i = 0; i < 20; i++) { await act(async () => new Promise(resolve => setTimeout(resolve, 5))); if (container.querySelector('[aria-label="History search results"]')?.getAttribute('aria-busy') === 'false') return } throw Error('Nonempty history query did not settle') }
beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface(); items = [message('captured-reply', 'Captured hidden needle original reply')]
 const workspace = { id: 'history-project', name: 'History project', hostId: 'local', path: fixturePath('history-search'), kind: 'folder' as const }
 const agent = { ...moteAgent(reference.agentSessionId, null), workspacePath: workspace.path }
 const tab = createWorkbenchTab('OriginalTab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'OriginalRegion', sessionId: agent.id })
 useAppStore.setState({ loading: false, config: { ...moteConfig, workspaces: [workspace] }, sessions: [agent], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('OriginalGroup', [tab.id]) }, timelines: {}, scratchTopicSnapshots: {}, agentNames: {}, mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { OriginalSession: 'Original unsent draft' } })
 vi.spyOn(api.sessions, 'historySources').mockResolvedValue([source])
 vi.spyOn(api.sessions, 'readHistory').mockImplementation((reference, options, context) => readAgentSessionHistory(owner, { ...reference, ...options }, context))
 vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
 vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null }); vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
 for (const key of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const) vi.spyOn(api.sessions, key)
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container); await mount()
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('queries original captured and native assistant text only on deliberate Enter and reads it through the common message body', async () => {
 const state = useAppStore.getState(); await query('hidden needle'); expect(api.sessions.readHistory).not.toHaveBeenCalled(); expect(container.querySelectorAll('.focus-context')).toHaveLength(0)
 await enter(); await settle(); expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(2)
 expect(container.textContent).toContain('Captured hidden needle original reply'); expect(container.textContent).toContain('Native hidden needle original reply'); expect(container.textContent).toContain('2 / 2 source streams checked')
 const first = container.querySelector<HTMLDetailsElement>('.focus-history-hit')!; await act(async () => { first.open = true; first.dispatchEvent(new Event('toggle')) })
 expect(first.querySelector('[data-message-id="captured-reply"]')).not.toBeNull(); expect(useAppStore.getState().tabs).toBe(state.tabs); expect(useAppStore.getState().agentComposerDrafts).toBe(state.agentComposerDrafts)
 for (const key of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const) expect(api.sessions[key]).not.toHaveBeenCalled()
})
it('keeps zero-hit partial history explicit and continues the original query without repeating earlier pages', async () => {
 items = [message('older-match', 'older needle'), ...Array.from({ length: 1800 }, (_, i) => message('ordinary-' + i, 'Other original reply'))]
 await query('older needle'); await enter(); await settle(); expect(api.sessions.readHistory).toHaveBeenCalledTimes(8)
 expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(0); expect(container.textContent).toContain('Search coverage is incomplete')
 const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue history search')!; await act(async () => more.click()); await settle()
 expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(1); expect(container.textContent).toContain('older needle'); expect(container.textContent).toContain('2 / 2 source streams checked')
 const calls = vi.mocked(api.sessions.readHistory).mock.calls; expect(calls[8]![1].cursor).toBeTruthy(); expect(new Set(calls.filter(call => call[1].source === 'captured').map(call => call[1].cursor ?? 'first')).size).toBe(10)
})
it('aborts hidden and superseded readers and discards late query results without losing original drafts', async () => {
 let finish!: (page: Awaited<ReturnType<typeof api.sessions.readHistory>>) => void, signal: AbortSignal | undefined
 vi.mocked(api.sessions.readHistory).mockImplementationOnce((_, __, context) => { signal = context?.signal; return new Promise(resolve => { finish = resolve }) })
 await query('hidden needle'); await enter(); expect(signal?.aborted).toBe(false)
 const old = await readAgentSessionHistory(owner, { ...reference, source: 'captured', kind: 'text', query: 'hidden needle' })
 await query('new query'); expect(signal?.aborted).toBe(true); await act(async () => finish(old)); expect(container.querySelector('[aria-label="History search results"]')).toBeNull()
 vi.mocked(api.sessions.readHistory).mockImplementationOnce((_, __, context) => { signal = context?.signal; return new Promise(() => {}) })
 await enter(); await mount(false); expect(signal?.aborted).toBe(true); expect(container.querySelector('[aria-label="History search results"]')).toBeNull(); expect(useAppStore.getState().agentComposerDrafts.OriginalSession).toBe('Original unsent draft')
})
it('keeps unavailable source coverage visible alongside successful retained matches', async () => {
 vi.mocked(api.sessions.readHistory).mockImplementation((ref, options, context) => options.source === 'native' ? Promise.reject(new Error('Original native source is unavailable')) : readAgentSessionHistory(owner, { ...ref, ...options }, context))
 await query('hidden needle'); await enter(); await settle(); expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(1)
 expect(container.textContent).toContain('1 unavailable'); expect(container.textContent).toContain('Original native source is unavailable'); expect(container.textContent).toContain('1 / 2 source streams checked')
})
it('reads an original matching reply beyond the initial query budget at its retained cursor', async () => {
 items = [message('large-original', 'hidden needle ' + 'x'.repeat(1100 * 1024))]
 await query('hidden needle'); await enter(); await settle()
 expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(2)
 const calls = vi.mocked(api.sessions.readHistory).mock.calls, retried = calls.find(call => (call[1].maxBytes ?? 0) > 1024 * 1024)
 expect(retried?.[1].cursor).toBeTruthy(); expect(retried?.[0]).toEqual(reference); expect(container.textContent).not.toContain('unavailable')
})

it('bounds repeated continuation by the original Focus reading budget while preserving the expanded record', async () => {
 items = Array.from({ length: 250 }, (_, i) => message('bounded-' + i, 'hidden needle ' + 'x'.repeat(80 * 1024)))
 await query('hidden needle'); await enter(); await settle()
 const pinned = container.querySelector<HTMLDetailsElement>('.focus-history-hit')!; await act(async () => { pinned.open = true; pinned.dispatchEvent(new Event('toggle')) })
 const body = pinned.querySelector('[data-message-id]')!; expect(body).not.toBeNull()
 for (let i = 0; i < 2; i++) { const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue history search')!; await act(async () => more.click()); await settle() }
 expect(container.querySelectorAll('.focus-history-hit').length).toBeLessThanOrEqual(155); expect(container.textContent).toContain('outside it')
 expect(pinned.querySelector('[data-message-id]')).toBe(body); expect(pinned.open).toBe(true)
})
it('keeps an expanded complete resource, its DOM selection and original reader when more matches arrive', async () => {
 const nativeSource = { providerId: 'generic', nativeSessionId: 'OriginalNative' }, text = 'hidden needle complete original resource'
 const bytes = Buffer.from(JSON.stringify({ kind: 'text', text })), sha256 = createHash('sha256').update(bytes).digest('hex')
 const part = { kind: 'resource' as const, resourceType: 'text' as const, reference: 'original-text-reference', content: { kind: 'text' as const, encoding: 'json-utf8' as const, byteLength: bytes.length, sha256 } }
 let reads = 0
 vi.mocked(api.sessions.readHistory).mockImplementation(async (ref, options) => {
  const captured = options.source === 'captured', current = captured ? 0 : ++reads, complete = captured || current > 7
  return { ...ref, source: options.source, kind: 'text', revision: 'a'.repeat(64), availability: current === 1 || current > 7 ? 'available' : 'empty', order: 'newest-first', budgetBytes: options.maxBytes!, scan: { examined: 1, complete }, nextCursor: complete ? null : 'resource-query-' + current,
   ...(captured ? {} : { nativeSource }), items: current === 1 ? [{ kind: 'item', item: { id: 'resource-record', kind: 'assistant-message', contentParts: [part] } }] : current > 7 ? [{ kind: 'item', item: { id: 'later-record', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'hidden needle later reply' }] } }] : [] }
 })
 const resource = vi.spyOn(api.sessions, 'historyResource').mockImplementation(async (ref, input) => ({ agentSessionId: ref.agentSessionId, source: nativeSource, recordId: input.recordId, partIndex: input.partIndex, reference: input.expectedReference,
  result: { status: 'fragment', encoding: 'json-utf8', dataBase64: bytes.toString('base64'), byteLength: bytes.length, offsetBytes: 0, totalBytes: bytes.length, sha256, nextOffsetBytes: null } }))
 await query('hidden needle'); await enter(); await settle()
 const hit = container.querySelector<HTMLDetailsElement>('.focus-history-hit')!; await act(async () => { hit.open = true; hit.dispatchEvent(new Event('toggle')) })
 const read = [...hit.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.startsWith('Read complete content'))!; expect(read).toBeDefined(); await act(async () => read.click())
 const body = hit.querySelector('.conversation-resource-text .log-turn__text')!; expect(body?.textContent).toContain(text)
 const range = document.createRange(); range.selectNodeContents(body); const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString(), count = resource.mock.calls.length
 const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue history search')!; await act(async () => more.click()); await settle()
 expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(2); expect(hit.querySelector('.conversation-resource-text .log-turn__text')).toBe(body); expect(selection.toString()).toBe(selected); expect(resource).toHaveBeenCalledTimes(count)
})
it('shows the recorded answer that caused a native question reply match and keeps the original record readable', async () => {
 vi.spyOn(owner, 'sessionHistoryPage').mockResolvedValue({ agentSessionId: reference.agentSessionId, source: { providerId: 'generic', nativeSessionId: 'OriginalNative' }, items: [{ id: 'native-answer', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original native wrapper' }], questionAnswers: [{ questionId: 'original-question', answer: 'recorded answer needle' }] }], nextCursor: null })
 await query('answer needle'); await enter(); await settle(); expect(container.querySelectorAll('.focus-history-hit')).toHaveLength(1)
 const hit = container.querySelector<HTMLDetailsElement>('.focus-history-hit')!; expect(hit.textContent).toContain('recorded answer needle'); await act(async () => { hit.open = true; hit.dispatchEvent(new Event('toggle')) })
 expect(hit.querySelector('[data-message-id="native-answer"]')?.textContent).toContain('recorded answer needle'); expect(hit.textContent).toContain('Original record'); expect(hit.textContent).toContain('Original native wrapper')
})

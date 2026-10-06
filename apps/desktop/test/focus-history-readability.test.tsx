// @vitest-environment happy-dom
import { fixtureEpoch as _newTailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readAgentSessionHistory, type AgentSessionHistoryDescriptor, type AgentSessionHistoryPage, type AgentTimelineItem } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createClientUiRoot } from './helpers/client-ui-render'
import { moteAgent, moteConfig, seedMoteWorkface } from './fixtures/mote-workface'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => createElement('output') }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const initial = useAppStore.getState(), reference = { hostId: 'local', agentSessionId: 'OriginalSession' }
const workspace = { id: 'history-project', name: 'History project', hostId: 'local', path: fixturePath('history-readability'), kind: 'folder' as const }
const source: AgentSessionHistoryDescriptor = { ...reference, state: 'retired', history: { providerId: 'generic', executorId: 'generic', workspacePath: workspace.path, createdAt: _newTailFixtureEpoch(0, 0, 1), nativeHandle: { kind: 'provider', providerId: 'generic', sessionId: 'OriginalNative' } } }
const message = (id: string, content: string): AgentTimelineItem => ({ id, agentSessionId: reference.agentSessionId, kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Recorded reply', content, createdAt: _newTailFixtureEpoch(0, 0, 1), updatedAt: _newTailFixtureEpoch(0, 0, 1) })
let items: AgentTimelineItem[], container: HTMLDivElement, root: Root
const owner = {
 sessionHistorySources: async () => [source],
 sessionTimeline: async () => ({ agentSessionId: reference.agentSessionId, revision: 1, items }),
 sessionHistoryPage: async (): Promise<AgentSessionHistoryPage> => ({ agentSessionId: reference.agentSessionId, source: { providerId: 'generic', nativeSessionId: 'OriginalNative' }, items: [{ id: 'native-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'Native cache[0] original reply' }] }], nextCursor: null })
}
async function query(value: string) { await act(async () => { const input = container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function search(value: string) { await query(value); await act(async () => container.querySelector('[aria-label="Search contexts"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))); await settle() }
async function settle() { for (let i = 0; i < 20; i++) { await act(async () => new Promise(resolve => setTimeout(resolve, 5))); if (container.querySelector('[aria-label="History search results"]')?.getAttribute('aria-busy') === 'false') return } throw Error('Nonempty history query did not settle') }
async function expand(hit: HTMLDetailsElement) { await act(async () => { hit.open = true; hit.dispatchEvent(new Event('toggle')) }) }
const hits = () => [...container.querySelectorAll<HTMLDetailsElement>('.focus-history-hit')]
const summary = (hit: HTMLDetailsElement) => hit.querySelector<HTMLElement>(':scope > summary')!

beforeEach(async () => {
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); seedMoteWorkface(); items = [message('captured-reply', 'Original cache[0] reply')]
 const agent = { ...moteAgent(reference.agentSessionId, null), workspacePath: workspace.path }
 const tab = createWorkbenchTab('OriginalTab', { kind: 'agent', phase: 'attached', workspaceId: workspace.id, regionId: 'OriginalRegion', sessionId: agent.id })
 useAppStore.setState({ loading: false, config: { ...moteConfig, workspaces: [workspace] }, sessions: [agent], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: createWorkspaceLayout('OriginalGroup', [tab.id]) }, timelines: {}, scratchTopicSnapshots: {}, agentNames: {}, mainSurface: 'agents', agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { OriginalSession: 'Original unsent draft' } })
 vi.spyOn(api.sessions, 'historySources').mockResolvedValue([source])
 vi.spyOn(api.sessions, 'readHistory').mockImplementation((target, options, context) => readAgentSessionHistory(owner, { ...target, ...options }, context))
 vi.spyOn(api.sessions, 'historyResource')
 vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: workspace.path })
 vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null }); vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
 for (const key of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const) vi.spyOn(api.sessions, key)
 container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
 await act(async () => root.render(<GlobalFocusSurface workspaceOpen={false} />))
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.getElementById('agentmux-window-overlay-host')?.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('shows the exact Host-qualified current name above original identities without renaming the recorded message', async () => {
 const correct = { ...moteAgent('local-presentation', null), workspacePath: workspace.path, control: { kind: 'agent' as const, hostId: 'local', agentSessionId: reference.agentSessionId, run: { runId: 'original-local-run' } } }
 const wrong = { ...moteAgent('remote-presentation', null), hostId: 'remote', control: { kind: 'agent' as const, hostId: 'remote', agentSessionId: reference.agentSessionId, run: { runId: 'original-remote-run' } } }
 await act(async () => useAppStore.setState({ sessions: [wrong, correct], agentNames: { [wrong.id]: 'Wrong Host name', [correct.id]: 'Current local name' } }))
 await search('cache[0]'); expect(hits()).toHaveLength(2)
 for (const hit of hits()) {
  expect(summary(hit).querySelector('strong')?.textContent).toBe('Current local name')
  expect(summary(hit).textContent).toContain('Current name · This Mac'); expect(summary(hit).textContent).not.toContain('Wrong Host name')
  expect(summary(hit).textContent).not.toContain('OriginalSession'); expect(summary(hit).textContent).not.toContain('OriginalNative')
 }
 const hit = hits()[1]!; await expand(hit)
 const provenance = hit.querySelector('[aria-label="Original record source"]')!
 for (const text of ['local', 'OriginalSession', 'native', 'generic', 'OriginalNative', 'native-reply']) expect(provenance.textContent).toContain(text)
 const body = hit.querySelector('[data-message-id="native-reply"]')!; expect(body).not.toBeNull(); expect(body.textContent).not.toContain('Current local name')
 const originalText = body.textContent, reads = vi.mocked(api.sessions.readHistory).mock.calls.length
 await act(async () => useAppStore.setState({ agentNames: { [correct.id]: 'Renamed local display', [wrong.id]: 'Wrong Host name' } }))
 expect(summary(hit).querySelector('strong')?.textContent).toBe('Renamed local display'); expect(hit.querySelector('[data-message-id="native-reply"]')).toBe(body); expect(body.textContent).toBe(originalText)
 expect(api.sessions.readHistory).toHaveBeenCalledTimes(reads); expect(api.sessions.historyResource).not.toHaveBeenCalled()
})

it('keeps original IDs when another Host owns the same Session ID or the current name is not available', async () => {
 const wrong = { ...moteAgent(reference.agentSessionId, null), hostId: 'remote', label: 'Wrong Host fallback', control: { kind: 'agent' as const, hostId: 'remote', agentSessionId: reference.agentSessionId, run: { runId: 'remote-run' } } }
 await act(async () => useAppStore.setState({ sessions: [wrong], agentNames: { [wrong.id]: 'Wrong Host name' }, config: { ...moteConfig, hosts: [], workspaces: [workspace] } }))
 await search('cache[0]'); expect(hits()).toHaveLength(2)
 for (const hit of hits()) { expect(summary(hit).querySelector('strong')?.textContent).toBe(reference.agentSessionId); expect(summary(hit).textContent).not.toContain('Wrong Host'); expect(summary(hit).textContent).not.toContain('Current name'); expect(summary(hit).textContent).toContain('local') }
 const misrouted = { ...wrong, hostId: 'local' }
 await act(async () => useAppStore.setState({ sessions: [misrouted] }))
 expect(summary(hits()[0]!).querySelector('strong')?.textContent).toBe(reference.agentSessionId)
 const unnamed = { ...moteAgent(reference.agentSessionId, null), label: '' }
 await act(async () => useAppStore.setState({ sessions: [unnamed], agentNames: {}, timelines: {} }))
 expect(summary(hits()[0]!).querySelector('strong')?.textContent).toBe(reference.agentSessionId)
 expect(summary(hits()[0]!).textContent).not.toContain('Current name')
})

it('emphasizes only exact case-sensitive literal matches in the already-read bounded excerpt', async () => {
 items = [message('literal-reply', 'Before cache[0] · CACHE[0] · cache0 · cache[0] after')]
 await search('cache[0]'); const hit = hits()[0]!, excerpt = summary(hit).querySelector('.focus-history-hit__excerpt')!
 expect([...excerpt.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['cache[0]', 'cache[0]'])
 expect(excerpt.textContent).toBe(items[0]!.content); expect(vi.mocked(api.sessions.readHistory).mock.calls.every(call => call[1].query === 'cache[0]')).toBe(true)
 await expand(hit); expect(hit.querySelector('[data-message-id="literal-reply"]')?.textContent).toContain(items[0]!.content)
 expect(hit.querySelector('[data-message-id="literal-reply"] mark')).toBeNull(); expect(api.sessions.historyResource).not.toHaveBeenCalled()
})

it('renders HTML-looking literal text as text and never emphasizes synthetic clipping ellipses', async () => {
 const literal = '<img src=x onerror=alert(1)>'
 items = [message('html-literal', `Before ${literal} after`)]
 await search(literal); let excerpt = summary(hits()[0]!).querySelector('.focus-history-hit__excerpt')!
 expect(excerpt.textContent).toBe(items[0]!.content); expect(excerpt.querySelector('img')).toBeNull(); expect(excerpt.querySelector('mark')?.textContent).toBe(literal)
 items = [message('clipped-literal', 'a'.repeat(200) + '… original ellipsis ' + 'b'.repeat(600))]
 await search('…'); excerpt = summary(hits()[0]!).querySelector('.focus-history-hit__excerpt')!
 expect(excerpt.textContent?.startsWith('…')).toBe(true); expect(excerpt.textContent?.endsWith('…')).toBe(true)
 expect(excerpt.textContent?.length).toBe(322); expect([...excerpt.querySelectorAll('mark')].map(mark => mark.textContent)).toEqual(['…'])
})

it('reads a selected conversation with its original empty query instead of its display label', async () => {
 await act(async () => useAppStore.setState({ sessions: [] }))
 await query(reference.agentSessionId)
 const read = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Read conversation')!
 expect(read).toBeDefined(); await act(async () => read.click()); await settle(); expect(hits()).toHaveLength(2)
 expect(summary(hits()[0]!).querySelector('.focus-history-hit__excerpt')?.textContent).toBe(items[0]!.content)
 expect(summary(hits()[0]!).querySelector('mark')).toBeNull()
 expect(container.querySelector('[aria-label="History search results"] > header')?.textContent).toContain('Recorded conversation · OriginalSession')
 expect(vi.mocked(api.sessions.readHistory).mock.calls.every(call => call[1].query === '')).toBe(true)
})

it('preserves original partial and failed coverage, reading selection and drafts while names change and more results arrive', async () => {
 items = Array.from({ length: 161 }, (_, i) => message('match-' + i, 'cache[0] original reply ' + i))
 vi.mocked(api.sessions.readHistory).mockImplementation((target, options, context) => options.source === 'native' ? Promise.reject(new Error('Original native source is unavailable')) : readAgentSessionHistory(owner, { ...target, ...options }, context))
 await search('cache[0]'); const hit = hits()[0]!; await expand(hit)
 const body = hit.querySelector('[data-message-id]')!, text = body.querySelector('.log-turn__text')!
 expect(text).not.toBeNull(); const range = document.createRange(); range.selectNodeContents(text)
 const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range); const selected = selection.toString()
 const before = useAppStore.getState(), reads = vi.mocked(api.sessions.readHistory).mock.calls.length
 await act(async () => useAppStore.setState({ agentNames: { OriginalSession: 'New current name' } }))
 expect(api.sessions.readHistory).toHaveBeenCalledTimes(reads); expect(hit.querySelector('[data-message-id]')).toBe(body); expect(selection.toString()).toBe(selected)
 const more = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue history search')!
 expect(more).toBeDefined(); await act(async () => more.click()); await settle()
 expect(hit.open).toBe(true); expect(hit.querySelector('[data-message-id]')).toBe(body); expect(selection.toString()).toBe(selected)
 expect(container.textContent).toContain('source streams remaining'); expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
 // Finish only the same captured stream; failure in its native sibling remains explicit.
 await act(async () => more.click()); await settle()
 expect(container.textContent).toContain('Original native source is unavailable'); expect(container.textContent).toContain('unavailable')
 expect(api.sessions.historyResource).not.toHaveBeenCalled()
 for (const key of ['launchAgent', 'recover', 'resume', 'stop', 'write', 'interrupt'] as const) expect(api.sessions[key]).not.toHaveBeenCalled()
})

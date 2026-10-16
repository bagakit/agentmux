// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentCardConversationFixture } from './helpers/agent-card-conversation-fixture'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))

const dom = composerDOM({ agentInformation: true }), agent = composerSession('reading-agent'), other = composerSession('other-agent')
const workspace = composerConfig.workspaces[0]!, onOpen = vi.fn()
const originalReply = 'Original **work**.\n\nMiddle paragraph stays selected.\n\nCOMPLETE ORIGINAL TAIL'
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'original-reply', agentSessionId: agent.id, kind: 'assistant_message' as const, source: 'native-hook' as const, title: 'Reply', status: 'complete' as const, content: originalReply, createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] }
const context = () => agentContextForSession(agent, timeline, 'Original work', workspace, null)
function panel() { return document.querySelector<HTMLElement>('.agent-information-reader')! }
function reading() { return panel().querySelector<HTMLElement>('.agent-information-reader__reading')! }
function card() { return dom.container.querySelector<HTMLButtonElement>('.focus-context')! }
async function mount(active = true) {
  await dom.render(<WorkbenchPresentationContext.Provider value={{ active, retainedRegionId: null }}><WorkspaceAgentRow context={context()} selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} /></WorkbenchPresentationContext.Provider>)
}
async function open() { await mount(); await act(async () => card().focus()); expect(panel()).not.toBeNull() }
async function info() { await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!.click()) }
async function escape() { await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))) }

beforeEach(async () => {
  useAppStore.setState({ sessions: [agent, other], timelines: { [agent.id]: timeline }, agentNames: {}, demands: {}, mainSurface: 'agents' })
  onOpen.mockClear()
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'original-source' }, dispose() {} }))
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'original-source' }, nextCursor: null, items: [] }))
  vi.spyOn(api.sessions, 'dispatches').mockResolvedValue({ hostId: 'local', participantSessionId: agent.id, nextSourceMessageId: null, dispatches: [] })
  await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'original-source' }))
})

it('puts the complete original reply before intentional metadata without closed-card demand', async () => {
  await mount(); expect(api.sessions.historyPage).not.toHaveBeenCalled(); expect(api.sessions.dispatches).not.toHaveBeenCalled()
  await act(async () => card().focus())
  expect(panel()).not.toBeNull()
  expect(reading().textContent).toContain('COMPLETE ORIGINAL TAIL')
  expect(panel().querySelector('.agent-information-details')).toBeNull()
  expect(panel().querySelector('details')).toBeNull()
  expect(panel().querySelector('.agent-information-reader__facts')?.getAttribute('aria-label')).toContain('message relationships')
  expect(api.sessions.dispatches).not.toHaveBeenCalled(); expect(onOpen).not.toHaveBeenCalled()
})

it('retains the same text nodes, selection and scroll across explicit metadata and layered Escape', async () => {
  await open()
  const original = reading(), prose = original.querySelector('.focus-context-hover__recap p')!
  const range = document.createRange(); range.selectNodeContents(prose)
  window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
  const selected = window.getSelection()!.toString(); original.scrollTop = 87
  await info()
  expect(reading()).toBe(original); expect(original.scrollTop).toBe(87); expect(original.querySelector('p')).toBe(prose)
  expect(window.getSelection()!.toString()).toBe(selected)
  expect(panel().querySelector('.agent-information-details__tabs')).not.toBeNull(); expect(api.sessions.dispatches).not.toHaveBeenCalled()
  await escape()
  expect(panel().querySelector('.agent-information-reader__metadata')).toBeNull(); expect(document.activeElement).toBe(original)
  expect(original.scrollTop).toBe(87); expect(window.getSelection()!.toString()).toBe(selected)
  await escape()
  expect(panel()).toBeNull(); expect(document.activeElement).toBe(card())
  await act(async () => Promise.resolve()); expect(panel()).toBeNull()
})

it('enters the original reader from ArrowDown without navigating or replacing the original action', async () => {
  await open()
  await act(async () => card().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })))
  expect(document.activeElement).toBe(reading()); expect(onOpen).not.toHaveBeenCalled()
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__open')!.click())
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(agent.id); expect(panel()).toBeNull()
})

it('keeps the original main action usable while its presentation is inactive', async () => {
  await mount(false); await act(async () => card().click())
  expect(onOpen).toHaveBeenCalledExactlyOnceWith(agent.id); expect(panel()).toBeNull(); expect(api.sessions.historyPage).not.toHaveBeenCalled()
})

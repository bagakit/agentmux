// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { DemandRecord } from '../src/renderer/src/lib/global-demand-board'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { api } from '../src/renderer/src/lib/api'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))

const dom = composerDOM({ agentInformation: true }), agent = composerSession('bookmark-copy-agent'), onOpen = vi.fn()
const title = 'Original Agent title', reply = 'Original **reply**.\n\nComplete second paragraph stays in the copied source.'
const timeline: AgentTimelineSnapshot = { agentSessionId: agent.id, revision: 1, items: [{ id: 'original-reply', agentSessionId: agent.id,
  kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content: reply,
  createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }] }
const usage = { scope: 'response' as const, inputTokens: 1400, outputTokens: 100, totalTokens: 1500, observedAt: fixtureEpoch(0, 0, 1),
  context: { usedTokens: 8000, capacityTokens: 32000 }, cumulative: { scope: 'native-session' as const, inputTokens: 500000, outputTokens: 40000, totalTokens: 540000 } }
const panels = () => [...document.querySelectorAll<HTMLElement>('.agent-information-reader')]
const panel = () => panels()[0]!
const copyButton = (label: string) => panel().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const summary = () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__facts')!

async function open(subject: Extract<SessionSnapshot, { kind: 'agent' }> = agent) {
  const state = useAppStore.getState()
  await dom.render(<WorkspaceAgentRow context={agentContextForSession(subject, state.timelines[subject.id], state.agentNames[subject.id], composerConfig.workspaces[0]!, null)}
    selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} />)
  await act(async () => dom.container.querySelector<HTMLElement>('.focus-context')!.focus())
  await waitForAgentCardReading(() => expect(panel()?.querySelector('[data-hover-input-id]')).not.toBeNull())
  return panel()
}
async function pin() {
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
  expect(agentBookmarks.get().bookmarks).toHaveLength(1)
}
async function copy(label: string) {
  const button = copyButton(label)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  return button!
}
function selectReply() {
  const prose = panel().querySelector<HTMLElement>('.focus-context-hover__recap p')!
  expect(prose).not.toBeNull()
  const range = document.createRange(); range.selectNodeContents(prose)
  document.getSelection()!.removeAllRanges(); document.getSelection()!.addRange(range)
  return { prose, selected: document.getSelection()!.toString() }
}
function goal(id: string, confirmed: boolean): DemandRecord {
  return { id, title: 'Goal ' + id, description: '', status: 'in_progress', priority: 'normal', projectId: null, projectName: null,
    sessionIds: confirmed ? [] : [agent.control.agentSessionId], source: 'default-topic', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1),
    ...(confirmed ? { participations: [0, 1].map(index => ({ id: `${id}-participation-${index}`, operationId: `${id}-operation-${index}`,
      hostId: agent.control.hostId, agentSessionId: agent.control.agentSessionId, kind: 'discussion' as const, entryPoint: 'original-entry', recordedAt: fixtureEpoch(0, 0, 1) })) } : {}) }
}

beforeEach(async () => {
  onOpen.mockClear()
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  useAppStore.setState({ sessions: [agent], timelines: { [agent.id]: timeline }, agentNames: { [agent.id]: title }, demands: {},
    error: null, lastError: null, errorDismissed: false, errorNoticeContext: null, notificationEvents: [] })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'bookmark-copy-' + control.agentSessionId }, nextCursor: null,
    items: [{ id: 'original-input', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original user task' }] }] }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
    source: { providerId: 'codex', nativeSessionId: 'bookmark-copy-' + control.agentSessionId }, dispose() {} }))
  vi.spyOn(api.sessions, 'dispatches').mockResolvedValue({ hostId: agent.control.hostId, participantSessionId: agent.control.agentSessionId, dispatches: [], nextSourceMessageId: null })
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  await agentCardConversationFixture(control => ({ providerId: 'codex', nativeSessionId: 'bookmark-copy-' + control.agentSessionId }))
})
afterEach(async () => {
  await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() })
})

it('copies the exact pinned title, held Markdown reply and canonical Agent link through the original clipboard port', async () => {
  const original = await open()
  expect(copyButton('Copy Agent title')).toBeNull(); expect(copyButton('Copy current reply')).toBeNull()
  await pin()
  const reads = vi.mocked(api.sessions.historyPage).mock.calls.length
  for (const label of ['Copy Agent title', 'Copy current reply', 'Copy Agent link']) expect((await copy(label)).dataset.copyState).toBe('copied')
  expect(vi.mocked(api.ui.writeClipboardText).mock.calls.map(call => call[0])).toEqual([title, reply, 'amux://agent/bookmark-copy-agent'])
  expect(panel()).toBe(original)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
  expect(api.sessions.dispatches).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()
})

it('copies the protected earlier reply after a replacement Run rather than the new reply or its activity', async () => {
  const original = await open(), { prose, selected } = selectReply()
  await pin()
  const replacement = { ...agent, control: { ...agent.control, run: { runId: 'replacement-copy-run' } } }
  await act(async () => useAppStore.setState({ sessions: [replacement], timelines: { [agent.id]: { ...timeline, revision: 2,
    items: [{ ...timeline.items[0]!, id: 'new-reply', content: 'NEW RUN REPLY MUST NOT BE COPIED', updatedAt: fixtureEpoch(0, 0, 2) }] } } }))
  expect(panel().textContent).toContain('earlier Run or source')
  expect(panel().querySelector('.focus-context-hover__recap p')).toBe(prose)
  await copy('Copy current reply')
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(reply)
  expect(document.getSelection()!.toString()).toBe(selected)
  expect(panel()).toBe(original)
  expect(onOpen).not.toHaveBeenCalled()
})

it.each(['activity only', 'user prompt only'] as const)('does not label or copy %s as an Agent reply', async source => {
  const items: AgentTimelineSnapshot['items'] = source === 'user prompt only' ? [{ ...timeline.items[0]!, id: 'prompt-only', kind: 'user_message', source: 'user', content: 'Original user prompt is not a reply' }]
    : [{ ...timeline.items[0]!, id: 'activity-only', kind: 'tool_call', title: 'Inspecting original source', content: 'Current activity summary is not a reply' }]
  useAppStore.setState({ timelines: { [agent.id]: { ...timeline, items } } })
  await open(); await pin()
  expect(copyButton('Copy current reply')).toBeNull()
  expect(copyButton('Copy reply excerpt')).toBeNull()
  expect(copyButton('Copy Agent title')).not.toBeNull()
  expect(copyButton('Copy Agent link')).not.toBeNull()
  expect(api.ui.writeClipboardText).not.toHaveBeenCalled()
})

it('labels a restored bounded snapshot as an excerpt and copies only that original saved excerpt', async () => {
  const longReply = 'Original saved reply paragraph. '.repeat(180)
  useAppStore.setState({ timelines: { [agent.id]: { ...timeline, items: [{ ...timeline.items[0]!, content: longReply }] } } })
  await open(); await pin()
  const saved = agentBookmarks.get().bookmarks[0]!
  expect(saved.excerpt).toHaveLength(4096)
  await dom.render(null)
  await act(async () => {
    agentInformationPreview.detach()
    useAppStore.setState({ sessions: [], timelines: {} })
    agentInformationPreview.restore([saved], document)
  })
  expect(copyButton('Copy current reply')).toBeNull()
  expect(copyButton('Copy reply excerpt')).toBeNull()
  const button = await copy('Copy saved excerpt')
  expect(panel().querySelector('.focus-context-hover__recap small')?.textContent).toContain('Saved excerpt')
  expect(button.dataset.copyState).toBe('copied')
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(saved.excerpt)
  expect(vi.mocked(api.ui.writeClipboardText).mock.calls[0]![0]).not.toBe(longReply)
})

it.each(['same canonical SID', 'different canonical SID'] as const)('copies the exact canonical alias and retains local facts beside another Host with %s', async collision => {
  const local = { ...agent, id: 'copy-presentation-alias', label: 'Local original title' }
  const foreign = { ...local, hostId: 'other-host', label: 'FOREIGN TITLE', control: { ...local.control, hostId: 'other-host',
    agentSessionId: collision === 'same canonical SID' ? local.control.agentSessionId : 'foreign-canonical-session', run: { runId: 'foreign-copy-run' } }, turnUsage: usage }
  const ownTimeline = { ...timeline, agentSessionId: local.id, items: timeline.items.map(item => ({ ...item, agentSessionId: local.id })) }
  useAppStore.setState({ sessions: [foreign, local], agentNames: {}, timelines: { [local.id]: ownTimeline } })
  await open(local); await pin()
  expect(agentBookmarks.get().bookmarks[0]).toMatchObject({ hostId: 'local', agentSessionId: agent.control.agentSessionId, presentationId: local.id })
  await copy('Copy Agent link'); await copy('Copy Agent title')
  expect(vi.mocked(api.ui.writeClipboardText).mock.calls.map(call => call[0])).toEqual(['amux://agent/bookmark-copy-agent', 'Local original title'])
  expect(summary().querySelector('[aria-label="Cumulative tokens not reported"]')).not.toBeNull()
  expect(summary().textContent).not.toContain('540k')
  expect(onOpen).not.toHaveBeenCalled()
})

it('reports the actual clipboard failure without success feedback and allows a real retry', async () => {
  const original = await open(); await pin()
  const failure = new Error('Clipboard permission denied'), report = vi.spyOn(useAppStore.getState(), 'reportError')
  vi.mocked(api.ui.writeClipboardText).mockRejectedValueOnce(failure)
  const button = await copy('Copy current reply')
  expect(button.dataset.copyState).toBe('failed')
  expect(button.textContent).toContain('Retry copy'); expect(button.textContent).not.toContain('Copied')
  expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  expect(useAppStore.getState().lastError).toContain('Clipboard permission denied')
  await copy('Copy current reply')
  expect(button.dataset.copyState).toBe('copied')
  expect(api.ui.writeClipboardText).toHaveBeenCalledTimes(2)
  expect(panel()).toBe(original)
  expect(useAppStore.getState().sessions).toEqual([agent])
  expect(onOpen).not.toHaveBeenCalled()
})

it('keeps copy pointer gestures out of header dragging and retains the reading DOM, Range and read demand', async () => {
  const original = await open(); await pin()
  const { prose, selected } = selectReply(), promote = vi.spyOn(agentInformationPreview, 'ensurePinned')
  const header = original.querySelector<HTMLElement>('.agent-information-reader__header')!, capture = vi.fn()
  Object.defineProperty(header, 'setPointerCapture', { configurable: true, value: capture })
  const button = copyButton('Copy Agent title')!, saved = agentBookmarks.get().bookmarks[0]!
  const historyReads = vi.mocked(api.sessions.historyPage).mock.calls.length
  const conversationReads = vi.mocked(api.conversation.readAgentConversation).mock.calls.length
  const down = new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, isPrimary: true, pointerId: 7, clientX: 100, clientY: 100 })
  await act(async () => {
    button.dispatchEvent(down)
    button.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, button: 0, isPrimary: true, pointerId: 7, clientX: 150, clientY: 130 }))
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, isPrimary: true, pointerId: 7, clientX: 150, clientY: 130 }))
    button.click()
  })
  expect(down.defaultPrevented).toBe(true)
  expect(capture).not.toHaveBeenCalled(); expect(promote).not.toHaveBeenCalled()
  expect(agentBookmarks.get().bookmarks).toEqual([saved])
  expect(panel()).toBe(original); expect(original.querySelector('.focus-context-hover__recap p')).toBe(prose)
  expect(document.getSelection()!.toString()).toBe(selected)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(title)
  expect(api.sessions.historyPage).toHaveBeenCalledTimes(historyReads)
  expect(api.conversation.readAgentConversation).toHaveBeenCalledTimes(conversationReads)
  expect(api.sessions.dispatches).not.toHaveBeenCalled()
  expect(onOpen).not.toHaveBeenCalled()
})

it('shows explicit unknown metrics instead of manufacturing zero or counting unconfirmed Goal candidates', async () => {
  const candidate = goal('possible-goal', false)
  useAppStore.setState({ demands: { [candidate.id]: candidate } })
  await open(); await pin()
  expect(summary().querySelector('[aria-label="Context remaining not reported"]')?.textContent).toBe('—')
  expect(summary().querySelector('[aria-label="Cumulative tokens not reported"]')?.textContent).toBe('—')
  expect(summary().querySelector('[data-semantic-icon="object.context"]')).not.toBeNull()
  expect(summary().querySelector('[data-semantic-icon="object.performance"]')).not.toBeNull()
  expect(summary().querySelector('[data-semantic-icon="object.goal"]')).toBeNull()
  expect(summary().textContent).not.toContain('0%')
  const descriptionId = summary().getAttribute('aria-describedby')
  expect(descriptionId).toBeTruthy()
  expect(document.getElementById(descriptionId!)?.textContent).toContain('Context remaining not reported · Cumulative tokens not reported')
  expect(api.sessions.dispatches).not.toHaveBeenCalled()
})

it('shows native cumulative tokens, actual context remaining and unique confirmed Goals rather than response totals or candidate counts', async () => {
  const subject = { ...agent, turnUsage: usage }, confirmed = goal('confirmed-goal', true), candidate = goal('possible-goal', false)
  useAppStore.setState({ sessions: [subject], demands: { [confirmed.id]: confirmed, [candidate.id]: candidate } })
  await open(subject); await pin()
  expect(summary().querySelector('[aria-label="75% context remaining"]')?.textContent).toBe('75%')
  expect(summary().querySelector('[aria-label="540k native Session tokens"]')?.textContent).toBe('540k')
  expect(summary().querySelector('[aria-label="1 confirmed Goals"]')?.textContent).toBe('1')
  expect(summary().querySelector('[data-semantic-icon="object.goal"]')).not.toBeNull()
  expect(summary().textContent).not.toContain('1.5k')
  const descriptionId = summary().getAttribute('aria-describedby')
  expect(descriptionId).toBeTruthy()
  expect(document.getElementById(descriptionId!)?.textContent).toContain('75% context remaining · 540k native Session tokens')
  expect(api.sessions.dispatches).not.toHaveBeenCalled()
})

it('distinguishes a reported zero total and full context capacity from missing metrics', async () => {
  const subject = { ...agent, turnUsage: { ...usage, totalTokens: 0, inputTokens: 0, outputTokens: 0,
    context: { usedTokens: 0, capacityTokens: 32000 }, cumulative: { scope: 'native-session' as const, inputTokens: 0, outputTokens: 0, totalTokens: 0 } } }
  useAppStore.setState({ sessions: [subject] })
  await open(subject); await pin()
  expect(summary().querySelector('[aria-label="100% context remaining"]')?.textContent).toBe('100%')
  expect(summary().querySelector('[aria-label="0 native Session tokens"]')?.textContent).toBe('0')
  expect(summary().querySelector('[aria-label="Cumulative tokens not reported"]')).toBeNull()
})

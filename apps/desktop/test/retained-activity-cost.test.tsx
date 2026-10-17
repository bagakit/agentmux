// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionHistoryPage } from '@agentmux/core'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import type { ConversationReading } from '../src/renderer/src/lib/session-conversation-window'
import { WorkbenchPresentationContext } from '../src/renderer/src/lib/workbench-presentation'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'


// The config counts entry into the original function bodies; neither ActivityView,
// its reading hook nor ConversationRecordSequence is replaced by a fixture.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-native-terminal /> }))
vi.mock('../src/renderer/src/components/AgentSessionComposer', () => ({ AgentSessionComposer: () => <div data-original-composer /> }))
vi.mock('../src/renderer/src/components/AgentRegionHeader', () => ({ AgentRegionHeader: ({ onHistory }: { onHistory?: () => void }) =>
  <header data-original-header>{onHistory ? <button type="button" onClick={onHistory}>Header history</button> : null}</header> }))
vi.mock('../src/renderer/src/components/SessionResultReview', () => ({ SessionResultReview: () => null }))
vi.mock('../src/renderer/src/components/AgentLifecycleFeedback', () => ({ AgentLifecycleFeedback: () => null }))
vi.mock('@agentmux/client-ui/components/AgentInteractionCard', () => ({ AgentInteractionCard: () => null }))
vi.mock('../src/renderer/src/components/OpenDestinationBar', () => ({ OpenDestinationPopover: () => null }))

const dom = composerDOM(), session = composerSession('retained-owner')
const body = 'Original retained reading body'
const counts = { activity: 0, sequence: 0 }
let latest: { conversationReading?: ConversationReading; activitySemantic?: string }
let runtimeControls: ReturnType<typeof vi.spyOn>[]
let reading: Awaited<ReturnType<typeof agentCardConversationFixture>>
function page(): AgentSessionHistoryPage {
  return { agentSessionId: session.id, source: { providerId: 'codex', nativeSessionId: 'original-source' }, nextCursor: null,
    items: [{ id: 'original-record', kind: 'user-message', contentParts: [{ kind: 'text', text: body }] }] }
}
async function flush() {
  await waitForAgentCardReading(() => expect(dom.container.querySelector('.activity-feed')?.textContent).toContain(body))
}
const pane = (visible: boolean, regionId = 'region') => <SessionPane sessionId={session.id} surfaceKind="agent" interactiveResize={false} visible={visible}
  linkOrigin={{ workspaceId: 'workspace', tabGroupId: 'group', tabId: 'tab', regionId }} />
const stage = (visible: boolean, semantic: 'active' | 'unknown' = 'active', nativePage = page(), regionId = 'region') => <SessionActivityPresentation
  target={{ hostId: 'original-secondary', active: true, visible, reference: { displayWorkspaceId: 'workspace', groupId: 'group', tabId: 'tab', regionId } }}
  regionId={regionId} sourceKey="original-source" sessionId={session.id} name="Original Agent" executorLabel="Codex"
  executionHost={{ configured: true, id: 'local', cwd: session.workspacePath, label: 'Original host', kind: 'local' }}
  activity={{ sessionId: session.id, items: [], nativeHistoryPage: nativePage, capability: 'complete-events', activitySemantic: semantic,
    conversationReading: { reference: session.control, identity: session.control.run.runId, enabled: visible } }}
  eligible readOnly={false} resourceOrigin={{ workspaceId: 'workspace', tabId: 'tab', regionId: 'region' }} renderFrame={content => content} selectRegion={() => {}} />

beforeEach(async () => {
  counts.activity = 0; counts.sequence = 0; latest = {}
  vi.stubGlobal('__retainedActivityProbe', {
    activity: (props: typeof latest & { sessionId: string }) => { if (props.sessionId === session.id) { counts.activity++; latest = props } },
    sequence: () => { counts.sequence++ }
  })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async () => page())
  vi.spyOn(api.sessions, 'observeHistory').mockResolvedValue({ source: page().source, dispose() {} })
  useAppStore.setState({ sessions: [session], viewModes: { [session.id]: 'activity' }, pendingAgentLaunches: {}, recoveryCandidates: [], runtimeOwnershipWarnings: [],
    timelines: { [session.id]: { agentSessionId: session.id, revision: 1, items: [] } }, agentComposerDrafts: { [session.id]: 'Original unsent draft' } })
  reading = await agentCardConversationFixture(() => page().source)
  const kernel = Reflect.get(reading.clientFor('local'), 'kernel')
  runtimeControls = ['connect', 'start', 'input', 'resize', 'stop', 'attach', 'status'].map(name =>
    vi.spyOn(kernel, name).mockImplementation(() => { throw Error('Retained reading cannot control Runtime: ' + name) }))
})
afterEach(() => {
  expect(runtimeControls.map(control => control.mock.calls.length)).toEqual([0, 0, 0, 0, 0, 0, 0])
  window.getSelection()?.removeAllRanges()
})
afterAll(() => vi.unstubAllGlobals())

for (const [name, render] of [['primary', pane], ['secondary', stage]] as const) {
  it(`${name} retained tree avoids unrelated parent and Session updates while preserving its original reading surface`, async () => {
    await dom.render(render(true)); await flush()
    const feed = dom.container.querySelector<HTMLElement>('.activity-feed')!
    expect(feed).not.toBeNull(); expect(feed.textContent).toContain(body)
    expect(counts.activity).toBeGreaterThan(0); expect(counts.sequence).toBeGreaterThan(0)
    const walker = document.createTreeWalker(feed, NodeFilter.SHOW_TEXT)
    let text: Node | null = null
    while (walker.nextNode()) if (walker.currentNode.textContent?.includes(body)) { text = walker.currentNode; break }
    expect(text).not.toBeNull()
    const range = document.createRange(); range.setStart(text!, 0); range.setEnd(text!, 8)
    window.getSelection()!.addRange(range); feed.scrollTop = 37
    await dom.render(render(false)); await flush()
    expect(latest.conversationReading?.enabled).toBe(false)
    const before = { ...counts }, reads = vi.mocked(api.sessions.historyPage).mock.calls.length
    for (let i = 0; i < 8; i++) {
      await act(async () => useAppStore.setState({ sessions: [session, { ...composerSession('unrelated'), updatedAt: i + 2 }] }))
      await dom.render(render(false)); await flush()
    }
    expect({ activity: counts.activity - before.activity, sequence: counts.sequence - before.sequence }).toEqual({ activity: 0, sequence: 0 })
    expect(api.sessions.historyPage).toHaveBeenCalledTimes(reads)
    expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(text!.isConnected).toBe(true)
    expect(window.getSelection()!.toString()).toBe('Original'); expect(feed.scrollTop).toBe(37)
    expect(dom.draft(session.id)).toBe('Original unsent draft')
    expect(useAppStore.getState().sessions[0]!.control).toBe(session.control)
    await dom.render(render(true)); await flush()
    expect(latest.conversationReading?.enabled).toBe(true); expect(counts.activity).toBeGreaterThan(before.activity)
    expect(dom.container.querySelector('.activity-feed')).toBe(feed)
    expect(window.getSelection()!.toString()).toBe('Original'); expect(dom.draft(session.id)).toBe('Original unsent draft')
  })
}

it('the primary hidden retained tree receives a real native source replacement', async () => {
  const original = { ...session, nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'source-a', transcriptPath: fixturePath('source-a') } }
  useAppStore.setState({ sessions: [original] })
  await dom.render(pane(true)); await flush(); await dom.render(pane(false)); await flush()
  const previous = latest.conversationReading?.nativeSourceFacts
  const replacement = { ...original, nativeHandle: { ...original.nativeHandle, sessionId: 'source-b' } }
  await act(async () => useAppStore.setState({ sessions: [replacement] })); await flush()
  expect(latest.conversationReading?.nativeSourceFacts).not.toBe(previous)
  expect(latest.conversationReading?.nativeSourceFacts?.nativeHandle).toBe(replacement.nativeHandle)
  expect(latest.conversationReading?.enabled).toBe(false)
  expect(dom.container.textContent).toContain(body); expect(dom.draft(session.id)).toBe('Original unsent draft')
})

it('the secondary hidden retained tree still receives current semantic changes', async () => {
  await dom.render(stage(true)); await flush(); await dom.render(stage(false)); await flush()
  const before = counts.activity
  await dom.render(stage(false, 'unknown')); await flush()
  expect(counts.activity).toBeGreaterThan(before); expect(latest.activitySemantic).toBe('unknown')
  expect(latest.conversationReading?.enabled).toBe(false); expect(dom.container.textContent).toContain(body)
})

for (const [name, render] of [
  ['primary', (visible: boolean, regionId: string) => pane(visible, regionId)],
  ['secondary', (visible: boolean, regionId: string) => stage(visible, 'active', page(), regionId)]
] as const) {
  it(`${name} hidden retained tree receives current consumer placement without replacing its reading body`, async () => {
    await dom.render(render(true, 'region')); await flush()
    const feed = dom.container.querySelector('.activity-feed')
    await dom.render(render(false, 'region')); await flush()
    expect(latest.conversationReading?.consumer?.regionId).toBe('region')
    const before = counts.activity
    await dom.render(render(false, 'moved-region')); await flush()
    expect(counts.activity).toBeGreaterThan(before)
    expect(latest.conversationReading?.consumer?.regionId).toBe('moved-region')
    expect(latest.conversationReading?.enabled).toBe(false)
    expect(dom.container.querySelector('.activity-feed')).toBe(feed)
    expect(dom.draft(session.id)).toBe('Original unsent draft')
  })
}

it('the primary retained tree catches up related captured records when revealed', async () => {
  await dom.render(pane(true)); await flush(); await dom.render(pane(false)); await flush()
  const feed = dom.container.querySelector('.activity-feed')
  await act(async () => useAppStore.setState({ timelines: { [session.id]: { agentSessionId: session.id, revision: 2,
    items: [{ id: 'related-input', agentSessionId: session.id, kind: 'user_message', source: 'user', status: 'complete',
      title: 'Input', content: 'New related captured input', createdAt: _historyFixtureEpoch(0, 0, 1), updatedAt: _historyFixtureEpoch(0, 0, 1) }] } } }))
  await flush(); expect(feed!.textContent).not.toContain('New related captured input')
  await dom.render(pane(true)); await flush()
  await waitForAgentCardReading(() => expect(feed!.textContent).toContain('New related captured input'))
  expect(dom.container.querySelector('.activity-feed')).toBe(feed)
  expect(feed!.textContent).toContain('New related captured input'); expect(dom.draft(session.id)).toBe('Original unsent draft')
})

it('the secondary retained tree catches up related native records when revealed', async () => {
  await dom.render(stage(true)); await flush(); await dom.render(stage(false)); await flush()
  const feed = dom.container.querySelector('.activity-feed')
  const next = page()
  next.items = [...next.items, { id: 'related-reply', kind: 'assistant-message', contentParts: [{ kind: 'text', text: 'New related native reply' }] }]
  vi.mocked(api.sessions.historyPage).mockResolvedValue(next)
  vi.mocked(reading.clientFor('local').readSessionHistoryChanges).mockImplementation(async (_id, input) => ({
    hostId: 'local', agentSessionId: session.id, source: next.source,
    items: input.checkpoint.cursor === 'original-card-source-cut' ? [next.items.at(-1)!] : [],
    checkpoint: { agentSessionId: session.id, source: next.source, cursor: 'retained-native-next-cut' }, more: false
  }))
  await dom.render(stage(false, 'active', next)); await flush()
  expect(feed!.textContent).not.toContain('New related native reply')
  await dom.render(stage(true, 'active', next)); await flush()
  await waitForAgentCardReading(() => expect(feed!.textContent).toContain('New related native reply'))
  expect(dom.container.querySelector('.activity-feed')).toBe(feed)
  expect(feed!.textContent).toContain('New related native reply'); expect(dom.draft(session.id)).toBe('Original unsent draft')
})

it('Return consumes the current presentation callback after its original History was retained', async () => {
  const oldSelection = vi.fn(), currentSelection = vi.fn()
  const presentation = (visible: boolean, onSelectRegion: (regionId: string) => void) => <WorkbenchPresentationContext.Provider
    value={{ active: true, retainedRegionId: null, surface: 'focus', onSelectRegion }}>{pane(visible)}</WorkbenchPresentationContext.Provider>
  await dom.render(presentation(true, oldSelection)); await flush()
  const feed = dom.container.querySelector('.activity-feed')
  await dom.click('[data-original-header] button'); await flush()
  expect(latest.conversationReading?.opened).toBe(true)
  await dom.render(presentation(false, oldSelection)); await flush()
  const previousClose = latest.conversationReading?.onClose
  await dom.render(presentation(false, currentSelection)); await flush()
  expect(latest.conversationReading?.enabled).toBe(false)
  expect(latest.conversationReading?.onClose).not.toBe(previousClose)
  await dom.render(presentation(true, currentSelection)); await flush()
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Return')!
  expect(button).toBeDefined(); await act(async () => button.click()); await flush()
  expect(oldSelection).not.toHaveBeenCalled(); expect(currentSelection).toHaveBeenCalledExactlyOnceWith('region')
  expect(dom.container.querySelector('.activity-feed')).toBe(feed); expect(dom.draft(session.id)).toBe('Original unsent draft')
})

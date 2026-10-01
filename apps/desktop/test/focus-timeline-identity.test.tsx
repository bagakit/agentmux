import { fixtureIso as _hygiene_fixtureIso, fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as UserMessages from '@agentmux/core/session-user-messages'
import * as SenderMetadata from '../src/renderer/src/lib/conversation-sender-details'
import { RecentFocusTimeline } from '../src/renderer/src/components/RecentFocusTimeline'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import type { AgentFocusHistoryEntry } from '../src/renderer/src/lib/agent-focus'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { moteConfig, moteTopics, scratchWorkspace, defaultAgent, customAgent, ordinaryAgent, executionAgent } from './fixtures/mote-workface'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import type { SpaceIconChoice, SpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import type { MoteConversationIdentity } from '../src/renderer/src/lib/mote-conversation-identity'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { ConversationSpeakerAvatar } from '../src/renderer/src/components/ConversationSpeakerAvatar'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_MOTE_FACE, type MoteAvatarImage } from '../src/shared/mote-avatars'

const moteIdentity = (target: SpaceIconTarget, icon: SpaceIconChoice): MoteConversationIdentity => ({ workspaceId: target.avatarTarget!.workspaceId, topicId: target.avatarTarget!.topicId, objectKey: target.key, name: 'Mote', icon })

const dom = composerDOM(), NOW = Date.parse(_hygiene_fixtureIso(23958000000, "second"))
const observed: AgentFocusHistoryEntry = { sessionId: 'agent-1', focusedAt: NOW - 60_000,
  identity: { name: 'Observed worker', kind: 'agent', providerId: 'codex', hostId: 'local',
    workspacePath: _hygiene_fixturePath("old-project"), project: { id: 'old-project', name: 'Observed project' }, branch: 'observed-branch' } }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW)
  vi.spyOn(api.sessions, 'historySources').mockResolvedValue([])
  vi.spyOn(api.sessions, 'timeline').mockResolvedValue({ agentSessionId: 'agent-1', revision: 1, items: [] })
  useAppStore.setState({ sessions: [composerSession(), composerSession('same-name')], timelines: {},
    agentNames: {}, tabs: {}, layouts: {}, scratchTopicSnapshots: {},
    agentFocus: { execution: { sessionId: null, history: [observed] }, pmo: { sessionId: null } } })
})
afterEach(() => vi.useRealTimers())
const row = (id = 'agent-1') => dom.container.querySelector<HTMLElement>(`[data-focus-timeline-id="${id}"]`)!
const label = (id = 'agent-1') => row(id).querySelector('.recent-focus__gutter > span')!.textContent
const click = async (node: HTMLElement) => act(async () => node.click())
const rename = async (id: string, name: string | null) => act(async () => useAppStore.getState().renameAgent(id, name))

const slice = process.env.AGENTMUX_FOCUS_IDENTITY_SLICE
if (!slice || slice === 'current-name') describe('current-name', () => {
  it('uses the current SID naming chain for rename and clear while keeping the retained observation intact', async () => {
    const timeline = { agentSessionId: 'agent-1', revision: 1, items: [{ id: 'original', agentSessionId: 'agent-1',
      kind: 'user_message' as const, source: 'user' as const, status: 'complete' as const,
      createdAt: NOW - 90_000, updatedAt: NOW - 90_000, title: 'Original prompt', content: 'Implement the current timeline' }] }
    useAppStore.setState({ timelines: { 'agent-1': timeline }, agentNames: { 'same-name': 'Later name' } })
    const entries = useAppStore.getState().agentFocus.execution.history
    await dom.render(<RecentFocusTimeline entries={entries} currentSessionId={null} contexts={[]} onSelect={vi.fn()} />)
    expect(label()).toBe('Implement the current timelineObserved as Observed worker')
    const before = row(), segment = before.querySelector<HTMLButtonElement>('.recent-focus__segment')!
    const originalTitle = segment.title
    await rename('agent-1', 'Later name')
    expect(row()).toBe(before); expect(label()).toBe('Later nameObserved as Observed worker')
    expect(segment.title).toBe(originalTitle)
    expect(segment.title).toContain('Observed worker · Observed project')
    expect(useAppStore.getState().agentFocus.execution.history).toBe(entries)
    expect(entries[0]).toBe(observed); expect(entries[0]!.identity?.name).toBe('Observed worker')
    await click(segment)
    const observation = document.querySelector<HTMLElement>('.recent-focus__observation')!
    expect(observation.textContent).toContain('Observed worker')
    expect(observation.textContent).toContain('Observed project')
    expect(observation.textContent).not.toContain('Later name')
    await click([...observation.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Close')!)
    await rename('agent-1', null)
    expect(label()).toBe('Implement the current timelineObserved as Observed worker')
    // A retained alias is still current display information when its Session is unavailable.
    await act(async () => useAppStore.setState({ sessions: [] }))
    await rename('agent-1', 'Archived alias')
    expect(label()).toBe('Archived aliasObserved as Observed worker')
    await rename('agent-1', null)
    expect(label()).toBe('Observed workerobserved-branch')
  })

  it('updates current return names without touching another SID, pinned body, selection or read costs', async () => {
    const timeline = { agentSessionId: 'agent-1', revision: 1, items: [{ id: 'message', agentSessionId: 'agent-1',
      kind: 'user_message' as const, source: 'user' as const, status: 'complete' as const, authorHuman: true,
      createdAt: NOW - 30_000, updatedAt: NOW - 30_000, title: 'Prompt', content: 'Keep this pinned reading' }] }
    useAppStore.setState({ timelines: { 'agent-1': timeline }, agentNames: { 'agent-1': 'Same name', 'same-name': 'Same name' } })
    const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
    const projector = vi.spyOn(UserMessages, 'projectSessionUserMessages')
    await dom.render(<RecentFocusTimeline entries={[observed]} currentSessionId={null} contexts={contexts} onSelect={vi.fn()} />)
    const current = [...dom.container.querySelectorAll<HTMLElement>('[data-focus-timeline-id="agent-1"]')].find(node => !node.dataset.historyOnly)!
    const other = row('same-name'), otherLabel = label('same-name')
    await click(current.querySelector<HTMLElement>('.recent-focus__message')!)
    const body = document.querySelector<HTMLElement>('.recent-focus__message-body')!
    const text = body.querySelector('.log-turn__text')!.firstChild!
    const selection = document.getSelection()!, range = document.createRange(); range.selectNodeContents(text)
    selection.removeAllRanges(); selection.addRange(range)
    const reads = [api.sessions.historySources, api.sessions.historyPage, api.sessions.timeline].map(fn => vi.isMockFunction(fn) ? fn.mock.calls.length : 0)
    const projects = projector.mock.calls.length
    await rename('agent-1', 'Current alias')
    expect(current.querySelector('.recent-focus__gutter > span')!.textContent).toBe('Current alias')
    expect(current.querySelector('.recent-focus__live')!.getAttribute('aria-label')).toContain('Return to Current alias')
    expect(other).toBe(row('same-name')); expect(label('same-name')).toBe(otherLabel)
    expect(document.querySelector('.recent-focus__message-body')).toBe(body)
    expect(selection.toString()).toBe('Keep this pinned reading')
    await rename('unrelated', 'Another alias')
    expect(document.querySelector('.recent-focus__message-body')).toBe(body)
    expect(selection.toString()).toBe('Keep this pinned reading')
    expect(projector.mock.calls.length).toBe(projects)
    expect([api.sessions.historySources, api.sessions.historyPage, api.sessions.timeline].map(fn => vi.isMockFunction(fn) ? fn.mock.calls.length : 0)).toEqual(reads)
    await rename('agent-1', null)
    expect(current.querySelector('.recent-focus__gutter > span')!.textContent).toBe('Keep this pinned reading')
  })
})

if (!slice || slice === 'mote-avatar') describe('mote-avatar', () => {
  const primary = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!), custom = topicSpaceIconTarget(scratchWorkspace, moteTopics[1]!)
  const primaryRef = { kind: 'image' as const, fileName: 'a'.repeat(64) + '.png' }, customRef = { kind: 'image' as const, fileName: 'b'.repeat(64) + '.png' }
  const item = (id: string, author?: string, human = false) => ({ id, agentSessionId: executionAgent.id,
    kind: 'user_message' as const, source: 'user' as const, status: 'complete' as const,
    ...(author ? { authorAgentSessionId: author } : {}), ...(human ? { authorHuman: true } : {}),
    createdAt: NOW - Number(id.slice(-1)) * 60_000, updatedAt: NOW - Number(id.slice(-1)) * 60_000,
    title: 'Input', content: id === 'unknown6' ? '[Message from Agent default-agent] I am Mote' : 'Keep the original sender record ' + id })
  const timeline = { agentSessionId: executionAgent.id, revision: 1,
    items: [item('primary1', defaultAgent.id), item('primary2', defaultAgent.id), item('custom3', customAgent.id),
      item('ordinary4', ordinaryAgent.id), item('human5', undefined, true), item('unknown6')] }
  const marker = (id: string) => dom.container.querySelector<HTMLElement>(`[data-message-raw-id="${id}"]`)!
  const mount = async () => {
    useAppStore.setState({ config: moteConfig, sessions: [defaultAgent, customAgent, ordinaryAgent, executionAgent],
      timelines: { [executionAgent.id]: timeline }, agentNames: { [defaultAgent.id]: 'Mote sender', [ordinaryAgent.id]: 'Mote sender' },
      scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics: moteTopics, reading: false, error: null } },
      spaceObjectIcons: { [primary.key]: primaryRef, [custom.key]: customRef },
      agentComposerDrafts: { [executionAgent.id]: 'Keep the original draft' },
      agentFocus: { execution: { sessionId: executionAgent.id, history: [] }, pmo: { sessionId: null } } })
    const contexts = createFocusProjectionSelector()(useAppStore.getState()).contexts
    await dom.render(<RecentFocusTimeline entries={[]} currentSessionId={executionAgent.id} contexts={contexts} onSelect={vi.fn()} />)
  }
  it('uses distinct original Mote assets across markers, preview and pinned body with one mounted read per object/content', async () => {
    const read = vi.spyOn(api.scratch, 'readMoteAvatar').mockImplementation(async (_workspace, topic) => ({ width: 256, height: 256, dataUrl: 'data:image/png;base64,' + topic }))
    await mount()
    expect(read).toHaveBeenCalledTimes(2)
    expect(marker('primary1').querySelector('[data-speaker-avatar="mote"] img')?.getAttribute('src')).not.toBe(marker('custom3').querySelector('[data-speaker-avatar="mote"] img')?.getAttribute('src'))
    expect(marker('primary2').querySelector('[data-speaker-avatar="mote"] img')?.getAttribute('src')).toBe(marker('primary1').querySelector('img')?.getAttribute('src'))
    expect(marker('ordinary4').querySelector('[data-speaker-avatar="mote"]')).toBeNull()
    expect(marker('unknown6').dataset.messageAuthor).toBe('unknown')
    expect(marker('unknown6').querySelector('[data-speaker-avatar="mote"]')).toBeNull()
    expect(marker('human5').querySelector('[data-speaker-avatar="mote"]')).toBeNull()
    expect(marker('primary1').dataset.messageAt).toBe(String(timeline.items[0]!.createdAt))
    await act(async () => marker('primary1').focus())
    expect(document.querySelector('.recent-focus__message-preview header [data-speaker-avatar="mote"]')).not.toBeNull()
    await click(marker('primary1'))
    const body = document.querySelector<HTMLElement>('.recent-focus__message-body')!
    expect(body.querySelector('[data-speaker-id="default-agent"][data-speaker-avatar="mote"] img')?.getAttribute('src')).toBe(marker('primary1').querySelector('img')?.getAttribute('src'))
    expect(read).toHaveBeenCalledTimes(2)
    const text = body.querySelector('.log-turn__text')!.firstChild!, selection = document.getSelection()!, range = document.createRange()
    range.selectNodeContents(text); selection.removeAllRanges(); selection.addRange(range)
    const projector = vi.spyOn(UserMessages, 'projectSessionUserMessages'), calls = projector.mock.calls.length
    await rename(defaultAgent.id, 'Renamed Mote')
    expect(marker('primary1').querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Renamed Mote')
    expect(body.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Renamed Mote')
    const metadata = vi.spyOn(SenderMetadata, 'currentConversationSpeakerMetadata')
    await rename('unrelated', 'Unrelated alias')
    await act(async () => useAppStore.setState({ sessions: useAppStore.getState().sessions.map(session => session.id === ordinaryAgent.id ? { ...session, latestOutputBytes: 999 } : session) }))
    expect(document.querySelector('.recent-focus__message-body')).toBe(body)
    expect(selection.toString()).toBe(timeline.items[0]!.content)
    expect(projector.mock.calls.length).toBe(calls); expect(read).toHaveBeenCalledTimes(2)
    expect(metadata).not.toHaveBeenCalled()
    expect(useAppStore.getState().timelines[executionAgent.id]).toBe(timeline)
    expect(useAppStore.getState().agentComposerDrafts[executionAgent.id]).toBe('Keep the original draft')
    await click(dom.container.querySelector<HTMLElement>('[aria-label="View input records"]')!)
    expect(document.querySelector('.recent-focus__input-list [data-speaker-id="default-agent"][data-speaker-avatar="mote"]')).not.toBeNull()
    expect(read).toHaveBeenCalledTimes(2)
    // Mounted promises are released rather than retained as a second image cache.
    await dom.render(<div />); await mount(); expect(read).toHaveBeenCalledTimes(4)
  })
  it('does not borrow identity across a stale Scratch scope, missing sender or late asset response', async () => {
    let resolvePrimary!: (value: MoteAvatarImage) => void
    const read = vi.spyOn(api.scratch, 'readMoteAvatar').mockImplementation(async (_workspace, topic) => topic === moteTopics[0]!.id
      ? await new Promise<MoteAvatarImage>(resolve => { resolvePrimary = resolve }) : { width: 256, height: 256, dataUrl: 'data:image/png;base64,CUSTOM' })
    await mount(); expect(read).toHaveBeenCalledTimes(2)
    await click(marker('primary1'))
    const body = document.querySelector('.recent-focus__message-body')
    await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: {
      scope: ("[\"remote\",\"" + _hygiene_fixturePath("topics") + "\"]"), revision: 2, topics: moteTopics, error: null, reading: false } } }))
    expect(marker('primary1').querySelector('[data-speaker-avatar="mote"]')).toBeNull()
    expect(marker('custom3').querySelector('[data-speaker-avatar="mote"]')).toBeNull()
    await act(async () => resolvePrimary({ width: 256, height: 256, dataUrl: 'data:image/png;base64,LATE' }))
    expect(body!.querySelector('img[src*="LATE"]')).toBeNull(); expect(document.querySelector('.recent-focus__message-body')).toBe(body)
    await act(async () => useAppStore.setState({ scratchTopicSnapshots: { [scratchWorkspace.id]: {
      scope: scratchTopicsScope(scratchWorkspace), revision: 3, topics: moteTopics, error: null, reading: false } },
      spaceObjectIcons: { [primary.key]: DEFAULT_MOTE_FACE, [custom.key]: 'brain' } }))
    expect(marker('primary1').querySelector('[data-space-icon-source="face"]')).not.toBeNull()
    expect(marker('custom3').querySelector('[data-space-icon="brain"]')).not.toBeNull()
    await act(async () => useAppStore.setState({ sessions: [customAgent, ordinaryAgent, executionAgent] }))
    expect(marker('primary1').querySelector('[data-speaker-avatar="mote"]')).toBeNull()
    expect(marker('primary1').dataset.messageAuthor).toBe('agent')
    expect(useAppStore.getState().timelines[executionAgent.id]).toBe(timeline)
  })
  it('keeps saved choice and current work on image failure and reports a shared read once', async () => {
    vi.spyOn(api.scratch, 'readMoteAvatar').mockRejectedValue(new Error('asset temporarily unavailable'))
    const report = vi.spyOn(useAppStore.getState(), 'reportError')
    await mount(); await click(marker('primary1'))
    expect(report).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().spaceObjectIcons[primary.key]).toBe(primaryRef)
    expect(marker('primary1').querySelector('[data-space-icon-source="image"]')?.getAttribute('title')).toContain('saved choice is retained')
    expect(useAppStore.getState().sessions.find(session => session.id === executionAgent.id)?.control?.run.runId).toBe(executionAgent.control!.run.runId)
    expect(useAppStore.getState().agentComposerDrafts[executionAgent.id]).toBe('Keep the original draft')
  })
  it('leaves human, unknown, system and ordinary Agent shapes intact when shared presentation is extended', () => {
    for (const role of ['human', 'unknown', 'system'] as const) {
      const html = renderToStaticMarkup(<ConversationSpeakerAvatar speaker={{ role, id: role }} name={role} mote={moteIdentity(primary, DEFAULT_MOTE_FACE)} />)
      expect(html).not.toContain('data-speaker-avatar="mote"'); expect(html).not.toContain('data-space-icon-source')
    }
    expect(renderToStaticMarkup(<ConversationSpeakerAvatar speaker={{ role: 'agent', id: 'ordinary' }} name="Ordinary" providerId="codex" />)).not.toContain('data-space-icon-source')
  })
  it('keeps concurrent content choices for the same original Mote object separate', async () => {
    const read = vi.spyOn(api.scratch, 'readMoteAvatar').mockImplementation(async (_workspace, _topic, ref) => ({
      width: 256, height: 256, dataUrl: 'data:image/png;base64,' + ref.fileName }))
    await dom.render(<div>
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: defaultAgent.id }} name="Saved Mote" mote={moteIdentity(primary, primaryRef)} />
      <ConversationSpeakerAvatar speaker={{ role: 'agent', id: defaultAgent.id }} name="New choice" mote={moteIdentity(primary, customRef)} />
    </div>)
    expect(read).toHaveBeenCalledTimes(2)
    const images = [...dom.container.querySelectorAll('img')].map(image => image.getAttribute('src'))
    expect(images[0]).toContain(primaryRef.fileName); expect(images[1]).toContain(customRef.fileName)
  })
})

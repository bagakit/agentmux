// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { agentCardConversationFixture, waitForAgentCardReading } from './helpers/agent-card-conversation-fixture'
import type { SessionSnapshot } from '../src/shared/contracts'
import type { FocusContextIdentity } from '../src/renderer/src/lib/focus-context-identity'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { WorkspaceAgentRow } from '../src/renderer/src/components/WorkspaceAgentRow'
import { scratchWorkspace, moteTopics } from './fixtures/mote-workface'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => createElement('span') }))
const dom = composerDOM({ agentInformation: true }), agent = composerSession('density-agent'), onOpen = vi.fn()
const config = { ...composerConfig, executors: { codex: { ...composerConfig.executors.codex!, label: 'Configured Executor', avatar: { badge: 'shield' as const, tint: '#cc8855' } } } }
const timeline = { agentSessionId: agent.id, revision: 1, items: [{ id: 'original-reply', agentSessionId: agent.id, kind: 'assistant_message' as const,
  source: 'native-hook' as const, status: 'complete' as const, title: 'Reply', content: 'Original task and complete reply tail.', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1) }] }
const identity: FocusContextIdentity = { occurrenceCount: 1, tabs: [{ tabId: 'original-tab', occurrenceKey: 'original-occurrence', title: 'Original workface', locationLabel: 'Project · Group 2', active: false, highlightedRegionIds: ['original-agent-region'], regions: [
  { regionId: 'original-agent-region', bounds: { x: 0, y: 0, width: 0.5, height: 1 }, surfaceKind: 'agent', executorLabel: 'Configured Executor', activity: 'Original activity' },
  { regionId: 'original-browser-region', bounds: { x: 0.5, y: 0, width: 0.5, height: 1 }, surfaceKind: 'browser', executorLabel: 'Browser', activity: 'Original browser' }
] }] }
const panel = () => document.querySelector<HTMLElement>('.agent-information-reader')!
async function open(subject = agent, position?: FocusContextIdentity) {
  const state = useAppStore.getState(), workspace = state.config?.workspaces.find(item => item.hostId === subject.hostId && item.path === subject.workspacePath)
  await dom.render(<WorkspaceAgentRow
    context={agentContextForSession(subject, timeline, 'Original Agent', workspace, null)} identity={position}
    selected={false} selecting={false} disabled={false} onToggle={() => {}} onOpen={onOpen} />)
  await act(async () => dom.container.querySelector<HTMLElement>('.focus-context[data-session-id]')!.focus())
  await waitForAgentCardReading(() => expect(panel()?.querySelector('[data-hover-input-id]')).not.toBeNull())
}
async function source() { await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__status')!.click()) }
beforeEach(async () => {
  for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key)
  onOpen.mockReset()
  useAppStore.setState({ config, sessions: [agent], timelines: { [agent.id]: timeline }, agentNames: {}, demands: {}, scratchTopicSnapshots: {}, spaceObjectIcons: {}, tabs: {}, layouts: {} })
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'density-native' }, nextCursor: null,
    items: [{ id: 'original-input', kind: 'user-message', contentParts: [{ kind: 'text', text: 'Original user task' }] }] }))
  vi.spyOn(api.sessions, 'observeHistory').mockImplementation(async control => ({ agentSessionId: control.agentSessionId, source: { providerId: 'codex', nativeSessionId: 'density-native' }, dispose() {} }))
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  await agentCardConversationFixture(() => ({ providerId: 'codex', nativeSessionId: 'density-native' }))
})
afterEach(async () => { await act(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() }) })

it('uses original Project and Executor artwork while Source retains exact Region layout and held reading', async () => {
  await open(agent, identity)
  const original = panel(), reading = original.querySelector('.agent-information-reader__reading')!, prose = reading.querySelector('p')!
  const avatar = original.querySelector('.agent-information-reader__identity')!
  expect(avatar.querySelector('[data-project-workspace-id]')?.getAttribute('data-project-workspace-id')).toBe('workspace')
  expect(avatar.querySelector('[data-executor-id]')?.getAttribute('data-executor-id')).toBe('codex')
  expect(avatar.querySelector('[data-avatar-badge="shield"]')).not.toBeNull()
  expect(avatar.querySelector('.status, button, [tabindex]')).toBeNull()
  expect(original.textContent).not.toContain('Observed at opening'); expect(original.textContent).not.toContain('End of this reading window')
  await source()
  expect(original.querySelectorAll('[data-region-id]')).toHaveLength(2)
  expect(original.querySelector('[data-region-id="original-agent-region"]')?.getAttribute('data-subject-region')).toBe('true')
  expect(original.textContent).toContain('Project · Group 2')
  expect(original.textContent).toContain('Earlier records remain in the Agent’s History')
  await act(async () => original.querySelector<HTMLButtonElement>('[aria-label="Back to original content"]')!.click())
  expect(panel()).toBe(original); expect(original.querySelector('.agent-information-reader__reading')).toBe(reading); expect(reading.querySelector('p')).toBe(prose)
  expect(onOpen).not.toHaveBeenCalled()
})
it('uses the confirmed Mote object and configured Executor through the same Reader', async () => {
  const topic = moteTopics[1]!, subject = { ...agent, workspacePath: topic.directoryPath }, moteConfig = { ...config, workspaces: [...config.workspaces, scratchWorkspace] }
  const target = topicSpaceIconTarget(scratchWorkspace, topic)!
  useAppStore.setState({ config: moteConfig, sessions: [subject], scratchTopicSnapshots: { [scratchWorkspace.id]: { scope: scratchTopicsScope(scratchWorkspace), revision: 1, topics: moteTopics, error: null, reading: false } }, spaceObjectIcons: { [target.key]: 'brain' } })
  await open(subject)
  const avatar = panel().querySelector('.agent-information-reader__identity')!
  expect(avatar.querySelector('[data-mote-author]')?.getAttribute('data-mote-author')).toBe(topic.id)
  expect(avatar.querySelector('[data-space-icon-kind="mote"]')).not.toBeNull()
  expect(avatar.querySelector('[data-avatar-badge="shield"]')).not.toBeNull()
  expect(avatar.querySelector('[data-project-workspace-id]')).toBeNull()
  await source(); expect(panel().textContent).toContain('Mote · ' + topic.title)
})
it('does not borrow affiliation from another Host with the same presentation SID', async () => {
  const remoteProject = { ...config.workspaces[0]!, id: 'remote-project', hostId: 'other-host', name: 'Other Host Project', path: fixturePath('remote-project') }
  const remote = { ...agent, hostId: 'other-host', workspacePath: remoteProject.path, control: { ...agent.control, hostId: 'other-host', run: { runId: 'remote-run' } } }
  useAppStore.setState({ sessions: [agent, remote], config: { ...config, workspaces: [remoteProject, ...config.workspaces] } })
  await open()
  expect(panel().querySelector('[data-project-workspace-id]')?.getAttribute('data-project-workspace-id')).toBe('workspace')
  await source(); expect(panel().textContent).not.toContain('Other Host Project')
  expect(onOpen).not.toHaveBeenCalled()
})
it('keeps the Executor when exact Project or Mote affiliation is unknown', async () => {
  const subject = { ...agent, workspacePath: fixturePath('not-registered') }
  useAppStore.setState({ sessions: [subject] }); await open(subject)
  const avatar = panel().querySelector('.agent-information-reader__identity')!
  expect(avatar.querySelector('[data-project-workspace-id], [data-mote-author]')).toBeNull()
  expect(avatar.querySelector('[data-executor-id]')?.getAttribute('data-executor-id')).toBe('codex')
  await source(); expect(panel().textContent).toContain('Project or Mote affiliation is not confirmed')
})
it('does not read replacement avatar assets while the pinned Reader document is hidden', async () => {
  await open()
  await act(async () => panel().querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
  const original = panel(), calls = vi.mocked(api.workspaces.appearance).mock.calls.length
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  try {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(original.hidden).toBe(true); expect(original.querySelector('.agent-information-reader__identity')?.childElementCount).toBe(0)
    await act(async () => useAppStore.setState({ config: { ...config, workspaces: config.workspaces.map(workspace => ({ ...workspace, name: 'Updated project label' })) } }))
    expect(api.workspaces.appearance).toHaveBeenCalledTimes(calls)
  } finally {
    if (descriptor) Object.defineProperty(document, 'visibilityState', descriptor); else Reflect.deleteProperty(document, 'visibilityState')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  }
})
it('keeps activity unknown legible without a routine banner and exposes its full original explanation', async () => {
  await open()
  const status = panel().querySelector('.agent-information-reader__status')!
  expect(status.textContent).toContain('Activity not confirmed')
  expect(status.querySelector('[data-focus-state-icon="unknown"]')).not.toBeNull()
  expect(panel().querySelector('.agent-information-reader__service')).toBeNull()
  await source(); expect(panel().textContent).toContain('Last confirmed activity unavailable'); expect(panel().textContent).toContain('Prompt readiness')
})
it.each([
  { state: 'error', processState: 'running', detail: 'Original Provider failure' },
  { state: 'disconnected', processState: 'running', detail: 'Original transport unavailable' },
  { state: 'disconnected', processState: 'interrupted', detail: 'Original interrupted Run' }
] as const)('retains real $state / $processState service facts', async item => {
  const subject = { ...agent, processState: item.processState, status: { state: item.state, source: 'run-process' as const, observedAt: Date.now(), detail: item.detail } } satisfies SessionSnapshot
  useAppStore.setState({ sessions: [subject] }); await open(subject)
  expect(panel().querySelector('.agent-information-reader__service')?.textContent).toContain(item.detail)
  expect(panel().querySelector('.agent-information-reader__status')?.textContent?.trim()).not.toBe('')
  await source(); expect(panel().textContent).toContain(item.detail)
})

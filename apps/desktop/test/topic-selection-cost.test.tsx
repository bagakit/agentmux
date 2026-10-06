import { win32 as _hygiene_win32 } from "node:path"
const { fixturePath: _hygiene_fixturePath } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { createWorkspaceLayout } from '@agentmux/layout'
import { TopicRowPresence } from '../src/renderer/src/components/TopicRowPresence'
import { topicTabRegionCells } from '../src/renderer/src/lib/scratch-topic-layout'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import * as activity from '../src/renderer/src/lib/session-recency'
import { topicSessionPaths } from '../src/renderer/src/lib/topic-session-subscriptions'
import { sessionPresentationById, sessionPresentationsAtPath } from '../src/renderer/src/lib/session-presentation'
import { beforeEach, expect, it, vi } from 'vitest'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { TopicNavigationPanel } from '../src/renderer/src/components/TopicNavigationPanel'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { originalTopicAddress } from '../src/shared/space-addresses'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'

const observed = vi.hoisted(() => ({ rows: 0, tabs: [] as { tabId: string; active: boolean }[] }))
vi.mock('../src/renderer/src/components/TopicPresence', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/components/TopicPresence')>('../src/renderer/src/components/TopicPresence')
  return { ...actual, TopicPresence: (props: Parameters<typeof actual.TopicPresence>[0]) => {
    observed.rows++; observed.tabs = (props.tabs ?? []).map(tab => ({ tabId: tab.tabId, active: tab.active })); return <actual.TopicPresence {...props} />
  } }
})
const dom = composerDOM()
const workspace = { ...composerConfig.workspaces[0]!, id: '__scratch__', path: _hygiene_fixturePath("private/scratch") }
const topics: ScratchTopicSnapshot[] = Array.from({ length: 16 }, (_, i) => ({ id: `view:${i}`, title: `Topic ${i}`,
  directoryPath: `topic--view--${i}`, topicPath: `topic--view--${i}/topic.md`, summary: 'Original knowledge',
  identityDirectoryPath: (_hygiene_fixturePath("private/topics/topic--view--") + (i) + ""), physicalDirectoryPath: (_hygiene_fixturePath("private/topics/topic--view--") + (i) + ""), collaborators: [] }))
const agents = topics.flatMap((topic, i) => Array.from({ length: 3 }, (_, j) => ({ ...composerSession(`topic-${i}-${j}`), workspacePath: topic.physicalDirectoryPath!, status: { state: 'working' as const, source: 'run-process' as const, observedAt: 1, detail: 'Original activity' } })))
const outside = Array.from({ length: 2000 }, (_, i) => ({ ...composerSession(`outside-${i}`), workspacePath: (_hygiene_fixturePath("other/") + (i) + "") }))
const tabs = Object.fromEntries(agents.map((session, i) => {
  const tab = { ...createWorkbenchTab(`tab-${i}`, { kind: 'agent', phase: 'attached', regionId: `region-${i}`,
    workspaceId: workspace.id, sessionId: session.id }), topicId: topics[Math.floor(i / 3)]!.id }
  return [tab.id, tab]
}))
const layout = createWorkspaceLayout('group', Object.keys(tabs))
const config = { ...composerConfig, workspaces: [workspace] }
beforeEach(() => {
  useAppStore.setState({ config, sessions: [...agents, ...outside], tabs, layouts: { [workspace.id]: layout }, timelines: {}, agentNames: {},
    scratchTopicOrder: [], pinnedItems: {}, spaceZoneBindings: Object.fromEntries(topics.map(topic => [originalTopicAddress(workspace, topic, {})!.zoneId,
      { spaceId: 'category', workspaceId: workspace.id, topicId: topic.id, contentKind: 'topic', relations: { category: true } }])),
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics, error: null, reading: false } },
    workbenchSpaceSelection: { spaceId: 'category', zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null } })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  vi.spyOn(api.spaceObjects, 'appearance').mockResolvedValue({ local: true, icon: null })
  observed.rows = 0
})
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }) }
it('keeps all nonempty original rows while unrelated Session, name and timeline updates do zero row work', async () => {
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={() => {}} />); await settle()
  expect(dom.container.querySelectorAll('.workspace-topic-entry')).toHaveLength(16)
  expect(observed.rows).toBeGreaterThanOrEqual(16)
  observed.rows = 0
  for (let i = 0; i < 40; i++) await act(async () => {
    const s = useAppStore.getState()
    useAppStore.setState({ sessions: [...agents, { ...outside[0]!, updatedAt: i + 2 }, ...outside.slice(1)],
      agentNames: { ...s.agentNames, [outside[0]!.id]: `outside ${i}` },
      timelines: { ...s.timelines, [outside[0]!.id]: { items: [], revision: i } as any } })
  })
  console.log('topic_unrelated_cost=' + JSON.stringify({ updates: 40, topics: 16, sessions: agents.length + outside.length, rowRenders: observed.rows }))
  expect(observed.rows).toBe(0)
  await act(async () => useAppStore.setState({ agentNames: { [agents[3]!.id]: 'Exact renamed Agent' } }))
  expect(observed.rows).toBe(1)
  expect(dom.container.querySelector('[aria-label*="Exact renamed Agent"]')).not.toBeNull()
})
it('selection-only changes do not recompute unchanged Topic presence', async () => {
  await dom.render(<WorkspaceTopicsPanel workspace={workspace} onRevealDirectory={() => {}} />); await settle()
  observed.rows = 0
  const summaries = vi.spyOn(activity, 'sessionRecentActivity')
  for (let i = 0; i < 16; i++) await act(async () => {
    const selection = useAppStore.getState().workbenchSpaceSelection!
    useAppStore.setState({ workbenchSpaceSelection: { ...selection, topicId: topics[i]!.id } })
  })
  console.log('topic_selection_cost=' + JSON.stringify({ switches: 16, rowRenders: observed.rows }))
  expect(observed.rows).toBe(0)
  expect(summaries).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-topic-id="view:15"][data-current="true"]')).not.toBeNull()
})
it('does not do hidden Knowledge reads when another Topic is selected', async () => {
  const calls = vi.spyOn(api.topics, 'call')
  await dom.render(<TopicNavigationPanel workspace={workspace} topic={topics[0]} selectedTopicId={topics[0]!.id} topics={topics}
    categorySpaceId="category" visible onRevealDirectory={() => {}} />); await settle()
  await dom.click('[aria-label="Show Knowledge"]'); await settle()
  expect(calls.mock.calls.some(([method]) => method === 'topic.inspect')).toBe(true)
  await dom.click('[aria-label="Show Topics"]'); await settle(); calls.mockClear()
  await dom.render(<TopicNavigationPanel workspace={workspace} topic={topics[1]} selectedTopicId={topics[1]!.id} topics={topics}
    categorySpaceId="category" visible onRevealDirectory={() => {}} />); await settle()
  expect(calls).not.toHaveBeenCalled()
})

it('indexes nonempty Session snapshots once across many Topic consumers and respects original host and alias ambiguity', () => {
  let scans = 0, idScans = 0
  const data = [...agents, ...outside]
  const sessions = new Proxy(data, { get(target, key, receiver) {
    if (key === 'map') idScans++
    if (key === Symbol.iterator) return function* () { scans++; yield* target }
    return Reflect.get(target, key, receiver)
  } })
  const resolved = topicSessionPaths(workspace, topics)
  for (let i = 0; i < 16; i++) for (const path of resolved.get(topics[i]!.id)!) {
    expect(sessionPresentationsAtPath(sessions, 'other-host', path)).toHaveLength(0)
    expect(sessionPresentationsAtPath(sessions, workspace.hostId, path)).toEqual(data.filter(session => session.hostId === workspace.hostId && session.workspacePath === path))
  }
  expect(sessionPresentationById(sessions).size).toBe(2048)
  expect(scans).toBe(1)
  expect(idScans).toBe(1)
  console.log('topic_index_cost=' + JSON.stringify({ consumers: 16, sessions: data.length, directoryPasses: scans, originalIdPasses: idScans }))
  const alias = _hygiene_fixturePath("private/retained-original-directory")
  const original = { ...topics[0]!, confirmedDirectoryPaths: [alias] }
  expect(topicSessionPaths(workspace, [original]).get(original.id)).toContain(alias)
  expect([...topicSessionPaths(workspace, [original, { ...topics[1]!, confirmedDirectoryPaths: [alias] }]).values()].flat()).not.toContain(alias)
})

it('preserves the original Windows separator forms without alias guessing', () => {
  const old = { ...topics[0]! }; delete old.physicalDirectoryPath; delete old.identityDirectoryPath
  const paths = topicSessionPaths({ path: _hygiene_win32.join("C:", _hygiene_win32.sep, "home\\scratch") }, [old]).get(old.id)!
  expect(paths).toContain(_hygiene_win32.join("C:", _hygiene_win32.sep, "home\\scratch\\topic--view--0"))
  expect(paths).toContain(_hygiene_win32.join("C:", _hygiene_win32.sep, "home\\topics\\topic--view--0"))
})

it('keeps each original Tab occurrence active state, including a missing preceding Tab', async () => {
  const tab = tabs['tab-0']!, cells = topicTabRegionCells(tab)
  const surfaces = [{ groupId: 'missing-group', tabId: 'missing-original-tab', active: false, cells: [] },
    { groupId: 'original-group', tabId: tab.id, active: true, cells }, { groupId: 'other-group', tabId: tab.id, active: false, cells }]
  await dom.render(<TopicRowPresence workspace={workspace} topic={topics[0]!} paths={[topics[0]!.physicalDirectoryPath!]}
    surfaces={surfaces} active onSelectTab={async () => {}} />)
  expect(observed.tabs).toEqual([{ tabId: tab.id, active: true }, { tabId: tab.id, active: false }])
})
it('reuses original Region geometry across selection and recalculates a genuinely changed Tab', () => {
  const tab = tabs['tab-0']!, before = topicTabRegionCells(tab)
  expect(before).toHaveLength(1)
  expect(topicTabRegionCells(tab)).toBe(before)
  const changed = { ...tab, regions: { [tab.titleRegionId]: { ...tab.regions[tab.titleRegionId]!, kind: 'launcher' as const } } }
  expect(topicTabRegionCells(changed)[0]!.surfaceKind).toBe('launcher')
  expect(topicTabRegionCells(changed)).not.toBe(before)
})

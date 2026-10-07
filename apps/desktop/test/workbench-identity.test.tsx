// @vitest-environment happy-dom
import { act } from 'react'
import { assertGroupInvariant, createWorkspaceLayout } from '@agentmux/layout'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TopicRowPresence } from '../src/renderer/src/components/TopicRowPresence'
import { WorkbenchTopology, type WorkbenchTabDetail } from '../src/renderer/src/components/WorkbenchTopology'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { openTopicWorkSurfaces, topicTabRegionCells } from '../src/renderer/src/lib/scratch-topic-layout'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { api } from '../src/renderer/src/lib/api'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { agentSessionPresentationIndex } from '../src/renderer/src/lib/session-presentation'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'

const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!
const agent = composerSession('subject-agent')
const neighbor = composerSession('neighbor-agent', 'claude')
const base = createWorkbenchTab('subject-tab', { kind: 'agent', phase: 'attached', regionId: 'neighbor-region', workspaceId: workspace.id, sessionId: neighbor.id })
const split = addWorkbenchRegion(base, 'neighbor-region', 'right', { kind: 'agent', phase: 'attached', regionId: 'subject-region', workspaceId: workspace.id, sessionId: agent.id })
const tab = { ...split, layout: { ...split.layout, activeRegionId: 'neighbor-region' } }
const layout = createWorkspaceLayout('subject-group', [tab.id])
const topic: ScratchTopicSnapshot = { id: 'subject-topic', title: 'Subject work', directoryPath: 'subject', topicPath: 'subject/topic.md', summary: '', collaborators: [] }
const reference = { displayWorkspaceId: workspace.id, groupId: 'subject-group', tabId: tab.id, regionId: 'subject-region' }
const surfaces = [{ groupId: reference.groupId, tabId: tab.id, active: false, cells: topicTabRegionCells(tab) }]
const onSelectTab = vi.fn(async () => {})
async function row(active = true) {
  await dom.render(<TopicRowPresence workspace={workspace} topic={topic} paths={[]} surfaces={surfaces} active={active} onSelectTab={onSelectTab} />)
}
const highlighted = () => dom.container.querySelectorAll<HTMLElement>('.workbench-topology__tab-glyph__cell[data-subject-region="true"]')

async function refreshCoreGraph(hostId?: string) {
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  if (hostId) for (const region of graph.regions) if (region.agentSessionId === agent.id) {
    region.execution = { hostId, cwd: agent.workspacePath }
  }
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  await initializeSpatialControlFixture()
}

beforeEach(async () => {
  onSelectTab.mockClear()
  useAppStore.setState({ config: composerConfig, sessions: [agent, neighbor], tabs: { [tab.id]: tab }, layouts: { [workspace.id]: layout },
    agentFocus: { execution: { sessionId: agent.id, history: [], reference }, pmo: { sessionId: null } }, timelines: {}, agentNames: {} })
  await refreshCoreGraph()
})

describe('original Topic row consumes shared workbench identity', () => {
  it('highlights the exact Agent Region in both maps while another Region and Tab are active', async () => {
    // The target is the second Region and the Tab is deliberately not active.
    expect(tab.layout.activeRegionId).not.toBe('subject-region')
    await row()
    expect(highlighted()).toHaveLength(1)
    expect(highlighted()[0]!.dataset.regionId).toBe('subject-region')
    const chip = dom.container.querySelector<HTMLButtonElement>('.workbench-topology__tab-chip')!
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    expect(chip.getAttribute('aria-label')).toContain('Current Agent Region highlighted')
    await act(async () => chip.focus())
    const expanded = document.querySelectorAll<HTMLElement>('.workbench-topology__inspector-regions__region[data-subject-region="true"]')
    expect(expanded).toHaveLength(1)
    expect(expanded[0]!.dataset.regionId).toBe('subject-region')
    expect(expanded[0]!.textContent).toContain('Current Agent')
    expect(expanded[0]!.style.left).toBe(highlighted()[0]!.style.left)
    await act(async () => chip.click())
    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith(topic.id, tab.id, reference.groupId)
    expect(useAppStore.getState().agentFocus.execution.reference).toEqual(reference)
  })

  it('moves the highlight only when the exact semantic Agent occurrence changes', async () => {
    await row()
    expect(highlighted()).toHaveLength(1)
    expect(highlighted()[0]!.dataset.regionId).toBe('subject-region')
    await act(async () => useAppStore.setState({ agentFocus: { execution: { sessionId: neighbor.id, history: [], reference: { ...reference, regionId: 'neighbor-region' } }, pmo: { sessionId: null } } }))
    expect(highlighted()).toHaveLength(1)
    expect(highlighted()[0]!.dataset.regionId).toBe('neighbor-region')
  })

  it.each([
    ['different display', { ...reference, displayWorkspaceId: 'other-display' }],
    ['different group', { ...reference, groupId: 'other-group' }],
    ['different Tab', { ...reference, tabId: 'other-tab' }],
    ['missing Region', { ...reference, regionId: 'missing-region' }],
    ['another Agent bound there', { ...reference, regionId: 'neighbor-region' }]
  ])('preserves the original navigable identity for %s', async (_label, target) => {
    useAppStore.setState({ agentFocus: { execution: { sessionId: agent.id, history: [], reference: target }, pmo: { sessionId: null } } })
    await row()
    expect(highlighted()).toHaveLength(0)
    expect(dom.container.querySelectorAll('.workbench-topology__tab-chip')).toHaveLength(1)
    await dom.click('.workbench-topology__tab-chip')
    expect(onSelectTab).toHaveBeenCalledExactlyOnceWith(topic.id, tab.id, reference.groupId)
  })

  it('does not borrow an identically named Session from another Host', async () => {
    useAppStore.setState({ sessions: [{ ...agent, hostId: 'other-host' }, neighbor] })
    await row()
    expect(highlighted()).toHaveLength(0)
    expect(dom.container.querySelectorAll('.workbench-topology__tab-chip')).toHaveLength(1)
    expect(dom.container.querySelector('[data-region-id="subject-region"] [data-executor-id]')).toBeNull()
  })

  it('keeps a confirmed remote execution identity in its original local display workspace', async () => {
    useAppStore.setState({ sessions: [{ ...agent, hostId: 'remote-host' }, neighbor] })
    await refreshCoreGraph('remote-host')
    await row()
    expect(highlighted()).toHaveLength(1)
    expect(highlighted()[0]!.dataset.regionId).toBe('subject-region')
  })

  it('keeps the exact remote Agent when the same Session ID also exists locally', async () => {
    const remote = { ...agent, hostId: 'remote-host', executorId: 'remote-executor', control: { ...agent.control, hostId: 'remote-host' } }
    useAppStore.setState({ sessions: [remote, agent, neighbor] })
    await refreshCoreGraph('remote-host')
    await row()
    expect(highlighted()).toHaveLength(1)
    expect(highlighted()[0]!.querySelector('[data-executor-id="remote-executor"]')).not.toBeNull()
    expect(highlighted()[0]!.querySelector(`[data-executor-id="${agent.executorId}"]`)).toBeNull()
  })

  it('emphasizes only the exact Group occurrence when a Tab has two positions', async () => {
    const duplicated = { ...layout,
      root: { type: 'split' as const, direction: 'horizontal' as const, ratio: .5, first: layout.root, second: { type: 'leaf' as const, groupId: 'other-group' } },
      groups: [...layout.groups, { ...layout.groups[0]!, id: 'other-group' }] }
    assertGroupInvariant(duplicated)
    const original = { ...tab, topicId: topic.id }
    useAppStore.setState({ layouts: { [workspace.id]: duplicated }, tabs: { [tab.id]: original } })
    useAppStore.setState({ agentFocus: { execution: { sessionId: agent.id, history: [], reference: { ...reference, groupId: 'other-group' } }, pmo: { sessionId: null } } })
    await refreshCoreGraph()
    const occurrences = openTopicWorkSurfaces(duplicated, { [tab.id]: original }).get(topic.id)!
    await dom.render(<TopicRowPresence workspace={workspace} topic={topic} paths={[]} surfaces={occurrences} active onSelectTab={onSelectTab} />)
    expect(dom.container.querySelectorAll('.workbench-topology__tab-chip')).toHaveLength(2)
    expect(highlighted()).toHaveLength(1)
    const chips = dom.container.querySelectorAll<HTMLButtonElement>('.workbench-topology__tab-chip')
    expect(chips[0]!.querySelector('[data-subject-region]')).toBeNull()
    await act(async () => chips[1]!.focus())
    expect(document.querySelectorAll('.workbench-topology__inspector--portal [data-subject-region]')).toHaveLength(1)
    expect(document.querySelector('.workbench-topology__inspector-head > small')?.textContent).toBe(`${workspace.name} · Group 2`)
    await act(async () => chips[0]!.focus())
    expect(document.querySelectorAll('.workbench-topology__inspector--portal [data-subject-region]')).toHaveLength(0)
    expect(document.querySelector('.workbench-topology__inspector-head > small')?.textContent).toBe(`${workspace.name} · Group 1`)
  })

  it('retains the original configured Executor appearance', async () => {
    useAppStore.setState({ config: { ...composerConfig, appearance: { ...composerConfig.appearance,
      agentAvatars: { [agent.executorId]: { badge: 'shield' } } } } })
    await row()
    expect(dom.container.querySelector('[data-region-id="subject-region"] [data-avatar-badge="shield"]')).not.toBeNull()
  })

  it('keeps exact Host identity in the original Tab title without borrowing ambiguous SID metadata', async () => {
    const remote = { ...agent, label: 'Remote source identity', hostId: 'remote-host', control: { ...agent.control, hostId: 'remote-host' } }
    const single = createWorkbenchTab(tab.id, { kind: 'agent', phase: 'attached', regionId: 'subject-region', workspaceId: workspace.id, sessionId: agent.id })
    useAppStore.setState({ sessions: [remote, { ...agent, label: 'Local unrelated identity' }], tabs: { [tab.id]: single },
      agentNames: { [agent.id]: 'Ambiguous SID name' } })
    await refreshCoreGraph('remote-host')
    await dom.render(<TopicRowPresence workspace={workspace} topic={topic} paths={[]} surfaces={[{ groupId: reference.groupId, tabId: tab.id, active: true, cells: topicTabRegionCells(single) }]} active onSelectTab={onSelectTab} />)
    const chip = dom.container.querySelector<HTMLButtonElement>('.workbench-topology__tab-chip')!
    expect(chip.getAttribute('aria-label')).toContain('Remote source identity')
    expect(chip.getAttribute('aria-label')).not.toMatch(/Local unrelated|Ambiguous SID/)
  })

  it('keeps the original full Session index warm while the Row derives only its own facts', async () => {
    let fullScans = 0
    const data = [agent, neighbor, ...Array.from({ length: 64 }, (_, index) => ({ ...agent, id: `outside-${index}`, control: { ...agent.control, agentSessionId: `outside-${index}` } }))]
    const all = new Proxy(data, { get(target, key, receiver) {
      if (key === Symbol.iterator) return function* () { ++fullScans; yield* target }
      return Reflect.get(target, key, receiver)
    } })
    useAppStore.setState({ sessions: all }); await refreshCoreGraph()
    agentSessionPresentationIndex(all)
    const before = fullScans
    await row()
    expect(fullScans).toBe(before)
    agentSessionPresentationIndex(all)
    expect(fullScans).toBe(before)
  })

  it('clears stale emphasis after the original Region is rebound without hiding its Tab', async () => {
    await row()
    expect(highlighted()).toHaveLength(1)
    await act(async () => useAppStore.setState({ tabs: { [tab.id]: { ...tab, regions: { ...tab.regions,
      'subject-region': { kind: 'agent', phase: 'attached', regionId: 'subject-region', workspaceId: workspace.id, sessionId: neighbor.id } } } } }))
    expect(highlighted()).toHaveLength(0)
    expect(dom.container.querySelectorAll('.workbench-topology__tab-chip')).toHaveLength(1)
  })
})

it('uses the original Executor face for a single Region without nested controls or a split frame', async () => {
  const single: WorkbenchTabDetail = { tabId: 'single', title: 'Executor identity', active: true, highlightedRegionIds: ['only-region'], regions: [{
    regionId: 'only-region', bounds: { x: 0, y: 0, width: 1, height: 1 }, surfaceKind: 'agent', executorLabel: 'Configured Executor', activity: 'Original reply',
    agent: { sessionId: agent.id, executorId: 'configured-executor', providerId: 'codex', label: 'Original Agent', appearance: { badge: 'shield' } }
  }] }
  await dom.render(<WorkbenchTopology tabs={[single]} />)
  expect(dom.container.querySelectorAll('.workbench-topology__tab-glyph--single')).toHaveLength(1)
  expect(dom.container.querySelectorAll('.workbench-topology__tab-glyph__cell')).toHaveLength(0)
  expect(dom.container.querySelector('[data-executor-id="configured-executor"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-avatar-badge="shield"]')).not.toBeNull()
  expect(dom.container.querySelector('button button')).toBeNull()
  expect(dom.container.querySelector('.agent-identity-popover')).toBeNull()
})

it('embeds readonly topology in the original button without another action or keyboard stop', async () => {
  const open = vi.fn(), nestedOpen = vi.fn()
  const detail: WorkbenchTabDetail = { tabId: 'split', title: 'Original split', active: true, highlightedRegionIds: ['left', 'right'], regions:
    ['left', 'right'].map((regionId, index) => ({ regionId, bounds: { x: index / 2, y: 0, width: .5, height: 1 }, surfaceKind: 'agent', executorLabel: 'Codex', activity: 'Original reply',
      agent: { sessionId: agent.id, executorId: 'codex', providerId: 'codex', label: 'Original Agent' } })) }
  await dom.render(<button type="button" onClick={open}><WorkbenchTopology tabs={[detail]} interactive={false} onSelectTab={nestedOpen} /></button>)
  expect(dom.container.querySelectorAll('button')).toHaveLength(1)
  expect(dom.container.querySelector('[tabindex]')).toBeNull()
  expect(highlighted()).toHaveLength(2)
  const identity = dom.container.querySelector<HTMLElement>('.workbench-topology')!
  await act(async () => identity.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  expect(document.querySelectorAll('.workbench-topology__inspector-regions__region[data-subject-region="true"]')).toHaveLength(2)
  await dom.click('button')
  expect(open).toHaveBeenCalledOnce()
  expect(nestedOpen).not.toHaveBeenCalled()
})

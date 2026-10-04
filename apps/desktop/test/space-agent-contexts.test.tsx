const { fixturePath: _hygiene_fixturePath, fixtureTime: _hygiene_fixtureTime } = await vi.hoisted(async () => await import("../scripts/lib/fixture-values.mjs"))
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { SurfaceToolDock } from '../src/renderer/src/components/SurfaceToolDock'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { allStyleRules } from './helpers/styles'
import { api } from '../src/renderer/src/lib/api'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'

const observed = vi.hoisted(() => ({ derivations: 0, renders: 0 }))
vi.mock('../src/renderer/src/lib/focus-context', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/lib/focus-context')>('../src/renderer/src/lib/focus-context')
  return { ...actual, agentContextForSession: (...args: Parameters<typeof actual.agentContextForSession>) => { observed.derivations++; return actual.agentContextForSession(...args) } }
})
vi.mock('../src/renderer/src/components/AgentContextContent', async () => {
  const actual = await vi.importActual<typeof import('../src/renderer/src/components/AgentContextContent')>('../src/renderer/src/components/AgentContextContent')
  return { ...actual, AgentContextContent: (props: Parameters<typeof actual.AgentContextContent>[0]) => { observed.renders++; return <actual.AgentContextContent {...props} /> } }
})

const dom = composerDOM()
const workspace = composerConfig.workspaces[0]!
const session = composerSession('same-agent')
const first = createWorkbenchTab('first-tab', { regionId: 'first-region', workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: session.id })
const exact = createWorkbenchTab('exact-tab', { regionId: 'exact-region', workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: session.id })
const reference = { displayWorkspaceId: workspace.id, groupId: 'space-group', tabId: exact.id, regionId: 'exact-region' }
const now = _hygiene_fixtureTime(32774400000)
function timeline(id: string, content: string, at = now - 300_000): AgentTimelineSnapshot {
  return { agentSessionId: id, revision: 1, items: [{ id: `message-${id}`, agentSessionId: id, kind: 'user_message', title: 'Prompt', status: 'complete', source: 'native-hook', content, createdAt: at, updatedAt: at }] }
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now)
  observed.derivations = 0; observed.renders = 0
  const base = createWorkspaceLayout('space-group', [exact.id])
  useAppStore.setState({ config: composerConfig, sessions: [session], workspaceTool: 'agents', projectRailOpen: true,
    tabs: { [first.id]: first, [exact.id]: exact }, timelines: {}, agentNames: {}, scratchTopicSnapshots: {}, error: null,
    layouts: { [workspace.id]: { ...base, root: { type: 'split', direction: 'horizontal', ratio: .5, first: base.root, second: { type: 'leaf', groupId: 'focus-held-group' } },
      groups: [...base.groups, { ...base.groups[0]!, id: 'focus-held-group', tabOrder: [first.id], activeTabId: first.id }], activeGroupId: 'space-group' } },
    mainSurface: 'workbench', activeWorkspaceId: workspace.id,
    agentComposerDrafts: { [session.id]: 'Original draft' },
    agentFocus: { execution: { sessionId: session.id, history: [], reference: { ...reference, groupId: 'focus-held-group', tabId: first.id, regionId: 'first-region' } }, pmo: { sessionId: null } } })
})
afterEach(() => vi.useRealTimers())

it('the actual Space caller chooses its explicit current Group even when Focus holds another occurrence', async () => {
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  const before = useAppStore.getState()
  await dom.click('.workspace-agent-row')
  const after = useAppStore.getState()
  expect(after.error).toBeNull()
  expect(after.agentFocus.execution.reference).toEqual(reference)
  expect(after.workbenchSpaceSelection).toMatchObject({ workspaceId: workspace.id, groupId: reference.groupId, tabId: exact.id, regionId: reference.regionId })
  expect(after.sessions).toBe(before.sessions)
  expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect(after.agentFocus.execution.history).toBe(before.agentFocus.execution.history)
})

it('without an explicit Group the original held complete occurrence still wins', async () => {
  const held = useAppStore.getState().agentFocus.execution.reference
  await act(async () => useAppStore.getState().selectSession(session.id))
  expect(useAppStore.getState().error).toBeNull()
  expect(useAppStore.getState().agentFocus.execution.reference).toEqual(held)
})

it('two Regions in the explicit Group remain indeterminate and never choose the first', async () => {
  const before = useAppStore.getState()
  const secondRegion = 'second-region'
  useAppStore.setState({ tabs: { ...before.tabs, [exact.id]: { ...exact, regions: { ...exact.regions, [secondRegion]: { regionId: secondRegion, workspaceId: workspace.id, kind: 'agent', phase: 'attached', sessionId: session.id } }, layout: splitWorkbenchRegion(exact.layout, 'exact-region', 'right', secondRegion) } } })
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  const stable = useAppStore.getState()
  await dom.click('.workspace-agent-row')
  const after = useAppStore.getState()
  expect(after.error).toContain('no unique confirmed display occurrence')
  expect(after.agentFocus).toBe(stable.agentFocus)
  expect(after.tabs).toBe(stable.tabs); expect(after.layouts).toBe(stable.layouts)
  expect(after.sessions).toBe(stable.sessions); expect(after.agentComposerDrafts).toBe(stable.agentComposerDrafts)
})

it('shows held task Context and absolute activity time while a byte/update heartbeat cannot refresh it', async () => {
  const second = { ...composerSession('same-name'), label: session.label }
  useAppStore.setState({ sessions: [session, second], timelines: { [session.id]: timeline(session.id, '修复滚动回退并验证真实目标'), [second.id]: timeline(second.id, 'Review navigation without changing the original Run') } })
  const reads = [vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.sessions, 'observeHistory'), vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline')]
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  const row = dom.container.querySelector(`[data-session-id="${session.id}"]`)!
  expect(row.querySelector('.focus-context__detail')?.textContent).toContain('修复滚动回退并验证真实目标')
  const time = row.querySelector('time')!
  expect(time.dateTime).toBe(new Date(now - 300_000).toISOString())
  expect(time.title).toContain('Last active')
  await act(async () => useAppStore.setState({ sessions: [{ ...session, updatedAt: now, latestOutputBytes: 80_000 }, second] }))
  expect(dom.container.querySelector(`[data-session-id="${session.id}"] time`)?.getAttribute('datetime')).toBe(time.dateTime)
  expect(dom.container.textContent).not.toContain('Agent Sessions')
  expect(dom.container.textContent).not.toContain('Agents kept during Tab close')
  expect(row.querySelector('[data-focus-state-icon="unknown"]')).not.toBeNull()
  await act(async () => row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })))
  expect(document.querySelector('.focus-context-hover')).toBeNull()
  for (const read of reads) expect(read).not.toHaveBeenCalled()
})

it('keeps Idle high pressure, unknown and ended members while status shapes use actual result facts', async () => {
  const known = (id: string, state: 'working' | 'done') => ({ ...composerSession(id), status: { state, source: 'native-hook' as const, observedAt: now }, semanticStatus: { state, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now - 120_000 } })
  const idle = { ...known('idle', 'done'), turnUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, observedAt: now, context: { usedTokens: 190_000, capacityTokens: 200_000 } } }
  const results = known('results', 'done'), working = known('working', 'working'), unknown = composerSession('unknown')
  const ended = { ...composerSession('ended'), processState: 'exited' as const, status: { state: 'exited' as const, source: 'run-process' as const, observedAt: now } }
  useAppStore.setState({ sessions: [idle, results, working, unknown, ended], timelines: { results: { ...timeline('results', 'A real completed reply'), items: [{ ...timeline('results', 'A real completed reply').items[0]!, kind: 'assistant_message' }] } } })
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  expect(dom.container.querySelectorAll('.workspace-agent-row')).toHaveLength(5)
  for (const id of ['idle', 'results', 'working', 'unknown']) expect(dom.container.querySelector(`[data-session-id="${id}"] [data-focus-state-icon]`)?.getAttribute('data-focus-state-icon')).toBe(id)
  expect(dom.container.querySelector('[data-session-id="working"] .focus-context__avatar--compact-content .agent-avatar__status')).not.toBeNull()
  expect(allStyleRules()).toMatch(/\.focus-context__avatar--compact-content \.agent-avatar \.agent-avatar__status\s*\{\s*display:\s*none/ )
  const pressure = dom.container.querySelector('[data-session-id="idle"] [data-pressure="danger"]')!
  expect(pressure.textContent).toBe('95%'); expect(pressure.getAttribute('title')).toContain('start a fresh session')
  const unknownRow = dom.container.querySelector('[data-session-id="unknown"]')!
  expect(unknownRow.querySelector('time')).toBeNull(); expect(unknownRow.textContent).not.toContain('0%')
  expect(unknownRow.getAttribute('title')).toContain('Activity time unknown')
})

it('retains an accurately scoped Mote which Focus excludes from execution cards', async () => {
  const scratch = { ...workspace, id: '__scratch__', name: 'Topics', path: _hygiene_fixturePath("focus-topics") }
  const mote = { ...composerSession('mote'), workspacePath: _hygiene_fixturePath("focus-topics/topic--launcher--leader") }
  const config = { ...composerConfig, workspaces: [scratch] }
  const scratchTopicSnapshots = { [scratch.id]: { scope: JSON.stringify([scratch.hostId, scratch.path]), revision: 1, reading: false, error: null, topics: [{ id: 'launcher:leader', title: 'Mote', summary: '', directoryPath: mote.workspacePath, topicPath: mote.workspacePath + '/topic.md', collaborators: [] }] } }
  useAppStore.setState({ config, sessions: [mote], scratchTopicSnapshots })
  expect(createFocusProjectionSelector()(useAppStore.getState()).contexts).toHaveLength(0)
  await dom.render(<SurfaceToolDock workspace={scratch} />)
  expect(dom.container.querySelector('[data-session-id="mote"]')).not.toBeNull()
})

it('isolates real unrelated Store output and makes no Context IO when hidden or first visible', async () => {
  const outside = { ...composerSession('outside'), hostId: 'other-host', workspacePath: _hygiene_fixturePath("other-repo") }
  useAppStore.setState({ sessions: [session, outside], timelines: { [session.id]: timeline(session.id, 'Measure only this relevant task') } })
  const reads = [vi.spyOn(api.sessions, 'historySources'), vi.spyOn(api.sessions, 'observeHistory'), vi.spyOn(api.sessions, 'historyPage'), vi.spyOn(api.sessions, 'timeline')]
  await dom.render(<SurfaceToolDock workspace={workspace} visible={false} />)
  expect(observed).toEqual({ derivations: 0, renders: 0 })
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  expect(observed.derivations).toBeGreaterThan(0); expect(observed.renders).toBeGreaterThan(0)
  const baseline = { ...observed }, row = dom.container.querySelector('.workspace-agent-row')
  for (let index = 0; index < 12; index++) await act(async () => useAppStore.setState({ sessions: [session, { ...outside, updatedAt: now + index, latestOutputBytes: index }], timelines: { ...useAppStore.getState().timelines, outside: timeline('outside', `Other output ${index}`) } }))
  expect(observed).toEqual(baseline); expect(dom.container.querySelector('.workspace-agent-row')).toBe(row)
  for (const read of reads) expect(read).not.toHaveBeenCalled()
})

it('both Focus entry actions share the existing Surface owner and retain execution, draft and Run', async () => {
  await dom.render(<SurfaceToolDock workspace={workspace} />)
  const before = useAppStore.getState()
  await dom.click('.workspace-tool-context .workspace-agents-tool__focus')
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  await act(async () => useAppStore.getState().setMainSurface('workbench'))
  await dom.click('.workspace-agents-tool__focus--footer')
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().agentFocus).toBe(before.agentFocus)
  expect(useAppStore.getState().sessions).toBe(before.sessions)
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
})

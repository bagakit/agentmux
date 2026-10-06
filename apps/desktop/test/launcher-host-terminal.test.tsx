// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: any) => <div data-warm-run={session.control.run.runId} /> }))
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import type { WorkbenchProjection } from '../src/renderer/src/lib/workbench-projection'
import type { WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { ordinaryTopicId, quietMoteId, seedMoteWorkface } from './fixtures/mote-workface'

const dom = composerDOM(), launcherBaseline = useLauncherState.getState()
const groupId = 'host-group', tabId = 'host-launcher', regionId = 'host-input'
let workspaceId = 'project'
beforeEach(async () => {
  localStorage.clear(); seedMoteWorkface()
  useAppStore.setState({ tabs: {}, layouts: {}, mainSurface: 'workbench', activeWorkspaceId: 'project',
    providerCatalog: [], detectExecutors: vi.fn().mockResolvedValue(undefined), refreshScratchTopics: vi.fn().mockResolvedValue(undefined),
    prewarmTerminal: vi.fn(), workbenchSpaceSelection: null, retainedSpatialFocus: null, workbenchNavigationInputPolicy: null })
  await act(async () => useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null }))
})
afterEach(async () => { await act(async () => useLauncherState.setState(launcherBaseline, true)); localStorage.clear() })

function seed({ scratch = false, topicId, empty = false }: { scratch?: boolean; topicId?: string; empty?: boolean } = {}) {
  workspaceId = scratch ? SCRATCH_WORKSPACE_ID : 'project'
  const tab = { ...createWorkbenchTab(tabId, { regionId, kind: 'launcher', workspaceId }), ...(topicId ? { topicId } : {}) }
  const workspace = useAppStore.getState().config!.workspaces.find(item => item.id === workspaceId)!
  const session = { ...composerSession('original-warm'), kind: 'terminal' as const, providerId: null, workspacePath: workspace.path,
    control: { kind: 'terminal' as const, hostId: workspace.hostId, runId: 'original-shell', run: { runId: 'original-shell' } } }
  useAppStore.setState({ tabs: empty ? {} : { [tabId]: tab }, layouts: { [workspaceId]: createWorkspaceLayout(groupId, empty ? [] : [tabId]) },
    activeWorkspaceId: workspaceId, agentComposerDrafts: { [regionId]: 'Original task\nKeep its second line.' },
    warmTerminals: { [warmTerminalKey(workspace.hostId, workspace.path)]: [{ key: warmTerminalKey(workspace.hostId, workspace.path), ownerLauncherId: empty ? `group:${groupId}` : `region:${regionId}`,
      session, ready: Promise.resolve(session) }] } })
}
function protectedFacts() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, drafts: state.agentComposerDrafts, warm: state.warmTerminals, sessions: state.sessions }
}
function terminal(mode: 'expanded' | 'collapsed' | 'hidden', parent: ParentNode = dom.container) {
  const modules = parent.querySelectorAll<HTMLElement>('[data-section="terminal"]')
  expect(modules).toHaveLength(mode === 'hidden' ? 0 : 1)
  if (mode !== 'hidden') expect(modules[0]!.dataset.mode).toBe(mode)
  expect(parent.querySelector('[data-warm-run="original-shell"]') !== null).toBe(mode === 'expanded')
  if (mode === 'hidden') expect(parent.querySelector('[aria-label="Restore Terminal"]')).not.toBeNull()
}
async function mountOriginal(topicId?: string) {
  await dom.render(<MoteWorkface workspaceId={workspaceId} topicId={topicId} visible={false}>
    <WorkspaceWorkbench workspaceId={workspaceId} visible={false} />
  </MoteWorkface>)
}
async function project(surface: NonNullable<WorkbenchViewTarget['surface']>, entity: 'tab' | 'region' = 'tab', moteOwner = false) {
  const state = useAppStore.getState(), catalog = spatialCatalog(state, [])
  const reference = { displayWorkspaceId: workspaceId, groupId, tabId, regionId }
  expect(catalog.locations.filter(item => item.tabId === tabId).length).toBeGreaterThan(0)
  const projection: WorkbenchProjection = { entity: entity === 'tab' ? { kind: 'tab', tabId } : { kind: 'region', regionId },
    displayWorkspaceId: workspaceId, presentationId: 'host-projection', catalog, selection: [reference], onSelect: vi.fn() }
  const target = { hostId: 'actual-host-slot', active: false, visible: true, surface, projection, reference }
  await dom.render(<><div id="actual-host-slot" /><MoteWorkface workspaceId={workspaceId} topicId={moteOwner ? quietMoteId : undefined} visible={false}>
    <WorkspaceWorkbench workspaceId={workspaceId} visible={false} viewTargets={{ [tabId]: [target] }} />
  </MoteWorkface></>)
  const slot = dom.container.querySelector('#actual-host-slot')!
  expect(slot.querySelectorAll('.launch-surface')).toHaveLength(1)
  return slot
}

describe('the actual Launcher host chooses only absent section defaults', () => {
  it.each([false, true])('ordinary Project empty Group=$0 defaults to a warm expanded Terminal without writing preferences', async empty => {
    seed({ empty }); const before = protectedFacts(); await mountOriginal()
    terminal('expanded'); expect(protectedFacts()).toEqual(before)
    expect(useLauncherState.getState().sections).toEqual({})
    expect([...dom.container.querySelectorAll('[data-section]')].map(node => [node.getAttribute('data-section'), node.getAttribute('data-mode')]))
      .toEqual([['terminal', 'expanded'], ['browser', 'collapsed'], ['note', 'collapsed']])
    expect(dom.container.querySelectorAll('.agent-picks > button[data-executor-id]')).toHaveLength(1)
  })
  it('the original real Mote Workface collapses Terminal while an ordinary Topic in the same Scratch Workspace expands it', async () => {
    seed({ scratch: true, topicId: quietMoteId }); const before = protectedFacts()
    await mountOriginal(quietMoteId); terminal('collapsed')
    expect(dom.container.querySelector('[data-mote-workface]')?.getAttribute('data-mote-workface')).toBe(quietMoteId)
    expect(protectedFacts()).toEqual(before); expect(useLauncherState.getState().sections).toEqual({})
    await act(async () => seed({ scratch: true, topicId: ordinaryTopicId })); await mountOriginal(ordinaryTopicId); terminal('expanded')
    expect(dom.container.querySelector('[data-mote-workface]')).toBeNull()
    expect(useLauncherState.getState().sections).toEqual({})
  })
  it.each(['survey', 'mote'] as const)('the actual $0 Tab portal overrides ordinary resource and global navigation with a collapsed Terminal', async surface => {
    seed(); const before = protectedFacts(); terminal('collapsed', await project(surface))
    expect(protectedFacts()).toEqual(before); expect(useLauncherState.getState().sections).toEqual({})
  })
  it('the actual Region portal inherits its destination rather than the parent Tab surface', async () => {
    seed(); const before = protectedFacts(); terminal('collapsed', await project('mote', 'region'))
    expect(protectedFacts()).toEqual(before); expect(useLauncherState.getState().sections).toEqual({})
  })
  it.each(['space', 'focus'] as const)('an original Mote projected to actual $0 expands Terminal and returning keeps the same work', async surface => {
    seed({ scratch: true, topicId: quietMoteId }); const before = protectedFacts()
    terminal('expanded', await project(surface, 'tab', true))
    await mountOriginal(quietMoteId); terminal('collapsed')
    expect(protectedFacts()).toEqual(before); expect(useLauncherState.getState().sections).toEqual({})
  })
  it.each(['expanded', 'collapsed', 'hidden'] as const)('an explicit durable $0 Terminal mode outranks original and projected hosts', async mode => {
    seed(); const saved = { sections: { [workspaceId]: { terminal: mode } }, drafts: { [`region:${regionId}`]: { browser: 'Unsent search', note: 'Unsent note' } }, executors: {} }
    localStorage.setItem('agentmux-launcher', JSON.stringify({ state: saved, version: 0 }))
    await act(async () => useLauncherState.persist.rehydrate()); const before = protectedFacts()
    await mountOriginal(); terminal(mode)
    terminal(mode, await project('mote')); terminal(mode, await project('survey', 'region'))
    expect(JSON.parse(localStorage.getItem('agentmux-launcher')!).state).toEqual(saved)
    expect(protectedFacts()).toEqual(before)
  })
  it('actual utility controls persist only the explicit choice and retain original warm Run and complete drafts across hosts', async () => {
    seed(); await mountOriginal(); const before = protectedFacts()
    await dom.click('[aria-label="Collapse Terminal"]'); terminal('collapsed')
    expect(useLauncherState.getState().sections).toEqual({ project: { terminal: 'collapsed' } })
    const slot = await project('mote'); terminal('collapsed', slot)
    await act(async () => (slot.querySelector('[aria-label="Expand Terminal"]') as HTMLButtonElement).click()); terminal('expanded', slot)
    expect(useLauncherState.getState().sections).toEqual({ project: { terminal: 'expanded' } })
    await mountOriginal(); terminal('expanded'); expect(protectedFacts()).toEqual(before)
  })
})

// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { focusSettingsModule } from '../src/renderer/src/components/settings/modules/focus'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { useAppStore, type AgentSteerQueueEntry } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { applyConfigEdit } from '../src/shared/config-edit'
import type { AppConfig } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout } from '@agentmux/layout'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { executionFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

// Native PTY painting is outside this settings-to-card consumer boundary.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
const dom = composerDOM(), Pane = focusSettingsModule.Pane
const shaOwners = ['FocusSettingsPane.tsx', 'FocusSettingsPreview.tsx', 'GlobalFocusSurface.tsx', 'focus-selection-style.ts', 'focus-preferences.ts']
beforeEach(() => {
  const loaded = (globalThis as any).__focusSelectionUiLoaded ?? []
  for (const owner of shaOwners) expect(loaded.some((entry: any) => entry.path.endsWith('/' + owner)), 'Actual original consumer evaluated: ' + owner).toBe(true)
  if (process.env.AGENTMUX_SELECTION_UI_MUTANT) expect(loaded.some((entry: any) => entry.applied)).toBe(true)
})
const prefs = { recentActivityHours: 48 as const, selectionFillPercent: 20, selectionBorderPercent: 35, selectionAccent: 'neutral' as const,
  projects: [{ key: JSON.stringify(['local', 'workspace']), pinned: true, note: 'Original project note', color: 'blue' as const, collapsed: null }],
  zonePresentations: [{ key: JSON.stringify(['project', 'local', 'workspace']), presentation: 'cards' as const }] }

async function setup(initial: NonNullable<AppConfig['focus']> = prefs) {
  let current: AppConfig = { ...composerConfig, focus: initial }
  const sessions = ['selected-original', 'neighbor-original'].map(id => ({ ...composerSession(id),
    status: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 },
    semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: 1 } }))
  const tabs = Object.fromEntries(sessions.map(session => {
    const tab = createWorkbenchTab('tab-' + session.id, { kind: 'agent', phase: 'attached', regionId: 'region-' + session.id, workspaceId: 'workspace', sessionId: session.id })
    return [tab.id, tab]
  }))
  const queue: AgentSteerQueueEntry = { operationId: 'original-queued-input', text: 'Original queued input', status: 'deferred', archived: true,
    awaitingExplicitSend: true, directInputControl: sessions[0]!.control }
  useAppStore.setState({ config: current, sessions, tabs, layouts: { workspace: createWorkspaceLayout('original-group', Object.keys(tabs)) },
    mainSurface: 'agents', focusView: 'list', activeWorkspaceId: 'workspace', timelines: {}, agentNames: {},
    agentFocus: { execution: { sessionId: sessions[0]!.id, history: [] }, pmo: { sessionId: null } },
    agentComposerDrafts: { [sessions[0]!.id]: 'Original unsent draft' }, agentSteerQueues: { [sessions[0]!.id]: [queue] } })
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph: desktopSpatialGraph(useAppStore.getState(), []) })
  await initializeSpatialControlFixture()
  const state = useAppStore.getState(), catalog = spatialCatalog(state, [])
  const presentation = executionFocusPresentation(state.agentFocus.execution, state.tabs, catalog, () => {}, 'region')
  expect(presentation.projection?.selection).toHaveLength(1)
  function Surface() {
    const config = useAppStore(value => value.config)!
    return <><Pane config={config} active onClose={() => {}} onNavigate={() => {}} /><GlobalFocusSurface presentation={presentation} workspaceOpen={false} /></>
  }
  const commit = (next: AppConfig, expected: AppConfig) => { current = applyConfigEdit(current, expected, next); return current }
  const save = vi.spyOn(api.config, 'save').mockImplementation(async (next, expected) => commit(next, expected!))
  await dom.render(<Surface />)
  const before = { sessions: state.sessions, drafts: state.agentComposerDrafts, queues: state.agentSteerQueues, tabs: state.tabs, focus: state.agentFocus,
    selected: dom.container.querySelector('.global-focus-surface [data-focus-card-key][data-focus-agent-selected="true"]') }
  expect(before.selected, 'The actual Global card owns the original selection').not.toBeNull()
  return { save, before, commit, get current() { return current }, publish(next: AppConfig) { current = next; useAppStore.setState({ config: next }) } }
}
function preview() { return dom.container.querySelector<HTMLElement>('.focus-settings-preview')! }
function global() { return dom.container.querySelector<HTMLElement>('.global-focus-surface')! }
function style(node: HTMLElement) { return ['ink', 'fill', 'border'].map(key => node.style.getPropertyValue('--focus-selection-' + key)) }
function input(field: string) { return dom.container.querySelector<HTMLInputElement>(`input[aria-label="${field}"]`)! }
async function emphasis(field: string, value: number) {
  const target = input(field); expect(target).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, String(value))
    target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const saveButton = () => dom.container.querySelector<HTMLButtonElement>('[data-settings-save-bar] button')!
async function save() { await act(async () => saveButton().click()) }
function retained(before: Awaited<ReturnType<typeof setup>>['before']) {
  const state = useAppStore.getState()
  expect(state.sessions).toBe(before.sessions)
  expect(state.sessions.map(session => session.control.run)).toEqual(before.sessions.map(session => session.control.run))
  expect(state.agentComposerDrafts).toBe(before.drafts); expect(state.agentSteerQueues).toBe(before.queues)
  expect(state.tabs).toBe(before.tabs); expect(state.agentFocus).toBe(before.focus)
  expect(dom.container.querySelector('.global-focus-surface [data-focus-card-key][data-focus-agent-selected="true"]')).toBe(before.selected)
}

it('previews authored choices locally, then saves through the original module into the actual Global selected-card consumer', async () => {
  const f = await setup()
  expect(style(global())).toEqual(['var(--text)', '20%', '35%'])
  expect(preview().querySelector('[data-example-agent]')?.getAttribute('aria-pressed'), 'The first rendered board example must initially show the selected appearance').toBe('true')
  await emphasis('Background emphasis', 28); await emphasis('Fine-edge emphasis', 70)
  await dom.click('[data-settings-field="selection-accent"] input[value="blue"]')
  expect(style(preview())).toEqual(['var(--blue)', '28%', '70%'])
  expect(style(global())).toEqual(['var(--text)', '20%', '35%'])
  const examples = [...preview().querySelectorAll<HTMLButtonElement>('[data-example-agent]')]
  expect(examples.length).toBeGreaterThan(1)
  await act(async () => examples[1]!.click())
  expect(examples[1]!.getAttribute('aria-pressed')).toBe('true')
  expect(examples[0]!.getAttribute('aria-pressed')).toBe('false')
  expect(f.save).not.toHaveBeenCalled(); retained(f.before)
  await act(async () => f.publish({ ...f.current, copyPathsAsAbsolute: true }))
  await save()
  expect(f.save).toHaveBeenCalledTimes(1)
  expect(f.save.mock.calls[0]![1]?.focus?.selectionFillPercent).toBe(20)
  expect(style(global()), 'Confirmed authored settings must reach the actual Global consumer').toEqual(['var(--blue)', '28%', '70%'])
  expect(f.current.copyPathsAsAbsolute).toBe(true)
  expect(f.current.focus?.projects).toEqual(prefs.projects); expect(f.current.focus?.zonePresentations).toEqual(prefs.zonePresentations)
  expect(saveButton().disabled).toBe(true); retained(f.before)
  expect(focusSettingsModule.searchTargets.map(target => target.id)).toEqual(expect.arrayContaining(['selection-fill', 'selection-border', 'selection-accent']))
})

it('retains a same-field conflicting draft and exact original baseline until explicit resolution', async () => {
  const f = await setup()
  await emphasis('Background emphasis', 27)
  await act(async () => f.publish({ ...f.current, focus: { ...f.current.focus!, selectionFillPercent: 24 } }))
  await save()
  expect(dom.container.querySelector('[role="alert"]')?.textContent).toContain('focus.selectionFillPercent')
  expect(input('Background emphasis').value).toBe('27')
  expect(style(preview())[1]).toBe('27%'); expect(style(global())[1]).toBe('24%')
  await save()
  expect(f.save.mock.calls.map(call => call[1]?.focus?.selectionFillPercent)).toEqual([20, 20])
  await dom.click('[data-settings-conflict-action="keep-mine"]')
  await save()
  expect(f.save.mock.calls[2]![1]?.focus?.selectionFillPercent).toBe(24)
  expect(style(global())[1]).toBe('27%'); retained(f.before)
})

it('keeps a later UI draft while a confirmed pending save advances only its submitted baseline', async () => {
  const f = await setup()
  let finish!: () => void
  f.save.mockImplementation((next, expected) => new Promise(resolve => { finish = () => resolve(f.commit(next, expected!)) }))
  await emphasis('Background emphasis', 25); await save()
  expect(saveButton().disabled).toBe(true)
  await emphasis('Background emphasis', 29)
  expect(style(preview())[1]).toBe('29%'); expect(style(global())[1]).toBe('20%')
  await act(async () => finish())
  expect(style(global())[1]).toBe('25%'); expect(style(preview())[1]).toBe('29%')
  expect(saveButton().disabled).toBe(false)
  await save()
  expect(f.save.mock.calls.map(call => [call[0].focus?.selectionFillPercent, call[1]?.focus?.selectionFillPercent])).toEqual([[25, 20], [29, 25]])
  await act(async () => finish()); retained(f.before)
})

it('restores selection defaults in the draft only and preserves project and Zone choices on explicit save', async () => {
  const f = await setup({ ...prefs, selectionFillPercent: 28, selectionBorderPercent: 80, selectionAccent: 'purple' })
  expect(style(global())).toEqual(['var(--purple)', '28%', '80%'])
  const reset = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Restore defaults')!
  await act(async () => reset.click())
  expect(style(preview())).toEqual(['var(--text)', '20%', '35%'])
  expect(style(global())).toEqual(['var(--purple)', '28%', '80%']); expect(f.save).not.toHaveBeenCalled()
  await save()
  expect(style(global())).toEqual(['var(--text)', '20%', '35%'])
  expect(f.current.focus?.projects).toEqual(prefs.projects); expect(f.current.focus?.zonePresentations).toEqual(prefs.zonePresentations)
  retained(f.before)
})

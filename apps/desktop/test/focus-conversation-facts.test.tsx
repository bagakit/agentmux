// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { conversationRevision, projectConversationSummary } from '@agentmux/core/conversation'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector, createWorkspaceAgentContextsSelector } from '../src/renderer/src/lib/focus-context'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import type { RendererAgentTimelineSnapshot } from '../src/renderer/src/lib/session-state'

vi.mock('@agentmux/core/conversation', async original => {
  const actual = await original<typeof import('@agentmux/core/conversation')>()
  return { ...actual, projectConversationSummary: vi.fn(actual.projectConversationSummary) }
})
// Keep the original Focus, Store, Core projection and card. Isolate unrelated native paint and IO.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusNavigationPreview } from '../src/renderer/src/components/FocusNavigationPreview'

const project = vi.mocked(projectConversationSummary)
const initial = useAppStore.getState(), session = composerSession('facts-original'), foreign = composerSession('facts-foreign')
const workspace = composerConfig.workspaces[0]!
let root: Root, container: HTMLDivElement
function timeline(id = session.id, content = 'Original observed response'): AgentTimelineSnapshot {
  return { agentSessionId: id, sourceHostId: 'local', revision: 1, items: [{ id: 'reply', agentSessionId: id,
    kind: 'assistant_message', source: 'native-hook', status: 'complete', title: 'Reply', content,
    createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1) }] }
}
function input(accepted = timeline()) {
  return { sessions: [session], timelines: { [session.id]: accepted }, config: composerConfig, agentNames: {}, scratchTopicSnapshots: {} }
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...input(), mainSurface: 'agents', tabs: {}, layouts: {}, recoveryCandidates: [],
    agentComposerDrafts: { [session.id]: 'Keep the original draft' } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  project.mockClear()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); useAppStore.setState(initial, true)
  project.mockClear(); vi.unstubAllGlobals()
})

it('updates the mounted Focus card through the original status event without reprojecting unchanged text', async () => {
  const accepted = timeline(), other = timeline(foreign.id, 'Foreign observed response')
  const failed = { ...session, status: { ...session.status, state: 'error' as const, detail: 'Prior observation failed' } }
  useAppStore.setState({ sessions: [failed, foreign], timelines: { [session.id]: accepted, [foreign.id]: other } })
  await act(async () => root.render(<GlobalFocusSurface />))
  expect(project.mock.calls.map(([value]) => value.agentSessionId).sort()).toEqual([foreign.id, session.id].sort())
  let row = container.querySelector<HTMLElement>(`[data-session-id="${session.id}"].focus-context`)!
  expect(row).not.toBeNull(); expect(row.getAttribute('aria-label')).toContain('Original observed response')
  project.mockClear()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: {
    type: 'agent-status', agentSessionId: session.id, state: 'error', detail: 'The original observation failed',
    evidence: { source: 'native-hook', run: session.control.run, observedAt: session.status.observedAt + 1 }
  } }))
  expect(useAppStore.getState().timelines[session.id]).toBe(accepted)
  expect(container.querySelector(`[data-session-id="${session.id}"].focus-context`)).toBe(row)
  expect(row.dataset.bucket).toBe('attention')
  expect(row.textContent).toContain('The original observation failed')
  expect(project).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ agentNames: { [session.id]: 'Renamed original' } }))
  expect(row.textContent).toContain('Renamed original'); expect(project).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original draft')
  expect(useAppStore.getState().sessions.find(value => value.id === session.id)?.control.run).toEqual(session.control.run)
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: {
    type: 'agent-status', agentSessionId: session.id, state: 'done',
    evidence: { source: 'native-hook', run: session.control.run, observedAt: session.status.observedAt + 2 }
  } }))
  row = container.querySelector<HTMLElement>(`[data-session-id="${session.id}"].focus-context`)!
  expect(row.dataset.bucket).toBe('results'); expect(project).not.toHaveBeenCalled()

  const changed = { ...accepted, revision: 2, items: [{ ...accepted.items[0]!, content: 'Changed observed response' }] }
  await act(async () => useAppStore.setState({ timelines: { [session.id]: changed, [foreign.id]: other } }))
  expect(row.getAttribute('aria-label')).toContain('Changed observed response')
  expect(row.getAttribute('aria-label')).not.toContain('Original observed response')
  expect(project.mock.calls.map(([value]) => value.agentSessionId)).toEqual([session.id])
})

it('keeps current classification and full recap while only presentation facts change', () => {
  const body = 'Complete original response. '.repeat(120), accepted = timeline(session.id, body)
  const select = createFocusProjectionSelector(), original = input(accepted), before = select(original).contexts[0]!
  expect(project).toHaveBeenCalledTimes(1); expect(before.recap?.reading?.text).toBe(body.trim())
  project.mockClear()
  const updated = { ...session, status: { ...session.status, state: 'done' as const } }
  const after = select({ ...original, sessions: [updated], agentNames: { [session.id]: 'Updated name' } }).contexts[0]!
  expect(after.name).toBe('Updated name'); expect(after.bucket).toBe('results')
  expect(after.recap).toBe(before.recap); expect(after.recap?.reading?.truncated).toBe(false)
  expect(project).not.toHaveBeenCalled()
  project.mockClear()
  const next = { ...accepted, revision: 2, items: [...accepted.items, { ...accepted.items[0]!, id: 'next-request', kind: 'user_message' as const, content: 'Continue with this request' }] }
  const changed = select({ ...original, sessions: [updated], timelines: { [session.id]: next } }).contexts[0]!
  expect(project).toHaveBeenCalledTimes(1); expect(changed.bucket).toBe('idle')
  expect(project.mock.results[0]!.value.at(-1)?.content).toBe('Continue with this request')
  expect(changed.detailIsRecap).toBe(false)
  expect(changed.recap?.reading?.text).toBe(body.trim())
})

it('reuses Core conversation facts when an admitted status clears only live tool provenance', async () => {
  const accepted: RendererAgentTimelineSnapshot = { ...timeline(), liveTool: { itemId: 'active-tool', hostId: session.hostId,
    runId: session.control.run.runId, epoch: 1, observedAt: session.status.observedAt, startedAt: session.status.observedAt } }
  const failed = { ...session, status: { ...session.status, state: 'error' as const, detail: 'Prior observation failed' } }
  useAppStore.setState({ sessions: [failed], timelines: { [session.id]: accepted } })
  await act(async () => root.render(<GlobalFocusSurface />))
  const row = container.querySelector<HTMLElement>(`[data-session-id="${session.id}"].focus-context`)!
  expect(row.getAttribute('aria-label')).toContain('Original observed response')
  expect(project).toHaveBeenCalledTimes(1); project.mockClear()
  await act(async () => useAppStore.getState().applyEvent({ type: 'core', hostId: session.hostId, event: {
    type: 'agent-status', agentSessionId: session.id, state: 'error', detail: 'Current observation failed',
    evidence: { source: 'native-hook', run: session.control.run, observedAt: session.status.observedAt + 1 }
  } }))
  const cleared = useAppStore.getState().timelines[session.id]!
  expect(cleared).not.toBe(accepted); expect(cleared).not.toHaveProperty('liveTool')
  expect(cleared.items).toBe(accepted.items); expect(cleared.stream).toBe(accepted.stream)
  expect(cleared.revision).toBe(accepted.revision); expect(cleared.sourceHostId).toBe(accepted.sourceHostId)
  expect(container.querySelector(`[data-session-id="${session.id}"].focus-context`)).toBe(row)
  expect(row.dataset.bucket).toBe('attention'); expect(row.textContent).toContain('Current observation failed')
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original draft')
  expect(useAppStore.getState().sessions[0]!.control.run).toEqual(session.control.run)
  expect(project).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ timelines: { [session.id]: { ...cleared,
    items: [{ ...cleared.items[0]!, content: 'Different accepted history at the same revision' }] } } }))
  expect(row.getAttribute('aria-label')).toContain('Different accepted history at the same revision')
  expect(project).toHaveBeenCalledTimes(1)
})

it('captures Core items and stream identities independently of the Timeline wrapper', () => {
  const accepted = timeline(), original = input(accepted), select = createFocusProjectionSelector()
  select(original); project.mockClear()
  accepted.items = [{ ...accepted.items[0]!, content: 'Replaced original items' }]
  expect(select({ ...original, timelines: { [session.id]: { ...accepted } } }).contexts[0]!.recap?.reading?.text).toBe('Replaced original items')
  expect(project).toHaveBeenCalledTimes(1); project.mockClear()
  accepted.stream = { epoch: 'same-source-epoch', sequence: 1, revision: accepted.revision, origin: 'beginning', gaps: [],
    positions: [{ id: accepted.items[0]!.id, firstSequence: 1, sequence: 1, revision: conversationRevision(accepted.items[0]) }] }
  select({ ...original, timelines: { [session.id]: { ...accepted } } })
  expect(project).toHaveBeenCalledTimes(1); project.mockClear()
  accepted.stream = { ...accepted.stream, sequence: 2, positions: [{ ...accepted.stream.positions[0]!, sequence: 2 }] }
  select({ ...original, timelines: { [session.id]: { ...accepted } } })
  expect(project).toHaveBeenCalledTimes(1)
})

it('invalidates independently captured revision and source facts even if the input object is reused', () => {
  const accepted = timeline(), original = input(accepted), select = createFocusProjectionSelector()
  select(original); project.mockClear()
  accepted.items[0] = { ...accepted.items[0]!, content: 'New revision of original response' }; accepted.revision++
  const revised = select({ ...original, timelines: { ...original.timelines } }).contexts[0]!
  expect(project).toHaveBeenCalledTimes(1); expect(revised.recap?.reading?.text).toBe('New revision of original response')
  project.mockClear(); accepted.sourceHostId = 'another-source'
  select({ ...original, timelines: { ...original.timelines } })
  expect(project).toHaveBeenCalledTimes(1)
  project.mockClear(); accepted.agentSessionId = 'another-session'
  const changed = select({ ...original, timelines: { ...original.timelines } }).contexts[0]!
  expect(project).toHaveBeenCalledTimes(1); expect(changed.recap).toBeNull()
})

it('removes an optional native identity while reusing the unchanged conversation', () => {
  const original = input(), select = createFocusProjectionSelector()
  const before = select({ ...original, sessions: [{ ...session, nativeSessionId: 'original-native' }] }).contexts[0]!
  expect(before.nativeSessionId).toBe('original-native'); project.mockClear()
  const after = select({ ...original, sessions: [session] }).contexts[0]!
  expect(after).not.toHaveProperty('nativeSessionId')
  expect(after.recap).toBe(before.recap); expect(project).not.toHaveBeenCalled()
})

it('keeps the captured source epoch independent of the numeric revision', () => {
  const accepted = timeline(), select = createFocusProjectionSelector(), original = input(accepted)
  const stream = (epoch: string): NonNullable<AgentTimelineSnapshot['stream']> => ({ epoch, sequence: 1,
    revision: accepted.revision, origin: 'beginning', gaps: [], positions: [{ id: accepted.items[0]!.id,
      firstSequence: 1, sequence: 1, revision: conversationRevision(accepted.items[0]) }] })
  accepted.stream = stream('original-epoch')
  const before = select(original).contexts[0]!
  expect(before.recap?.reading?.text).toBe('Original observed response'); project.mockClear()
  accepted.items = [{ ...accepted.items[0]!, content: 'Response from another original epoch' }]
  accepted.stream = stream('next-epoch')
  const after = select({ ...original, timelines: { ...original.timelines } }).contexts[0]!
  expect(after.recap?.reading?.text).toBe('Response from another original epoch')
  expect(project).toHaveBeenCalledTimes(1)
})

it('retires removed Session facts and preserves empty and process-only observations', () => {
  const accepted = timeline(), original = input(accepted), select = createFocusProjectionSelector()
  select(original); project.mockClear()
  expect(select({ ...original, sessions: [] }).contexts).toEqual([])
  expect(select(original).contexts[0]!.recap?.reading?.text).toBe('Original observed response')
  expect(project).not.toHaveBeenCalled()
  const process = { ...accepted, revision: 2, items: [{ ...accepted.items[0]!, kind: 'tool_call' as const, toolName: 'inspect', content: 'Process details' }] }
  const observed = select({ ...original, timelines: { [session.id]: process } }).contexts[0]!
  expect(observed.recap).toBeNull(); project.mockClear()
  const renamed = select({ ...original, timelines: { [session.id]: process }, agentNames: { [session.id]: 'Process owner' } }).contexts[0]!
  expect(renamed.recap).toBeNull(); expect(project).not.toHaveBeenCalled()
  const empty = select({ ...original, timelines: { [session.id]: { ...accepted, revision: 3, items: [] } } }).contexts[0]!
  expect(empty.recap).toBeNull(); expect(project).toHaveBeenCalledTimes(1)
})

it('shares accepted conversation facts across the actual transient preview, Focus and Space directory', async () => {
  const accepted = timeline(), original = input(accepted)
  original.sessions = [{ ...session, status: { ...session.status, state: 'done' } }]
  useAppStore.setState(original)
  await act(async () => root.render(<FocusNavigationPreview />))
  expect(container.querySelector('[data-preview-session]')?.textContent).toContain('Original observed response')
  expect(project).toHaveBeenCalledTimes(1)
  project.mockClear()
  await act(async () => root.render(<><FocusNavigationPreview /><GlobalFocusSurface /></>))
  expect(container.querySelector('.focus-context')?.getAttribute('aria-label')).toContain('Original observed response')
  const directory = createWorkspaceAgentContextsSelector()
  expect(directory([session], original.timelines, {}, workspace, null)[0]!.recap?.reading?.text).toBe('Original observed response')
  expect(project).not.toHaveBeenCalled()
  await act(async () => root.render(<GlobalFocusSurface />))
  await act(async () => root.render(<><FocusNavigationPreview /><GlobalFocusSurface /></>))
  expect(project).not.toHaveBeenCalled()
  accepted.revision++
  accepted.items[0] = { ...accepted.items[0]!, content: 'Current source response' }
  await act(async () => useAppStore.setState({ timelines: { ...original.timelines } }))
  expect(project).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-preview-session]')?.textContent).toContain('Current source response')
  expect(container.querySelector('.focus-context')?.getAttribute('aria-label')).toContain('Current source response')
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original draft')
  expect(useAppStore.getState().sessions[0]?.control.run).toEqual(session.control.run)
})

it('validates shared source facts even for a fresh reader and seeds a reused Timeline wrapper', () => {
  const accepted = timeline(), original = input(accepted), first = createFocusProjectionSelector()
  first(original); project.mockClear()
  const wrapper = { ...accepted }
  first({ ...original, timelines: { [session.id]: wrapper } })
  createFocusProjectionSelector()({ ...original, timelines: { [session.id]: wrapper } })
  expect(project).not.toHaveBeenCalled()
  for (const change of [
    () => { wrapper.items = [{ ...wrapper.items[0]!, content: 'New items at the original revision' }] },
    () => { wrapper.revision++ },
    () => { wrapper.sourceHostId = 'original-source-moved' },
    () => { wrapper.stream = { epoch: 'next-epoch', sequence: 1, revision: wrapper.revision, positions: [], gaps: [], origin: 'beginning' } },
    () => { wrapper.agentSessionId = 'different-source-session' }
  ]) {
    change(); project.mockClear()
    createFocusProjectionSelector()({ ...original, timelines: { [session.id]: wrapper } })
    expect(project).toHaveBeenCalledTimes(1)
  }
})

it('reuses the same small facts in the existing workspace selector and refreshes its actual owner', () => {
  const accepted = timeline(), select = createWorkspaceAgentContextsSelector()
  const before = select([session], { [session.id]: accepted }, {}, workspace, null)[0]!
  expect(project).toHaveBeenCalledTimes(1); project.mockClear()
  const next = { ...session, status: { ...session.status, state: 'done' as const } }
  const moved = { ...workspace, name: 'Updated workspace' }
  const after = select([next], { [session.id]: accepted }, { [session.id]: 'Renamed workspace Agent' }, moved, null)[0]!
  expect(after.recap).toBe(before.recap); expect(after.name).toBe('Renamed workspace Agent')
  expect(after.workspace).toBe(moved); expect(after.bucket).toBe('results'); expect(project).not.toHaveBeenCalled()
  accepted.revision++; accepted.items[0] = { ...accepted.items[0]!, content: 'Updated workspace response' }
  const revised = select([next], { [session.id]: accepted }, {}, moved, null)[0]!
  expect(project).toHaveBeenCalledTimes(1); expect(revised.recap?.reading?.text).toBe('Updated workspace response')
})

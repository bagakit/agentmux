// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { conversationRevision, projectConversationRecords } from '@agentmux/core/conversation'
import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { useAppStore } from '../src/renderer/src/store'
import { createFocusProjectionSelector, createWorkspaceAgentContextsSelector } from '../src/renderer/src/lib/focus-context'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

vi.mock('@agentmux/core/conversation', async original => {
  const actual = await original<typeof import('@agentmux/core/conversation')>()
  return { ...actual, projectConversationRecords: vi.fn(actual.projectConversationRecords) }
})
// Keep the original Focus, Store, Core projection and card. Isolate unrelated native paint and IO.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/AgentAvatar', () => ({ AgentAvatar: () => null }))
vi.mock('../src/renderer/src/lib/use-focus-hierarchy', () => ({ useFocusHierarchy: () => ({ facts: { topics: {}, worktrees: [] }, errors: [] }) }))
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'

const project = vi.mocked(projectConversationRecords)
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
  select(original); expect(project).toHaveBeenCalledTimes(1)
  const process = { ...accepted, revision: 2, items: [{ ...accepted.items[0]!, kind: 'tool_call' as const, toolName: 'inspect', content: 'Process details' }] }
  const observed = select({ ...original, timelines: { [session.id]: process } }).contexts[0]!
  expect(observed.recap).toBeNull(); project.mockClear()
  const renamed = select({ ...original, timelines: { [session.id]: process }, agentNames: { [session.id]: 'Process owner' } }).contexts[0]!
  expect(renamed.recap).toBeNull(); expect(project).not.toHaveBeenCalled()
  const empty = select({ ...original, timelines: { [session.id]: { ...accepted, revision: 3, items: [] } } }).contexts[0]!
  expect(empty.recap).toBeNull(); expect(project).toHaveBeenCalledTimes(1)
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

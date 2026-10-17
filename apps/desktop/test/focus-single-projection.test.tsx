// @vitest-environment happy-dom
import { fixtureEpoch as _tailFixtureEpoch } from "../../../test/fixture-values.mjs"
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConversationRecord } from '@agentmux/core/conversation'
import type { AgentTimelineSnapshot } from '@agentmux/core'
import { projectConversationSummary } from '@agentmux/core/conversation'
import { FocusNavigationButton } from '../src/renderer/src/components/FocusNavigationButton'
import { agentContextForSession } from '../src/renderer/src/lib/focus-context'
import { useAppStore } from '../src/renderer/src/store'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'

vi.mock('@agentmux/core/conversation', async importOriginal => {
  const actual = await importOriginal<typeof import('@agentmux/core/conversation')>()
  return { ...actual, projectConversationSummary: vi.fn(actual.projectConversationSummary) }
})

const project = vi.mocked(projectConversationSummary)
const initial = useAppStore.getState()
const session = composerSession('focus-original')
const workspace = composerConfig.workspaces[0]!
let root: Root
let container: HTMLDivElement

function timeline(content = 'Original complete reply'): AgentTimelineSnapshot {
  return { agentSessionId: session.id, sourceHostId: session.hostId, revision: 1,
    items: [{ id: 'reply', agentSessionId: session.id, kind: 'assistant_message', source: 'native-hook',
      status: 'complete', createdAt: _tailFixtureEpoch(0, 0, 1), updatedAt: _tailFixtureEpoch(0, 0, 1), title: 'Reply', content }] }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ config: composerConfig, sessions: [session], timelines: {}, agentNames: {},
    scratchTopicSnapshots: {}, agentComposerDrafts: { [session.id]: 'Keep the original draft' } })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  project.mockClear()
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  useAppStore.setState(initial, true)
  project.mockClear()
  vi.unstubAllGlobals()
})

it('keeps full conversation projection out of mounted Focus navigation counts', async () => {
  const accepted = timeline()
  const other = composerSession('focus-foreign')
  const foreign = { ...timeline('Foreign reply'), agentSessionId: other.id,
    items: [{ ...timeline('Foreign reply').items[0]!, agentSessionId: other.id }] }
  const callsFor = (id: string) => project.mock.calls.filter(([input]) => input.agentSessionId === id)
  useAppStore.setState({ sessions: [session, other], timelines: { [session.id]: accepted, [other.id]: foreign } })
  await act(async () => root.render(<FocusNavigationButton aria-label="Focus">Focus</FocusNavigationButton>))
  const button = container.querySelector('button')!
  expect(button.textContent).toContain('Focus')
  expect(callsFor(session.id)).toHaveLength(0)
  expect(callsFor(other.id)).toHaveLength(0)

  project.mockClear()
  await act(async () => useAppStore.setState({ error: 'An unrelated observation' }))
  expect(project).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ sessions: [{ ...session, latestOutputBytes: 128 }, other] }))
  expect(project).not.toHaveBeenCalled()

  const foreignUpdate = { ...other, status: { ...other.status, state: 'starting' as const } }
  await act(async () => useAppStore.setState({ sessions: [session, foreignUpdate] }))
  expect(callsFor(session.id)).toHaveLength(0)
  expect(callsFor(other.id)).toHaveLength(0)
  expect(button.querySelector('[data-focus-count="working"]')?.textContent).toBe('1')
  project.mockClear()
  await act(async () => useAppStore.setState({ sessions: [{ ...session, status: { ...session.status, state: 'error' } }, foreignUpdate] }))
  expect(container.querySelector('button')).toBe(button)
  expect(button.getAttribute('aria-label')).toContain('1 failed')
  expect(callsFor(session.id)).toHaveLength(0)
  expect(callsFor(other.id)).toHaveLength(0)
  expect(useAppStore.getState().agentComposerDrafts[session.id]).toBe('Keep the original draft')

  project.mockClear()
  const changed = { ...accepted, revision: 2, items: [{ ...accepted.items[0]!, content: 'New complete reply' }] }
  await act(async () => useAppStore.setState({ timelines: { [session.id]: changed, [other.id]: foreign } }))
  expect(callsFor(session.id)).toHaveLength(0)
  expect(callsFor(other.id)).toHaveLength(0)
})

it('uses the same original Core records for current result and complete recap', () => {
  const accepted = timeline()
  const result = agentContextForSession({ ...session, status: { ...session.status, state: 'done' } }, accepted, undefined, workspace, null)
  expect(result.bucket).toBe('results')
  expect(result.detail).toContain('Original complete reply')
  expect(result.recap?.reading).toEqual({ text: 'Original complete reply', truncated: false })
  expect(result.recap?.origin).toBe('timeline')
  expect(project).toHaveBeenCalledTimes(1)
})

it('keeps empty and process-only accepted timelines distinct from a reply', () => {
  const accepted = timeline()
  accepted.items = [{ ...accepted.items[0]!, kind: 'tool_call', toolName: 'inspect', toolInput: '{}', content: 'Original process detail' }]
  const process = agentContextForSession(session, accepted, undefined, workspace, null)
  expect(process.recap).toBeNull()
  expect(project).toHaveBeenCalledTimes(1)
  project.mockClear()
  const empty = agentContextForSession(session, { ...accepted, items: [] }, undefined, workspace, null)
  expect(empty.recap).toBeNull()
  expect(project).toHaveBeenCalledTimes(1)
})

it('reads a revised original object on each direct derivation without introducing a cache', () => {
  const accepted = timeline()
  const first = agentContextForSession(session, accepted, undefined, workspace, null)
  expect(first.recap?.reading?.text).toBe('Original complete reply')
  accepted.items[0] = { ...accepted.items[0]!, content: 'Changed original reply', updatedAt: _tailFixtureEpoch(0, 0, 2) }
  accepted.revision += 1
  project.mockClear()
  const changed = agentContextForSession(session, accepted, undefined, workspace, null)
  expect(changed.recap?.reading?.text).toBe('Changed original reply')
  expect(project).toHaveBeenCalledTimes(1)
})

it('retains independent same-body original records and the original Run', () => {
  const accepted = timeline()
  accepted.items.push({ ...accepted.items[0]!, id: 'independent-reply', createdAt: _tailFixtureEpoch(0, 0, 2), updatedAt: _tailFixtureEpoch(0, 0, 2) })
  const result = agentContextForSession(session, accepted, undefined, workspace, null)
  const records = project.mock.results[0]!.value as AgentConversationRecord[]
  expect(records.map(record => record.rawId)).toEqual(['reply', 'independent-reply'])
  expect(result.runId).toBe(session.control.run.runId)
  expect(result.recap?.reading?.text).toBe('Original complete reply')
  expect(project).toHaveBeenCalledTimes(1)
})

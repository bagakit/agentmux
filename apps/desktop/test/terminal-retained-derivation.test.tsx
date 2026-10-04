import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { SessionPane } from '../src/renderer/src/components/SessionPane'
import { useAppStore } from '../src/renderer/src/store'
import * as tabs from '../src/renderer/src/lib/workbench-tabs'
import * as topics from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createSessionViewModeSelector } from '../src/renderer/src/lib/session-presentation'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
import type { AgentTimelineSnapshot } from '../src/shared/contracts'

// Only native PTY painting is outside this DOM boundary; Pane/Composer/Store are real.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <textarea aria-label="Original PTY" /> }))
const dom = composerDOM()
function timeline(id: string, content?: string): AgentTimelineSnapshot {
  return { agentSessionId: id, revision: 1, items: content ? [{ id: `${id}-prompt`, agentSessionId: id,
    kind: 'user_message', content, title: 'Prompt', source: 'user', status: 'complete', createdAt: 1, updatedAt: 1 }] : [] }
}
async function unrelatedUpdates() {
  for (let n = 0; n < 24; n++) await act(async () => useAppStore.setState(state => ({
    sessions: state.sessions.map(session => session.id === 'other' ? { ...session, updatedAt: n + 2,
      status: { state: 'working', source: 'native-hook', observedAt: n + 2 } } : session),
    timelines: { ...state.timelines, other: timeline('other', `Other prompt ${n}`) }
  })))
}

it('retained Composer avoids unrelated prompt and topic walks while own drafts and prompts stay fresh', async () => {
  const own = timeline('agent-1')
  useAppStore.setState({ sessions: [composerSession(), composerSession('other')], timelines: { 'agent-1': own },
    viewModes: { 'agent-1': 'terminal' }, scratchTopicSnapshots: {} })
  const prompt = vi.spyOn(tabs, 'firstPromptFromTimeline'), catalog = vi.spyOn(topics, 'scratchTopicsForConfig')
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  expect(dom.container.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(prompt.mock.calls.length).toBeGreaterThan(0)
  expect(catalog.mock.calls.length).toBeGreaterThan(0)
  prompt.mockClear(); catalog.mockClear()
  await unrelatedUpdates()
  expect(prompt).not.toHaveBeenCalled()
  expect(catalog).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
  // The web preview appends to a timeline in place, then publishes a new revision.
  own.items.push(timeline('agent-1', 'Original first prompt').items[0]!)
  own.revision++
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines }, agentComposerDrafts: { 'agent-1': 'New draft' } })))
  expect(dom.container.querySelector('.composer-agent-identity button')?.getAttribute('aria-label')).toContain('Original first prompt')
  expect(prompt).toHaveBeenCalled()
  expect(dom.draft()).toBe('New draft')
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, 'agent-1': timeline('agent-1', 'Replaced prompt') } })))
  expect(dom.container.querySelector('.composer-agent-identity button')?.getAttribute('aria-label')).toContain('Replaced prompt')
  expect(useAppStore.getState().sessions[0]!.control.run.runId).toBe('run-agent-1')
})

it('mounted Pane keeps speaker derivation scoped while related names and histories invalidate', async () => {
  useAppStore.setState({ sessions: [composerSession(), composerSession('other')], timelines: { 'agent-1': timeline('agent-1', 'Own first prompt') },
    viewModes: { 'agent-1': 'activity' }, scratchTopicSnapshots: {} })
  const prompt = vi.spyOn(tabs, 'firstPromptFromTimeline')
  await dom.render(<SessionPane sessionId="agent-1" surfaceKind="agent" visible interactiveResize={false} linkOrigin={{ workspaceId: 'workspace' }} />)
  expect(dom.container.querySelector('.agent-input-stack')).not.toBeNull()
  expect(prompt.mock.calls.length).toBeGreaterThan(0)
  prompt.mockClear()
  await unrelatedUpdates()
  expect(prompt).not.toHaveBeenCalled()
  await act(async () => useAppStore.setState({ agentNames: { 'agent-1': 'Updated own identity' } }))
  expect(dom.container.textContent).toContain('Updated own identity')
  expect(prompt).toHaveBeenCalled()
  await act(async () => useAppStore.setState(state => ({ timelines: { ...state.timelines, 'agent-1': timeline('agent-1', 'Changed history') }, agentNames: {} })))
  expect(dom.container.textContent).toContain('Changed history')
  expect(dom.draft()).toBe('Keep my draft')
})

it('view mode skips unrelated directory walks and follows confirmed hashed Mote paths, preferences and removal', () => {
  const select = createSessionViewModeSelector('agent-1'), catalog = vi.spyOn(topics, 'scratchTopicsForConfig')
  let state: ReturnType<typeof useAppStore.getState> = { ...useAppStore.getState(), config: composerConfig, sessions: [composerSession()], viewModes: {}, scratchTopicSnapshots: {} }
  expect(select(state)).toBe('terminal')
  expect(catalog.mock.calls.length).toBeGreaterThan(0)
  catalog.mockClear()
  state = { ...state, sessions: [{ ...composerSession(), updatedAt: 10 }, composerSession('other')] }
  expect(select(state)).toBe('terminal')
  expect(catalog).not.toHaveBeenCalled()
  const workspace = { ...composerConfig.workspaces[0]!, id: '__scratch__', path: _hygiene_fixturePath("private/.agentmux/scratch") }
  const path = _hygiene_fixturePath("private/.agentmux/motes/0123456789abcdef")
  const mote = { id: 'launcher:original', title: 'Original Mote', summary: '', directoryPath: 'original', topicPath: 'original/topic.md',
    collaborators: [], kind: 'mote' as const, confirmedDirectoryPaths: [path], physicalDirectoryPath: path, identityDirectoryPath: path }
  state = { ...state, config: { ...composerConfig, workspaces: [workspace] }, sessions: [{ ...composerSession(), workspacePath: path }],
    scratchTopicSnapshots: { __scratch__: { scope: JSON.stringify(['local', workspace.path]), revision: 1, topics: [mote], error: null, reading: false } } }
  expect(select(state)).toBe('activity')
  expect(select({ ...state, viewModes: { 'agent-1': 'terminal' } })).toBe('terminal')
  expect(select(state)).toBe('activity')
  expect(select({ ...state, sessions: [{ ...state.sessions[0]!, hostId: 'remote' }] })).toBe('terminal')
  expect(select(state)).toBe('activity')
  expect(select({ ...state, scratchTopicSnapshots: {} })).toBe('terminal')
  expect(select(state)).toBe('activity')
  expect(select({ ...state, sessions: [] })).toBe('terminal')
})

it('mounted Composer follows its original host, path and fresh hashed-directory ownership', async () => {
  const scratch = { ...composerConfig.workspaces[0]!, id: '__scratch__', path: _hygiene_fixturePath("private/.agentmux/scratch") }
  const moved = { ...composerConfig.workspaces[0]!, id: 'moved', path: _hygiene_fixturePath("moved") }
  const path = _hygiene_fixturePath("private/.agentmux/motes/0123456789abcdef")
  useAppStore.setState({ config: { ...composerConfig, workspaces: [...composerConfig.workspaces, moved, scratch] },
    lastActiveFileByWorkspace: { workspace: _hygiene_fixturePath("repo/original.ts"), moved: _hygiene_fixturePath("moved/updated.ts"), __scratch__: `${path}/SOUL.md` },
    scratchTopicSnapshots: {}, viewModes: { 'agent-1': 'terminal' } })
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  const reference = () => dom.container.querySelector('button[aria-label^="Reference /"]')?.getAttribute('aria-label')
  expect(reference()).toBe(("Reference " + _hygiene_fixturePath("repo/original.ts")))
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), workspacePath: moved.path }] }))
  expect(reference()).toBe(("Reference " + _hygiene_fixturePath("moved/updated.ts")))
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), hostId: 'remote', workspacePath: moved.path }] }))
  expect(reference()).toBeUndefined()
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), workspacePath: path }] }))
  expect(reference()).toBeUndefined()
  await act(async () => useAppStore.setState({ scratchTopicSnapshots: { __scratch__: {
    scope: JSON.stringify(['local', scratch.path]), revision: 1, reading: false, error: null,
    topics: [{ id: 'launcher:original', title: 'Mote', summary: '', directoryPath: 'original', topicPath: 'original/topic.md',
      collaborators: [], kind: 'mote', confirmedDirectoryPaths: [path] }]
  } } }))
  expect(reference()).toBe(`Reference ${path}/SOUL.md`)
  expect(dom.draft()).toBe('Keep my draft')
})

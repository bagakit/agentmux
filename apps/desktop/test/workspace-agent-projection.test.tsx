// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceAgentContextsSelector } from '../src/renderer/src/lib/focus-context'
import { workspaceAgentSessions } from '../src/renderer/src/lib/surface-tool-dock'
import { focusLaneForSession } from '../src/renderer/src/lib/agent-focus'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { composerDOM, composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'

const observed = vi.hoisted(() => new Map<string, { context: unknown; identity: unknown }>())
// Observe props while retaining the real row, preview, identity and Store consumers.
vi.mock('../src/renderer/src/components/WorkspaceAgentRow', async original => {
  const actual = await original<typeof import('../src/renderer/src/components/WorkspaceAgentRow')>()
  return { ...actual, WorkspaceAgentRow: (props: Parameters<typeof actual.WorkspaceAgentRow>[0]) => {
    observed.set(JSON.stringify([props.context.hostId, props.context.id]), { context: props.context, identity: props.identity })
    return <actual.WorkspaceAgentRow {...props} />
  } }
})
import { WorkspaceAgentsTool } from '../src/renderer/src/components/SurfaceToolDock'

const dom = composerDOM(), workspace = composerConfig.workspaces[0]!
const key = (session: { hostId: string; id: string }) => JSON.stringify([session.hostId, session.id])
beforeEach(() => observed.clear())

it('keeps untouched Workspace Context and identity references during scoped byte-only updates', async () => {
  const sessions = [0, 1, 2].map(index => composerSession(`workspace-cost-${index}`))
  const tabs = Object.fromEntries(sessions.map((session, index) => {
    const original = createWorkbenchTab(`cost-tab-${index}`, { kind: 'agent', phase: 'attached',
      regionId: `agent-region-${index}`, workspaceId: workspace.id, sessionId: session.id })
    const split = addWorkbenchRegion(original, `agent-region-${index}`, 'right', { kind: 'terminal', phase: 'attached',
      regionId: `terminal-region-${index}`, workspaceId: workspace.id, sessionId: `terminal-${index}` })
    return [split.id, split]
  }))
  useAppStore.setState({ config: composerConfig, sessions, tabs,
    layouts: { [workspace.id]: createWorkspaceLayout('cost-group', Object.keys(tabs)) },
    timelines: {}, scratchTopicSnapshots: {}, agentNames: {} })
  const graph = desktopSpatialGraph(useAppStore.getState(), [])
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ schemaVersion: 1, revision: 1, graph })
  await initializeSpatialControlFixture()
  const open = vi.fn()
  await dom.render(<WorkspaceAgentsTool workspace={workspace} sessions={sessions} onOpen={open} />)
  expect(observed.size).toBe(3)
  const before = new Map(observed)
  for (const value of before.values()) expect(value.identity).toBeDefined()

  const changed = sessions.map((session, index) => index === 0
    ? { ...session, latestOutputBytes: session.latestOutputBytes + 100 } : session)
  await act(async () => useAppStore.setState({ sessions: changed }))
  await dom.render(<WorkspaceAgentsTool workspace={workspace} sessions={changed} onOpen={open} />)
  for (const session of sessions) {
    expect(observed.get(key(session))!.context).toBe(before.get(key(session))!.context)
    expect(observed.get(key(session))!.identity).toBe(before.get(key(session))!.identity)
    expect(dom.container.querySelector(`button[data-session-id="${session.id}"]`)).not.toBeNull()
  }
  expect(open).not.toHaveBeenCalled()
})

it('keeps Host subjects separate, invalidates the exact Run and prunes removed projections', () => {
  const select = createWorkspaceAgentContextsSelector()
  const local = composerSession('same-scalar-sid')
  const remote = { ...local, hostId: 'other-host', control: { ...local.control, hostId: 'other-host', run: { runId: 'other-run' } } }
  const first = select([local, remote], {}, {}, workspace, [])
  expect(first).toHaveLength(2)
  expect(first.map(context => [context.hostId, context.runId])).toEqual([
    ['local', local.control.run.runId], ['other-host', 'other-run']
  ])

  const nextLocal = { ...local, control: { ...local.control, run: { runId: 'next-original-run' } } }
  const next = select([nextLocal, remote], {}, {}, workspace, [])
  expect(next[0]).not.toBe(first[0]); expect(next[0]!.runId).toBe('next-original-run')
  expect(next[1]).toBe(first[1])
  const heartbeat = { ...nextLocal, latestOutputBytes: 900 }
  expect(select([heartbeat, remote], {}, {}, workspace, [])).toBe(next)

  expect(select([heartbeat], {}, {}, workspace, [])).toHaveLength(1)
  const restored = select([heartbeat, remote], {}, {}, workspace, [])
  expect(restored[0]).toBe(next[0])
  expect(restored[1]).not.toBe(first[1]); expect(restored[1]!.hostId).toBe('other-host')
})

it('retains confirmed Mote members and their original open action in the real Workspace directory', async () => {
  const scratch = { ...workspace, id: '__scratch__', name: 'Scratch' }
  const motePath = `${workspace.path}/original-mote`
  const topic = { id: 'confirmed-mote', title: 'Confirmed Mote', summary: '', kind: 'mote' as const,
    directoryPath: 'original-mote', physicalDirectoryPath: motePath, confirmedDirectoryPaths: [motePath],
    topicPath: 'original-mote/topic.md', collaborators: [] }
  const mote = { ...composerSession('original-mote-agent'), workspacePath: motePath }
  const plain = { ...composerSession('original-plain-agent'), workspacePath: scratch.path }
  const source = [mote, plain]
  expect(focusLaneForSession(topic.id, [topic])).toBe('pmo')
  expect(workspaceAgentSessions(source, scratch, [topic]).map(session => session.id)).toEqual([mote.id, plain.id])
  useAppStore.setState({ config: { ...composerConfig, workspaces: [scratch] }, sessions: source,
    tabs: {}, layouts: {}, timelines: {}, agentNames: {}, scratchTopicSnapshots: {
      [scratch.id]: { scope: scratchTopicsScope(scratch), revision: 1, topics: [topic], error: null, reading: false }
    } })
  const open = vi.fn()
  await dom.render(<WorkspaceAgentsTool workspace={scratch} sessions={source} onOpen={open} />)
  expect(dom.container.querySelector(`[data-session-id="${mote.id}"]`)).not.toBeNull()
  expect(dom.container.querySelector(`[data-session-id="${plain.id}"]`)).not.toBeNull()
  const original = observed.get(key(mote))!.context

  const changed = source.map(session => session.id === plain.id ? { ...session, latestOutputBytes: 300 } : session)
  await act(async () => useAppStore.setState({ sessions: changed }))
  await dom.render(<WorkspaceAgentsTool workspace={scratch} sessions={changed} onOpen={open} />)
  expect(observed.get(key(mote))!.context).toBe(original)
  const button = dom.container.querySelector<HTMLButtonElement>(`button[data-session-id="${mote.id}"]`)
  expect(button).not.toBeNull()
  await act(async () => button!.click())
  expect(open).toHaveBeenCalledExactlyOnceWith(mote.id)
})

// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { act } from 'react'
import { useAppStore } from '../src/renderer/src/store'
import { restorePersistedWorkbench } from '../src/renderer/src/lib/workbench-persistence'
import { desktopSpatialGraph, desktopWorkbenchFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { api } from '../src/renderer/src/lib/api'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { RuntimeController } from '../src/main/runtime-controller'
import { AgentMuxClient } from '../../../packages/core/src/client'
import { AgentMuxFileAgentSessionStore } from '../../../packages/core/src/agent-session-store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => <div data-canonical-terminal /> }))
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
const dom = composerDOM()
async function context() {
  const root = process.env.AGENTMUX_PRIVATE_TERMINAL_RECOVERY_ROOT!
  expect(root).toMatch(/^\/private\/tmp\/amxtr-native-/u)
  const input = JSON.parse(await readFile(join(root, 'request.json'), 'utf8'))
  const config = { ...composerConfig, workspaces: [{ ...composerConfig.workspaces[0]!, path: root }] }
  const raw = { ...composerSession(input.expectedRun.runId), kind: 'terminal' as const, workspacePath: root, processState: 'exited' as const,
    control: { kind: 'terminal' as const, hostId: 'local', runId: input.expectedRun.runId, run: input.expectedRun } }
  return { root, input, config, raw }
}
it('[terminal recovery Native seed] saves an original nonempty Workbench through the actual persistence projection before the UI process exits', async () => {
  const { root, config, raw } = await context()
  useAppStore.setState({ config, sessions: [raw as never], tabs: {}, layouts: {}, activeWorkspaceId: 'workspace', mainSurface: 'workbench' })
  useAppStore.getState().selectSession(raw.id)
  const state = useAppStore.getState()
  expect(Object.values(state.tabs)).toHaveLength(1)
  const saved = await new AgentMuxSpatialStateStore(join(root, 'spatial.json')).commit({ expectedRevision: 0, graph: desktopSpatialGraph(state, []) })
  expect(saved.graph.regions.length).toBe(1)
  await writeFile(join(root, 'workbench-before-restart.json'), JSON.stringify({ tabs: state.tabs, layouts: state.layouts, processId: process.pid, revision: saved.revision }))
})
it('[terminal recovery Native restore] a fresh UI and Core process restore the saved Region and use the same canonical live Run without Stop or new Start', async () => {
  const { root, input, config, raw } = await context()
  const saved = JSON.parse(await readFile(join(root, 'workbench-before-restart.json'), 'utf8'))
  expect(saved.processId).not.toBe(process.pid)
  const durable = await new AgentMuxSpatialStateStore(join(root, 'spatial.json')).readForLayout()
  expect(durable!.revision).toBe(saved.revision)
  const before = restorePersistedWorkbench({ config, sessions: [raw as never], persisted: desktopWorkbenchFromSpatial(durable!.graph), createTabGroupId: () => { throw Error('A new group must not replace the original workface') } })
  expect(Object.keys(before.tabs)).toEqual(Object.keys(saved.tabs)); expect(before.layouts).toEqual(saved.layouts)
  for (const [id, tab] of Object.entries(saved.tabs) as Array<[string, any]>) {
    expect(before.tabs[id]).toMatchObject({ id: tab.id, workspaceId: tab.workspaceId, layout: tab.layout, regions: tab.regions })
  }
  useAppStore.setState({ config, sessions: [raw as never], tabs: before.tabs, layouts: before.layouts, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    viewModes: { [raw.id]: 'terminal' }, recoveryCandidates: [], pendingAgentLaunches: {} })
  for (const key of Object.keys(process.env)) if (key.startsWith('AGENTMUX_') && key !== 'AGENTMUX_TERMINAL_RECOVERY_LOADED' && key !== 'AGENTMUX_PRIVATE_TERMINAL_RECOVERY_ROOT') delete process.env[key]
  process.env.AGENTMUX_RUNTIME_DIRECTORY = join(root, 'runtime'); process.env.AGENTMUX_STATE_DIRECTORY = join(root, 'state')
  process.env.AGENTMUX_AGENT_SESSION_STORE = join(root, 'sessions.sqlite'); process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(root, 'messages.sqlite')
  const core = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(process.env.AGENTMUX_AGENT_SESSION_STORE) })
  await core.connect()
  try {
    const controller = Object.create(RuntimeController.prototype) as any
    controller.connectedClient = async () => core; controller.hosts = new Map([['local', { client: core }]]); controller.terminalInputCursors = new Map()
    const create = vi.spyOn(core, 'createPreparedTerminal'), stop = vi.spyOn(api.sessions, 'stop')
    vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
    vi.spyOn(api.connections, 'call').mockResolvedValue({ bindings: [] } as never)
    vi.spyOn(api.sessions, 'recover').mockImplementation((control, cwd, operationId, request) => controller.performRecovery(control, config, cwd, operationId, request))
    const recovered = await useAppStore.getState().recoverSession(raw.id, 'fresh-ui-process', { trigger: 'startup' })
    const native = JSON.parse(await readFile(join(root, 'native-replacement.json'), 'utf8'))
    expect(recovered?.control.run.runId).toBe(native.runId); expect(create).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    const after = useAppStore.getState(), oldTab = Object.values(saved.tabs)[0] as any, currentTab = after.tabs[oldTab.id]!
    expect(Object.keys(after.tabs)).toEqual(Object.keys(saved.tabs)); expect(after.layouts).toEqual(saved.layouts)
    expect(currentTab.layout).toEqual(oldTab.layout)
    expect(Object.keys(currentTab.regions)).toEqual(Object.keys(oldTab.regions))
    expect(Object.values(currentTab.regions).some(region => 'sessionId' in region && region.sessionId === native.runId)).toBe(true)
    await act(async () => dom.render(<WorkspaceWorkbench workspaceId="workspace" />))
    expect(dom.container.querySelector('[data-canonical-terminal]')).not.toBeNull()
    await writeFile(join(root, 'workbench-restored.json'), JSON.stringify({ processId: process.pid, expectedRun: input.expectedRun, run: recovered!.control.run,
      tabs: after.tabs, layouts: after.layouts, originalTabId: oldTab.id, sameRegionIds: true, newStartCalls: create.mock.calls.length, stopCalls: stop.mock.calls.length }))
  } finally { await core.dispose() }
})

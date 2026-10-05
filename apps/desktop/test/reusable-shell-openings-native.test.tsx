// @vitest-environment happy-dom
import { act } from 'react'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxFileAgentSessionStore, AgentMuxSpatialStateStore } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import { headlessFixture, until } from '../../../packages/core/test/helpers/headless-runtime-fixture'
import { bridge, owningBridge } from './helpers/first-execution-ipc-bridge'
import { composerDOM } from './helpers/composer-dom-fixture'
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { ScratchTopics } from '../src/main/scratch-topics'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import type { AppConfig, SessionSnapshot, TerminalLaunchInput } from '../src/shared/contracts'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: any) => <div data-private-preview={session.id} /> }))
const dom = composerDOM(), execute = promisify(execFile)
const original = useAppStore.getState()
let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined
let owner: Awaited<ReturnType<typeof owningBridge>> | undefined
let releaseReceipt: (() => void) | undefined
const pids = new Set<number>(), runs = new Set<string>()
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  releaseReceipt?.()
  if (scope) {
    const client = await scope.client()
    for (const runId of runs) await client.stopTerminal({ runId })
  }
  await owner?.dispose(); await scope?.cleanup()
  const remaining = [...pids].filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  expect(remaining).toEqual([])
  const output = process.env.AGENTMUX_REUSABLE_SHELL_NATIVE_RECEIPT
  if (output) await writeFile(output.replace(/\.json$/u, '-cleanup.json'), JSON.stringify({ privatePids: [...pids], remaining, privateRootRemoved: true, userRunTouched: false }) + '\n')
})
it('registered Main/preload and public Core preserve two original interactive shells and durable workfaces through actual owner and reader process restarts', async () => {
  scope = await headlessFixture()
  const client = await scope.client()
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local' as const, label: 'Private proof' }],
    workspaces: [{ id: 'private', kind: 'folder' as const, hostId: 'local', name: 'Private proof', path: scope.root }] }
  owner = await owningBridge({ client: client as never, store: new AgentMuxFileAgentSessionStore(join(scope.root, 'desktop-sessions.json')), config, scratchTopics: new ScratchTopics() })
  const tabs = Object.fromEntries(['A','B','recovery'].map(id => [id, createWorkbenchTab(id, { regionId: `region-${id}`, kind: 'launcher', workspaceId: 'private' })]))
  useAppStore.setState({ config, activeWorkspaceId: 'private', tabs, layouts: { private: createWorkspaceLayout('private-group', ['A','B','recovery']) },
    warmTerminal: null, sessions: [], unclaimedTerminalSessionIds: [], closingWorkbenchViews: {}, spaceZoneBindings: {}, spatialRequests: {},
    scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], workbenchSpaceSelection: null,
    agentComposerDrafts: { 'region-A': 'Original unsent private input' }, prewarmTerminal: original.prewarmTerminal,
    promoteWarmTerminal: original.promoteWarmTerminal, launchTerminal: original.launchTerminal, detectExecutors: vi.fn(async () => {}) })
  let A: SessionSnapshot | undefined
  const requests: TerminalLaunchInput[] = []
  const delayed = new Promise<void>(resolve => { releaseReceipt = resolve })
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async request => {
    requests.push(request)
    const session = await bridge.api!.sessions.launchTerminal(request)
    runs.add(session.control.run.runId)
    if (requests.length === 1) { A = session; await delayed }
    return session
  })
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => await owner!.runtime.refresh(control, config))
  const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async control => await bridge.api!.sessions.stop(control))
  useAppStore.getState().prewarmTerminal('private', 'region:region-A')
  await until(() => A, Boolean, 'original real private Run allocated before its reply is delivered')
  const openingA = useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'A', regionId: 'region-A' })
  expect(useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'A', regionId: 'region-A' })).toBe(openingA)
  await dom.render(<NewTabSurface tabGroupId="private-group" tabId="B" regionId="region-B" />)
  const open = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Open Terminal'))!
  expect(open).toBeDefined()
  await act(async () => { open.click(); await vi.waitFor(() => expect(useAppStore.getState().tabs.B?.regions['region-B']).toMatchObject({ phase: 'attached' }), { timeout: 15_000 }) })
  const B = useAppStore.getState().sessions.find(session => session.id !== A!.id)!
  expect(B).toBeDefined()
  expect(B.control.run.runId).not.toBe(A!.control.run.runId)
  expect(requests[1]!.createOperationId).not.toBe(requests[0]!.createOperationId)
  expect(requests.map(request => [request.hostId, request.workspacePath])).toEqual([['local', scope.root], ['local', scope.root]])
  // The original presentation is closed while its actual healthy Run is unknown to it.
  await act(async () => {
    const { A: _closed, ...remaining } = useAppStore.getState().tabs
    useAppStore.setState({ tabs: remaining, layouts: { private: createWorkspaceLayout('private-group', ['B','recovery']) } })
    releaseReceipt!(); await openingA
  })
  expect(useAppStore.getState().tabs.A).toBeUndefined()
  expect(useAppStore.getState().warmTerminal?.session?.id).toBe(A!.id)
  expect(stop).not.toHaveBeenCalled()
  await act(async () => { await useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'recovery', regionId: 'region-recovery' }) })
  expect(launch).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().tabs.recovery?.regions['region-recovery']).toMatchObject({ sessionId: A!.id, phase: 'attached' })
  const live = await client.listRuns()
  expect(live).toHaveLength(2)
  for (const run of live) { expect(run.state).toBe('running'); expect(run.pid).toBeGreaterThan(1); pids.add(run.pid!) }
  const workface = useAppStore.getState()
  const spatialPath = join(scope.root, 'spatial.json'), uiPath = join(scope.root, 'ui.json')
  const saved = await new AgentMuxSpatialStateStore(spatialPath).commit({ expectedRevision: 0, graph: desktopSpatialGraph(workface, []) })
  const persisted = useAppStore.persist.getOptions().partialize!(workface)
  await writeFile(uiPath, JSON.stringify(persisted))
  const before = { spatial: sha(await readFile(spatialPath)), ui: sha(await readFile(uiPath)) }
  const native = requests.map((request, index) => ({ request: { createOperationId: request.createOperationId, workspacePath: request.workspacePath },
    runId: index === 0 ? A!.control.run.runId : B.control.run.runId, pid: live.find(run => run.runId === (index === 0 ? A!.control.run.runId : B.control.run.runId))!.pid }))
  const ownerBefore = scope.owner
  await scope.restart()
  expect(scope.owner.ownerInstanceId).not.toBe(ownerBefore.ownerInstanceId)
  const child = await execute(process.execPath, [resolve('apps/desktop/test/fixtures/reusable-shell-openings/restart-reader.mjs'), scope.socketPath, spatialPath, uiPath, JSON.stringify(native)], { env: scope.env, timeout: 20_000 })
  const reread = JSON.parse(child.stdout.trim())
  expect(reread.pid).not.toBe(process.pid)
  expect(reread.spatial).toEqual(saved)
  expect(saved.graph.tabs.map(tab => tab.tabId).sort()).toEqual(['B', 'recovery'])
  expect(saved.graph.regions.map(region => region.runId).sort()).toEqual([A!.control.run.runId, B.control.run.runId].sort())
  expect(saved.graph.layouts).toEqual(workface.layouts)
  expect(reread.ui).toEqual(persisted)
  expect(reread.ui.agentComposerDrafts).toEqual({ 'region-A': 'Original unsent private input' })
  expect(reread.runs.map((run: any) => ({ runId: run.runId, pid: run.pid, state: run.state, interactive: run.interactive }))).toEqual(native.map(run => ({ runId: run.runId, pid: run.pid, state: 'running', interactive: true })))
  expect({ spatial: sha(await readFile(spatialPath)), ui: sha(await readFile(uiPath)) }).toEqual(before)
  const output = process.env.AGENTMUX_REUSABLE_SHELL_NATIVE_RECEIPT
  if (output) await writeFile(output, JSON.stringify({ passed: true, private: true, originalRequests: requests, originalRuns: native,
    originalOwner: ownerBefore, reopenedOwner: scope.owner, separateReaderPID: reread.pid, reread, durableBytes: before,
    boundary: 'Actual private official ctxmux retains original PTYs while Headless owner and public reader are restarted. Main IPC/preload is registered; DOM paint is isolated. Not a user Desktop restart or installation.',
    source: Object.fromEntries(await Promise.all(['apps/desktop/src/renderer/src/store.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts','packages/core/src/client.ts','packages/core/dist/index.js'].map(async path => [path, sha(await readFile(resolve(path)))]))) }, null, 2) + '\n')
}, 90_000)

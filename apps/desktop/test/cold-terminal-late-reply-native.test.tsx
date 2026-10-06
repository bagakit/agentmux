import { warmCandidates } from './helpers/reusable-shell-candidates'
// @vitest-environment happy-dom
import { act } from 'react'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, access } from 'node:fs/promises'
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
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { ScratchTopics } from '../src/main/scratch-topics'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import type { AppConfig, SessionSnapshot, TerminalLaunchInput } from '../src/shared/contracts'

vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: SessionSnapshot }) => <div data-private-preview={session.id} /> }))
const dom = composerDOM(), execute = promisify(execFile), original = useAppStore.getState()
let scope: Awaited<ReturnType<typeof headlessFixture>> | undefined
let owner: Awaited<ReturnType<typeof owningBridge>> | undefined
const pids = new Set<number>(), runs = new Set<string>(), releases: (() => void)[] = []
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  releases.forEach(release => release())
  const privateRoot = scope?.root
  try {
    if (scope) {
      const client = await scope.client()
      for (const run of await client.listRuns()) if (runs.has(run.runId) && run.state === 'running') await client.stopTerminal({ runId: run.runId })
    }
  } finally { try { await owner?.dispose() } finally { await scope?.cleanup() } }
  const remaining = [...pids].filter(pid => { try { process.kill(pid, 0); return true } catch { return false } })
  const privateRootRemoved = !privateRoot || await access(privateRoot).then(() => false, () => true)
  const output = process.env.AGENTMUX_COLD_TERMINAL_NATIVE_RECEIPT
  if (output) await writeFile(output.replace(/\.json$/u, '-cleanup.json'), JSON.stringify({ privatePids: [...pids], remaining, privateRootRemoved, userRunTouched: false }) + '\n')
  expect(remaining).toEqual([]); expect(privateRootRemoved).toBe(true)
})

it('actual mounted opening and closeRegion keep a late cold Run discoverable beside a claimed warm Run through private owner and reader restarts', async () => {
  scope = await headlessFixture()
  const client = await scope.client()
  const config: AppConfig = { ...structuredClone(DEFAULT_CONFIG), hosts: [{ id: 'local', kind: 'local', label: 'Private proof' }],
    workspaces: [{ id: 'private', kind: 'folder', hostId: 'local', name: 'Private proof', path: scope.root }] }
  owner = await owningBridge({ client: client as never, store: new AgentMuxFileAgentSessionStore(join(scope.root, 'desktop-sessions.json')), config, scratchTopics: new ScratchTopics() })
  const A = createWorkbenchTab('A', { regionId: 'region-A', kind: 'launcher', workspaceId: 'private' })
  const B = addWorkbenchRegion(createWorkbenchTab('B', { regionId: 'region-B', kind: 'launcher', workspaceId: 'private' }), 'region-B', 'right',
    { regionId: 'survivor-B', kind: 'launcher', workspaceId: 'private' })
  useAppStore.setState({ config, activeWorkspaceId: 'private', tabs: { A, B }, layouts: { private: createWorkspaceLayout('private-group', ['A', 'B']) },
    warmTerminals: {}, sessions: [], unclaimedTerminalSessionIds: [], closingWorkbenchViews: {}, spaceZoneBindings: {}, spatialRequests: {},
    scratchTopicSnapshots: {}, topicCategories: [], projectGroups: [], workbenchSpaceSelection: null,
    agentComposerDrafts: { 'region-B': 'Original unsent private input' }, prewarmTerminal: original.prewarmTerminal,
    promoteWarmTerminal: original.promoteWarmTerminal, launchTerminal: original.launchTerminal, detectExecutors: vi.fn(async () => {}) })
  const allocated: SessionSnapshot[] = [], requests: TerminalLaunchInput[] = []
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async request => {
    const index = requests.length
    requests.push(request)
    const wait = new Promise<void>(yes => { releases[index] = yes })
    const session = await bridge.api!.sessions.launchTerminal(request)
    allocated[index] = session; runs.add(session.control.run.runId)
    await wait; return session
  })
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => await owner!.runtime.refresh(control, config))
  const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async control => await bridge.api!.sessions.stop(control))
  useAppStore.getState().prewarmTerminal('private', 'region:region-A')
  await until(() => allocated[0], Boolean, 'private warm Run allocated')
  const openingA = useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'A', regionId: 'region-A' })
  const held = warmCandidates(scope!.root)[0]!
  expect(held.claimToken).toBeDefined()
  // Exercise the explicit cold opening without B's optional background prewarm.
  useAppStore.setState({ prewarmTerminal: vi.fn() })
  await dom.render(<NewTabSurface tabGroupId="private-group" tabId="B" regionId="region-B" />)
  const button = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent?.includes('Open Terminal'))
  expect(button).toBeDefined()
  let openingB: Promise<void> | undefined
  await act(async () => {
    button!.click()
    openingB = useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'B', regionId: 'region-B' })
    await until(() => allocated[1], Boolean, 'private cold Run allocated before its reply')
  })
  expect(useAppStore.getState().tabs.B?.regions['region-B']).toMatchObject({ kind: 'terminal', phase: 'launching' })
  await act(async () => { await useAppStore.getState().closeRegion('private', 'B', 'region-B') })
  const closed = useAppStore.getState().tabs
  await act(async () => { releases[1]!(); await openingB })
  const late = allocated[1]!
  expect(stop).not.toHaveBeenCalled()
  expect(useAppStore.getState().sessions).toContainEqual(late)
  expect(useAppStore.getState().tabs).toBe(closed)
  expect(useAppStore.getState().tabs.B?.regions['region-B']).toBeUndefined()
  expect(warmCandidates(scope!.root)[0]).toBe(held)
  await act(async () => { releases[0]!(); await openingA })
  await act(async () => { useAppStore.getState().selectSession(late.id, 'private-group') })
  const restored = Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'terminal' && region.sessionId === late.id)
  expect(restored).toHaveLength(1); expect(restored[0]!.regionId).not.toBe('region-B')
  expect(launch).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled()
  const live = await client.listRuns()
  expect(live).toHaveLength(2)
  for (const run of live) { expect(run.state).toBe('running'); expect(run.pid).toBeGreaterThan(1); pids.add(run.pid!) }
  const workface = useAppStore.getState(), spatialPath = join(scope.root, 'spatial.json'), uiPath = join(scope.root, 'ui.json')
  const saved = await new AgentMuxSpatialStateStore(spatialPath).commit({ expectedRevision: 0, graph: desktopSpatialGraph(workface, []) })
  const persisted = useAppStore.persist.getOptions().partialize!(workface)
  await writeFile(uiPath, JSON.stringify(persisted))
  const before = { spatial: sha(await readFile(spatialPath)), ui: sha(await readFile(uiPath)) }
  const native = requests.map((request, index) => ({ request: { createOperationId: request.createOperationId, workspacePath: request.workspacePath },
    runId: allocated[index]!.control.run.runId, pid: live.find(run => run.runId === allocated[index]!.control.run.runId)!.pid }))
  const ownerBefore = scope.owner
  await scope.restart()
  expect(scope.owner.ownerInstanceId).not.toBe(ownerBefore.ownerInstanceId)
  const child = await execute(process.execPath, [resolve('apps/desktop/test/fixtures/reusable-shell-openings/restart-reader.mjs'), scope.socketPath, spatialPath, uiPath, JSON.stringify(native)], { env: scope.env, timeout: 20_000 })
  const reread = JSON.parse(child.stdout.trim())
  expect(reread.pid).not.toBe(process.pid); expect(reread.spatial).toEqual(saved)
  expect(saved.graph.tabs.map(tab => tab.tabId).sort()).toEqual(Object.keys(workface.tabs).sort())
  expect(saved.graph.tabs.length).toBeGreaterThan(0)
  expect(saved.graph.regions.flatMap(region => region.runId ? [region.runId] : []).sort()).toEqual(native.map(run => run.runId).sort())
  expect(saved.graph.layouts).toEqual(workface.layouts); expect(reread.ui).toEqual(persisted)
  expect(reread.ui.agentComposerDrafts).toEqual({ 'region-B': 'Original unsent private input' })
  expect(reread.runs.map((run: { runId: string; pid: number; state: string; interactive: boolean }) => ({ runId: run.runId, pid: run.pid, state: run.state, interactive: run.interactive })))
    .toEqual(native.map(run => ({ runId: run.runId, pid: run.pid, state: 'running', interactive: true })))
  expect({ spatial: sha(await readFile(spatialPath)), ui: sha(await readFile(uiPath)) }).toEqual(before)
  const output = process.env.AGENTMUX_COLD_TERMINAL_NATIVE_RECEIPT
  if (output) await writeFile(output, JSON.stringify({ passed: true, private: true, lateRunId: late.control.run.runId, originalRequests: requests,
    originalRuns: native, originalOwner: ownerBefore, reopenedOwner: scope.owner, separateReaderPID: reread.pid, reread, durableBytes: before,
    boundary: 'Actual mounted NewTabSurface→Store busy-cache→cold launch→registered Main/preload→public Core→private official ctxmux. Actual closeRegion before late confirmation; existing discovery selects original Run into a new occurrence. Private Headless owner and separate public reader restart retain original PTYs, PIDs, and nonempty workface. Not installed Desktop/Renderer restart or user Run evidence.',
    source: Object.fromEntries(await Promise.all(['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts',
      'apps/desktop/src/preload/index.ts', 'packages/core/src/client.ts', 'packages/core/dist/index.js'].map(async path => [path, sha(await readFile(resolve(path)))]))) }, null, 2) + '\n')
}, 90_000)

import { fixtureEpoch as _batchFixtureEpoch } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createElement } from 'react'
import { act } from 'react'
import { expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createClientUiRoot as createRoot } from './helpers/client-ui-render'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { executionAgent, installNativePopover, moteConfig } from './fixtures/mote-workface'
import { App } from '../src/renderer/src/App'
import { api } from '../src/renderer/src/lib/api'
import { addWorkbenchRegion, createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'

vi.mock('react-resizable-panels', () => createRequire(import.meta.url)(
  '../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// The original App, Focus, Workbench and persistence owners remain live. These
// painting leaves avoid claiming a Native PTY or Provider Runtime in this test.
vi.mock('../src/renderer/src/components/SessionPane', () => ({
  SessionPane: ({ sessionId }: { sessionId: string }) => {
    const draft = useAppStore(state => state.agentComposerDrafts[sessionId] ?? '')
    return createElement('section', { 'data-restored-agent': sessionId },
      createElement('textarea', { 'aria-label': 'Restored original draft', value: draft, readOnly: true }))
  }
}))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))

const initial = useAppStore.getState()
type State = ReturnType<typeof useAppStore.getState>
type Saved = {
  parentPid: number
  ownerPath: string
  record: string
  config: NonNullable<State['config']>
  sessions: State['sessions']
  tabs: State['tabs']
  layouts: State['layouts']
  choice: State['workbenchSpaceSelection']
  drafts: State['agentComposerDrafts']
  agentFocus: State['agentFocus']
  viewModes: State['viewModes']
  browserRegionId: string
  agentRegionId: string
  tabId: string
}

function connectDiskOwner(path: string) {
  const owner = new AgentMuxSpatialStateStore(path)
  const commits = vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  return { owner, commits }
}

async function restoreInFreshProcess(saved: Saved, proofPath: string) {
  expect(process.pid).not.toBe(saved.parentPid)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  localStorage.setItem('agentmux-workbench-v1', saved.record)
  useAppStore.setState(initial, true)
  await useAppStore.persist.rehydrate()
  const { owner } = connectDiskOwner(saved.ownerPath)
  const graph = (await owner.read())!.graph
  expect(graph.regions.some(region => region.regionId === saved.browserRegionId)).toBe(false)
  expect(graph.resources).not.toHaveProperty(`region:${saved.browserRegionId}`)
  vi.spyOn(api.config, 'get').mockResolvedValue(saved.config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: saved.sessions, timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
  // Startup may ask Core to reattach the saved healthy identity. Supply that
  // declared boundary receipt; no Native process is started by this fixture.
  const recovery = vi.spyOn(api.sessions, 'recover').mockImplementation(async control => {
    expect(control).toEqual(saved.sessions[0]!.control)
    return { kind: 'reattachable', session: saved.sessions[0]! }
  })
  const lifecycle = ['launchAgent', 'launchTerminal', 'resume', 'stop', 'write', 'interrupt', 'submitPrompt', 'attach']
    .map(name => vi.spyOn(api.sessions, name as keyof typeof api.sessions))
  const dispose = await useAppStore.getState().initialize()
  const restorePopover = installNativePopover()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await vi.waitFor(() => expect(useAppStore.getState().sessions).toHaveLength(saved.sessions.length))
    const state = useAppStore.getState()
    expect(state.tabs).toEqual(saved.tabs)
    expect(state.layouts).toEqual(saved.layouts)
    expect(state.workbenchSpaceSelection).toEqual(saved.choice)
    expect(state.agentComposerDrafts).toEqual(saved.drafts)
    expect(state.agentFocus).toEqual(saved.agentFocus)
    expect(state.viewModes).toEqual(saved.viewModes)
    expect(state.sessions.map(session => ({ id: session.id, hostId: session.hostId, control: session.control })))
      .toEqual(saved.sessions.map(session => ({ id: session.id, hostId: session.hostId, control: session.control })))
    useAppStore.setState({ initialize: async () => () => {} })
    await act(async () => root.render(createElement(App)))
    expect(container.querySelector('.focus-location-recovery')).toBeNull()
    expect(container.querySelector('.focused-tab-workspace')?.getAttribute('data-focus-tab-id')).toBe(saved.tabId)
    expect(container.querySelector(`[data-workbench-region-id="${saved.agentRegionId}"]`)).not.toBeNull()
    expect(container.querySelector(`[data-workbench-region-id="${saved.browserRegionId}"]`)).toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Restored original draft"]')?.value)
      .toBe(saved.drafts[saved.sessions[0]!.id])
    for (const call of lifecycle) expect(call).not.toHaveBeenCalled()
    await prepareRendererUpdate()
    const after = (await owner.read())!.graph
    expect(after.regions.some(region => region.regionId === saved.browserRegionId)).toBe(false)
    expect(after.resources).not.toHaveProperty(`region:${saved.browserRegionId}`)
    await writeFile(proofPath, JSON.stringify({ pid: process.pid, parentPid: saved.parentPid,
      recordSha256: createHash('sha256').update(saved.record).digest('hex'),
      choice: state.workbenchSpaceSelection, tabs: state.tabs, layouts: state.layouts,
      sessions: state.sessions.map(session => ({ id: session.id, hostId: session.hostId, control: session.control })),
      drafts: state.agentComposerDrafts, agentFocus: state.agentFocus, viewModes: state.viewModes,
      closedBrowserRegionAbsentBeforeAndAfterSave: true, lifecycleCalls: lifecycle.map(call => call.mock.calls.length),
      exactReattachmentChecks: recovery.mock.calls.length,
      scope: 'Fresh Node/Vitest process, real Core disk owner, original Store hydration and actual App/Focus/Workbench. Native painting leaves are isolated; this is not Provider Runtime recovery.'
    }, null, 2))
  } finally {
    await act(async () => root.unmount())
    container.remove()
    restorePopover()
    dispose()
  }
}

it('persists confirmed event-first Browser removal through two fresh client processes without reviving its Region', async () => {
  const childRecord = process.env.AGENTMUX_BROWSER_RESTART_RECORD
  if (childRecord) {
    const saved = JSON.parse(await readFile(childRecord, 'utf8')) as Saved
    await restoreInFreshProcess(saved, process.env.AGENTMUX_BROWSER_RESTART_PROOF!)
    return
  }
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  const directory = await mkdtemp(join(tmpdir(), 'amux-browser-close-'))
  const evidence = process.env.AGENTMUX_BROWSER_RESTART_EVIDENCE
  if (evidence) await mkdir(evidence, { recursive: true })
  let dispose: (() => void) | undefined
  try {
    const config = { ...moteConfig, workspaces: moteConfig.workspaces.filter(workspace => workspace.id === 'project') }
    const browser = await api.browser.create('original-browser', 'https://example.test', 'project')
    const tab = addWorkbenchRegion(createWorkbenchTab('original-tab', {
      kind: 'agent', phase: 'attached', workspaceId: 'project', regionId: 'original-agent-region', sessionId: executionAgent.id
    }), 'original-agent-region', 'right', {
      ...browser, kind: 'browser', workspaceId: 'project', regionId: 'closed-browser-region', browserId: browser.id
    })
    useAppStore.setState({ ...initial, loading: false, config, sessions: [executionAgent],
      tabs: { [tab.id]: tab }, layouts: { project: createWorkspaceLayout('original-group', [tab.id]) },
      mainSurface: 'agents', activeWorkspaceId: 'project', toolsOpen: false, projectRailOpen: false,
      agentFocus: { execution: { sessionId: executionAgent.id, history: [{ sessionId: executionAgent.id, focusedAt: _batchFixtureEpoch(0, 0, 1) }] }, pmo: { sessionId: null } },
      agentComposerDrafts: { [executionAgent.id]: 'Original unsent draft must survive' },
      viewModes: { [executionAgent.id]: 'terminal' } }, true)
    const { owner, commits } = connectDiskOwner(join(directory, 'spatial.json'))
    vi.spyOn(api.sessions, 'recover').mockImplementation(async control => {
      expect(control).toEqual(executionAgent.control)
      return { kind: 'reattachable', session: executionAgent }
    })
    await owner.commit({ expectedRevision: 0, graph: desktopSpatialGraph(useAppStore.getState(), []) })
    await initializeSpatialControlFixture()
    dispose = await useAppStore.getState().initialize()
    await vi.waitFor(() => expect(useAppStore.getState().sessions).toHaveLength(1))
    useAppStore.getState().selectMainRegion({ displayWorkspaceId: 'project', groupId: 'original-group',
      tabId: tab.id, regionId: 'closed-browser-region' }, useAppStore.getState().workbenchSpaceSelection)
    await prepareRendererUpdate()
    const before = useAppStore.getState()
    expect((await owner.read())!.graph.regions.some(region => region.regionId === 'closed-browser-region')).toBe(true)
    useAppStore.getState().applyBrowserEvent({ type: 'closed', id: browser.id })
    await prepareRendererUpdate()
    const state = useAppStore.getState(), graph = (await owner.read())!.graph
    expect(state.tabs[tab.id]!.layout.root).toEqual({ type: 'leaf', regionId: 'original-agent-region' })
    expect(state.tabs[tab.id]!.layout.activeRegionId).toBe('original-agent-region')
    expect(state.workbenchSpaceSelection).toMatchObject({ workspaceId: 'project', groupId: 'original-group',
      tabId: tab.id, regionId: 'original-agent-region' })
    expect(state.sessions[0]).toBe(before.sessions[0])
    expect(state.agentComposerDrafts).toBe(before.agentComposerDrafts)
    expect(state.agentFocus).toBe(before.agentFocus)
    expect(graph.regions.some(region => region.regionId === 'closed-browser-region')).toBe(false)
    expect(graph.resources).not.toHaveProperty('region:closed-browser-region')
    expect(graph.tabLayouts[tab.id]).toEqual(state.tabs[tab.id]!.layout)
    expect(commits.mock.calls.some(([input]) => input.allowEntityRemoval === true)).toBe(true)
    const saved: Saved = { parentPid: process.pid, ownerPath: owner.path,
      record: localStorage.getItem('agentmux-workbench-v1')!, config, sessions: state.sessions,
      tabs: state.tabs, layouts: state.layouts, choice: state.workbenchSpaceSelection,
      drafts: state.agentComposerDrafts, agentFocus: state.agentFocus, viewModes: state.viewModes,
      browserRegionId: 'closed-browser-region', agentRegionId: 'original-agent-region', tabId: tab.id }
    expect(JSON.parse(saved.record).state).not.toHaveProperty('tabs')
    const recordPath = join(directory, 'handoff.json')
    await writeFile(recordPath, JSON.stringify(saved))
    // Dispose the original subscriptions before starting either new process.
    dispose(); dispose = undefined
    const repository = resolve(import.meta.dirname, '../../..')
    const configPath = process.env.AGENTMUX_BROWSER_RESTART_CONFIG ?? join(repository, 'vitest.config.ts')
    const proofs = []
    for (let restart = 0; restart < 2; restart++) {
      const proofPath = join(directory, `child-${restart}.json`)
      const env = { ...Object.fromEntries(Object.entries(process.env)
        .filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_'))),
        AGENTMUX_BROWSER_RESTART_RECORD: recordPath, AGENTMUX_BROWSER_RESTART_PROOF: proofPath }
      let result: { stdout: string; stderr: string }
      try {
        result = await promisify(execFile)(process.execPath,
          [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', configPath,
            'apps/desktop/test/focus-browser-close-restart.test.tsx', '--reporter=json', '--outputFile', join(directory, `vitest-${restart}.json`)],
          { cwd: repository, env, timeout: 30000 })
      } catch (error) {
        if (evidence) {
          const failure = error as { stdout?: string; stderr?: string }
          await writeFile(join(evidence, `child-${restart}.failure.log`), (failure.stdout ?? '') + (failure.stderr ?? ''))
          const report = await readFile(join(directory, `vitest-${restart}.json`), 'utf8')
          await writeFile(join(evidence, `child-${restart}.failure.json`), report)
        }
        throw error
      }
      const proof = JSON.parse(await readFile(proofPath, 'utf8'))
      expect(proof.parentPid).toBe(process.pid)
      expect(proof.pid).not.toBe(process.pid)
      proofs.push(proof)
      if (evidence) {
        await writeFile(join(evidence, `child-${restart}.json`), JSON.stringify(proof, null, 2))
        await writeFile(join(evidence, `child-${restart}.log`), result.stdout + result.stderr)
        await writeFile(join(evidence, `vitest-${restart}.json`), await readFile(join(directory, `vitest-${restart}.json`)))
      }
    }
    expect(proofs[0].pid).not.toBe(proofs[1].pid)
    if (evidence) await writeFile(join(evidence, 'process-receipt.json'), JSON.stringify({ parentPid: process.pid,
      restoredPids: proofs.map(proof => proof.pid), originalRecordSha256: proofs[0].recordSha256,
      diskRegionRemoved: true, collapsedLayoutRestored: true, originalMainChoiceRestored: true,
      exactHostSessionRunControlRetained: true, nonemptyDraftAndModeRestored: true,
      scope: proofs[0].scope }, null, 2))
  } finally {
    dispose?.()
    await rm(directory, { recursive: true, force: true })
    useAppStore.setState(initial, true)
    localStorage.clear()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
}, 90000)

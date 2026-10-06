const { fixturePath, fixtureEpoch } = await vi.hoisted(async () => await import('../../../test/fixture-values.mjs'))
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AGENTMUX_CONTROL_SCHEMA_VERSION, type AgentMuxControlRequest } from '@agentmux/core'
import { createWorkspaceLayout } from '@agentmux/layout'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, replaceWorkbenchRegion, workbenchSurfaces } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'

vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))

const original = useAppStore.getState()
const config: AppConfig = {
  version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'workspace', name: 'Project', hostId: 'local', path: fixturePath('project'), kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } }
}
function terminal(): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return {
    id: 'created-run', kind: 'terminal', providerId: null, hostId: 'local', workspacePath: fixturePath('project'),
    label: 'Terminal', createdAt: fixtureEpoch(0, 0, 1), updatedAt: fixtureEpoch(0, 0, 1), processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: fixtureEpoch(0, 0, 1) }, latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: 'created-run', run: { runId: 'created-run' } }
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const tab = createWorkbenchTab('original-tab', { regionId: 'original-region', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ config, sessions: [], tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('group', [tab.id]) }, activeWorkspaceId: 'workspace', mainSurface: 'workbench',
    closingWorkbenchViews: {}, spatialRequests: {}, spaceZoneBindings: {}, pendingAgentLaunches: {}, error: null })
  const request: Extract<AgentMuxControlRequest, { operation: 'open.terminal' }> = {
    schemaVersion: AGENTMUX_CONTROL_SCHEMA_VERSION, requestId: 'original-creation', operation: 'open.terminal',
    shellCommand: 'echo fixture', destination: { kind: 'split', direction: 'right', region: { kind: 'region', regionId: 'original-region' } }
  }
  const launch = deferred<SessionSnapshot>()
  const start = vi.spyOn(api.sessions, 'launchTerminal').mockReturnValue(launch.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  const controller = new AbortController()
  const cancel = () => controller.abort(Object.assign(new Error('Reply reader ended'), { code: 'CONTROL_CANCELLED' }))
  const begin = () => {
    const result = useAppStore.getState().executeControl(request, controller.signal)
    // Observe rejection now, while the test controls the admitted reply.
    const settled = result.then(value => ({ value, error: null }), error => ({ value: null, error }))
    const pending = workbenchSurfaces(useAppStore.getState().tabs[tab.id]!).find(surface => surface.regionId !== 'original-region')!
    return { result, settled, pending }
  }
  return { tab, request, launch, start, stop, controller, cancel, begin }
}
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(original, true) })

describe('public Terminal creation observation', () => {
  it('does not dispatch or change layout for an already cancelled reader', async () => {
    const f = fixture(), before = useAppStore.getState()
    f.cancel()
    const opening = useAppStore.getState().executeControl(f.request, f.controller.signal)
    f.launch.resolve(terminal())
    await expect(opening).rejects.toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(f.start).not.toHaveBeenCalled()
    expect(f.stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
  })

  it('binds the original late Run after reader cancellation without Stop or another Start', async () => {
    const f = fixture(), opening = f.begin()
    const pendingLayout = useAppStore.getState().layouts.workspace
    f.cancel()
    expect(useAppStore.getState().tabs[f.tab.id]!.regions[opening.pending.regionId]).toBe(opening.pending)
    f.launch.resolve(terminal())
    expect((await opening.settled).error).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(useAppStore.getState().tabs[f.tab.id]!.regions[opening.pending.regionId]).toMatchObject({ kind: 'terminal', phase: 'attached', sessionId: 'created-run' })
    expect(useAppStore.getState().layouts.workspace).toBe(pendingLayout)
    expect(useAppStore.getState().sessions).toEqual([terminal()])
    expect(f.start).toHaveBeenCalledOnce()
    expect(f.start).toHaveBeenCalledWith({ hostId: 'local', workspacePath: fixturePath('project'), createOperationId: f.request.requestId, shellCommand: 'echo fixture' })
    expect(f.stop).not.toHaveBeenCalled()
  })

  it.each(['closed', 'replaced'] as const)('keeps the late Run discoverable without reviving its %s Region', async change => {
    const f = fixture(), opening = f.begin()
    if (change === 'closed') await useAppStore.getState().closeRegion('workspace', f.tab.id, opening.pending.regionId)
    else useAppStore.setState(state => ({ tabs: { ...state.tabs, [f.tab.id]: replaceWorkbenchRegion(state.tabs[f.tab.id]!, opening.pending.regionId,
      { regionId: opening.pending.regionId, kind: 'file', workspaceId: 'workspace', path: 'notes.md' }) } }))
    const before = useAppStore.getState()
    f.launch.resolve(terminal())
    expect((await opening.settled).error).toMatchObject({ code: 'CONTROL_OWNER_LOST' })
    expect(useAppStore.getState().tabs).toBe(before.tabs)
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(useAppStore.getState().sessions).toEqual([terminal()])
    expect(f.stop).not.toHaveBeenCalled()
  })

  it('binds a cancelled late result to its current promoted Tab without reverting later focus', async () => {
    const f = fixture(), opening = f.begin()
    useAppStore.getState().promoteRegionToTab('workspace', f.tab.id, opening.pending.regionId)
    const owner = Object.values(useAppStore.getState().tabs).find(tab => tab.regions[opening.pending.regionId])!
    const before = useAppStore.getState()
    f.cancel(); f.launch.resolve(terminal())
    expect((await opening.settled).error).toMatchObject({ code: 'CONTROL_CANCELLED' })
    expect(useAppStore.getState().tabs[owner.id]!.regions[opening.pending.regionId]).toMatchObject({ sessionId: 'created-run', phase: 'attached' })
    expect(useAppStore.getState().layouts).toBe(before.layouts)
    expect(f.stop).not.toHaveBeenCalled()
  })

  it.each(['host', 'directory', 'kind'] as const)('rejects a mismatched %s result without stopping it or deleting the original Region', async mismatch => {
    const f = fixture(), opening = f.begin(), result: SessionSnapshot = mismatch === 'host' ? { ...terminal(), hostId: 'other-host' }
      : mismatch === 'directory' ? { ...terminal(), workspacePath: fixturePath('other-project') }
      : { ...terminal(), kind: 'agent', providerId: 'codex', executorId: 'codex', agentSessionUpdatedAt: fixtureEpoch(0, 0, 1),
        capabilities: { terminal: true, timeline: 'streaming', permission: 'observe', providerResume: true, replyCorrelation: 'none' },
        control: { kind: 'agent', hostId: 'local', agentSessionId: 'created-run', run: { runId: 'created-run' } } }
    const catalog = useAppStore.getState().sessions
    f.launch.resolve(result)
    expect((await opening.settled).error).toMatchObject({ code: 'LAUNCH_RESULT_MISMATCH' })
    expect(useAppStore.getState().tabs[f.tab.id]!.regions[opening.pending.regionId]).toBe(opening.pending)
    expect(useAppStore.getState().sessions).toBe(catalog)
    expect(f.stop).not.toHaveBeenCalled()
  })

  it.each(['unknown', 'missing', 'not_applied'] as const)('rolls back only an accurate not_applied creation receipt (%s)', async disposition => {
    const f = fixture(), opening = f.begin()
    f.launch.reject(Object.assign(new Error('Creation reply unavailable'), disposition === 'missing' ? {}
      : { controlFailure: { disposition, confirmedInputBytes: null } }))
    expect((await opening.settled).error).toMatchObject({ message: 'Creation reply unavailable' })
    if (disposition === 'not_applied') expect(useAppStore.getState().tabs[f.tab.id]).toEqual(f.tab)
    else expect(useAppStore.getState().tabs[f.tab.id]!.regions[opening.pending.regionId]).toBe(opening.pending)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.start).toHaveBeenCalledOnce()
  })

  it('retains an unconfirmed creation after its reader ends and the reply fails', async () => {
    const f = fixture(), opening = f.begin()
    f.cancel(); f.launch.reject(new Error('Transport lost'))
    expect((await opening.settled).error).toMatchObject({ message: 'Transport lost' })
    expect(useAppStore.getState().tabs[f.tab.id]!.regions[opening.pending.regionId]).toBe(opening.pending)
    expect(f.stop).not.toHaveBeenCalled()
  })
})

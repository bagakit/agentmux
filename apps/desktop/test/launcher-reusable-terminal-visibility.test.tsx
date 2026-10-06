// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: ({ session, visible }: any) => <div data-warm-run={session.control.run.runId} data-visible={String(visible)} />
}))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), original = useAppStore.getState(), launcherInitial = useLauncherState.getState()
const project = composerConfig.workspaces[0]!
const other = { ...project, id: 'other', name: 'Other', path: fixturePath('other') }
const key = warmTerminalKey(project.hostId, project.path)
const owner = (id: string) => `region:region-${id}`
const shell = (id: string, path = project.path) => ({ ...composerSession(id), kind: 'terminal' as const,
  providerId: null, workspacePath: path,
  control: { kind: 'terminal' as const, hostId: 'local', runId: id, run: { runId: id } } })
let secondProject = false
beforeEach(() => {
  secondProject = false
  const A = createWorkbenchTab('A', { regionId: 'region-A', kind: 'launcher', workspaceId: project.id })
  const B = createWorkbenchTab('B', { regionId: 'region-B', kind: 'launcher', workspaceId: project.id })
  useAppStore.setState({ activeWorkspaceId: project.id, mainSurface: 'workbench', warmTerminals: {},
    tabs: { A, B }, layouts: { [project.id]: createWorkspaceLayout('group', ['A', 'B']) },
    config: { ...composerConfig, workspaces: [project, other] }, sessions: [], unclaimedTerminalSessionIds: [],
    workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null, retainedSpatialFocus: null,
    prewarmTerminal: original.prewarmTerminal, releaseWarmTerminal: original.releaseWarmTerminal,
    promoteWarmTerminal: original.promoteWarmTerminal, retryWarmTerminal: original.retryWarmTerminal,
    detectExecutors: vi.fn(async () => {}) })
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null })
})
afterEach(async () => { await act(async () => useLauncherState.setState(launcherInitial, true)) })
function pair(showA = true, showB = true) {
  return <>
    <section data-launcher="A"><NewTabSurface tabGroupId="group" tabId="A" regionId="region-A" visible={showA} /></section>
    <section data-launcher="B"><NewTabSurface tabGroupId={secondProject ? 'other-group' : 'group'} tabId="B" regionId="region-B" visible={showB} /></section>
  </>
}
function runs(id?: string): string[] {
  const container = id ? dom.container.querySelector(`[data-launcher="${id}"]`)! : dom.container
  return [...container.querySelectorAll<HTMLElement>('[data-warm-run][data-visible="true"]')].map(node => node.dataset.warmRun!)
}
function launchShells() {
  let count = 0
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(async input => shell(`shell-${++count}`, input.workspacePath))
  const stop = vi.spyOn(api.sessions, 'stop')
  return { launch, stop }
}
function focus(id: 'A' | 'B') {
  useAppStore.setState({ workbenchSpaceSelection: { spaceId: null, zoneId: null, topicId: null,
    workspaceId: project.id, groupId: 'group', tabId: id, regionId: `region-${id}` } })
}

it('two projects each show their own reusable Terminal without a foreign-project warning', async () => {
  secondProject = true
  useAppStore.setState(state => ({ tabs: { ...state.tabs, B: createWorkbenchTab('B', {
    regionId: 'region-B', kind: 'launcher', workspaceId: other.id }) },
    layouts: { [project.id]: createWorkspaceLayout('group', ['A']), [other.id]: createWorkspaceLayout('other-group', ['B']) } }))
  const { launch, stop } = launchShells()
  await dom.render(pair())
  expect(runs('A')).toHaveLength(1); expect(runs('B')).toHaveLength(1)
  expect(new Set(runs()).size).toBe(2)
  expect(launch.mock.calls.map(([input]) => input.workspacePath).sort()).toEqual([project.path, other.path].sort())
  expect(dom.container.textContent).not.toContain('another project')
  expect(stop).not.toHaveBeenCalled()
})

it('two visible Launchers in one project keep independent live Runs without stealing the first preview', async () => {
  const { launch, stop } = launchShells()
  await dom.render(pair())
  const first = runs('A'), second = runs('B')
  expect(first).toHaveLength(1); expect(second).toHaveLength(1)
  expect(first[0]).not.toBe(second[0])
  expect(useAppStore.getState().warmTerminals[key]).toHaveLength(2)
  await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Updated Agent' } }))
  expect(runs('A')).toEqual(first); expect(runs('B')).toEqual(second)
  expect(launch).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled()
})

it('moving input focus between still-visible Launchers never removes either Terminal', async () => {
  const { launch, stop } = launchShells()
  await dom.render(pair())
  const first = runs('A'), second = runs('B')
  expect(new Set([...first, ...second]).size).toBe(2)
  await act(async () => focus('A'))
  expect(runs('A')).toEqual(first); expect(runs('B')).toEqual(second)
  await act(async () => focus('B'))
  expect(runs('A')).toEqual(first); expect(runs('B')).toEqual(second)
  expect(launch).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled()
})

it('hiding a preview releases only its presentation so another Launcher can reuse the same project Run', async () => {
  const { launch, stop } = launchShells()
  await dom.render(pair(true, false))
  const first = runs('A')
  expect(first).toHaveLength(1); expect(runs('B')).toEqual([])
  expect(launch).toHaveBeenCalledOnce()
  await dom.render(pair(false, false))
  expect(useAppStore.getState().warmTerminals[key]![0]?.ownerLauncherId).toBeNull()
  await dom.render(pair(false, true))
  expect(runs('A')).toEqual([]); expect(runs('B')).toEqual(first)
  expect(useAppStore.getState().warmTerminals[key]![0]?.ownerLauncherId).toBe(owner('B'))
  expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
})

it('collapsing and restoring the real Terminal section keeps its original Run reusable', async () => {
  const { launch, stop } = launchShells()
  await dom.render(pair(true, false))
  const first = runs('A')
  expect(first).toHaveLength(1)
  await dom.click('[data-launcher="A"] [aria-label="Collapse Terminal"]')
  expect(runs('A')).toEqual([])
  expect(useAppStore.getState().warmTerminals[key]![0]?.ownerLauncherId).toBeNull()
  await dom.click('[data-launcher="A"] [aria-label="Expand Terminal"]')
  expect(runs('A')).toEqual(first)
  expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
})

it('unmounting a Launcher leaves its exact Run available to the next project preview', async () => {
  const { launch, stop } = launchShells()
  await dom.render(pair(true, false))
  const first = runs('A')
  expect(first).toHaveLength(1)
  await dom.render(<></>)
  expect(useAppStore.getState().warmTerminals[key]![0]?.ownerLauncherId).toBeNull()
  await dom.render(pair(false, true))
  expect(runs('B')).toEqual(first)
  expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
})

it('a nonactivating Control navigation keeps the existing preview and does not start another PTY', async () => {
  const { launch, stop } = launchShells()
  await dom.render(pair(true, false))
  const first = runs('A')
  expect(first).toHaveLength(1)
  await act(async () => { focus('A'); useAppStore.setState({ workbenchNavigationInputPolicy: 'preserve' }) })
  await dom.render(pair())
  expect(runs('A')).toEqual(first); expect(runs('B')).toEqual([])
  expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
  // The same mounted Launcher becomes usable after the human explicitly selects it.
  await act(async () => { focus('B'); useAppStore.setState({ workbenchNavigationInputPolicy: null }) })
  expect(runs('A')).toEqual(first); expect(runs('B')).toHaveLength(1)
  expect(runs('B')[0]).not.toBe(first[0])
  expect(launch).toHaveBeenCalledTimes(2)
})

it('hiding and returning to an unconfirmed preview preserves its original Check again request', async () => {
  const unknown = Object.assign(new Error('The original shell receipt is unavailable'), {
    code: 'CTXMUX_IO', controlFailure: { disposition: 'unknown', confirmedInputBytes: null }
  })
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown).mockResolvedValue(shell('recovered'))
  const stop = vi.spyOn(api.sessions, 'stop')
  await dom.render(pair(true, false))
  const request = launch.mock.calls[0]![0]
  expect(dom.container.querySelector('[data-launcher="A"] .launcher-terminal-recovery-actions button')).not.toBeNull()
  await dom.render(pair(false, false))
  await dom.render(pair(true, false))
  expect(dom.container.querySelector('[data-launcher="A"] .launcher-terminal-recovery-actions button')).not.toBeNull()
  expect(launch).toHaveBeenCalledOnce()
  await dom.click('[data-launcher="A"] .launcher-terminal-recovery-actions button')
  expect(launch).toHaveBeenCalledTimes(2)
  expect(launch.mock.calls[1]![0]).toEqual(request)
  expect(runs('A')).toEqual(['recovered'])
  expect(stop).not.toHaveBeenCalled()
})

it('a hidden pending request remains its original Launcher request while another preview opens independently', async () => {
  let resolve!: (session: ReturnType<typeof shell>) => void
  const receipt = new Promise<ReturnType<typeof shell>>(yes => { resolve = yes })
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockReturnValueOnce(receipt).mockResolvedValue(shell('B'))
  const stop = vi.spyOn(api.sessions, 'stop')
  await dom.render(pair(true, false))
  const request = launch.mock.calls[0]![0]
  expect(launch).toHaveBeenCalledOnce()
  await dom.render(pair(false, true))
  expect(runs('B')).toEqual(['B'])
  expect(launch).toHaveBeenCalledTimes(2)
  await dom.render(pair())
  expect(useAppStore.getState().warmTerminals[key]!.find(item => item.ownerLauncherId === owner('A'))?.creation?.request).toEqual(request)
  expect(dom.container.querySelector('[data-launcher="A"] .launcher-terminal-pending')?.textContent).toContain('Preparing')
  expect(launch).toHaveBeenCalledTimes(2)
  await act(async () => { resolve(shell('A')); await receipt })
  expect(runs('A')).toEqual(['A']); expect(runs('B')).toEqual(['B'])
  expect(launch).toHaveBeenCalledTimes(2); expect(stop).not.toHaveBeenCalled()
})

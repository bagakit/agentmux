import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: any) => <div data-warm-run={session.id} /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), launcherInitial = useLauncherState.getState()
const original = useAppStore.getState()
const shell = (id = 'same-original-run') => ({ ...composerSession(id), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: id, run: { runId: id } } })
const unknown = () => Object.assign(new Error('The original shell receipt was lost.'), {
  code: 'CTXMUX_IO', detail: 'start receipt unavailable', controlFailure: { disposition: 'unknown', confirmedInputBytes: null }
})
beforeEach(() => {
  const tab = createWorkbenchTab('launcher', { regionId: 'input', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ activeWorkspaceId: 'workspace', mainSurface: 'workbench', warmTerminal: null,
    tabs: { launcher: tab }, layouts: { workspace: createWorkspaceLayout('group', [tab.id]) },
    workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null, runtimeEndpointWarnings: [],
    prewarmTerminal: original.prewarmTerminal, retryWarmTerminal: original.retryWarmTerminal,
    promoteWarmTerminal: original.promoteWarmTerminal, detectExecutors: vi.fn().mockResolvedValue(undefined),
    agentComposerDrafts: { input: 'Complete original task\nKeep the second line' }, unclaimedTerminalSessionIds: [] })
  useLauncherState.setState({ sections: {}, drafts: {}, executors: {}, persistenceIssue: null })
})
afterEach(() => useLauncherState.setState(launcherInitial, true))
const render = () => dom.render(<NewTabSurface tabGroupId="group" tabId="launcher" regionId="input" />)

describe('the real Launcher keeps and reconciles its original shell creation', () => {
  it('renders a reachable same-operation Check again after receipt loss without a rerender loop', async () => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown())
      .mockImplementation(() => new Promise(() => {}))
    await render()
    const held = useAppStore.getState().warmTerminal!
    expect(held.creation?.request).toEqual(launch.mock.calls[0]![0])
    expect(held.creation?.issue).toMatchObject({ code: 'CTXMUX_IO', message: 'The original shell receipt was lost.',
      detail: 'start receipt unavailable', controlFailure: { disposition: 'unknown' } })
    expect(dom.container.querySelector('.launcher-terminal-pending')?.textContent).toContain('Shell connection needs checking')
    expect(dom.container.querySelector('.service-window__original')?.textContent).toContain(held.creation!.request.createOperationId)
    await act(async () => useAppStore.setState({ agentNames: { unrelated: 'Healthy Agent' } }))
    expect(launch).toHaveBeenCalledOnce()
    launch.mockResolvedValue(shell() as never)
    await dom.click('.launcher-terminal-recovery-actions button')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
    expect(dom.container.querySelector('[data-warm-run="same-original-run"]')).not.toBeNull()
    expect(useAppStore.getState().warmTerminal?.creation?.issue).toBeUndefined()
    expect(dom.draft('input')).toBe('Complete original task\nKeep the second line')
    expect(useAppStore.getState().sessions[0]!.id).toBe('agent-1')
  })

  it('shows a confirmed creation refusal without claiming that its shell might already exist', async () => {
    vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(Object.assign(new Error('The Host refused this shell creation.'), {
      code: 'CONTROL_REFUSED', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 }
    }))
    await render()
    const details = dom.container.querySelector('.service-window__original')?.textContent
    expect(details).toContain('The Host confirmed this request was not applied.')
    expect(details).toContain('CONTROL_REFUSED')
    expect(details).not.toContain('may already be running')
    expect(dom.container.querySelector('.launcher-terminal-recovery-actions button')?.hasAttribute('disabled')).toBe(false)
  })

  it('Open Terminal confirms the same failed creation before attaching its original Run', async () => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown()).mockResolvedValue(shell() as never)
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(shell() as never)
    await render()
    await dom.click('.launcher-terminal-recovery-actions button:last-child')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', sessionId: 'same-original-run' })
    expect(useAppStore.getState().sessions.filter(item => item.id === 'same-original-run')).toHaveLength(1)
    expect(dom.draft('input')).toBe('Complete original task\nKeep the second line')
  })

  it('keeps a pending creation that fails during promotion for an explicit same-request retry', async () => {
    let reject!: (error: Error) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
    await render()
    const originalRequest = launch.mock.calls[0]![0]
    let promotion!: Promise<void>
    await act(async () => {
      promotion = useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' })
      reject(unknown())
      await expect(promotion).rejects.toMatchObject({ code: 'CTXMUX_IO', controlFailure: { disposition: 'unknown' } })
    })
    expect(launch).toHaveBeenCalledOnce()
    expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(originalRequest)
    expect(useAppStore.getState().warmTerminal?.creation?.issue?.code).toBe('CTXMUX_IO')
    expect(useAppStore.getState().tabs.launcher?.regions.input.kind).toBe('launcher')
    launch.mockResolvedValue(shell() as never)
    await dom.click('.launcher-terminal-recovery-actions button')
    expect(launch.mock.calls[1]![0]).toEqual(originalRequest)
  })

  it('does not resurrect the original Launcher closed while its failed creation is being confirmed', async () => {
    let resolve!: (value: never) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown())
      .mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    const stop = vi.spyOn(api.sessions, 'stop')
    await render()
    let promotion!: Promise<void>
    await act(async () => { promotion = useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' }) })
    await act(async () => {
      useAppStore.setState({ tabs: {} })
      resolve(shell() as never)
      await promotion
    })
    expect(useAppStore.getState().tabs.launcher).toBeUndefined()
    expect(useAppStore.getState().warmTerminal?.session?.id).toBe('same-original-run')
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
    expect(stop).not.toHaveBeenCalled()
  })

  it('retains its pending promotion across foreign preview requests and a competing explicit claim', async () => {
    let reject!: (error: Error) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
    await render()
    const originalRequest = launch.mock.calls[0]![0]
    const other = createWorkbenchTab('other-launcher', { regionId: 'other', kind: 'launcher', workspaceId: 'workspace' })
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [other.id]: other }, config: { ...useAppStore.getState().config!,
      workspaces: [...useAppStore.getState().config!.workspaces, { id: 'foreign', name: 'Foreign', hostId: 'local', path: _hygiene_fixturePath("other"), kind: 'folder' }] } }))
    let promotion!: Promise<void>
    await act(async () => { promotion = useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' }) })
    expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(originalRequest)
    await act(async () => useAppStore.getState().prewarmTerminal('foreign', 'region:foreign'))
    await expect(useAppStore.getState().promoteWarmTerminal('group', { tabId: other.id, regionId: 'other' })).rejects.toThrow('already opening')
    await act(async () => { reject(unknown()); await expect(promotion).rejects.toMatchObject({ code: 'CTXMUX_IO' }) })
    expect(launch).toHaveBeenCalledOnce()
    expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(originalRequest)
    expect(useAppStore.getState().warmTerminal?.creation?.issue?.code).toBe('CTXMUX_IO')
    expect(useAppStore.getState().warmTerminal?.claimingLauncherId).toBeUndefined()
    expect(dom.container.querySelector('.launcher-terminal-recovery-actions button')).not.toBeNull()
  })

  it('claims a late same-operation confirmation once when two original Launchers try to open it', async () => {
    let resolve!: (value: never) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown())
      .mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    const stop = vi.spyOn(api.sessions, 'stop')
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(shell() as never)
    await render()
    const other = createWorkbenchTab('other-launcher', { regionId: 'other', kind: 'launcher', workspaceId: 'workspace' })
    let first!: Promise<void>, second!: Promise<void>
    await act(async () => {
      useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [other.id]: other } })
      first = useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' })
      second = useAppStore.getState().promoteWarmTerminal('group', { tabId: other.id, regionId: 'other' })
      const secondResult = expect(second).rejects.toThrow('already opening')
      resolve(shell() as never)
      await first
      await secondResult
    })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', sessionId: 'same-original-run' })
    expect(useAppStore.getState().tabs[other.id]?.regions.other.kind).toBe('launcher')
    expect(stop).not.toHaveBeenCalled()
  })

  it('explains a foreign healthy slot and preserves its exact Run without requesting another preview', async () => {
    const foreign = shell('foreign-healthy-run')
    useAppStore.setState({ warmTerminal: { key: warmTerminalKey('local', _hygiene_fixturePath("other")), ownerLauncherId: 'region:other',
      session: foreign, ready: Promise.resolve(foreign as never) } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal'), stop = vi.spyOn(api.sessions, 'stop')
    await render()
    expect(dom.container.querySelector('.launcher-terminal-pending')?.textContent).toContain('another project')
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    useAppStore.getState().prewarmTerminal('workspace', 'region:input')
    expect(useAppStore.getState().warmTerminal?.session).toBe(foreign)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })

  it('explains a sibling preview and claims the same Run without attaching another live preview', async () => {
    const retained = shell()
    useAppStore.setState({ tabs: { launcher: { ...useAppStore.getState().tabs.launcher!, layout: {
      ...useAppStore.getState().tabs.launcher!.layout, activeRegionId: 'another-selected-region' } } },
      warmTerminal: { key: warmTerminalKey('local', _hygiene_fixturePath("repo")), ownerLauncherId: 'region:sibling',
        session: retained, ready: Promise.resolve(retained as never) } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal')
    await render()
    expect(dom.container.querySelector('.launcher-terminal-pending')?.textContent).toContain('another region')
    expect(dom.container.querySelector('[data-warm-run]')).toBeNull()
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(retained as never)
    await dom.click('.launcher-terminal-pending .small-button')
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', sessionId: retained.id })
    expect(launch).not.toHaveBeenCalled()
  })

  it('a real restored Host event advances the original operation at most once; unrelated snapshots do not', async () => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(unknown())
    await render()
    const originalRequest = launch.mock.calls[0]![0]
    const restored = (hostId: string) => ({ hostId, event: { type: 'connection-state' as const, state: 'restored' as const,
      evidence: { source: 'run-process' as const, observedAt: 10 } }, endpointWarning: null })
    await act(async () => {
      useAppStore.setState({ runtimeEndpointWarnings: [] })
      useAppStore.getState().applyEvent(restored('unrelated-host'))
      await Promise.resolve()
    })
    expect(launch).toHaveBeenCalledOnce()
    await act(async () => { useAppStore.getState().applyEvent(restored('local')); await Promise.resolve() })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]![0]).toEqual(originalRequest)
    await act(async () => { useAppStore.getState().applyEvent(restored('local')); await Promise.resolve() })
    expect(launch).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().warmTerminal?.creation?.issue?.controlFailure.disposition).toBe('unknown')
    expect(dom.container.querySelector('.launcher-terminal-recovery-actions button')?.textContent).toBe('Check again')
  })
})

const { fixtureEpoch: _reshape_fixtureEpoch } = await vi.hoisted(async () => await import("../../../test/fixture-values.mjs"))
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: any) => <div data-warm-run={session.id} /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'
import { warmCandidates } from './helpers/reusable-shell-candidates'
import { useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM(), launcherInitial = useLauncherState.getState()
const original = useAppStore.getState()
const shell = (id = 'same-original-run') => ({ ...composerSession(id), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: id, run: { runId: id } } })
const unknown = (code = 'CTXMUX_IO') => Object.assign(new Error('The original shell receipt was lost.'), {
  code, detail: 'start receipt unavailable', controlFailure: { disposition: 'unknown', confirmedInputBytes: null }
})
beforeEach(() => {
  const tab = createWorkbenchTab('launcher', { regionId: 'input', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ activeWorkspaceId: 'workspace', mainSurface: 'workbench', warmTerminals: {},
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
    const held = warmCandidates(_hygiene_fixturePath("repo"))[0]!
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
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.issue).toBeUndefined()
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

  it.each(['CTXMUX_IO', 'CONTROL_CANCELLED'])('Open Terminal opens independently after %s automatic receipt loss and keeps the original request', async code => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown(code)).mockResolvedValue(shell('new-explicit-run') as never)
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(shell('new-explicit-run') as never)
    await render()
    expect(launch).toHaveBeenCalledOnce()
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation).toMatchObject({
      request: { createOperationId: expect.any(String) }, issue: { code, controlFailure: { disposition: 'unknown', confirmedInputBytes: null } }
    })
    expect(launch.mock.calls[0]![0].createOperationId).not.toBe('')
    await dom.click('.launcher-terminal-recovery-actions button:last-child')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch.mock.calls[1]![0]).toMatchObject({ hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
    expect(launch.mock.calls[1]![0].createOperationId).not.toBe(launch.mock.calls[0]![0].createOperationId)
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', sessionId: 'new-explicit-run' })
    expect(useAppStore.getState().sessions.filter(item => item.id === 'new-explicit-run')).toHaveLength(1)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation).toMatchObject({ request: launch.mock.calls[0]![0],
      issue: { code, controlFailure: { disposition: 'unknown', confirmedInputBytes: null } } })
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.explicitOpening).toBeUndefined()
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
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.request).toEqual(originalRequest)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.issue?.code).toBe('CTXMUX_IO')
    expect(useAppStore.getState().tabs.launcher?.regions.input?.kind).toBe('launcher')
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
    let confirmation!: ReturnType<typeof original.retryWarmTerminal>
    await act(async () => { confirmation = useAppStore.getState().retryWarmTerminal('workspace', 'region:input') })
    await act(async () => {
      useAppStore.setState({ tabs: {} })
      resolve(shell() as never)
      await confirmation
    })
    expect(useAppStore.getState().tabs.launcher).toBeUndefined()
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.session?.id).toBe('same-original-run')
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
    expect(stop).not.toHaveBeenCalled()
  })

  it('retains its original pending request while a competing Region independently opens', async () => {
    let reject!: (error: Error) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => new Promise((_yes, no) => { reject = no }))
      .mockResolvedValueOnce({ ...shell('foreign-independent-run'), workspacePath: _hygiene_fixturePath("other") } as never)
      .mockResolvedValue(shell('second-independent-run') as never)
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(shell('second-independent-run') as never)
    await render()
    const originalRequest = launch.mock.calls[0]![0]
    const other = createWorkbenchTab('other-launcher', { regionId: 'other', kind: 'launcher', workspaceId: 'workspace' })
    await act(async () => useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [other.id]: other },
      layouts: { workspace: createWorkspaceLayout('group', ['launcher', other.id]) }, config: { ...useAppStore.getState().config!,
      workspaces: [...useAppStore.getState().config!.workspaces, { id: 'foreign', name: 'Foreign', hostId: 'local', path: _hygiene_fixturePath("other"), kind: 'folder' }] } }))
    let promotion!: Promise<void>
    await act(async () => { promotion = useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' }) })
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.request).toEqual(originalRequest)
    await act(async () => useAppStore.getState().prewarmTerminal('foreign', 'region:foreign'))
    await act(async () => { await useAppStore.getState().promoteWarmTerminal('group', { tabId: other.id, regionId: 'other' }) })
    expect(useAppStore.getState().tabs[other.id]?.regions.other).toMatchObject({ kind: 'terminal', phase: 'attached', sessionId: 'second-independent-run' })
    expect(launch.mock.calls[1]![0]).toMatchObject({ hostId: 'local', workspacePath: _hygiene_fixturePath("other") })
    expect(launch.mock.calls[2]![0]).toMatchObject({ hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
    expect(launch.mock.calls[2]![0].createOperationId).not.toBe(originalRequest.createOperationId)
    await act(async () => { reject(unknown()); await expect(promotion).rejects.toMatchObject({ code: 'CTXMUX_IO' }) })
    expect(launch).toHaveBeenCalledTimes(3)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.request).toEqual(originalRequest)
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.issue?.code).toBe('CTXMUX_IO')
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.claimToken).toBeUndefined()
    expect(warmCandidates(_hygiene_fixturePath("other"))[0]?.session?.id).toBe('foreign-independent-run')
    expect(dom.container.querySelector('.launcher-terminal-recovery-actions button')).not.toBeNull()
  })

  it('claims a late same-operation confirmation once while another Launcher opens its own Run', async () => {
    let resolve!: (value: never) => void
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(unknown())
      .mockImplementationOnce(() => new Promise(yes => { resolve = yes })).mockResolvedValue(shell('second-independent-run') as never)
    const stop = vi.spyOn(api.sessions, 'stop')
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(shell() as never)
    await render()
    const other = createWorkbenchTab('other-launcher', { regionId: 'other', kind: 'launcher', workspaceId: 'workspace' })
    let confirmation!: ReturnType<typeof original.retryWarmTerminal>
    await act(async () => {
      useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, [other.id]: other }, layouts: { workspace: createWorkspaceLayout('group', ['launcher', other.id]) } })
      confirmation = useAppStore.getState().retryWarmTerminal('workspace', 'region:input')
      await useAppStore.getState().promoteWarmTerminal('group', { tabId: other.id, regionId: 'other' })
      expect(useAppStore.getState().tabs[other.id]?.regions.other).toMatchObject({ kind: 'terminal', sessionId: 'second-independent-run' })
      resolve(shell() as never)
      await confirmation
      await useAppStore.getState().promoteWarmTerminal('group', { tabId: 'launcher', regionId: 'input' })
    })
    expect(launch).toHaveBeenCalledTimes(3)
    expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
    expect(launch.mock.calls[2]![0].createOperationId).not.toBe(launch.mock.calls[0]![0].createOperationId)
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', sessionId: 'same-original-run' })
    expect(useAppStore.getState().tabs[other.id]?.regions.other).toMatchObject({ kind: 'terminal', sessionId: 'second-independent-run' })
    expect(stop).not.toHaveBeenCalled()
  })

  it('shows this project preview while preserving the foreign project original Run', async () => {
    const foreign = { ...shell('foreign-healthy-run'), workspacePath: _hygiene_fixturePath("other") }
    const foreignKey = warmTerminalKey('local', foreign.workspacePath)
    const foreignCandidate = { key: foreignKey, ownerLauncherId: 'region:other',
      session: foreign, ready: Promise.resolve(foreign as never) }
    useAppStore.setState({ warmTerminals: { [foreignKey]: [foreignCandidate] } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(shell('project-preview') as never)
    const stop = vi.spyOn(api.sessions, 'stop')
    await render()
    expect(dom.container.querySelector('[data-warm-run="project-preview"]')).not.toBeNull()
    expect(dom.container.querySelector('.launcher-terminal-pending')).toBeNull()
    expect(warmCandidates(foreign.workspacePath)).toEqual([foreignCandidate])
    expect(launch).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ hostId: 'local', workspacePath: _hygiene_fixturePath("repo") }))
    expect(stop).not.toHaveBeenCalled()
    useAppStore.getState().prewarmTerminal('workspace', 'region:input')
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.session?.id).toBe('project-preview')
    expect(warmCandidates(foreign.workspacePath)).toEqual([foreignCandidate])
    expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
  })

  it('shows its own preview and opens its own Run while preserving a sibling preview', async () => {
    const retained = shell()
    const key = warmTerminalKey('local', _hygiene_fixturePath("repo"))
    const sibling = { key, ownerLauncherId: 'region:sibling', session: retained, ready: Promise.resolve(retained as never) }
    useAppStore.setState({ warmTerminals: { [key]: [sibling] } })
    const own = shell('independent-input-run')
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(own as never)
    const stop = vi.spyOn(api.sessions, 'stop')
    await render()
    expect(dom.container.querySelector('[data-warm-run="independent-input-run"]')).not.toBeNull()
    expect(dom.container.querySelector('[data-warm-run="same-original-run"]')).toBeNull()
    expect(warmCandidates(_hygiene_fixturePath("repo"))).toEqual([sibling, expect.objectContaining({ ownerLauncherId: 'region:input', session: own })])
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(own as never)
    await dom.click('[data-agentmux-action="claim-reusable-terminal"]')
    expect(useAppStore.getState().tabs.launcher?.regions.input).toMatchObject({ kind: 'terminal', sessionId: own.id })
    expect(warmCandidates(_hygiene_fixturePath("repo"))).toEqual([sibling])
    expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
  })

  it('a real restored Host event advances the original operation at most once; unrelated snapshots do not', async () => {
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValue(unknown())
    await render()
    const originalRequest = launch.mock.calls[0]![0]
    const restored = (hostId: string) => ({ type: 'core' as const, hostId, event: { type: 'connection-state' as const, state: 'restored' as const,
      evidence: { source: 'run-process' as const, observedAt: _reshape_fixtureEpoch(0, 0, 10) } }, endpointWarning: null })
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
    expect(warmCandidates(_hygiene_fixturePath("repo"))[0]?.creation?.issue?.controlFailure.disposition).toBe('unknown')
    expect(dom.container.querySelector('.launcher-terminal-recovery-actions button')?.textContent).toBe('Check again')
  })
})

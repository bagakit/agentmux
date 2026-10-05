import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: any) => <div data-warm-run={session.id} /> }))
import { NewTabSurface } from '../src/renderer/src/components/NewTabSurface'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const original = useAppStore.getState()
const target = { tabId: 'first', regionId: 'first-region' }
const shell = (id: string) => ({ ...composerSession(id), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: id, run: { runId: id } } })
const pending = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
beforeEach(() => {
  const first = createWorkbenchTab(target.tabId, { regionId: target.regionId, kind: 'launcher', workspaceId: 'workspace' })
  const second = createWorkbenchTab('second', { regionId: 'second-region', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ activeWorkspaceId: 'workspace', warmTerminal: null,
    tabs: { first, second }, layouts: { workspace: createWorkspaceLayout('group', ['first', 'second']) },
    closingWorkbenchViews: {}, workbenchSpaceSelection: null, workbenchNavigationInputPolicy: null,
    agentComposerDrafts: { 'first-region': 'Keep original draft' }, unclaimedTerminalSessionIds: [],
    prewarmTerminal: original.prewarmTerminal, retryWarmTerminal: original.retryWarmTerminal,
    promoteWarmTerminal: original.promoteWarmTerminal, launchTerminal: original.launchTerminal,
    detectExecutors: vi.fn().mockResolvedValue(undefined) })
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => shell(control.run.runId) as never)
})

it('real mounted Launcher B completes while A keeps its pending original creation and draft', async () => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise).mockResolvedValue(shell('B') as never)
  const stop = vi.spyOn(api.sessions, 'stop')
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  const A = useAppStore.getState().promoteWarmTerminal('group', target)
  await dom.render(<NewTabSurface tabGroupId="group" tabId="second" regionId="second-region" />)
  const open = [...dom.container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Open Terminal'))!
  expect(open).toBeDefined()
  await act(async () => { open.click(); await vi.waitFor(() => expect(useAppStore.getState().tabs.second?.regions['second-region']).toMatchObject({ sessionId: 'B', phase: 'attached' })) })
  expect(launch).toHaveBeenCalledTimes(2)
  expect(launch.mock.calls[1]![0]).toMatchObject({ hostId: 'local', workspacePath: _hygiene_fixturePath("repo") })
  expect(launch.mock.calls[1]![0].createOperationId).not.toBe(launch.mock.calls[0]![0].createOperationId)
  expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(launch.mock.calls[0]![0])
  expect(dom.draft('first-region')).toBe('Keep original draft')
  await act(async () => { receipt.resolve(shell('A')); await A })
  expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'A', phase: 'attached' })
  expect(useAppStore.getState().tabs.second?.regions['second-region']).toMatchObject({ sessionId: 'B', phase: 'attached' })
  expect(stop).not.toHaveBeenCalled()
})

it.each(['warm', 'cold'] as const)('the same pending Region shares its actual %s opening promise and releases it on success', async mode => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise).mockResolvedValue(shell('new-intent') as never)
  if (mode === 'warm') useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  const first = useAppStore.getState().promoteWarmTerminal('group', target)
  const duplicate = useAppStore.getState().promoteWarmTerminal('group', target)
  expect(duplicate).toBe(first)
  expect(launch).toHaveBeenCalledOnce()
  receipt.resolve(shell('original')); await Promise.all([first, duplicate])
  const prior = useAppStore.getState().tabs.first!
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, first: { ...prior,
    regions: { ...prior.regions, 'first-region': { regionId: 'first-region', kind: 'launcher', workspaceId: 'workspace' } } } } })
  const next = useAppStore.getState().promoteWarmTerminal('group', target)
  expect(next).not.toBe(first); await next
  expect(launch).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'new-intent' })
})

it.each(['warm', 'cold'] as const)('an empty Group has one pending %s opening before it has a Region', async mode => {
  useAppStore.setState({ tabs: {}, layouts: { workspace: createWorkspaceLayout('group') } })
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(() => receipt.promise)
  if (mode === 'warm') useAppStore.getState().prewarmTerminal('workspace', 'group:group')
  const first = useAppStore.getState().promoteWarmTerminal('group')
  expect(useAppStore.getState().promoteWarmTerminal('group')).toBe(first)
  expect(launch).toHaveBeenCalledOnce()
  receipt.resolve(shell('original')); await first
  expect(Object.values(useAppStore.getState().tabs)).toHaveLength(1)
  expect(useAppStore.getState().layouts.workspace?.groups[0]?.tabOrder).toHaveLength(1)
  expect(Object.values(Object.values(useAppStore.getState().tabs)[0]!.regions)).toEqual([expect.objectContaining({ sessionId: 'original', phase: 'attached' })])
})

it.each(['closed', 'replaced'] as const)('late warm success preserves its Run when the original Region was %s', async mode => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise).mockResolvedValue(shell('replacement') as never)
  const stop = vi.spyOn(api.sessions, 'stop')
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  const originalRequest = launch.mock.calls[0]![0]
  const first = useAppStore.getState().promoteWarmTerminal('group', target)
  let replacementOpening: Promise<void> | undefined
  if (mode === 'closed') useAppStore.setState({ tabs: { second: useAppStore.getState().tabs.second! } })
  else {
    const prior = useAppStore.getState().tabs.first!
    useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, first: { ...prior,
      regions: { ...prior.regions, 'first-region': { regionId: 'first-region', kind: 'launcher', workspaceId: 'workspace' } } } } })
    replacementOpening = useAppStore.getState().promoteWarmTerminal('group', target)
    expect(replacementOpening).not.toBe(first)
    await replacementOpening
  }
  receipt.resolve(shell('original')); await first
  expect(useAppStore.getState().warmTerminal?.session?.id).toBe('original')
  expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(originalRequest)
  expect(useAppStore.getState().warmTerminal?.claimToken).toBeUndefined()
  expect(useAppStore.getState().unclaimedTerminalSessionIds).toContain('original')
  if (mode === 'closed') expect(useAppStore.getState().tabs.first).toBeUndefined()
  else expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'replacement' })
  expect(stop).not.toHaveBeenCalled()
  await useAppStore.getState().promoteWarmTerminal('group', { tabId: 'second', regionId: 'second-region' })
  expect(useAppStore.getState().tabs.second?.regions['second-region']).toMatchObject({ sessionId: 'original' })
  expect(launch).toHaveBeenCalledTimes(mode === 'closed' ? 1 : 2)
})

it('a failed same-operation opening releases its flight without discarding typed failure or exact input', async () => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise).mockResolvedValue(shell('original') as never)
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  const first = useAppStore.getState().promoteWarmTerminal('group', target)
  expect(useAppStore.getState().promoteWarmTerminal('group', target)).toBe(first)
  const rejection = expect(first).rejects.toMatchObject({ code: 'CTXMUX_IO', controlFailure: { disposition: 'unknown' } })
  receipt.reject(Object.assign(new Error('receipt lost'), { code: 'CTXMUX_IO', controlFailure: { disposition: 'unknown', confirmedInputBytes: null } }))
  await rejection
  const retry = useAppStore.getState().promoteWarmTerminal('group', target)
  expect(retry).not.toBe(first); await retry
  expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
  expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'original' })
})

it('an unavailable exact target refuses this opening without consuming or stopping the warm candidate', async () => {
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(shell('original') as never)
  const stop = vi.spyOn(api.sessions, 'stop')
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  await Promise.resolve(); await Promise.resolve()
  let rejection: unknown
  try { await useAppStore.getState().promoteWarmTerminal('absent-group', target) } catch (error) { rejection = error }
  expect(rejection).toBeInstanceOf(Error)
  expect((rejection as Error).message).toContain('exact Terminal display position')
  expect(useAppStore.getState().warmTerminal?.session?.id).toBe('original')
  expect(useAppStore.getState().tabs.first?.regions['first-region']?.kind).toBe('launcher')
  expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
})

it('the actual ordinary Topic creation opens independently while another Region claims the warm request', async () => {
  const config = useAppStore.getState().config!
  const first = createWorkbenchTab('first', { regionId: 'first-region', kind: 'launcher', workspaceId: SCRATCH_WORKSPACE_ID })
  useAppStore.setState({ config: { ...config, workspaces: [{ id: SCRATCH_WORKSPACE_ID, hostId: 'local', name: 'Topics', path: _hygiene_fixturePath("topics"), kind: 'folder' }] },
    activeWorkspaceId: SCRATCH_WORKSPACE_ID, tabs: { first }, layouts: { [SCRATCH_WORKSPACE_ID]: createWorkspaceLayout('group', ['first']) },
    scratchTopicSnapshots: {}, spaceZoneBindings: {}, topicCategories: [], workbenchSpaceSelection: null })
  // The controlled filesystem port writes the same requested Topic; createScratchTopic,
  // spatial addressing and its promoteWarmTerminal consumer are production owners.
  vi.spyOn(api.spatial, 'read').mockResolvedValue({ revision: 1, graph: { spaces: [], zones: [], tabs: [], regions: [], bindings: [], layouts: {}, tabLayouts: {}, resources: {} } } as never)
  const create = vi.spyOn(api.topics, 'call').mockImplementation(async (_method, input: any) => {
    await api.scratch.ensureTopic(SCRATCH_WORKSPACE_ID, input.topicId); return {} as never
  })
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise)
    .mockResolvedValue({ ...shell('topic-B'), workspacePath: _hygiene_fixturePath("topics") } as never)
  useAppStore.getState().prewarmTerminal(SCRATCH_WORKSPACE_ID, 'region:first-region')
  const A = useAppStore.getState().promoteWarmTerminal('group', target)
  const topic = await useAppStore.getState().createScratchTopic()
  const tab = Object.values(useAppStore.getState().tabs).find(one => one.topicId === topic.id)!
  expect(create).toHaveBeenCalledOnce()
  expect(Object.values(tab.regions)).toEqual([expect.objectContaining({ sessionId: 'topic-B', phase: 'attached' })])
  expect(launch.mock.calls[1]![0]).toMatchObject({ hostId: 'local', workspacePath: _hygiene_fixturePath("topics") })
  expect(launch.mock.calls[1]![0].createOperationId).not.toBe(launch.mock.calls[0]![0].createOperationId)
  receipt.resolve({ ...shell('A'), workspacePath: _hygiene_fixturePath("topics") }); await A
  expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'A', phase: 'attached' })
})

it('preview owner transfer during a claim does not transfer its original request or block the sibling opening', async () => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise).mockResolvedValue(shell('B') as never)
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  const A = useAppStore.getState().promoteWarmTerminal('group', target)
  const before = useAppStore.getState().warmTerminal!
  useAppStore.getState().prewarmTerminal('workspace', 'region:second-region')
  expect(useAppStore.getState().warmTerminal).toMatchObject({ ownerLauncherId: 'region:second-region', claimToken: before.claimToken,
    ready: before.ready, creation: before.creation })
  await dom.render(<NewTabSurface tabGroupId="group" tabId="second" regionId="second-region" />)
  expect(dom.container.querySelectorAll('[data-warm-run]')).toHaveLength(0)
  await act(async () => { await useAppStore.getState().promoteWarmTerminal('group', { tabId: 'second', regionId: 'second-region' })
    receipt.resolve(shell('A')); await A })
  expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'A' })
  expect(useAppStore.getState().tabs.second?.regions['second-region']).toMatchObject({ sessionId: 'B' })
  expect(launch).toHaveBeenCalledTimes(2)
})

it('settling an obsolete opening cannot erase the pending replacement flight at the same address', async () => {
  const receiptA = pending<any>(), receiptB = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receiptA.promise).mockImplementationOnce(() => receiptB.promise)
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  const A = useAppStore.getState().promoteWarmTerminal('group', target)
  const prior = useAppStore.getState().tabs.first!
  useAppStore.setState({ tabs: { ...useAppStore.getState().tabs, first: { ...prior,
    regions: { ...prior.regions, 'first-region': { regionId: 'first-region', kind: 'launcher', workspaceId: 'workspace' } } } } })
  const B = useAppStore.getState().promoteWarmTerminal('group', target)
  receiptA.resolve(shell('A')); await A
  expect(useAppStore.getState().promoteWarmTerminal('group', target)).toBe(B)
  expect(launch).toHaveBeenCalledTimes(2)
  receiptB.resolve(shell('B')); await B
  expect(useAppStore.getState().tabs.first?.regions['first-region']).toMatchObject({ sessionId: 'B' })
  expect(useAppStore.getState().warmTerminal?.session?.id).toBe('A')
})

it('a removed exact target during original-operation confirmation rejects stale opens without changing the original request', async () => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(Object.assign(new Error('lost'), { code: 'CTXMUX_IO' }))
    .mockImplementationOnce(() => receipt.promise)
  useAppStore.getState().prewarmTerminal('workspace', 'region:first-region')
  await Promise.resolve(); await Promise.resolve()
  const originalRequest = launch.mock.calls[0]![0]
  const opening = useAppStore.getState().promoteWarmTerminal('group', target)
  useAppStore.setState({ tabs: { second: useAppStore.getState().tabs.second! } })
  const stale = useAppStore.getState().promoteWarmTerminal('group', target)
  expect(stale).not.toBe(opening)
  await expect(stale).rejects.toThrow('Launcher Region is no longer available')
  receipt.resolve(shell('original')); await opening
  expect(useAppStore.getState().warmTerminal?.session?.id).toBe('original')
  expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(originalRequest)
  expect(useAppStore.getState().tabs.first).toBeUndefined()
  expect(launch).toHaveBeenCalledTimes(2)
})

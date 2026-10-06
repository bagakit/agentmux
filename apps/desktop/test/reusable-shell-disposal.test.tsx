// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { warmCandidates } from './helpers/reusable-shell-candidates'
import { composerSession } from './helpers/composer-dom-fixture'
import { initializeDisposal, disposalTarget, removeOpeningPresentation } from './helpers/reusable-shell-disposal-fixture'

const original = useAppStore.getState()
const shell = (id: string) => ({ ...composerSession(id), kind: 'terminal' as const, providerId: null,
  control: { kind: 'terminal' as const, hostId: 'local', runId: id, run: { runId: id } } })
const pending = <T,>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
let path: string, dispose: (() => void) | undefined
beforeEach(async () => { useAppStore.setState(original, true); path = await mkdtemp(join(tmpdir(), 'amux-disposal-'))
  const initialized = await initializeDisposal(path); dispose = initialized.dispose
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => shell(control.run.runId) as never) })
afterEach(async () => { dispose?.(); vi.restoreAllMocks(); useAppStore.setState(original, true); await rm(path, { recursive: true, force: true }) })

it('actual initialize disposal preserves a claimed pending request and its late binding', async () => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(() => receipt.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  const opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  const held = warmCandidates(path)[0]!
  dispose!(); dispose = undefined
  expect(warmCandidates(path)[0]).toBe(held)
  expect(warmCandidates(path)[0]?.creation?.request).toEqual(launch.mock.calls[0]![0])
  expect(stop).not.toHaveBeenCalled()
  receipt.resolve(shell('late-original')); await opening
  expect(useAppStore.getState().tabs.opening?.regions['opening-region']).toMatchObject({ sessionId: 'late-original', phase: 'attached' })
  expect(useAppStore.getState().agentComposerDrafts['opening-region']).toBe('Retain private draft')
  expect(stop).not.toHaveBeenCalled()
})

it('actual disposal keeps explicit ownership after the receipt claim token has been released', async () => {
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(shell('retained-original') as never)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  await warmCandidates(path)[0]!.ready
  const opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  removeOpeningPresentation(); await opening
  const retained = warmCandidates(path)[0]!
  expect(retained.claimToken).toBeUndefined()
  expect(retained.session?.id).toBe('retained-original')
  dispose!(); dispose = undefined
  expect(warmCandidates(path)[0]).toBe(retained)
  expect(stop).not.toHaveBeenCalled()
  await useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'recovery', regionId: 'recovery-region' })
  expect(launch).toHaveBeenCalledOnce()
  expect(useAppStore.getState().tabs.recovery?.regions['recovery-region']).toMatchObject({ sessionId: 'retained-original', phase: 'attached' })
})

it('an unknown original operation remains retained when its explicit retry fails after disposal', async () => {
  const receipt = pending<any>(), originalReceipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => originalReceipt.promise).mockImplementation(() => receipt.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  const claimed = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  originalReceipt.reject(new Error('Original receipt unknown'))
  await expect(claimed).rejects.toThrow('Original receipt unknown')
  const opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  dispose!(); dispose = undefined
  receipt.reject(new Error('Original receipt remains unknown'))
  let failure: unknown
  try { await opening } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
  expect(warmCandidates(path)[0]?.creation?.request).toEqual(launch.mock.calls[0]![0])
  expect(warmCandidates(path)[0]?.creation?.issue).toBeDefined()
  expect(warmCandidates(path)[0]?.claimToken).toBeUndefined()
  expect(stop).not.toHaveBeenCalled()
})

it.each(['pending', 'ready'] as const)('actual disposal still releases an unclaimed %s automatic warm shell', async phase => {
  const receipt = pending<any>()
  vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(() => receipt.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  const held = warmCandidates(path)[0]!
  if (phase === 'ready') { receipt.resolve(shell('unused')); await held.ready }
  dispose!(); dispose = undefined
  expect(warmCandidates(path)).toEqual([])
  if (phase === 'pending') receipt.resolve(shell('unused'))
  await held.ready
  await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(shell('unused').control))
  await vi.waitFor(() => expect(useAppStore.getState().unclaimedTerminalSessionIds).not.toContain('unused'))
})

it('actual disposal retains a claimed request while releasing unclaimed candidates in both projects', async () => {
  const receipt = pending<any>()
  const otherPath = join(path, 'other-project')
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => receipt.promise)
    .mockResolvedValueOnce({ ...shell('unused-sibling'), workspacePath: path } as never)
    .mockResolvedValueOnce({ ...shell('unused-other'), workspacePath: otherPath } as never)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  const config = useAppStore.getState().config!
  useAppStore.setState({ config: { ...config, workspaces: [...config.workspaces,
    { id: 'other', kind: 'folder', hostId: 'local', name: 'Other project', path: otherPath }] } })
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  const opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  const claimed = warmCandidates(path)[0]!
  useAppStore.getState().prewarmTerminal('private', 'region:recovery-region')
  useAppStore.getState().prewarmTerminal('other', 'region:other')
  await Promise.all([warmCandidates(path)[1]!.ready, warmCandidates(otherPath)[0]!.ready])
  expect(launch).toHaveBeenCalledTimes(3)
  dispose!(); dispose = undefined
  expect(warmCandidates(path)).toEqual([claimed])
  expect(warmCandidates(otherPath)).toEqual([])
  expect(claimed.creation?.request).toEqual(launch.mock.calls[0]![0])
  await vi.waitFor(() => expect(stop.mock.calls.map(([control]) => control.run.runId).sort()).toEqual(['unused-other', 'unused-sibling']))
  receipt.resolve({ ...shell('claimed-original'), workspacePath: path }); await opening
  expect(useAppStore.getState().tabs.opening?.regions['opening-region']).toMatchObject({ sessionId: 'claimed-original', phase: 'attached' })
  expect(useAppStore.getState().agentComposerDrafts['opening-region']).toBe('Retain private draft')
  expect(stop).toHaveBeenCalledTimes(2)
})

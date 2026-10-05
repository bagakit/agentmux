// @vitest-environment happy-dom
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
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
  const held = useAppStore.getState().warmTerminal!
  dispose!(); dispose = undefined
  expect(useAppStore.getState().warmTerminal).toBe(held)
  expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(launch.mock.calls[0]![0])
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
  await useAppStore.getState().warmTerminal!.ready
  const opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  removeOpeningPresentation(); await opening
  const retained = useAppStore.getState().warmTerminal!
  expect(retained.claimToken).toBeUndefined()
  expect(retained.session?.id).toBe('retained-original')
  dispose!(); dispose = undefined
  expect(useAppStore.getState().warmTerminal).toBe(retained)
  expect(stop).not.toHaveBeenCalled()
  await useAppStore.getState().promoteWarmTerminal('private-group', { tabId: 'recovery', regionId: 'recovery-region' })
  expect(launch).toHaveBeenCalledOnce()
  expect(useAppStore.getState().tabs.recovery?.regions['recovery-region']).toMatchObject({ sessionId: 'retained-original', phase: 'attached' })
})

it('an unknown original operation remains retained when its explicit retry fails after disposal', async () => {
  const receipt = pending<any>()
  const launch = vi.spyOn(api.sessions, 'launchTerminal').mockRejectedValueOnce(new Error('Original receipt unknown')).mockImplementation(() => receipt.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  await useAppStore.getState().warmTerminal!.ready
  const opening = useAppStore.getState().promoteWarmTerminal('private-group', disposalTarget)
  dispose!(); dispose = undefined
  receipt.reject(new Error('Original receipt remains unknown'))
  let failure: unknown
  try { await opening } catch (error) { failure = error }
  expect(failure).toBeInstanceOf(Error)
  expect(launch.mock.calls[1]![0]).toEqual(launch.mock.calls[0]![0])
  expect(useAppStore.getState().warmTerminal?.creation?.request).toEqual(launch.mock.calls[0]![0])
  expect(useAppStore.getState().warmTerminal?.creation?.issue).toBeDefined()
  expect(useAppStore.getState().warmTerminal?.claimToken).toBeUndefined()
  expect(stop).not.toHaveBeenCalled()
})

it.each(['pending', 'ready'] as const)('actual disposal still releases an unclaimed %s automatic warm shell', async phase => {
  const receipt = pending<any>()
  vi.spyOn(api.sessions, 'launchTerminal').mockImplementation(() => receipt.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.getState().prewarmTerminal('private', 'region:opening-region')
  const held = useAppStore.getState().warmTerminal!
  if (phase === 'ready') { receipt.resolve(shell('unused')); await held.ready }
  dispose!(); dispose = undefined
  expect(useAppStore.getState().warmTerminal).toBeNull()
  if (phase === 'pending') receipt.resolve(shell('unused'))
  await held.ready
  await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith(shell('unused').control))
  await vi.waitFor(() => expect(useAppStore.getState().unclaimedTerminalSessionIds).not.toContain('unused'))
})

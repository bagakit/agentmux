import { fixturePath as _historyFixturePath } from "../../../test/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostRuntimeObservation } from '@agentmux/core'
import { HostRuntimePanel } from '../src/renderer/src/components/settings/HostRuntimePanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
import type { HostConfig } from '../src/shared/contracts'
import { fixtureEpoch as _historyFixtureEpoch } from '../../../test/fixture-values.mjs'

const dom = composerDOM()
const host: HostConfig = { id: 'remote-a', kind: 'ssh', label: 'Selected host', hostname: 'a.invalid', runtimeId: 'runtime-a' }
function observation(id = host.id, retained = 1024): HostRuntimeObservation {
  const readAt = _historyFixtureEpoch(0, 5, 0), missing = { state: 'unavailable' as const, code: 'RUNTIME_UNCONFIRMED', message: 'Original source is unconfirmed.', readAt }
  return { routeHostId: id, configuration: id === host.id ? host : { ...host, id, hostname: 'b.invalid' }, requestedAt: _historyFixtureEpoch(0, 4, 999), completedAt: readAt, owner: missing, nativeIdentity: missing, diagnostics: missing,
    resources: { state: 'available', readAt, value: { observedAt: _historyFixtureEpoch(0, 1, 234), runCount: 4, runningRuns: 1, terminatedRuns: 3, terminatedUnattachedRuns: 2, attachments: 2, retainedOutputBytes: retained } } }
}
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })
it('renders real source-scoped resource facts, keeps partial failures and never fills missing capabilities or PID', async () => {
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValue(observation())
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(inspect).toHaveBeenCalledOnce(); expect(inspect.mock.calls[0]![0]).toEqual(host)
  expect(dom.container.textContent).toContain('1 KiB')
  expect(dom.container.textContent).toContain('4 retained in total')
  expect(dom.container.textContent).toContain('Some observations unavailable')
  expect(dom.container.textContent).toContain('Capabilities not observed')
  expect(dom.container.querySelectorAll('[data-native-capability]')).toHaveLength(6)
  expect([...dom.container.querySelectorAll('[data-native-capability] strong')].map(row => row.textContent)).toEqual(Array(6).fill('Unconfirmed'))
  expect(dom.container.textContent).toContain('Not provided by Runtime')
  const partial = observation(); partial.resources = { state: 'unavailable', code: 'RESOURCE_UNAVAILABLE', message: 'Original resources could not be read.', readAt: _historyFixtureEpoch(0, 9, 0) }
  inspect.mockResolvedValue(partial)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(dom.container.textContent).toContain('1 KiB')
  expect(dom.container.textContent).toContain('Original resources could not be read. Last confirmed')
  expect(dom.container.textContent).toContain('Resource sample')
})
it('presents each original Native declaration with its own diagnostic read time and marks retained evidence after a source failure', async () => {
  const first = observation()
  first.diagnostics = { state: 'available', readAt: _historyFixtureEpoch(0, 3, 141), value: { nodeVersion: 'v22', platform: 'darwin', arch: 'arm64', supported: true,
    ctxmux: { state: { configuredDirectory: _historyFixturePath("configured"), servingDirectory: _historyFixturePath("serving") }, serving: { buildIdentity: 'build', protocolVersion: 16, instanceId: 'original-native', sourceCommit: null },
      bundled: { version: '1.0.0', sourceCommit: 'commit', artifactPlatform: 'darwin-arm64' }, ready: true,
      capabilities: { transport: 'local-unix', orderedOutputBytes: true, boundedReplay: true, recoverableInput: true, resize: true, interrupt: true, completeStop: true } } } }
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValue(first)
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  const capability = () => dom.container.querySelector<HTMLElement>('[aria-label="Native capability declarations"]')!
  expect(capability().dataset.diagnosticEvidence).toBe('current')
  expect(capability().textContent).toContain('Source · Native diagnostics')
  expect(capability().querySelector('time')?.dateTime).toBe(new Date(_historyFixtureEpoch(0, 3, 141)).toISOString())
  expect([...capability().querySelectorAll('[data-native-capability]')].map(row => row.textContent?.trim())).toEqual([
    'Ordered outputDeclared', 'Bounded replayDeclared', 'Recoverable inputDeclared', 'ResizeDeclared', 'InterruptDeclared', 'Complete stopDeclared'
  ])
  expect(capability().textContent).toContain('Access to an individual Run is checked separately.')
  const partial = observation(); partial.diagnostics = { state: 'unavailable', readAt: _historyFixtureEpoch(0, 9, 900), code: 'DIAGNOSTICS_UNAVAILABLE', message: 'Original diagnostics could not be read.' }
  inspect.mockResolvedValue(partial)
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(capability().dataset.diagnosticEvidence).toBe('retained')
  expect(capability().querySelector('time')?.dateTime).toBe(new Date(_historyFixtureEpoch(0, 3, 141)).toISOString())
  expect([...capability().querySelectorAll('[data-native-capability] strong')].map(row => row.textContent)).toEqual(Array(6).fill('Last confirmed'))
  expect(capability().textContent).not.toContain('Current observation')
  expect(dom.container.textContent).toContain('Original diagnostics could not be read.')
  expect(dom.container.textContent).not.toContain('Unsupported')
  inspect.mockRejectedValue(new Error('This observation transport failed.'))
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(capability().dataset.diagnosticEvidence).toBe('retained')
  expect(capability().querySelector('time')?.dateTime).toBe(new Date(_historyFixtureEpoch(0, 3, 141)).toISOString())
})
it('reads only the active saved route, cancels on Host changes, and ignores a late old response', async () => {
  let release!: (value: HostRuntimeObservation) => void
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    .mockResolvedValue(observation('remote-b', 2048))
  await dom.render(<HostRuntimePanel host={host} committed={host} active={false} />)
  expect(inspect).not.toHaveBeenCalled()
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  const firstSignal = inspect.mock.calls[0]![1]!.signal!
  expect(firstSignal.aborted).toBe(false)
  const second: HostConfig = { ...host, id: 'remote-b', hostname: 'b.invalid' }
  await dom.render(<HostRuntimePanel host={second} committed={second} active />)
  expect(firstSignal.aborted).toBe(true)
  expect(dom.container.textContent).toContain('2 KiB')
  await act(async () => release(observation(host.id, 987654321)))
  expect(dom.container.textContent).toContain('2 KiB')
  expect(dom.container.textContent).not.toContain('941')
  await dom.render(<HostRuntimePanel host={second} committed={second} active={false} />)
  const count = inspect.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(inspect).toHaveBeenCalledTimes(count)
  const draft = { ...second, hostname: 'unsaved.invalid' }
  await dom.render(<HostRuntimePanel host={draft} committed={second} active />)
  expect(dom.container.textContent).toContain('Save this connection')
  expect(inspect).toHaveBeenCalledTimes(count)
})
it('does not accumulate observations while a read is pending and resumes from explicit refresh', async () => {
  let reject!: (reason: unknown) => void
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no }))
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(inspect).toHaveBeenCalledOnce()
  await act(async () => reject(new Error('Read failed at the original endpoint')))
  expect(dom.container.textContent).toContain('Read failed at the original endpoint')
  inspect.mockResolvedValue(observation())
  await dom.click('[aria-label="Refresh Runtime observation"]')
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).toContain('1 KiB')
})
it('drops retained resources when the confirmed Native identity changes', async () => {
  const first = observation()
  first.nativeIdentity = { state: 'available', readAt: _historyFixtureEpoch(0, 4, 0), value: { hostId: 'local', instanceId: 'native-before', processId: null, protocolVersion: 16, buildIdentity: 'original-build' } }
  const second = observation()
  second.nativeIdentity = { ...first.nativeIdentity, value: { ...first.nativeIdentity.value, instanceId: 'native-after' } }
  second.resources = { state: 'unavailable', code: 'RESOURCE_UNAVAILABLE', message: 'New instance resources unconfirmed.', readAt: _historyFixtureEpoch(0, 5, 0) }
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValueOnce(first).mockResolvedValue(second)
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(dom.container.textContent).toContain('1 KiB')
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).not.toContain('1 KiB')
  expect(dom.container.textContent).toContain('New instance resources unconfirmed.')
})
it('does not retain resources across a newer serving diagnostics instance or semantic Core owner', async () => {
  const first = observation()
  first.nativeIdentity = { state: 'available', readAt: _historyFixtureEpoch(0, 4, 0), value: { hostId: 'local', instanceId: 'native-before', processId: null, protocolVersion: 16, buildIdentity: 'original-build' } }
  const newer = observation()
  newer.resources = { state: 'unavailable', code: 'NATIVE_IDENTITY_UNCONFIRMED', message: 'New instance resources unconfirmed.', readAt: _historyFixtureEpoch(0, 5, 0) }
  newer.diagnostics = { state: 'available', readAt: _historyFixtureEpoch(0, 5, 0), value: { nodeVersion: 'v22', platform: 'darwin', arch: 'arm64', supported: true,
    ctxmux: { state: { configuredDirectory: _historyFixturePath("configured"), servingDirectory: _historyFixturePath("serving") }, serving: { buildIdentity: 'build', protocolVersion: 16, instanceId: 'native-after', sourceCommit: null },
      bundled: { version: '1.0.0', sourceCommit: 'commit', artifactPlatform: 'darwin-arm64' }, ready: true,
      capabilities: { transport: 'local-unix', orderedOutputBytes: true, boundedReplay: true, recoverableInput: true, resize: true, interrupt: true, completeStop: true } } } }
  const inspect = vi.spyOn(api.hosts, 'inspect').mockResolvedValueOnce(first).mockResolvedValue(newer)
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(dom.container.textContent).toContain('1 KiB')
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(dom.container.textContent).not.toContain('1 KiB')
  const before = observation()
  before.owner = { state: 'available', readAt: _historyFixtureEpoch(0, 5, 0), value: { runtimeId: 'same-runtime', ownerInstanceId: 'before', processId: 1, protocolVersion: 2, availability: 'connected', ctxmux: null } }
  inspect.mockResolvedValue(before)
  await dom.click('[aria-label="Refresh Runtime observation"]')
  expect(dom.container.textContent).toContain('1 KiB')
  const after = observation()
  after.owner = { ...before.owner, value: { ...before.owner.value, ownerInstanceId: 'after' } }
  after.resources = newer.resources
  inspect.mockResolvedValue(after)
  await dom.click('[aria-label="Refresh Runtime observation"]')
  expect(dom.container.textContent).not.toContain('1 KiB')
})

it('binds a pending read to the complete committed snapshot even when only its label changed', async () => {
  const inspect = vi.spyOn(api.hosts, 'inspect').mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue(observation())
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  const oldSignal = inspect.mock.calls[0]![1]!.signal!
  const committed = { ...host, label: 'Saved renamed connection' }
  const result = observation(); result.configuration = committed
  inspect.mockResolvedValue(result)
  await dom.render(<HostRuntimePanel host={host} committed={committed} active />)
  expect(oldSignal.aborted).toBe(true)
  expect(inspect).toHaveBeenCalledTimes(2)
  expect(inspect.mock.calls[1]![0]).toEqual(committed)
  expect(dom.container.textContent).toContain('1 KiB')
})

it('rejects a same-ID result carrying another saved route before a Renderer configuration event arrives', async () => {
  const replacement = observation(); replacement.configuration = { ...host, hostname: 'already-replaced.invalid' }
  vi.spyOn(api.hosts, 'inspect').mockResolvedValue(replacement)
  await dom.render(<HostRuntimePanel host={host} committed={host} active />)
  expect(dom.container.textContent).toContain('The observation belongs to another Host')
  expect(dom.container.textContent).not.toContain('1 KiB')
})

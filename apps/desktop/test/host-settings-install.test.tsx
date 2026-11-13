// @vitest-environment happy-dom
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RemoteCoreInstallCheck, RemoteCoreInstallReceipt } from '@agentmux/core'
import type { SshHostConfig } from '../src/shared/contracts'
import { HostCorePanel } from '../src/renderer/src/components/settings/HostCorePanel'
import { HostInstallPanel } from '../src/renderer/src/components/settings/HostInstallPanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const host: SshHostConfig = { id: 'build', kind: 'ssh', label: 'Build server', hostname: 'build.invalid' }
const check: RemoteCoreInstallCheck = { input: host, eligible: true, reason: 'ready', detail: 'This machine is ready for its first install.',
  probe: { platform: 'linux', machine: 'x86_64', glibc: '2.36', home: fixturePath('home/build'), prefix: fixturePath('home/build/.agentmux/server'), user: 'build',
    installed: false, socket: 'absent', availableBytes: 1024 ** 3, systemd: { user: true, linger: false, unitAvailable: true } },
  candidate: { digest: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), version: '0.1.0' }, node: { version: 'v24.22.1', sha256: 'c'.repeat(64) },
  keepRunning: [{ mode: 'start-script', available: true, startsAtBoot: false }, { mode: 'systemd', available: true, startsAtBoot: false }],
  expected: { targetDigest: 'd'.repeat(64), prefix: fixturePath('home/build/.agentmux/server'), candidateDigest: 'a'.repeat(64), nodeSha256: 'c'.repeat(64) } }
const receipt = (status: RemoteCoreInstallReceipt['status'] = 'completed'): RemoteCoreInstallReceipt => ({ input: host, expected: { ...check.expected!, keepRunning: 'start-script' },
  operationId: 'original', status, stage: status === 'completed' ? 'completed' : 'confirming', detail: 'Original installation result', updatedAt: 100,
  ...(status === 'completed' ? { installed: { remoteCommand: fixturePath('core/amux'), remoteSocketPath: fixturePath('core/control.sock'), runtimeId: 'new-runtime', startScript: fixturePath('core/start.sh'), unit: null } } : {}) })
let checks: ReturnType<typeof vi.spyOn>, installs: ReturnType<typeof vi.spyOn>, inspections: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  checks = vi.spyOn(api.hosts, 'installCheck').mockResolvedValue(check)
  installs = vi.spyOn(api.hosts, 'install').mockImplementation(async (input, expected, operationId) => ({ ...receipt(), input, expected, operationId }))
  inspections = vi.spyOn(api.hosts, 'installInspect').mockResolvedValue(receipt('unknown'))
})
const render = (draft = host, committed: SshHostConfig | undefined = host, active = true) => dom.render(<HostInstallPanel host={draft} committed={committed} active={active} />)
const read = () => dom.click('[data-install-check]')
const confirm = () => dom.click('[data-install-confirm]')
it('checks explicitly and installs only the reviewed candidate and selected startup mode', async () => {
  await render()
  expect(checks).not.toHaveBeenCalled()
  await read()
  expect(checks).toHaveBeenCalledExactlyOnceWith(host)
  expect(installs).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Boot startup needs linger')
  await dom.click('input[value="systemd"]')
  await confirm()
  expect(installs).toHaveBeenCalledExactlyOnceWith(host, { ...check.expected, keepRunning: 'systemd' }, expect.any(String))
  expect(checks).toHaveBeenCalledTimes(1)
  expect(dom.container.textContent).toContain('Core installed')
  expect(dom.container.querySelectorAll('[data-state="done"]')).toHaveLength(6)
})
it('unsaved and inactive workfaces cannot check or install a changed same-ID route', async () => {
  await render(); await read()
  const changed = { ...host, hostname: 'other.invalid' }
  await render(changed, host)
  expect(dom.container.querySelector('[data-install-confirm]')).toBeNull()
  await read()
  expect(checks).toHaveBeenCalledTimes(1)
  await render(host, host, false); await confirm()
  expect(installs).not.toHaveBeenCalled()
})
it('keeps a lost reply bound to its original operation and never repeats install', async () => {
  installs.mockRejectedValue(new Error('Reply lost'))
  await render(); await read(); await confirm()
  const id = installs.mock.calls[0]![2]
  expect(dom.container.textContent).toContain('Original install needs checking')
  expect(dom.container.textContent).toContain(id)
  await dom.click('[data-install-inspect]')
  expect(inspections).toHaveBeenCalledExactlyOnceWith(host, id)
  expect(installs).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('[data-install-confirm]')).toBeNull()
})
it('does not treat a missing original record as permission to replay', async () => {
  installs.mockRejectedValue(new Error('Reply lost')); inspections.mockResolvedValue(null)
  await render(); await read(); await confirm(); await dom.click('[data-install-inspect]')
  expect(dom.container.textContent).toContain('No record was found')
  expect(installs).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('[data-install-check]')).toBeNull()
})
it('keeps completed installation visible after Main adopts its new connection', async () => {
  await render(); await read(); await confirm()
  const installed = receipt().installed!
  await render({ ...host, remoteCommand: installed.remoteCommand, remoteSocketPath: installed.remoteSocketPath, runtimeId: installed.runtimeId },
    { ...host, remoteCommand: installed.remoteCommand, remoteSocketPath: installed.remoteSocketPath, runtimeId: installed.runtimeId })
  expect(dom.container.textContent).toContain('Core installed')
  expect(installs).toHaveBeenCalledTimes(1)
})
it('shows an existing Core or unavailable probe without an install confirmation', async () => {
  checks.mockResolvedValue({ ...check, eligible: false, expected: undefined, reason: 'installed', detail: 'A Core already runs here. Use Core update.' })
  await render(); await read()
  expect(dom.container.textContent).toContain('Use Core update')
  expect(dom.container.querySelector('[data-install-confirm]')).toBeNull()
})
it('cannot select a systemd manager that the probe did not confirm', async () => {
  checks.mockResolvedValue({ ...check, keepRunning: [{ mode: 'start-script', available: true, startsAtBoot: false }, { mode: 'systemd', available: false, startsAtBoot: null }] })
  await render(); await read()
  expect(dom.container.querySelector<HTMLInputElement>('input[value="systemd"]')?.disabled).toBe(true)
  await confirm()
  expect(installs.mock.calls[0]![1].keepRunning).toBe('start-script')
})
it('recovers the retained original operation from a fresh check after the view restarts', async () => {
  const original = receipt('unknown')
  checks.mockResolvedValue({ ...check, eligible: false, expected: undefined, reason: 'unverified', latestOperation: original })
  await render(); await read()
  expect(dom.container.textContent).toContain('Original install needs checking')
  expect(dom.container.textContent).toContain(original.operationId)
  await dom.click('[data-install-inspect]')
  expect(inspections).toHaveBeenCalledExactlyOnceWith(original.input, original.operationId)
  expect(installs).not.toHaveBeenCalled()
})
it('allows a fresh reviewed attempt after a confirmed pre-write failure, retaining the old operation in Core', async () => {
  installs.mockImplementationOnce(async (input, expected, operationId) => ({ ...receipt('failed'), input, expected, operationId, stage: 'preparing' }))
  await render(); await read(); await confirm()
  const original = installs.mock.results[0]
  expect(dom.container.textContent).toContain('Installation did not complete')
  checks.mockResolvedValue({ ...check, latestOperation: await original!.value })
  await dom.click('[data-install-recheck]')
  expect(dom.container.querySelector('[data-install-confirm]')).not.toBeNull()
  expect(installs).toHaveBeenCalledTimes(1)
})
it('keeps the original operation discoverable when this Host route is edited', async () => {
  installs.mockRejectedValue(new Error('Reply lost'))
  await render(); await read(); await confirm()
  const id = installs.mock.calls[0]![2]
  const changed = { ...host, hostname: 'other.invalid' }
  await render(changed, changed)
  expect(dom.container.textContent).toContain('Original install on build.invalid')
  expect(dom.container.textContent).toContain(id)
  expect(dom.container.querySelector<HTMLButtonElement>('[data-install-check]')?.disabled).toBe(false)
  expect(installs).toHaveBeenCalledTimes(1)
})
it('explicitly adopts a reconciled completed installation with the same operation ID', async () => {
  installs.mockRejectedValueOnce(new Error('Original response lost'))
  await render(); await read(); await confirm()
  const id = installs.mock.calls[0]![2], expected = installs.mock.calls[0]![1]
  inspections.mockResolvedValue({ ...receipt(), operationId: id, expected,
    connectionAdoption: { state: 'pending-confirmation', readAt: 100, detail: 'Installation confirmed; connection adoption has not run.' } })
  await dom.click('[data-install-inspect]')
  expect(installs).toHaveBeenCalledTimes(1)
  await dom.click('[data-install-connect]')
  expect(installs).toHaveBeenLastCalledWith(host, expected, id)
})

it('keeps completed installation primary until the user explicitly moves to updates', async () => {
  const updates = vi.spyOn(api.hosts, 'upgradeCheck').mockImplementation(async input => ({ input,
    current: { state: 'unavailable', observedAt: 1, code: 'UNAVAILABLE', detail: 'No observation' },
    candidate: null, eligible: false, reason: 'unverified', detail: 'No observation' }))
  await dom.render(<HostCorePanel host={host} committed={host} active />)
  await read(); await confirm()
  const installed = receipt().installed!
  const adopted = { ...host, remoteCommand: installed.remoteCommand, remoteSocketPath: installed.remoteSocketPath, runtimeId: installed.runtimeId }
  await dom.render(<HostCorePanel host={adopted} committed={adopted} active />)
  expect(dom.container.querySelector('[data-host-upgrade]')?.closest('[hidden]')).not.toBeNull()
  const before = updates.mock.calls.length
  await dom.click('[data-install-updates]')
  expect(updates.mock.calls.length).toBe(before + 1)
  expect(dom.container.querySelector('[data-host-upgrade]')?.closest('[hidden]')).toBeNull()
  expect(dom.container.querySelector('[data-host-install]')?.closest('[hidden]')).not.toBeNull()
})

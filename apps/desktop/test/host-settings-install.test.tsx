// @vitest-environment happy-dom
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RemoteCoreInstallCheck, RemoteCoreInstallReceipt } from '@agentmux/core'
import type { SshHostConfig } from '../src/shared/contracts'
import { HostCorePanel } from '../src/renderer/src/components/settings/HostCorePanel'
import { HostCorePanel as HostInstallPanel } from '../src/renderer/src/components/settings/HostCorePanel'
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
  vi.spyOn(api.hosts, 'upgradeCheck').mockImplementation(async input => ({ input,
    current: { state: 'unavailable', observedAt: 1, code: 'UNAVAILABLE', detail: 'No observation' },
    candidate: null, eligible: false, reason: 'unverified', detail: 'No observation' }))
  checks = vi.spyOn(api.hosts, 'installCheck').mockResolvedValue(check)
  installs = vi.spyOn(api.hosts, 'install').mockImplementation(async (input, expected, operationId) => ({ ...receipt(), input, expected, operationId }))
  inspections = vi.spyOn(api.hosts, 'installInspect').mockResolvedValue(receipt('unknown'))
})
const render = (draft = host, committed: SshHostConfig | undefined = host, active = true) => dom.render(<HostInstallPanel host={draft} committed={committed} active={active} />)
const read = () => dom.click(dom.container.querySelector('[data-install-check]') ? '[data-install-check]' : '[data-upgrade-action]')
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
  expect(dom.container.querySelector('[data-host-install]')).toBeNull()
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
  expect(dom.container.querySelector<HTMLButtonElement>('[data-upgrade-action]')?.disabled).toBe(false)
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
  expect(dom.container.querySelector('[data-host-upgrade]')).toBeNull()
  const before = updates.mock.calls.length
  await dom.click('[data-install-updates]')
  expect(updates.mock.calls.length).toBe(before + 1)
  expect(dom.container.querySelector('[data-host-upgrade]')?.closest('[hidden]')).toBeNull()
  expect(dom.container.querySelector('[data-host-install]')).toBeNull()
})

it('unverified probes share one maintenance summary and keep raw diagnostics collapsed without proposing installation', async () => {
  const detail = 'Original probe traceback: unsupported subprocess keyword'
  checks.mockResolvedValue({ input: host, eligible: false, reason: 'unverified', detail })
  const copy = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const upgrades = vi.spyOn(api.hosts, 'upgrade')
  await render(); await read()
  expect(checks).toHaveBeenCalledExactlyOnceWith(host)
  expect(dom.container.querySelectorAll('[data-host-upgrade]')).toHaveLength(1)
  expect(dom.container.querySelector('[data-host-install]')).toBeNull()
  expect(dom.container.textContent).not.toContain('Set up this machine')
  expect(dom.container.textContent).not.toContain('Ready to install')
  const raw = Array.from(dom.container.querySelectorAll('.host-upgrade__diagnostic-message')).find(node => node.textContent === detail)!
  expect(raw).toBeDefined()
  expect(raw.closest('details')?.open).toBe(false)
  await dom.click('[data-copy-upgrade-diagnostics]')
  expect(copy.mock.calls[0]![0]).toContain(detail)
  expect(installs).not.toHaveBeenCalled(); expect(upgrades).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})
it('does not start an installation check for a newly observed unresolved original upgrade', async () => {
  const original = { input: host, operationId: 'original-upgrade', status: 'unknown' as const, stage: 'starting' as const,
    expected: { targetDigest: 'a'.repeat(64), runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', processId: 100, startTicks: '1', candidateDigest: 'b'.repeat(64), nativeInstanceId: 'original-native', nativeProcessId: 101, nativeStartTicks: '2' }, detail: 'Original response lost', updatedAt: 1 }
  const upgrade = vi.spyOn(api.hosts, 'upgradeCheck')
  await render()
  upgrade.mockResolvedValueOnce({ input: host, current: { state: 'unavailable', code: 'UNAVAILABLE', detail: 'Not observed', observedAt: 1 }, candidate: null, eligible: false, reason: 'unverified', latestOperation: original, detail: 'Original operation unconfirmed' })
  const inspect = vi.spyOn(api.hosts, 'upgradeInspect').mockResolvedValue(original)
  await read()
  expect(inspect).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Original upgrade needs checking')
  await read()
  expect(inspect).toHaveBeenCalledExactlyOnceWith(host, original.operationId)
  expect(checks).not.toHaveBeenCalled(); expect(installs).not.toHaveBeenCalled()
})
it('a late unavailable observation never checks installation on a newly selected same-ID route', async () => {
  let finish!: (value: Awaited<ReturnType<typeof api.hosts.upgradeCheck>>) => void
  const pending = new Promise<Awaited<ReturnType<typeof api.hosts.upgradeCheck>>>(resolve => { finish = resolve })
  const upgrade = vi.spyOn(api.hosts, 'upgradeCheck')
  await render()
  upgrade.mockReturnValueOnce(pending)
  await act(async () => { dom.container.querySelector<HTMLButtonElement>('[data-upgrade-action]')!.click() })
  const changed = { ...host, hostname: 'changed.invalid' }
  await render(changed, changed)
  await act(async () => finish({ input: host, current: { state: 'unavailable', code: 'UNAVAILABLE', detail: 'Original unavailable', observedAt: 1 }, candidate: null, eligible: false, reason: 'unverified', detail: 'Original unavailable' }))
  expect(checks).not.toHaveBeenCalled(); expect(installs).not.toHaveBeenCalled()
})

it('a failed new installation check keeps the old facts as diagnostics rather than a ready install', async () => {
  await render(); await read()
  expect(dom.container.querySelector('[data-install-confirm]')).not.toBeNull()
  checks.mockRejectedValueOnce(new Error('This later probe is unconfirmed'))
  await read()
  expect(dom.container.querySelector('[data-install-confirm]')).toBeNull()
  expect(dom.container.querySelector('[data-host-install]')).toBeNull()
  expect(dom.container.textContent).toContain('This later probe is unconfirmed')
  expect(installs).not.toHaveBeenCalled()
})

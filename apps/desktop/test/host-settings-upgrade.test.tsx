import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { RemoteCoreUpgradeCheck, RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { SshHostConfig } from '../src/shared/contracts'
import { HostUpgradePanel } from '../src/renderer/src/components/settings/HostUpgradePanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const host: SshHostConfig = { id: 'build', kind: 'ssh', label: 'Build server', hostname: 'build.invalid',
  runtimeId: 'original-runtime', remoteCommand: _hygiene_fixturePath("opt/original/agentmux"), remoteSocketPath: _hygiene_fixturePath("srv/original/control.sock") }
const candidateDigest = 'a'.repeat(64)
const check: RemoteCoreUpgradeCheck = { input: host, eligible: true, reason: 'ready', detail: 'Original owner is qualified',
  candidate: { digest: candidateDigest, sourceCommit: 'b'.repeat(40), protocolVersion: 22 },
  expected: { targetDigest: 'c'.repeat(64), runtimeId: 'original-runtime', ownerInstanceId: 'original-owner',
    processId: 100, startTicks: '123', candidateDigest, nativeInstanceId: 'native-owner', nativeProcessId: 101, nativeStartTicks: '456' } }
const refusal = (detail = 'The current Runtime cannot be safely updated; original Runs were preserved.'): RemoteCoreUpgradeCheck => ({
  input: host, candidate: check.candidate, eligible: false, reason: 'runtime-update-required', detail })
const receipt = (status: RemoteCoreUpgradeReceipt['status']): RemoteCoreUpgradeReceipt => ({ input: host,
  operationId: 'original-operation', expected: check.expected!, status, stage: status === 'completed' ? 'completed' : 'verifying',
  detail: status === 'completed' ? 'Core updated and exact connection verified' : 'Original upgrade receipt is unconfirmed',
  ...(status === 'completed' ? { remoteCommand: host.remoteCommand! } : {}), updatedAt: 1 })
let checkCall: ReturnType<typeof vi.spyOn>, upgradeCall: ReturnType<typeof vi.spyOn>, inspectCall: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  checkCall = vi.spyOn(api.hosts, 'upgradeCheck').mockResolvedValue(check)
  upgradeCall = vi.spyOn(api.hosts, 'upgrade').mockImplementation(async (input, expected, operationId) => ({ ...receipt('completed'), input, expected, operationId }))
  inspectCall = vi.spyOn(api.hosts, 'upgradeInspect').mockResolvedValue(receipt('completed'))
})
const render = (draft = host, committed: SshHostConfig | undefined = host, active = true) => dom.render(<HostUpgradePanel host={draft} committed={committed} active={active} />)
const click = () => dom.click('[data-upgrade-action]')
it('checks automatically, then one explicit click rechecks and pins the owner before upgrading', async () => {
  await render(); await click()
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(checkCall.mock.calls.every(([input]) => input.hostname === host.hostname)).toBe(true)
  expect(upgradeCall).toHaveBeenCalledExactlyOnceWith(host, check.expected, expect.stringMatching(/^[a-f0-9-]{36}$/))
  expect(inspectCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Upgrade complete')
})
it('displays a qualified refusal without invoking upgrade or stopping a service', async () => {
  checkCall.mockResolvedValue(refusal())
  await render()
  expect(checkCall).toHaveBeenCalledExactlyOnceWith(host)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Automatic upgrade unavailable')
  expect(dom.container.textContent).toContain('original Runs were preserved')
})
it('Recheck availability only rechecks eligibility; a new qualified result still waits for an explicit upgrade', async () => {
  checkCall.mockResolvedValueOnce(refusal()).mockResolvedValue(check)
  await render()
  expect(dom.container.textContent).toContain('Recheck availability')
  await click()
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Upgrade and reconnect')
  await click()
  expect(upgradeCall).toHaveBeenCalledTimes(1)
})
it('reconciles a retained unknown operation instead of admitting another upgrade', async () => {
  checkCall.mockResolvedValue({ input: host, candidate: check.candidate, eligible: false, reason: 'unverified',
    detail: 'Core update requires reconciliation', latestOperation: receipt('unknown') })
  await render()
  expect(inspectCall).not.toHaveBeenCalled()
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Check original result')
  expect(dom.container.querySelector('.field-hint')!.textContent).toContain('previous update result is not confirmed')
  await click()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Upgrade complete')
})
it('retains the admitted operation after a lost response and never retries the deployment', async () => {
  upgradeCall.mockRejectedValue(new Error('Connection lost after admission'))
  await render(); await click()
  const operationId = upgradeCall.mock.calls[0]![2]
  expect(dom.container.textContent).toContain('Upgrade result unconfirmed')
  await click()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, operationId)
  expect(upgradeCall).toHaveBeenCalledTimes(1)
})
it('retains the original unknown operation after Main saved its new command but reconnection failed', async () => {
  const next = { ...host, remoteCommand: _hygiene_fixturePath("srv/original/core-releases/verified/bin/agentmux-public") }
  inspectCall.mockResolvedValue({ ...receipt('completed'), remoteCommand: next.remoteCommand })
  upgradeCall.mockImplementation(async (input, expected, operationId) => ({ ...receipt('unknown'), input, expected, operationId,
    remoteCommand: next.remoteCommand, detail: 'Core updated; the original connection still needs verification.' }))
  await render(); await click()
  const operationId = upgradeCall.mock.calls[0]![2]
  await render(next, next)
  expect(dom.container.textContent).toContain('Upgrade result unconfirmed')
  expect(dom.container.textContent).toContain('Check original result')
  expect(dom.container.querySelector('.host-upgrade__diagnostic-message')!.textContent).toContain('the original connection still needs verification')
  await click()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, operationId)
  expect(upgradeCall).toHaveBeenCalledTimes(1)
  expect(dom.container.textContent).toContain('Upgrade complete')
  const changed = { ...next, hostname: 'another.invalid' }
  await render(changed, changed)
  expect(dom.container.textContent).not.toContain('the original connection still needs verification')
})
it('keeps a running original operation visible while its staged command has not been saved', async () => {
  checkCall.mockResolvedValue({ input: host, candidate: check.candidate, eligible: false, reason: 'unverified',
    detail: 'The original operation is still running', latestOperation: { ...receipt('running'),
      remoteCommand: _hygiene_fixturePath("srv/original/core-releases/staged/bin/agentmux-public") } })
  await render()
  expect(inspectCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Upgrade result unconfirmed')
  expect(dom.container.textContent).toContain('Check original result')
  await click()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('does not use a late eligibility result after a draft or same-ID saved connection changed', async () => {
  let resolve!: (value: RemoteCoreUpgradeCheck) => void
  checkCall.mockReturnValueOnce(new Promise<RemoteCoreUpgradeCheck>(done => { resolve = done }))
  const changed = { ...host, hostname: 'another.invalid' }
  checkCall.mockResolvedValue({ ...check, input: changed, detail: 'Replacement is qualified' })
  await render()
  await render(changed, changed)
  expect(checkCall).toHaveBeenCalledTimes(1)
  await act(async () => resolve(check))
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(checkCall.mock.calls[1]![0]).toEqual(changed)
  expect(dom.container.textContent).toContain('Replacement is qualified')
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).not.toContain('Original owner is qualified')
  expect(dom.container.textContent).not.toContain('Upgrade complete')
})
it('requires the selected connection to be saved and leaves other capabilities available', async () => {
  await render({ ...host, hostname: 'authored.invalid' }, host)
  expect(dom.container.querySelector<HTMLButtonElement>('[data-host-upgrade] button')!.disabled).toBe(true)
  expect(dom.container.textContent).toContain('Save this connection before upgrading')
  expect(checkCall).not.toHaveBeenCalled()
  expect(upgradeCall).not.toHaveBeenCalled()
})

it('automatically shows pending and qualified states without admitting any deployment', async () => {
  let resolve!: (value: RemoteCoreUpgradeCheck) => void
  checkCall.mockReturnValueOnce(new Promise<RemoteCoreUpgradeCheck>(done => { resolve = done }))
  await render()
  expect(checkCall).toHaveBeenCalledExactlyOnceWith(host)
  expect(dom.container.textContent).toContain('Checking upgrade')
  expect(upgradeCall).not.toHaveBeenCalled()
  await act(async () => resolve(check))
  expect(dom.container.textContent).toContain('Ready to upgrade')
  expect(dom.container.textContent).not.toContain('New version')
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
})
it('deduplicates the same route across rerenders and label edits, and checks again on reentry', async () => {
  await render()
  await render({ ...host })
  await render({ ...host, label: 'New name' }, { ...host, label: 'New name' })
  expect(checkCall).toHaveBeenCalledTimes(1)
  await render(host, host, false)
  await render()
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('does not check hidden or unsaved targets and checks the exact route only when visible and saved', async () => {
  const changed = { ...host, hostname: 'new.invalid' }
  await render(host, host, false)
  await render(changed, changed, false)
  await render(changed, host)
  expect(checkCall).not.toHaveBeenCalled()
  await render(changed, changed)
  expect(checkCall).toHaveBeenCalledExactlyOnceWith(changed)
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('keeps a failed automatic observation unknown without a retry loop or an automatic deployment', async () => {
  checkCall.mockRejectedValueOnce(new Error('SSH observation timed out')).mockResolvedValue(check)
  await render()
  await render({ ...host })
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(dom.container.textContent).toContain('Upgrade check unconfirmed')
  expect(dom.container.textContent).toContain('SSH observation timed out')
  expect(dom.container.textContent).toContain('Recheck availability')
  await click()
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
})
it('does not start another check after an in-flight observation finishes in a hidden editor', async () => {
  let resolve!: (value: RemoteCoreUpgradeCheck) => void
  checkCall.mockReturnValueOnce(new Promise<RemoteCoreUpgradeCheck>(done => { resolve = done }))
  await render()
  const changed = { ...host, hostname: 'next.invalid' }
  await render(changed, changed, false)
  await act(async () => resolve(check))
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
})
it('keeps a completed original receipt through the saved command update without launching another check', async () => {
  const next = { ...host, remoteCommand: _hygiene_fixturePath("srv/original/core-releases/verified/bin/agentmux-public") }
  upgradeCall.mockImplementation(async (input, expected, operationId) => ({ ...receipt('completed'), input, expected, operationId, remoteCommand: next.remoteCommand }))
  await render(); await click()
  expect(checkCall).toHaveBeenCalledTimes(2)
  await render(next, next)
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).toContain('Upgrade complete')
  expect(upgradeCall).toHaveBeenCalledTimes(1)
})
it('keeps an admitted failure visible rather than replacing it with an automatic check', async () => {
  upgradeCall.mockImplementation(async (input, expected, operationId) => ({ ...receipt('failed'), input, expected, operationId,
    detail: 'The original update failed; original Runs remain available', remoteCommand: _hygiene_fixturePath("srv/original/core-releases/staged/bin/agentmux-public") }))
  await render(); await click()
  await render({ ...host })
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).toContain('Upgrade not completed')
  expect(dom.container.textContent).toContain('original Runs remain available')
})
it('joins the original in-flight check when reentering the same connection', async () => {
  let resolve!: (value: RemoteCoreUpgradeCheck) => void
  checkCall.mockReturnValueOnce(new Promise<RemoteCoreUpgradeCheck>(done => { resolve = done }))
  await render()
  await render(host, host, false)
  await render()
  expect(checkCall).toHaveBeenCalledTimes(1)
  await act(async () => resolve(check))
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(dom.container.textContent).toContain('Ready to upgrade')
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
})
it('keeps the terminal receipt in its current entry, but checks new facts on an explicit reentry', async () => {
  await render(); await click()
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(dom.container.textContent).toContain('Upgrade complete')
  await render(host, host, false)
  await render()
  expect(checkCall).toHaveBeenCalledTimes(3)
  expect(upgradeCall).toHaveBeenCalledTimes(1)
  expect(inspectCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Ready to upgrade')
})
it('retains an unknown original operation across reentry without another automatic check or inspection', async () => {
  checkCall.mockResolvedValue({ input: host, candidate: check.candidate, eligible: false, reason: 'unverified',
    detail: 'Original result remains unknown', latestOperation: receipt('unknown') })
  await render()
  await render(host, host, false)
  await render()
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
  await click()
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(inspectCall).toHaveBeenCalledTimes(1)
  expect(dom.container.textContent).toContain('Upgrade complete')
})
it('explains an unavailable runtime update before its closed technical details and offers explicit diagnostics', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  checkCall.mockResolvedValue(refusal('远端 Runtime 为协议 21，本机候选为协议 22。原 Agent 已保留。'))
  const keyed = { ...host, identityFile: _hygiene_fixturePath("private/key"), remoteCommand: 'do-not-copy-private-command' }
  await render(keyed, keyed)
  const details = dom.container.querySelector<HTMLDetailsElement>('.host-upgrade__details')!
  expect(details.open).toBe(false)
  expect(dom.container.querySelector('.host-upgrade__description')!.textContent).toContain('cannot safely perform')
  expect(dom.container.querySelector('.host-upgrade__next-step')!.textContent).toContain('whoever maintains this host')
  expect(dom.container.textContent).toContain('Required Runtime protocol')
  expect(dom.container.textContent).not.toContain('Runtime update required')
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Recheck availability')
  expect(clipboard).not.toHaveBeenCalled()
  await dom.click('[data-copy-upgrade-diagnostics]')
  expect(clipboard).toHaveBeenCalledTimes(1)
  const copied = clipboard.mock.calls[0]![0]
  expect(copied).toContain('Build server (build)')
  expect(copied).toContain('远端 Runtime 为协议 21')
  expect(copied).toContain(check.candidate.sourceCommit)
  expect(copied).toContain(check.candidate.digest)
  expect(copied).toContain('Required Runtime protocol: 22')
  expect(copied).not.toContain(keyed.identityFile)
  expect(copied).not.toContain(keyed.remoteCommand)
  expect(dom.container.querySelector('.host-upgrade__copy-feedback')!.textContent).toContain('Diagnostics copied')
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
})
it('keeps the original maintenance result on a failed clipboard write and reports success only after a successful retry', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockRejectedValueOnce(new Error('Clipboard denied')).mockResolvedValue(undefined)
  checkCall.mockResolvedValue(refusal())
  await render(); await dom.click('[data-copy-upgrade-diagnostics]')
  expect(dom.container.querySelector('[role=alert]')!.textContent).toContain('Clipboard denied')
  expect(dom.container.textContent).toContain('Automatic upgrade unavailable')
  expect(dom.container.querySelector('.host-upgrade__copy-feedback')!.textContent).not.toContain('Diagnostics copied')
  await dom.click('[data-copy-upgrade-diagnostics]')
  expect(clipboard).toHaveBeenCalledTimes(2)
  expect(dom.container.querySelector('[role=alert]')).toBeNull()
  expect(dom.container.querySelector('.host-upgrade__copy-feedback')!.textContent).toContain('Diagnostics copied')
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('does not borrow a late copied confirmation after the saved route changed', async () => {
  let finish!: () => void
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  checkCall.mockImplementation(async input => ({ ...refusal(), input }))
  await render(); await dom.click('[data-copy-upgrade-diagnostics]')
  expect(dom.container.querySelector('[data-copy-upgrade-diagnostics]')!.textContent).toContain('Copying')
  const changed = { ...host, identityFile: _hygiene_fixturePath("different-key") }
  await render(changed, changed)
  await act(async () => finish())
  expect(clipboard).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('.host-upgrade__copy-feedback')).toBeNull()
  expect(dom.container.querySelector('[data-copy-upgrade-diagnostics]')!.textContent).toContain('Copy diagnostics')
})
it('copies an unknown original operation without inspecting or replacing it and offers only original-result checking', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'unverified', latestOperation: receipt('unknown') })
  await render(); await dom.click('[data-copy-upgrade-diagnostics]')
  expect(clipboard.mock.calls[0]![0]).toContain('Operation: original-operation')
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Check original result')
  expect(dom.container.textContent).not.toContain('whoever maintains this host')
  expect(inspectCall).not.toHaveBeenCalled()
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('offers a fresh availability check after completion instead of repeating the upgrade', async () => {
  await render(); await click()
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Recheck availability')
  await click()
  expect(checkCall).toHaveBeenCalledTimes(3)
  expect(upgradeCall).toHaveBeenCalledTimes(1)
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Upgrade and reconnect')
})
it('reports an unknown Core source consistently in readable diagnostics and the copied payload', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const blocked = refusal()
  checkCall.mockResolvedValue({ ...blocked, candidate: { ...blocked.candidate, sourceCommit: null } })
  await render()
  expect(dom.container.querySelector('.host-upgrade__facts code')!.textContent).toBe('Unknown')
  await dom.click('[data-copy-upgrade-diagnostics]')
  expect(clipboard.mock.calls[0]![0]).toContain('App Core source: Unknown')
  expect(clipboard.mock.calls[0]![0]).not.toContain('App Core source: null')
})
it('does not let an old copied result replace a newer copy still in progress', async () => {
  const pending: Array<() => void> = []
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockImplementation(() => new Promise<void>(resolve => { pending.push(resolve) }))
  checkCall.mockImplementation(async input => ({ ...refusal(), input }))
  await render(); await dom.click('[data-copy-upgrade-diagnostics]')
  const changed = { ...host, identityFile: _hygiene_fixturePath("different-key") }
  await render(changed, changed); await dom.click('[data-copy-upgrade-diagnostics]')
  expect(clipboard).toHaveBeenCalledTimes(2)
  await act(async () => pending[0]!())
  expect(dom.container.querySelector('[data-copy-upgrade-diagnostics]')!.textContent).toContain('Copying')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-copy-upgrade-diagnostics]')!.disabled).toBe(true)
  await act(async () => pending[1]!())
  expect(dom.container.querySelector('.host-upgrade__copy-feedback')!.textContent).toContain('Diagnostics copied')
  expect(upgradeCall).not.toHaveBeenCalled()
})

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
const click = () => dom.click('[data-host-upgrade] > .host-upgrade__heading > button')
it('one click checks, pins the exact owner and candidate, and invokes the real public API once', async () => {
  await render(); await click()
  expect(checkCall).toHaveBeenCalledExactlyOnceWith(host)
  expect(upgradeCall).toHaveBeenCalledExactlyOnceWith(host, check.expected, expect.stringMatching(/^[a-f0-9-]{36}$/))
  expect(inspectCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Upgrade complete')
})
it('displays a qualified refusal without invoking upgrade or stopping a service', async () => {
  checkCall.mockResolvedValue(refusal())
  await render(); await click()
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Runtime update required')
  expect(dom.container.textContent).toContain('original Runs were preserved')
})
it('Check again only rechecks eligibility; a new qualified result still waits for an explicit upgrade', async () => {
  checkCall.mockResolvedValueOnce(refusal()).mockResolvedValue(check)
  await render(); await click()
  expect(dom.container.textContent).toContain('Check again')
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
  await render(); await click()
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Check upgrade result')
  expect(dom.container.querySelector('.field-hint')!.textContent).toContain('Original upgrade receipt is unconfirmed')
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
  expect(dom.container.textContent).toContain('Check upgrade result')
  expect(dom.container.querySelector('.field-hint')!.textContent).toContain('the original connection still needs verification')
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
  await render(); await click()
  expect(dom.container.textContent).toContain('Upgrade result unconfirmed')
  expect(dom.container.textContent).toContain('Check upgrade result')
  await click()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('does not use a late eligibility result after a draft or same-ID saved connection changed', async () => {
  let resolve!: (value: RemoteCoreUpgradeCheck) => void
  checkCall.mockReturnValue(new Promise<RemoteCoreUpgradeCheck>(done => { resolve = done }))
  await render(); await click()
  const changed = { ...host, hostname: 'another.invalid' }
  await render(changed, changed)
  await act(async () => resolve(check))
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

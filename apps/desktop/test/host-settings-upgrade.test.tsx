import { fixturePath } from '../scripts/lib/fixture-values.mjs'
// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteCoreUpgradeCheck, RemoteCoreUpgradeReceipt } from '@agentmux/core'
import type { SshHostConfig } from '../src/shared/contracts'
import { HostCorePanel as HostUpgradePanel } from '../src/renderer/src/components/settings/HostCorePanel'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const host: SshHostConfig = { id: 'build', kind: 'ssh', label: 'Build server', hostname: 'build.invalid',
  runtimeId: 'original-runtime', remoteCommand: fixturePath('opt/original/agentmux'), remoteSocketPath: fixturePath('srv/original/control.sock') }
const check: RemoteCoreUpgradeCheck & { candidate: NonNullable<RemoteCoreUpgradeCheck['candidate']> } = { input: host, eligible: true, reason: 'ready', detail: 'Original owner is qualified',
  current: { state: 'available', observedAt: 1700000000000, version: '0.1.0', sourceCommit: 'd'.repeat(40), deploymentDigest: 'e'.repeat(64),
    ownerProtocolVersion: 1, runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', processId: 100,
    native: { instanceId: 'native-owner', buildId: 'native-build', protocolVersion: 25 } },
  candidate: { digest: 'a'.repeat(64), version: '0.1.0', sourceCommit: 'b'.repeat(40), ownerProtocolVersion: 2, requiredNativeProtocolVersion: 25 },
  expected: { targetDigest: 'c'.repeat(64), runtimeId: 'original-runtime', ownerInstanceId: 'original-owner', processId: 100,
    startTicks: '123', candidateDigest: 'a'.repeat(64), nativeInstanceId: 'native-owner', nativeProcessId: 101, nativeStartTicks: '456' } }
const receipt = (status: RemoteCoreUpgradeReceipt['status'] = 'unknown'): RemoteCoreUpgradeReceipt => ({ input: host,
  operationId: 'original-operation', expected: check.expected!, status, stage: status === 'completed' ? 'completed' : 'verifying',
  detail: 'Original service result', updatedAt: 1700000001000,
  ...(status === 'completed' ? { remoteCommand: host.remoteCommand, connectionAdoption: { state: 'pending-confirmation' as const, readAt: 1700000002000 } } : {}) })
let checkCall: ReturnType<typeof vi.spyOn>, upgradeCall: ReturnType<typeof vi.spyOn>, inspectCall: ReturnType<typeof vi.spyOn>, reconnectCall: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  checkCall = vi.spyOn(api.hosts, 'upgradeCheck').mockResolvedValue(check)
  upgradeCall = vi.spyOn(api.hosts, 'upgrade').mockImplementation(async (input, expected, operationId) => ({ ...receipt('completed'), input, expected, operationId,
    candidate: check.candidate, connectionAdoption: { state: 'connected', readAt: 1700000003000 } }))
  inspectCall = vi.spyOn(api.hosts, 'upgradeInspect').mockResolvedValue(receipt('completed'))
  reconnectCall = vi.spyOn(api.hosts, 'upgradeReconnect').mockResolvedValue({ ...receipt('completed'), connectionAdoption: { state: 'connected', readAt: 1700000003000 } })
})
const render = (draft = host, committed: SshHostConfig | undefined = host, active = true) => dom.render(<HostUpgradePanel host={draft} committed={committed} active={active} />)
const action = () => dom.click('[data-upgrade-action]')
const review = async () => { await action(); expect(dom.container.querySelector('[aria-label="Review upgrade"]')).not.toBeNull() }
const confirm = () => dom.click('[data-upgrade-confirm]')
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

it('automatically reads exact versions without deployment and shows same-version source differences above closed technical details', async () => {
  await render()
  expect(checkCall).toHaveBeenCalledExactlyOnceWith(host)
  expect(upgradeCall).not.toHaveBeenCalled()
  const facts = dom.container.querySelector('[aria-label="Current and target Core versions"]')!
  expect(facts.closest('details')).toBeNull()
  expect(facts.textContent).toContain('0.1.0Source dddddddddd')
  expect(facts.textContent).toContain('0.1.0Source bbbbbbbbbb')
  expect(dom.container.querySelector('.host-upgrade__read-time time')?.getAttribute('datetime')).toBe(new Date(check.current.observedAt).toISOString())
  expect(dom.container.querySelector<HTMLDetailsElement>('details')!.open).toBe(false)
  expect(dom.container.textContent).toContain('Core owner API protocol · deployed / app1 / 2')
  expect(dom.container.textContent).toContain('Native protocol · current / required25 / 25')
})
it('one explicit Core-only update submits the displayed tuple without another review or fresh check', async () => {
  await render()
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toBe('Update Core')
  checkCall.mockResolvedValue({ ...check, candidate: { ...check.candidate, digest: 'f'.repeat(64) }, expected: { ...check.expected!, candidateDigest: 'f'.repeat(64) } })
  await action()
  expect(dom.container.querySelector('[aria-label="Review upgrade"]')).toBeNull()
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).toHaveBeenCalledExactlyOnceWith(host, check.expected, expect.any(String))
  expect(dom.container.textContent).toContain('Deployment completed')
  expect(dom.container.textContent).toContain('Connection verified at')
})
it('does not borrow a checked target when the same-ID saved route changes', async () => {
  await render()
  const changed = { ...host, hostname: 'other.invalid' }, pending = deferred<RemoteCoreUpgradeCheck>()
  checkCall.mockReturnValueOnce(pending.promise)
  await render(changed, changed); await action()
  expect(dom.container.querySelector('[data-upgrade-confirm]')).toBeNull()
  expect(upgradeCall).not.toHaveBeenCalled()
  const expected = { ...check.expected!, targetDigest: 'f'.repeat(64) }
  await act(async () => pending.resolve({ ...check, input: changed, expected }))
  await action()
  expect(upgradeCall).toHaveBeenCalledExactlyOnceWith(changed, expected, expect.any(String))
})
it('preserves the original admitted ID after a lost response and inspects it without replay', async () => {
  upgradeCall.mockRejectedValue(new Error('Lost result after admission'))
  await render(); await action()
  const operationId = upgradeCall.mock.calls[0]![2]
  expect(dom.container.textContent).toContain('Original upgrade result unconfirmed')
  await action()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, operationId)
  expect(upgradeCall).toHaveBeenCalledTimes(1)
  expect(reconnectCall).not.toHaveBeenCalled()
})
it('a refusal before admission leaves no record, so the original check clears it and restores Check versions', async () => {
  upgradeCall.mockRejectedValue(new Error('Save this exact Host configuration before upgrading it.'))
  inspectCall.mockResolvedValue(null)
  await render(); await action()
  const operationId = upgradeCall.mock.calls[0]![2]
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toBe('Check original result')
  await action()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, operationId)
  expect(dom.container.querySelector('[role="status"]')!.textContent).toBe('Upgrade not started')
  expect(dom.container.querySelector('[aria-label="Original update receipt"]')).toBeNull()
  expect(dom.container.textContent).toContain('Save this exact Host configuration before upgrading it.')
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toBe('Check Core')
  await action()
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toBe('Update Core')
  expect(upgradeCall).toHaveBeenCalledTimes(1)
})
it('names an unreadable update record beside the receipt of a prior operation', async () => {
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'up-to-date', expected: undefined, latestOperation: receipt('completed'), unreadableOperations: ['damaged-operation'] })
  await render()
  expect(dom.container.querySelector('[aria-label="Original update receipt"]')).not.toBeNull()
  expect(dom.container.querySelector('[data-upgrade-unreadable-records]')?.textContent ?? '').toContain('Could not read update record damaged-operation.')
  expect(dom.container.querySelector('.host-upgrade__diagnostic-message')!.textContent).toBe('Original service result')
  const details = dom.container.querySelector('.host-upgrade__facts')!.textContent!
  expect(details).toContain('Unreadable update records'); expect(details).toContain('damaged-operation')
  expect(upgradeCall).not.toHaveBeenCalled(); expect(inspectCall).not.toHaveBeenCalled()
})
it.each([
  ['connected', 'The saved Core connection was adopted. It was not saved for restart: the ledger could not be read.'],
  ['pending-confirmation', 'Confirm reconnect. Saved adoption receipts could not be read (Unexpected token).']
] as const)('shows the %s connection detail beside the receipt detail in Technical details and copied diagnostics', async (state, adoptionDetail) => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'up-to-date', expected: undefined,
    latestOperation: { ...receipt('completed'), connectionAdoption: { ...receipt('completed').connectionAdoption!, state, detail: adoptionDetail } } })
  await render()
  expect(dom.container.querySelector('[data-upgrade-connection-detail]')?.textContent).toBe(adoptionDetail)
  expect(dom.container.querySelector('.host-upgrade__diagnostic-message')!.textContent).toBe('Original service result')
  await dom.click('[data-copy-upgrade-diagnostics]')
  const text = clipboard.mock.calls[0]![0]
  expect(text).toContain(`Connection detail: ${adoptionDetail}`); expect(text).toContain('Details: Original service result')
  expect(upgradeCall).not.toHaveBeenCalled(); expect(inspectCall).not.toHaveBeenCalled(); expect(reconnectCall).not.toHaveBeenCalled()
})

it('same-tick double update admits one operation and preserves its exact ID for inspection', async () => {
  const pending = deferred<RemoteCoreUpgradeReceipt>()
  upgradeCall.mockReturnValue(pending.promise)
  await render()
  const button = dom.container.querySelector<HTMLButtonElement>('[data-upgrade-action]')!
  await act(async () => { button.click(); button.click() })
  expect(upgradeCall).toHaveBeenCalledTimes(1)
  const operationId = upgradeCall.mock.calls[0]![2]
  expect(dom.container.textContent).toContain('Upgrading Core')
  await act(async () => pending.resolve({ ...receipt(), operationId }))
  await action()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, operationId)
})
it('retains unknown history separately from the current app candidate and only queries the original operation', async () => {
  const old = { ...receipt(), expected: { ...check.expected!, candidateDigest: 'f'.repeat(64) } }
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'unverified', latestOperation: old })
  await render()
  expect(dom.container.textContent).toContain('Original upgrade needs checking')
  expect(dom.container.querySelector('[data-upgrade-candidate-version]')!.textContent).toContain('Source bbbbbbbbbb')
  expect(dom.container.textContent).toContain('Original upgrade candidate versionUnknown')
  expect(dom.container.textContent).toContain('f'.repeat(64))
  await action()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(reconnectCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Deployment completed')
  expect(dom.container.textContent).toContain('connection to it is not confirmed')
})
it('completed deployment stays completed while connection adoption is separate and explicit', async () => {
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'up-to-date', expected: undefined, latestOperation: receipt('completed') })
  reconnectCall.mockResolvedValue({ ...receipt('completed'), connectionAdoption: { state: 'unconfirmed', readAt: 1700000004000, detail: 'Route adoption not confirmed' } })
  await render()
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Reconnect to updated Core')
  expect(reconnectCall).not.toHaveBeenCalled()
  await action()
  expect(reconnectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(inspectCall).not.toHaveBeenCalled()
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Deployment completed')
  expect(dom.container.textContent).toContain('Connection: unconfirmed')
})
it('preserves unknown operation through a saved command change and draft round trip', async () => {
  checkCall.mockResolvedValue({ ...check, latestOperation: { ...receipt(), remoteCommand: fixturePath('srv/releases/new/core') } })
  await render()
  const adopted = { ...host, remoteCommand: fixturePath('srv/releases/new/core') }
  await render(adopted, adopted)
  const draft = { ...adopted, hostname: 'draft.invalid' }
  await render(draft, adopted)
  expect(dom.container.textContent).not.toContain('Original upgrade result unconfirmed')
  await render(adopted, adopted); await action()
  expect(inspectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('a late check updates only its original route and does not replace the selected target', async () => {
  const pending = deferred<RemoteCoreUpgradeCheck>()
  checkCall.mockReturnValueOnce(pending.promise).mockImplementation(async input => ({ ...check, input, candidate: { ...check.candidate, version: '0.2.0' } }))
  await render()
  const other = { ...host, hostname: 'other.invalid' }
  await render(other, other)
  await act(async () => pending.resolve(check))
  expect(checkCall).toHaveBeenCalledTimes(2)
  expect(dom.container.querySelector('[data-upgrade-candidate-version]')!.textContent).toContain('0.2.0')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('keeps missing version facts unknown without inventing versions from protocol or digests', async () => {
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'unverified', current: { state: 'unavailable', observedAt: 1700000000000, code: 'CONTROL_UNAVAILABLE', detail: 'Owner read unavailable' },
    candidate: { ...check.candidate, version: null, sourceCommit: null } })
  await render()
  expect(dom.container.querySelector('[data-upgrade-current-version]')!.textContent).toBe('UnknownSource unknown')
  expect(dom.container.querySelector('[data-upgrade-candidate-version]')!.textContent).toBe('UnknownContent aaaaaaaaaaaa')
  expect(dom.container.textContent).not.toContain('0.1.0')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('scopes read failure to this update check, keeps prior facts, and permits a read-only retry', async () => {
  await render()
  checkCall.mockRejectedValueOnce(new Error('Original observation unavailable'))
  await dom.click('[data-upgrade-refresh]')
  expect(dom.container.textContent).toContain('Upgrade check unconfirmed')
  expect(dom.container.textContent).toContain('Existing work remains available')
  expect(dom.container.textContent).toContain('Original observation unavailable')
  expect(dom.container.querySelector('[data-upgrade-current-version]')!.textContent).toContain('0.1.0')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('does not deploy an up-to-date candidate or perform an unsupported Native update', async () => {
  checkCall.mockResolvedValueOnce({ ...check, eligible: false, reason: 'up-to-date', expected: undefined })
  await render(); expect(dom.container.textContent).toContain('Up to date'); await action()
  expect(upgradeCall).not.toHaveBeenCalled()
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'runtime-update-required', expected: undefined })
  await dom.click('[data-upgrade-refresh]')
  expect(dom.container.textContent).toContain('Automatic upgrade unavailable')
  expect(dom.container.textContent).toContain('supported Native Runtime update')
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('hidden or unsaved routes do not check and only the update action is unavailable', async () => {
  await render(host, host, false); expect(checkCall).not.toHaveBeenCalled()
  const draft = { ...host, hostname: 'draft.invalid' }
  await render(draft, host)
  expect(dom.container.querySelector<HTMLButtonElement>('[data-upgrade-action]')!.disabled).toBe(true)
  expect(checkCall).not.toHaveBeenCalled()
  await render(); expect(checkCall).toHaveBeenCalledExactlyOnceWith(host)
  expect(upgradeCall).not.toHaveBeenCalled()
})
it('in-progress headings name the current action without changing deployment or last-reported facts', async () => {
  const pending = deferred<RemoteCoreUpgradeReceipt | null>()
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'unverified', expected: undefined, latestOperation: receipt() })
  inspectCall.mockReturnValue(pending.promise)
  await render(); await action()
  expect(dom.container.querySelector('[role=status]')!.textContent).toBe('Checking original result')
  expect(dom.container.textContent).toContain('Last reported stage')
  await act(async () => pending.resolve(receipt('completed')))
  const reconnecting = deferred<RemoteCoreUpgradeReceipt | null>()
  reconnectCall.mockReturnValue(reconnecting.promise); await action()
  expect(dom.container.querySelector('[role=status]')!.textContent).toBe('Reconnecting to updated Core')
  expect(dom.container.textContent).toContain('Deployment completed')
  await act(async () => reconnecting.resolve({ ...receipt('completed'), connectionAdoption: { state: 'connected', readAt: 1700000005000 } }))
})
it('copy diagnostics preserves original identity, distinguishes protocols and excludes private connection configuration', async () => {
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  const privateHost = { ...host, identityFile: fixturePath('private/client-key'), remoteCommand: 'private-command-token' }
  checkCall.mockImplementation(async input => ({ ...check, input, latestOperation: { ...receipt(), input } }))
  await render(privateHost, privateHost); await dom.click('[data-copy-upgrade-diagnostics]')
  const text = clipboard.mock.calls[0]![0]
  expect(text).toContain('Operation: original-operation')
  expect(text).toContain('App Core owner API protocol: 2')
  expect(text).toContain('Required Native protocol: 25')
  expect(text).toContain('Deployed Core source: '+ 'd'.repeat(40))
  expect(text).toContain('Deployed content digest: '+ 'e'.repeat(64))
  expect(text).not.toContain(privateHost.identityFile)
  expect(text).not.toContain(privateHost.remoteCommand)
  expect(inspectCall).not.toHaveBeenCalled()
  expect(upgradeCall).not.toHaveBeenCalled()
})

it('keeps deployed and bundled versions independent and names a different original Host before reconnecting it', async () => {
  const original = { ...host, id: 'original-alias', label: 'Original service alias' }
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'unverified', expected: undefined, current: { ...check.current, state: 'available', version: '0.0.9' } as RemoteCoreUpgradeCheck['current'],
    latestOperation: { ...receipt('completed'), input: original } })
  await render()
  expect(dom.container.querySelector('[data-upgrade-current-version]')!.textContent).toContain('0.0.9')
  expect(dom.container.querySelector('[data-upgrade-candidate-version]')!.textContent).toContain('0.1.0')
  expect(dom.container.textContent).toContain('Original Host: Original service alias (original-alias)')
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Reconnect Original service alias')
  await action()
  expect(reconnectCall).toHaveBeenCalledExactlyOnceWith(original, 'original-operation')
  expect(upgradeCall).not.toHaveBeenCalled()
})

it('a completed older update awaiting adoption does not block a newly qualified candidate', async () => {
  const older = { ...receipt('completed'), expected: { ...check.expected!, candidateDigest: 'f'.repeat(64) }, candidate: { ...check.candidate, digest: 'f'.repeat(64), version: '0.0.9' } }
  checkCall.mockResolvedValue({ ...check, latestOperation: older })
  await render()
  expect(dom.container.querySelector('[role=status]')!.textContent).toBe('Update available')
  expect(dom.container.querySelector('[data-upgrade-reconnect]')!.textContent).toContain('Reconnect original update')
  await action()
  expect(upgradeCall).toHaveBeenCalledExactlyOnceWith(host, check.expected, expect.any(String))
  expect(reconnectCall).not.toHaveBeenCalled()
  expect(inspectCall).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-upgrade-confirm]')).toBeNull()
  expect(dom.container.textContent).toContain('Last read before upgrade')
})

it('shows an unavailable app candidate without hiding current deployment or inventing an upgrade target', async () => {
  checkCall.mockResolvedValue({ ...check, candidate: null, candidateUnavailable: { code: 'CORE_ARTIFACT_UNAVAILABLE', detail: 'Local candidate archive was not assembled.' }, eligible: false, reason: 'unverified', expected: undefined })
  await render()
  expect(dom.container.querySelector('[data-upgrade-current-version]')!.textContent).toContain('0.1.0Source dddddddddd')
  expect(dom.container.querySelector('[data-upgrade-candidate-version]')!.textContent).toBe('UnavailableSource unknown')
  expect(dom.container.querySelector('[data-upgrade-candidate-unavailable]')!.closest('details')).toBeNull()
  const explanation = dom.container.querySelector('.host-upgrade__description')!.textContent!
  expect(explanation).toContain('local update bundle could not be prepared')
  expect(explanation).toContain('Check Core')
  expect(explanation).toContain('Technical details')
  expect(explanation).not.toContain('Read the original service')
  expect(explanation).not.toContain('operations remain available')
  expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toContain('Check Core')
  expect(dom.container.querySelector('[data-upgrade-confirm]')).toBeNull()
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.textContent).toContain('Local candidate archive was not assembled.')
})
it.each(['unknown', 'completed'] as const)('candidate failure preserves original %s operation and its exact safe action', async status => {
  const original = { ...receipt(status), candidate: { ...check.candidate, version: '0.0.9', digest: 'f'.repeat(64) } }
  checkCall.mockResolvedValue({ ...check, candidate: null, candidateUnavailable: { code: 'CORE_ARTIFACT_UNAVAILABLE', detail: 'App candidate missing' }, eligible: false, reason: 'unverified', expected: undefined, latestOperation: original })
  inspectCall.mockResolvedValue(original)
  await render()
  expect(dom.container.querySelector('[data-upgrade-candidate-version]')!.textContent).not.toContain('0.0.9')
  expect(dom.container.textContent).toContain('Original upgrade candidate version0.0.9')
  expect(dom.container.querySelectorAll('[data-upgrade-candidate-unavailable]')).toHaveLength(1)
  expect(dom.container.querySelector('.host-upgrade__description')!.textContent).toBe('A new update candidate is unavailable. The original operation below is retained.')
  await action()
  expect(status === 'unknown' ? inspectCall : reconnectCall).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.container.querySelector('[data-upgrade-confirm]')).toBeNull()
})
it.each([['inspect','throw'],['inspect','null'],['reconnect','throw'],['reconnect','null']] as const)('original %s %s failure is visible while the receipt and safe action remain intact', async(kind,outcome) => {
  checkCall.mockResolvedValue({ ...check, eligible: false, reason: 'unverified', expected: undefined, latestOperation: receipt(kind === 'inspect' ? 'unknown' : 'completed') })
  const call = kind === 'inspect' ? inspectCall : reconnectCall
  if (outcome === 'throw') call.mockRejectedValue(new Error('Controlled original request failure'))
  else call.mockResolvedValue(null)
  await render()
  const observations = () => dom.container.querySelector('[aria-label="Original update receipt"] .host-upgrade__observation')!.textContent
  const prior = observations()
  await action()
  const feedback = dom.container.querySelector('[data-upgrade-attempt-feedback]')!
  expect(feedback).not.toBeNull()
  expect(feedback.closest('details')).toBeNull()
  expect(feedback.textContent).toContain(kind === 'inspect' ? 'This original result check was not confirmed' : 'This connection attempt was not confirmed')
  expect(feedback.textContent).not.toContain('Controlled original request failure')
  expect(observations()).toBe(prior)
  expect(dom.container.textContent).toContain('original-operation')
  expect(dom.container.textContent).toContain(outcome === 'throw' ? 'Controlled original request failure' : 'No confirmed receipt')
  expect(dom.container.querySelector<HTMLButtonElement>('[data-upgrade-action]')!.disabled).toBe(false)
  expect(call).toHaveBeenCalledExactlyOnceWith(host, 'original-operation')
  expect(checkCall).toHaveBeenCalledTimes(1)
  expect(upgradeCall).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
})

describe('Native replacement review', () => {
  const ending = [{ runId: 'run-a', agentSessionId: 'agent-a' }, { runId: 'run-b', agentSessionId: 'agent-b' }, { runId: 'run-c', agentSessionId: null }]
  const replacementCheck = (runs = ending): RemoteCoreUpgradeCheck & { candidate: NonNullable<RemoteCoreUpgradeCheck['candidate']> } => ({ ...check, reason: 'native-replacement',
    current: { ...check.current, native: { ...(check.current as Extract<RemoteCoreUpgradeCheck['current'], { state: 'available' }>).native, protocolVersion: 22 } } as RemoteCoreUpgradeCheck['current'],
    nativeReplacement: { ending: runs }, expected: { ...check.expected!, nativeReplacement: { endingRunIds: runs.map(run => run.runId) } } })

  it('names the reason, what ends and what is kept, and confirms with a danger button that counts the processes', async () => {
    checkCall.mockResolvedValue(replacementCheck())
    await render()
    expect(dom.container.querySelector('[role="status"]')!.textContent).toBe('Native Runtime update required')
    expect(dom.container.textContent).toContain('This upgrade also restarts the Native Runtime. Review what ends before confirming.')
    await review()
    const block = dom.container.querySelector('[data-upgrade-native-replacement]')!
    expect(block.textContent).toContain('The Native Runtime on Build server speaks protocol 22 and this app needs protocol 25, so it restarts with the new version.')
    expect(block.querySelector('[data-upgrade-ending]')!.textContent).toBe('2 in Agent Sessions, 1 in a terminal')
    expect(block.textContent).toContain('Sessions with their history and output, and the Runtime identity')
    expect(block.textContent).toContain('A copy of the Native state is saved on Build server before the restart.')
    const confirmButton = block.querySelector<HTMLButtonElement>('[data-upgrade-confirm]')!
    expect(confirmButton.className).toBe('danger-button')
    expect(confirmButton.textContent).toBe('Upgrade and end 3 processes')
    // Cancel comes first and holds focus; the confirm button is not the default action.
    expect(block.querySelector('.host-upgrade__actions')!.firstElementChild).toBe(block.querySelector('[data-upgrade-cancel]'))
    expect(document.activeElement).toBe(block.querySelector('[data-upgrade-cancel]'))
    expect(upgradeCall).not.toHaveBeenCalled()
  })

  it('Escape and Cancel leave the reviewed replacement without upgrading', async () => {
    checkCall.mockResolvedValue(replacementCheck())
    await render(); await review()
    await act(async () => { dom.container.querySelector('[data-upgrade-native-replacement]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(dom.container.querySelector('[data-upgrade-native-replacement]')).toBeNull()
    await review(); await dom.click('[data-upgrade-cancel]')
    expect(dom.container.querySelector('[data-upgrade-native-replacement]')).toBeNull()
    expect(upgradeCall).not.toHaveBeenCalled()
  })

  it('says nothing ends when no process runs and confirms with the primary button', async () => {
    checkCall.mockResolvedValue(replacementCheck([]))
    await render(); await review()
    const block = dom.container.querySelector('[data-upgrade-native-replacement]')!
    expect(block.querySelector('[data-upgrade-ending]')!.textContent).toBe('No processes are running on Build server, so nothing ends. Sessions, their history and the Runtime identity are kept.')
    expect(block.querySelector('.host-upgrade__observation')).toBeNull()
    const confirmButton = block.querySelector<HTMLButtonElement>('[data-upgrade-confirm]')!
    expect(confirmButton.className).toBe('primary-button')
    expect(confirmButton.textContent).toBe('Upgrade Core and Native Runtime')
  })

  it('confirms exactly the reviewed admission, shows the replacement in progress and how to continue ended Sessions', async () => {
    const reviewed = replacementCheck(), pending = deferred<RemoteCoreUpgradeReceipt>()
    checkCall.mockResolvedValue(reviewed)
    upgradeCall.mockImplementation(async () => await pending.promise)
    await render(); await review()
    checkCall.mockResolvedValue(replacementCheck([ending[0]!]))
    await confirm()
    expect(upgradeCall).toHaveBeenCalledExactlyOnceWith(host, reviewed.expected, expect.any(String))
    expect(dom.container.querySelector('[role="status"]')!.textContent).toBe('Upgrading Core and Native Runtime')
    expect(dom.container.textContent).toContain('Saving a copy of the Native state, restarting the Native Runtime and starting the updated Core.')
    expect(dom.container.textContent).toContain('Original upgrade is in progress')
    expect(dom.container.textContent).not.toContain('Check this original operation before starting another upgrade.')
    expect(dom.container.textContent).not.toContain('Check current versions before reviewing another upgrade.')
    const operationId = upgradeCall.mock.calls[0]![2] as string
    await act(async () => pending.resolve({ ...receipt('completed'), operationId, expected: reviewed.expected!, candidate: reviewed.candidate,
      connectionAdoption: { state: 'connected', readAt: 1700000003000 },
      nativeReplacement: { stateCopy: fixturePath('srv/original/state/core-releases/copy.native-state'), endedRunIds: ['run-a', 'run-b', 'run-c'], survivingProcessIds: [] } }))
    expect(dom.container.querySelector('[data-upgrade-ended-runs]')!.textContent).toBe(
      'The Native Runtime was replaced and 3 running processes ended. Open an ended Session and choose Restore original to continue it; a terminal starts a new shell when you open it.')
    expect(dom.container.querySelector('.host-upgrade__details')!.textContent).toContain('Native state copy')
  })

  it('shows the replacement stage of an unknown original operation and only offers to check it', async () => {
    const reviewed = replacementCheck()
    checkCall.mockResolvedValue({ ...reviewed, eligible: false, reason: 'unverified', expected: undefined, nativeReplacement: undefined,
      latestOperation: { ...receipt('unknown'), expected: reviewed.expected!, stage: 'replacing-native' } })
    await render()
    expect(dom.container.querySelector('[data-upgrade-stage]')!.textContent).toBe('Replacing the Native Runtime')
    expect(dom.container.querySelector('[data-upgrade-action]')!.textContent).toBe('Check original result')
    expect(dom.container.querySelector('[data-upgrade-native-replacement]')).toBeNull()
  })
})

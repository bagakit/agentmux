// @vitest-environment happy-dom
import { act } from 'react'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfigurationInspection, AgentConfigurationReceipt, AgentConfigurationSnapshot, AgentConfigurationTarget, AgentInformationInspection, AgentInformationSnapshot } from '@agentmux/core'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentNativeInformation } from '../src/renderer/src/components/AgentNativeInformation'
import { NativeConfigurationPicker } from '../src/renderer/src/components/PosturePicker'
import { useAgentNativeConfiguration } from '../src/renderer/src/lib/use-agent-native-configuration'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { modelStateMainClient } from './helpers/model-state-main-client'
import type { RuntimeEvent } from '../src/shared/contracts'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const configuration: AgentConfigurationSnapshot = { revision: 'original-native-revision', observation: {
  nativeSessionId: 'native-original', sourceId: 'native-source', observedAt: 5000, sequence: 1, state: 'confirmed'
}, options: [{ id: 'native-picker-not-named-model', name: 'Select engine', category: 'model', type: 'select', currentValue: 'model-a', choices: [
  { value: 'model-a', name: 'Original Model' }, { value: 'model-b', name: 'Next Native Model' }, { value: 'model-c', name: 'TUI Native Model' }
] }, { id: 'details', name: 'Details', type: 'boolean', currentValue: true }] }
const information: AgentInformationSnapshot = { nativeSessionId: 'native-original', sourceId: 'source-original', observedAt: 5000,
  model: { id: 'model-a', name: 'Original Model', scope: 'next-turn' }, plan: { id: 'plan-original', name: 'Native Team' },
  limits: [{ id: 'short', name: 'Short window', usedPercent: 24, resetsAt: 100000 }, { id: 'long', name: 'Weekly', usedPercent: 60 }], issues: [] }
function target(session = composerSession()): AgentConfigurationTarget {
  return { hostId: session.control.hostId, runtimeId: 'runtime-original', agentSessionId: session.id, expectedRun: session.control.run, providerId: session.providerId }
}
function inspection(session = composerSession(), snapshot: AgentConfigurationSnapshot | null = configuration): Extract<AgentConfigurationInspection, { kind: 'configuration' }> {
  return { kind: 'configuration', target: target(session), snapshot }
}
function informationInspection(): AgentInformationInspection { return { kind: 'information', target: target(), snapshot: information, configuration } }
function receipt(outcome: AgentConfigurationReceipt['outcome'] = 'applied', extra: Partial<AgentConfigurationReceipt> = {}): AgentConfigurationReceipt {
  return { action: 'agent-configuration', operationId: 'original-switch', target: target(), configId: 'native-picker-not-named-model', value: 'model-b',
    actor: { kind: 'user', id: 'original-person' }, phase: 'settled', outcome, nativeOperationId: 'original-native-switch',
    runtime: { runtimeId: 'runtime-original', instanceId: 'original-instance', buildIdentity: 'fixture-build', protocolVersion: 1 },
    acknowledgement: outcome === 'applied' ? changed('model-b') : null, diskDurability: 'confirmed', ...extra }
}
function changed(value: string, revision = `native-${value}`): AgentConfigurationSnapshot {
  return { ...configuration, revision, options: [{ ...configuration.options[0]!, currentValue: value }, configuration.options[1]!] } as AgentConfigurationSnapshot
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function click(element: Element) { await act(async () => { (element as HTMLElement).click() }) }
async function openModel() {
  await click(dom.container.querySelector('.composer-model-picker')!)
  await vi.waitFor(() => expect(document.querySelector('[role="dialog"][aria-label="Model"]')).not.toBeNull())
}
async function choose(value = 'model-b') { await click(document.querySelector(`[role="option"][data-value="${value}"]`)!) }
function pickerProps() { return { snapshot: configuration, onSet: vi.fn().mockResolvedValue(receipt()), onInspect: vi.fn().mockResolvedValue(receipt()), onRefresh: vi.fn().mockResolvedValue(undefined) } }
function modelText() { return dom.container.querySelector('.composer-model-picker')?.textContent }
beforeEach(() => {
  vi.spyOn(api.sessions, 'inspectConfiguration').mockImplementation(async control => inspection({ ...composerSession(), id: control.agentSessionId, control }))
  vi.spyOn(api.sessions, 'inspectInformation').mockResolvedValue(informationInspection())
})

it('the real visible Composer reads model configuration without reading account information; its avatar reads the account separately', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(api.sessions.inspectConfiguration).toHaveBeenCalledExactlyOnceWith(composerSession().control)
  expect(api.sessions.inspectInformation).not.toHaveBeenCalled()
  expect(modelText()).toContain('Original Model')
  await openModel()
  expect(api.sessions.inspectConfiguration).toHaveBeenCalledTimes(2)
  expect(api.sessions.inspectInformation).not.toHaveBeenCalled()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(api.sessions.inspectInformation).toHaveBeenCalledExactlyOnceWith(composerSession().control)
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('Native Team')
  expect(document.querySelector('.agent-state-face__facts')?.hasAttribute('open')).toBe(false)
  expect(dom.draft()).toBe('Keep my draft')
})

it('a pending account read does not delay the actual model selection and the Store sends the exact original target and revision', async () => {
  const account = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValue(account.promise)
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockImplementation(async (_control, input) => receipt('applied', { operationId: input.operationId }))
  const submit = vi.spyOn(api.sessions, 'submitPrompt')
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-native-information')?.getAttribute('aria-busy')).toBe('true')
  await dom.click('.composer-agent-identity .agent-avatar')
  await openModel(); await choose()
  expect(set).toHaveBeenCalledOnce()
  expect(set.mock.calls[0]![0]).toEqual(composerSession().control)
  expect(set.mock.calls[0]![1]).toMatchObject({ target: target(), expectedRevision: configuration.revision, configId: 'native-picker-not-named-model', value: 'model-b' })
  expect(submit).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
  await act(async () => account.resolve(informationInspection()))
})

it('Core Session publication drives current model and an older setter acknowledgement cannot overwrite a later TUI observation', async () => {
  const pending = deferred<AgentConfigurationReceipt>()
  vi.spyOn(api.sessions, 'setConfiguration').mockReturnValueOnce(pending.promise)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose()
  expect(modelText()).toContain('Original Model')
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: changed('model-c') }] }))
  expect(modelText()).toContain('TUI Native Model')
  await act(async () => pending.resolve(receipt()))
  expect(modelText()).toContain('TUI Native Model')
  expect(dom.draft()).toBe('Keep my draft')
})

it('a concrete Main or transport error without a receipt stays an error, creates no invented unknown operation and does not lock model choices', async () => {
  vi.spyOn(api.sessions, 'setConfiguration').mockRejectedValueOnce(Object.assign(new Error('The original model target changed before dispatch. Read choices again.'), { code: 'INVALID_CONTROL_REQUEST', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose(); await openModel()
  const face = document.querySelector('.model-picker')!
  expect(face.textContent).toContain('target changed before dispatch')
  expect(face.textContent).not.toContain('The model change is not confirmed')
  expect([...face.querySelectorAll('button')].some(button => button.textContent === 'Check original change')).toBe(false)
  expect([...face.querySelectorAll<HTMLButtonElement>('[role="option"]')].every(button => !button.disabled)).toBe(true)
  expect(dom.draft()).toBe('Keep my draft')
})

it.each(['not-dispatched', 'not-applied'] as const)('a real %s receipt keeps its exact native issue without turning into unknown', async outcome => {
  vi.spyOn(api.sessions, 'setConfiguration').mockResolvedValueOnce(receipt(outcome, { issue: `Original ${outcome} reason` }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose(); await openModel()
  expect(document.querySelector('.model-picker')?.textContent).toContain(`Original ${outcome} reason`)
  expect(document.querySelector('.model-picker')?.textContent).not.toContain('Check original change')
  expect(modelText()).toContain('Original Model')
})

it('a real unknown operation is checked by operationId without replaying its setter and permits another explicit choice', async () => {
  const unknown = receipt('unknown', { issue: 'Native acknowledgement missing for original-switch' })
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockResolvedValueOnce(unknown)
  vi.mocked(api.sessions.inspectConfiguration).mockImplementation(async (_control, operationId) => operationId
    ? { kind: 'operation', agentSessionId: 'agent-1', operationId, operation: unknown } : inspection())
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose(); await openModel()
  expect(document.querySelector('.model-picker')?.textContent).toContain(unknown.issue)
  const check = [...document.querySelectorAll('.model-picker button')].find(button => button.textContent === 'Check original change')!
  expect(check).toBeDefined()
  expect((check as HTMLButtonElement).tabIndex).toBe(0)
  await click(check)
  expect(api.sessions.inspectConfiguration).toHaveBeenLastCalledWith(composerSession().control, 'original-switch')
  expect(set).toHaveBeenCalledOnce()
  expect([...document.querySelectorAll<HTMLButtonElement>('.model-picker [role="option"]')].every(button => !button.disabled)).toBe(true)
})

it('current unlisted model is readable without adding a fake Provider choice and marks have one fixed slot in every row', async () => {
  const snapshot = { ...configuration, options: [{ ...configuration.options[0]!, currentValue: 'native-unlisted-model' }] } as AgentConfigurationSnapshot
  await dom.render(<NativeConfigurationPicker {...pickerProps()} snapshot={snapshot} />)
  expect(modelText()).toContain('native-unlisted-model')
  await openModel()
  const current = document.querySelector('[role="option"][data-missing="true"]')!
  expect(current.getAttribute('aria-selected')).toBe('true')
  expect(current.textContent).toContain('outside the available choices')
  expect(document.querySelectorAll('.model-picker [role="option"] > .selection-field__mark')).toHaveLength(4)
  expect(snapshot.options[0]!.type === 'select' && snapshot.options[0]!.choices.some(choice => choice.value === 'native-unlisted-model')).toBe(false)
})

it('the shared selector preserves native groups, filters the directory and never selects on IME Enter', async () => {
  const choices = Array.from({ length: 20 }, (_, index) => ({ value: `native-${index}`, name: `Native Model ${index}`, group: { id: index < 10 ? 'first' : 'second', name: index < 10 ? 'First native group' : 'Second native group' } }))
  const props = pickerProps()
  await dom.render(<NativeConfigurationPicker {...props} snapshot={{ ...configuration, options: [{ ...configuration.options[0]!, choices, currentValue: 'native-0' }] } as AgentConfigurationSnapshot} />)
  await openModel()
  expect([...document.querySelectorAll('.selection-field__group')].map(group => group.textContent)).toEqual(['First native group', 'Second native group'])
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Find model"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Model 17')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(document.querySelectorAll('.model-picker [role="option"]')).toHaveLength(1)
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
  expect(props.onSet).not.toHaveBeenCalled()
  expect(document.querySelector('.selection-field__group')?.textContent).toBe('Second native group')
})

it('an unconfirmed native observation shows its last model and issue while keeping the directory and unrelated input usable', async () => {
  const unconfirmed: AgentConfigurationSnapshot = { ...configuration, observation: { ...configuration.observation!, state: 'unconfirmed', issue: { code: 'SOURCE_GAP', message: 'Original configuration observer has a gap' } } }
  await dom.render(<NativeConfigurationPicker {...pickerProps()} snapshot={unconfirmed} information={information} />)
  expect(modelText()).toContain('Last: Original Model')
  expect(dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.title).not.toContain('Current native model, outside')
  await openModel()
  expect(document.querySelector('.model-picker')?.textContent).toContain('observer has a gap')
  expect([...document.querySelectorAll<HTMLButtonElement>('.model-picker [role="option"]')].every(button => !button.disabled)).toBe(true)
  expect(document.querySelector('.model-picker [aria-selected="true"]')).toBeNull()
})

it('older native reads cannot overwrite same-clock Core configuration revisions or withdraw a newer TUI model', async () => {
  const request = deferred<AgentConfigurationInspection>()
  vi.mocked(api.sessions.inspectConfiguration).mockReturnValueOnce(request.promise)
  useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: configuration }] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: changed('model-c') }] }))
  await act(async () => request.resolve(inspection()))
  expect(modelText()).toContain('TUI Native Model')
})

it('complete null inspection and Core source withdrawal clear stale model values rather than retaining a competing client cache', async () => {
  useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: configuration }] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  vi.mocked(api.sessions.inspectConfiguration).mockResolvedValueOnce(inspection(composerSession(), null))
  await openModel()
  expect(modelText()).not.toContain('Original Model')
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: changed('model-c') }] }))
  expect(modelText()).toContain('TUI Native Model')
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(modelText()).not.toContain('TUI Native Model')
})

it('old Run observations and pending operations never move onto the next Run of the same original Session', async () => {
  const pending = deferred<AgentConfigurationReceipt>()
  vi.spyOn(api.sessions, 'setConfiguration').mockReturnValueOnce(pending.promise)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose()
  expect(dom.container.querySelector('.composer-model-control__state')?.textContent).toBe('…')
  const next = { ...composerSession(), control: { ...composerSession().control, run: { runId: 'next-original-run' } }, nativeConfiguration: changed('model-c') }
  vi.mocked(api.sessions.inspectConfiguration).mockResolvedValueOnce(inspection(next, changed('model-c')))
  await act(async () => useAppStore.setState({ sessions: [next] }))
  await act(async () => pending.resolve(receipt('unknown')))
  expect(modelText()).toContain('TUI Native Model')
  expect(dom.container.querySelector('.composer-model-control__state')?.textContent).toBe('')
})

it('duplicate configuration reads share the exact mounted request; failures preserve the native sample without blocking it', async () => {
  let reading!: ReturnType<typeof useAgentNativeConfiguration>
  function Harness() { reading = useAgentNativeConfiguration(composerSession().control, true, configuration); return <span>{reading.snapshot?.revision}</span> }
  const request = deferred<AgentConfigurationInspection>()
  vi.mocked(api.sessions.inspectConfiguration).mockReturnValueOnce(request.promise)
  await dom.render(<Harness />)
  let first!: Promise<unknown>, second!: Promise<unknown>
  await act(async () => { first = reading.refresh(); second = reading.refresh() })
  expect(first).toBe(second)
  await act(async () => request.resolve(inspection()))
  vi.mocked(api.sessions.inspectConfiguration).mockRejectedValueOnce(new Error('Original configuration source temporarily unavailable'))
  await act(async () => { await reading.refresh().catch(() => {}) })
  expect(dom.container.textContent).toBe(configuration.revision)
  expect(reading.issue).toContain('temporarily unavailable')
})

it('Context and account windows stay separate and quota bars use remaining values', async () => {
  await dom.render(<AgentNativeInformation information={information} contextWindowUsage={{ usedTokens: 250, capacityTokens: 1000, observedAt: 1000 }} />)
  expect(dom.container.textContent).toContain('25% used')
  expect([...dom.container.querySelectorAll('progress')].map(bar => bar.value)).toEqual([76, 40])
  expect(dom.container.querySelector('progress')?.getAttribute('aria-label')).toBe('Short window: 76% remaining')
})

it('refreshes the open account face on cadence and preserves source time on failure and while hidden', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  try {
    const now = Date.now(), sample = { ...information, observedAt: now - 120_000 }
    const original = { ...composerSession(), nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: information.nativeSessionId }, nativeInformation: sample }
    const owner = vi.spyOn(api.sessions, 'inspectInformation')
      .mockResolvedValueOnce({ ...informationInspection(), snapshot: sample })
      .mockResolvedValueOnce({ ...informationInspection(), snapshot: null, issue: { code: 'AGENT_INFORMATION_READ_UNAVAILABLE', message: 'Account read timed out.' } })
      .mockImplementation(async () => ({ ...informationInspection(), snapshot: { ...sample, observedAt: Date.now() } }))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    useAppStore.setState({ sessions: [original] })
    await dom.render(<AgentSessionComposer sessionId="agent-1" />)
    const tick = (delay: number) => act(async () => { await vi.advanceTimersByTimeAsync(delay) })
    const time = () => document.querySelector<HTMLTimeElement>('.agent-native-information footer time')
    await tick(30_000)
    expect(owner).not.toHaveBeenCalled()
    await dom.click('.composer-agent-identity .agent-avatar')
    expect(owner).toHaveBeenCalledExactlyOnceWith(original.control)
    expect(time()?.dateTime).toBe(new Date(sample.observedAt).toISOString())
    const modelReads = vi.mocked(api.sessions.inspectConfiguration).mock.calls.length
    await tick(30_000)
    expect(owner).toHaveBeenCalledTimes(2)
    expect(time()?.dateTime).toBe(new Date(sample.observedAt).toISOString())
    expect(document.querySelector('.agent-native-information [role="status"]')?.textContent).toContain('Account read timed out.')
    visibility.mockReturnValue('hidden')
    await tick(60_000)
    expect(owner).toHaveBeenCalledTimes(2)
    visibility.mockReturnValue('visible')
    await act(async () => document.dispatchEvent(new Event('visibilitychange')))
    expect(owner).toHaveBeenCalledTimes(3)
    expect(time()?.dateTime).toBe(new Date(Date.now()).toISOString())
    expect(time()?.textContent).toBe('Just now')
    expect(api.sessions.inspectConfiguration).toHaveBeenCalledTimes(modelReads)
    await click(document.querySelector('[aria-label="Close Agent status"]')!)
    await tick(60_000)
    expect(owner).toHaveBeenCalledTimes(3)
    expect(dom.draft()).toBe('Keep my draft')
  } finally { vi.useRealTimers() }
})

it('reopening the same account face while a read is in flight reuses the original request', async () => {
  const pending = deferred<AgentInformationInspection>()
  const read = vi.spyOn(api.sessions, 'inspectInformation').mockReturnValue(pending.promise)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  await click(document.querySelector('[aria-label="Close Agent status"]')!)
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(read).toHaveBeenCalledExactlyOnceWith(composerSession().control)
  await act(async () => pending.resolve(informationInspection()))
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('Native Team')
})

it('equal Provider and executor labels appear once and a distinct configured executor label stays visible', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-state-face__provider')?.textContent).toBe('Codex')
  await act(async () => useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors, codex: { ...composerConfig.executors.codex!, label: 'Team Codex' } } } }))
  expect(document.querySelector('.agent-state-face__provider')?.textContent).toBe('Codex · Team Codex')
})


it('cached model choices open while the native read is still pending and share that one original target read', async () => {
  const request = deferred<AgentConfigurationInspection>()
  vi.mocked(api.sessions.inspectConfiguration).mockReturnValueOnce(request.promise)
  useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: configuration }] })
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockResolvedValueOnce(receipt())
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel()
  expect(document.querySelector('.model-picker [role="option"]')).not.toBeNull()
  expect(api.sessions.inspectConfiguration).toHaveBeenCalledTimes(1)
  expect(api.sessions.inspectInformation).not.toHaveBeenCalled()
  await choose()
  expect(set).not.toHaveBeenCalled()
  await act(async () => request.resolve(inspection()))
  expect(set).toHaveBeenCalledOnce()
  expect(dom.draft()).toBe('Keep my draft')
})

it('a new explicit choice does not erase an earlier unknown receipt and its read-only check cannot lock the model directory', async () => {
  const unknown = receipt('unknown', { issue: 'Original model operation remains unconfirmed' })
  const check = deferred<AgentConfigurationInspection>()
  vi.mocked(api.sessions.inspectConfiguration).mockImplementation(async (_control, operationId) => operationId ? await check.promise : inspection())
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockResolvedValueOnce(unknown).mockImplementationOnce(async (_control, request) =>
    receipt('not-applied', { operationId: request.operationId, value: request.value, issue: 'The new explicit choice was refused by its original native owner' }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose(); await openModel()
  const button = [...document.querySelectorAll('.model-picker button')].find(item => item.textContent === 'Check original change')!
  await click(button)
  expect([...document.querySelectorAll<HTMLButtonElement>('.model-picker [role="option"]')].every(option => !option.disabled)).toBe(true)
  await choose('model-c'); await openModel()
  await act(async () => check.resolve({ kind: 'operation', agentSessionId: 'agent-1', operationId: unknown.operationId, operation: unknown }))
  expect(document.querySelector('.model-picker')?.textContent).toContain('new explicit choice was refused')
  expect(document.querySelector('.model-picker')?.textContent).toContain(unknown.issue)
  expect(document.querySelector('.model-picker')?.textContent).toContain('Check original change')
  expect(set).toHaveBeenCalledTimes(2)
  expect(dom.draft()).toBe('Keep my draft')
})

it('late account information never adopts its cached configuration over the current Core model', async () => {
  const account = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValueOnce(account.promise)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), nativeConfiguration: changed('model-c') }] }))
  await act(async () => account.resolve(informationInspection()))
  expect(modelText()).toContain('TUI Native Model')
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('TUI Native Model')
})


it('explicit selections after an unknown operation mint a new operation while only a genuinely pending request is shared', async () => {
  const pending = deferred<AgentConfigurationReceipt>()
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockReturnValueOnce(pending.promise).mockResolvedValueOnce(receipt('unknown', { operationId: 'second-original-switch' }))
  const input = { target: target(), configId: 'native-picker-not-named-model', value: 'model-b', expectedRevision: configuration.revision }
  const first = useAppStore.getState().setConfiguration('agent-1', input)
  const duplicate = useAppStore.getState().setConfiguration('agent-1', input)
  await act(async () => pending.resolve(receipt('unknown')))
  await Promise.all([first, duplicate])
  expect(set).toHaveBeenCalledOnce()
  await useAppStore.getState().setConfiguration('agent-1', input)
  expect(set).toHaveBeenCalledTimes(2)
  expect(set.mock.calls[1]![1].operationId).not.toBe(set.mock.calls[0]![1].operationId)
})

it('an explicitly selected Last value is admitted when currentness is unconfirmed rather than silently treated as current', async () => {
  const props = pickerProps()
  const unconfirmed = { ...configuration, observation: { ...configuration.observation!, state: 'unconfirmed' as const } }
  await dom.render(<NativeConfigurationPicker {...props} snapshot={unconfirmed} />)
  await openModel(); await choose('model-a')
  expect(props.onSet).toHaveBeenCalledExactlyOnceWith('native-picker-not-named-model', 'model-a', configuration.revision)
})

it('transport failure without a receipt retains the minted operation and full target for read-only recovery, without inventing a receipt', async () => {
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockRejectedValueOnce(Object.assign(new Error('Connection closed after the native request'), { code: 'ECONNRESET' }))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel(); await choose(); await openModel()
  const original = set.mock.calls[0]![1]
  expect(document.querySelector('.model-picker')?.textContent).toContain('No original operation receipt is available')
  expect(document.querySelector('.model-picker')?.textContent).toContain('Connection closed after the native request')
  vi.mocked(api.sessions.inspectConfiguration).mockResolvedValueOnce({ kind: 'operation', agentSessionId: 'agent-1', operationId: original.operationId, operation: null })
  await click([...document.querySelectorAll('.model-picker button')].find(button => button.textContent === 'Check original change')!)
  expect(api.sessions.inspectConfiguration).toHaveBeenLastCalledWith(composerSession().control, original.operationId)
  expect(set).toHaveBeenCalledOnce()
  expect(original.target).toEqual(target())
  expect([...document.querySelectorAll<HTMLButtonElement>('.model-picker [role="option"]')].every(option => !option.disabled)).toBe(true)
})


it('a confirmed direct reading still exposes its continuous-observation limitation without disabling the healthy directory', async () => {
  const props = pickerProps()
  const direct: AgentConfigurationSnapshot = { ...configuration, observation: { ...configuration.observation!, issue: { code: 'CONTINUOUS_UNSUPPORTED', message: 'This original Run supports direct model read and set; continuous observation is unavailable.' } } }
  await dom.render(<NativeConfigurationPicker {...props} snapshot={direct} />)
  expect(modelText()).toContain('Original Model')
  await openModel()
  expect(document.querySelector('.model-picker')?.textContent).toContain('supports direct model read and set')
  expect(document.querySelector('.model-picker')?.textContent).toContain('Applies to the next turn')
  await choose()
  expect(props.onSet).toHaveBeenCalledOnce()
})


it.skipIf(!process.env.AMX_INFORMATION_CANDIDATE)('the actual Main/Core public chain drives the real Composer and preserves pre-native refusal and lost-receipt recovery without replay', async () => {
  let listening = false
  const queued: RuntimeEvent[] = []
  const owner = await modelStateMainClient(event => {
    if (!listening) queued.push(event)
    else act(() => { useAppStore.getState().applyEvent(event) })
  })
  try {
    const original = owner.ready.control
    const session = { ...composerSession(original.agentSessionId, owner.ready.inspection.target.providerId), control: original,
      ...(owner.ready.inspection.snapshot ? { nativeConfiguration: owner.ready.inspection.snapshot } : {}) }
    await act(async () => {
      useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Original draft through actual Main and Core' } })
      for (const event of queued) useAppStore.getState().applyEvent(event)
    })
    listening = true
    vi.mocked(api.sessions.inspectConfiguration).mockImplementation((...args) => owner.call('inspectConfiguration', args))
    vi.mocked(api.sessions.inspectInformation).mockImplementation((...args) => owner.call('inspectInformation', args))
    let wrongRun = true, loseReply = false
    const set = vi.spyOn(api.sessions, 'setConfiguration').mockImplementation(async (control, request) => {
      const selected = wrongRun ? { ...control, run: { runId: 'another-original-run' } } : control
      const result = await owner.call<AgentConfigurationReceipt>('setConfiguration', [selected, request])
      if (loseReply) throw Object.assign(new Error('The native operation reply was lost after dispatch'), { code: 'CONNECTION_CLOSED' })
      return result
    })
    const settleRead = async () => { await act(async () => { await vi.mocked(api.sessions.inspectConfiguration).mock.results.at(-1)?.value }) }
    const settleSet = async (count: number) => { await act(async () => { await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(count)); await set.mock.results.at(-1)!.value.catch(() => {}) }) }
    await dom.render(<AgentSessionComposer sessionId={session.id} />)
    await settleRead()
    await openModel(); await settleRead()
    await click(document.querySelector('.model-picker [role="option"][data-value="model-large"]')!)
    await settleSet(1)
    await openModel(); await settleRead()
    expect(document.querySelector('.model-picker')?.textContent).toContain('Keep the original configuration Host, Session and Run')
    expect(document.querySelector('.model-picker')?.textContent).not.toContain('Check original change')
    expect((await owner.call<{ nativeWrites: unknown[] }>('stats')).nativeWrites).toHaveLength(0)
    wrongRun = false
    await act(async () => { await owner.call('emit', [{ current: 'native-unlisted-current', sequence: 1, observedAt: 6000 }]) })
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value).toBe('native-unlisted-current'))
    loseReply = true
    await click(document.querySelector('.model-picker [role="option"][data-value="model-small"]')!)
    await settleSet(2)
    await openModel(); await settleRead()
    expect(document.querySelector('.model-picker')?.textContent).toContain('No original operation receipt is available')
    expect(document.querySelector('.model-picker')?.textContent).toContain('reply was lost after dispatch')
    const dispatched = set.mock.calls.at(-1)![1]
    const before = await owner.call<{ nativeWrites: unknown[]; runtimeWrites: number; informationReads: number; configurationReads: number; requests: Array<{ method: string }> }>('stats')
    expect(before.nativeWrites).toHaveLength(1)
    expect(before.runtimeWrites).toBe(0)
    expect(before.informationReads).toBe(0)
    expect(before.requests.filter(request => request.method === 'agent.configuration.set')).toHaveLength(1)
    await click([...document.querySelectorAll('.model-picker button')].find(button => button.textContent === 'Check original change')!)
    await settleRead()
    expect(api.sessions.inspectConfiguration).toHaveBeenLastCalledWith(original, dispatched.operationId)
    expect(document.querySelector('.model-picker')?.textContent).not.toContain('Check original change')
    const after = await owner.call<{ nativeWrites: unknown[]; configurationReads: number }>('stats')
    expect(after.nativeWrites).toHaveLength(before.nativeWrites.length)
    expect(after.configurationReads).toBe(before.configurationReads)
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value).toBe('model-small'))
    expect(dom.draft(session.id)).toBe('Original draft through actual Main and Core')
  } finally { listening = false; await owner.close() }
}, 30000)


it('unrelated Session updates do not trigger model or account reads for the original visible Composer', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const other = Array.from({ length: 100 }, (_, index) => composerSession(`unrelated-${index}`))
  await act(async () => useAppStore.setState({ sessions: [composerSession(), ...other] }))
  await act(async () => useAppStore.setState({ sessions: [composerSession(), ...other.map(item => ({ ...item, updatedAt: 2 }))] }))
  expect(api.sessions.inspectConfiguration).toHaveBeenCalledExactlyOnceWith(composerSession().control)
  expect(api.sessions.inspectInformation).not.toHaveBeenCalled()
})


it.skipIf(process.env.AMX_MODEL_STATE_NATIVE_UI !== '1')('the same physical native TUI and original Core Session converge in both directions through the actual Composer', async () => {
  type NativeStats = { native: true; modelHttpRequests: number; nativeRequests: Record<string, number> | null; proof: { identity: unknown; setup: unknown; version: string; nativeBinary: unknown;
    missingNativeConfigurationPublication?: { nativeModel: string; core?: AgentConfigurationSnapshot } } }
  const catalog = (stats: NativeStats) => { expect(stats.nativeRequests).not.toBeNull(); return stats.nativeRequests!['model/list'] ?? 0 }
  const accountRequests = (stats: NativeStats) => Object.entries(stats.nativeRequests!).filter(([method]) => /^(?:account\/)|rateLimit|quota/iu.test(method))
  const compiled = JSON.parse(await readFile(join(process.env.AMX_INFORMATION_CANDIDATE!, 'compiled.json'), 'utf8')) as { digest: string }
  const evidence: Record<string, unknown> = { schema: 'agentmux.model-state-native-renderer.v1', phase: 'running', candidate: { digest: compiled.digest } }
  let listening = false
  const queued: RuntimeEvent[] = []
  let owner: Awaited<ReturnType<typeof modelStateMainClient>> | undefined
  try {
    owner = await modelStateMainClient(event => {
      if (!listening) queued.push(event)
      else act(() => { useAppStore.getState().applyEvent(event) })
    }, true)
    const original = owner
    const control = owner.ready.control
    evidence.control = control
    const session = { ...composerSession(control.agentSessionId, owner.ready.inspection.target.providerId), control,
      ...(owner.ready.inspection.snapshot ? { nativeConfiguration: owner.ready.inspection.snapshot } : {}) }
    await act(async () => {
      useAppStore.setState({ sessions: [session], agentComposerDrafts: { [session.id]: 'Original same-native workface draft' } })
      for (const event of queued) useAppStore.getState().applyEvent(event)
    })
    listening = true
    vi.mocked(api.sessions.inspectConfiguration).mockImplementation((...args) => original.call('inspectConfiguration', args))
    vi.mocked(api.sessions.inspectInformation).mockImplementation((...args) => original.call('inspectInformation', args))
    const set = vi.spyOn(api.sessions, 'setConfiguration').mockImplementation((...args) => original.call('setConfiguration', args))
    const before = await owner.call<{ id: string; model: string; turns: unknown[] }>('nativeRead')
    const stats = await owner.call<NativeStats>('stats')
    evidence.identity = stats.proof.identity
    evidence.setup = stats.proof.setup
    evidence.version = stats.proof.version
    evidence.nativeBinary = stats.proof.nativeBinary
    catalog(stats)
    await dom.render(<AgentSessionComposer sessionId={session.id} />)
    await act(async () => { await vi.mocked(api.sessions.inspectConfiguration).mock.results.at(-1)?.value })
    const mounted = await owner.call<NativeStats>('stats')
    expect(catalog(mounted) - catalog(stats)).toBe(1)
    let fromTui!: AgentConfigurationSnapshot
    await act(async () => { fromTui = await original.call<AgentConfigurationSnapshot>('selectInTui') })
    const selectedInTui = fromTui.options.find(option => option.category === 'model')
    if (!selectedInTui || selectedInTui.type !== 'select') throw new Error('The actual native TUI did not publish a model selection.')
    const tuiValue = selectedInTui.currentValue
    expect(tuiValue).not.toBe(before.model)
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value).toBe(tuiValue))
    evidence.coreEventToComposer = { nativeModel: tuiValue, composerModel: dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value,
      nativeObservation: fromTui.observation }
    const tuiSelected = await owner.call<NativeStats>('stats')
    await openModel()
    await act(async () => { await vi.mocked(api.sessions.inspectConfiguration).mock.results.at(-1)?.value })
    const menu = await owner.call<NativeStats>('stats')
    expect(catalog(menu) - catalog(tuiSelected)).toBe(1)
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await openModel()
    await act(async () => { await vi.mocked(api.sessions.inspectConfiguration).mock.results.at(-1)?.value })
    const reopened = await owner.call<NativeStats>('stats')
    expect(catalog(reopened) - catalog(menu)).toBe(1)
    expect(api.sessions.inspectConfiguration).toHaveBeenCalledTimes(3)
    const choice = [...document.querySelectorAll<HTMLButtonElement>('.model-picker [role="option"][data-value]')]
      .find(option => option.dataset.value !== tuiValue && !option.dataset.missing && !option.disabled)!
    expect(choice).toBeDefined()
    const wanted = choice.dataset.value!
    await click(choice)
    let applied!: AgentConfigurationReceipt
    await act(async () => { await vi.waitFor(() => expect(set).toHaveBeenCalledOnce()); applied = await set.mock.results[0]!.value })
    expect(applied.outcome).toBe('applied')
    expect(applied.target.agentSessionId).toBe(control.agentSessionId)
    expect(applied.target.expectedRun).toEqual(control.run)
    expect(set.mock.calls[0]![0]).toEqual(control)
    expect(set.mock.calls[0]![1].target.agentSessionId).toBe(control.agentSessionId)
    expect(set.mock.calls[0]![1].target.expectedRun).toEqual(control.run)
    await vi.waitFor(() => expect(dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value).toBe(wanted))
    const visibleInSameTui = await owner.call<{ model: string; action: string }>('verifyExternalInTui', [wanted])
    expect(visibleInSameTui.model).toBe(wanted)
    expect(visibleInSameTui.action).toBe('real-tui-reopened-model-menu')
    evidence.composerToSameTui = { request: set.mock.calls[0]![1], receipt: applied, nativeVerification: visibleInSameTui,
      composerModel: dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value }
    const after = await owner.call<{ id: string; model: string; turns: unknown[] }>('nativeRead')
    expect(after.id).toBe(before.id)
    expect(after.model).toBe(wanted)
    expect(after.turns).toHaveLength(before.turns.length)
    const settled = await owner.call<NativeStats>('stats')
    expect(settled.modelHttpRequests).toBe(stats.modelHttpRequests)
    expect(catalog(settled)).toBe(catalog(reopened))
    for (const stage of [mounted, tuiSelected, menu, reopened, settled]) expect(accountRequests(stage)).toEqual(accountRequests(stats))
    expect((settled.nativeRequests!['thread/settings/update'] ?? 0) - (stats.nativeRequests!['thread/settings/update'] ?? 0)).toBe(1)
    expect(api.sessions.inspectInformation).not.toHaveBeenCalled()
    expect(dom.draft(session.id)).toBe('Original same-native workface draft')
    Object.assign(evidence, { phase: 'passed',
      modelHttpRequests: { before: stats.modelHttpRequests, after: settled.modelHttpRequests },
      nativeRequests: { before: stats.nativeRequests, mounted: mounted.nativeRequests, tuiSelected: tuiSelected.nativeRequests,
        menu: menu.nativeRequests, reopened: reopened.nativeRequests, settled: settled.nativeRequests },
      configurationReads: vi.mocked(api.sessions.inspectConfiguration).mock.calls.length, uiSetters: set.mock.calls.length,
      originalThread: before.id, turns: { before: before.turns.length, after: after.turns.length }, draftPreserved: true })
  } catch (error) {
    evidence.phase = 'failed'
    evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    if (owner) {
      const state = await owner.call<{ model: string }>('nativeRead').then(value => ({ native: value }), error => ({ nativeReadError: String(error) }))
      const failedStats = await owner.call<NativeStats>('stats').catch(error => ({ statsError: String(error) }))
      const currentSession = useAppStore.getState().sessions.find(session => session.id === owner?.ready.control.agentSessionId)
      evidence.failureState = { ...state, stats: failedStats, core: currentSession?.kind === 'agent' ? currentSession.nativeConfiguration : undefined,
        composerModel: dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value }
      if ('proof' in failedStats && failedStats.proof.missingNativeConfigurationPublication) {
        const missing = failedStats.proof.missingNativeConfigurationPublication
        expect(missing.core?.options.find(option => option.category === 'model')?.currentValue,
          'The actual original native model must reach the original Core owner.').toBe(missing.nativeModel)
        expect(dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')?.dataset.value,
          'The actual original native model must reach this mounted Composer.').toBe(missing.nativeModel)
      }
    }
    throw error
  } finally {
    listening = false
    try {
      evidence.cleanup = owner ? await owner.close() : { state: 'owner-unavailable' }
      if (owner) expect(evidence.cleanup).toEqual({ exitCode: 0, directoryRemoved: true })
    }
    catch (error) { evidence.phase = 'failed'; evidence.cleanup = { error: String(error) }; throw error }
    finally {
      if (process.env.AMX_MODEL_SYNC_NATIVE_RENDERER_EVIDENCE) await writeFile(process.env.AMX_MODEL_SYNC_NATIVE_RENDERER_EVIDENCE, JSON.stringify(evidence, null, 2) + '\n')
      console.info(JSON.stringify({ evidence: 'same-native-composer', ...evidence }))
    }
  }
}, 180000)

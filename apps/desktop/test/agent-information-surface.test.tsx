// @vitest-environment happy-dom
import { act } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AgentConfigurationReceipt, AgentConfigurationSnapshot, AgentInformationInspection, AgentInformationSnapshot } from '@agentmux/core'
import { AgentSessionComposer } from '../src/renderer/src/components/AgentSessionComposer'
import { AgentNativeInformation } from '../src/renderer/src/components/AgentNativeInformation'
import { useAgentNativeInformation } from '../src/renderer/src/lib/use-agent-native-information'
import { NativeConfigurationPicker } from '../src/renderer/src/components/PosturePicker'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { composerConfig, composerDOM, composerSession } from './helpers/composer-dom-fixture'

const dom = composerDOM()
const configuration: AgentConfigurationSnapshot = { revision: 'original-native-revision', options: [
  { id: 'native-picker-not-named-model', name: 'Select engine', category: 'model', type: 'select', currentValue: 'model-a', choices: [
    { value: 'model-a', name: 'Original Model' }, { value: 'model-b', name: 'Next Native Model' }
  ] }, { id: 'details', name: 'Details', type: 'boolean', currentValue: true }
] }
const information: AgentInformationSnapshot = { nativeSessionId: 'native-original', sourceId: 'source-original', observedAt: 5000,
  model: { id: 'model-a', name: 'Original Model', scope: 'next-turn' }, plan: { id: 'plan-original', name: 'Native Team' },
  limits: [{ id: 'short', name: 'Short window', usedPercent: 24, resetsAt: 100000 }, { id: 'long', name: 'Weekly', usedPercent: 60 }], issues: [] }
function inspection(session = composerSession(), snapshot: AgentInformationSnapshot | null = information): AgentInformationInspection {
  return { kind: 'information', target: { hostId: session.control.hostId, runtimeId: 'runtime-original', agentSessionId: session.id,
    expectedRun: session.control.run, providerId: session.providerId }, snapshot, configuration }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail }); return { promise, resolve, reject } }
async function click(element: Element) { await act(async () => { (element as HTMLElement).click() }) }
async function openModel() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')!
  await act(async () => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); trigger.click() })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][aria-label="Model"]')).not.toBeNull())
}
beforeEach(() => {
  vi.spyOn(api.sessions, 'inspectInformation').mockImplementation(async control => inspection({ ...composerSession(), id: control.agentSessionId, control }))
})

it('the real visible Composer reads once and shares native model, plan and quota with its avatar without replacing the draft', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(api.sessions.inspectInformation).toHaveBeenCalledExactlyOnceWith(composerSession().control)
  const model = dom.container.querySelector('.composer-model-picker')!
  expect(model.textContent).toContain('Original Model')
  const group = dom.container.querySelector('.composer-session-controls')!
  expect(model.nextElementSibling?.getAttribute('aria-label')).toBe('Session settings')
  expect(group.querySelector('.composer__context')).not.toBeNull()
  await dom.click('.composer-agent-identity .agent-avatar')
  const face = document.querySelector('.agent-state-face')!
  expect(face.textContent).toContain('Native Team')
  expect(face.textContent).toContain('76% remaining')
  expect(face.textContent).toContain('40% remaining')
  expect(face.querySelector('.agent-state-face__facts')?.hasAttribute('open')).toBe(false)
  expect(face.textContent).not.toContain('Final admission is decided by Core')
  expect(face.textContent).not.toContain('Shown status')
  expect(api.sessions.inspectInformation).toHaveBeenCalledTimes(1)
  expect(dom.draft()).toBe('Keep my draft')
})

it('keeps Context separate from account windows and never fabricates zero for unavailable native fields', async () => {
  await dom.render(<AgentNativeInformation information={information} contextWindowUsage={{ usedTokens: 250, capacityTokens: 1000, observedAt: 1000 }} />)
  expect(dom.container.textContent).toContain('75% remaining')
  expect(dom.container.textContent).toContain('76% remaining')
  expect([...dom.container.querySelectorAll('progress')].map(bar => bar.value)).toEqual([76, 40])
  expect(dom.container.querySelector('progress')?.getAttribute('aria-label')).toBe('Short window: 76% remaining')
  await dom.render(<AgentNativeInformation information={{ ...information, model: undefined, plan: undefined, limits: undefined,
    issues: [{ field: 'plan', kind: 'unsupported', code: 'NATIVE_NOT_REPORTED', message: 'Native has no plan field' },
      { field: 'limits', kind: 'unavailable', code: 'PRIVATE_READ_UNAVAILABLE', message: 'Not available' }] }} />)
  expect(dom.container.querySelector('progress')).toBeNull()
  expect(dom.container.textContent).toContain('Plan not provided · Account limits unavailable')
  expect(dom.container.textContent).not.toContain('0%')
})

it('retains the last native value and original time when explicit refresh fails', async () => {
  vi.mocked(api.sessions.inspectInformation).mockResolvedValueOnce(inspection()).mockRejectedValueOnce(new Error('original source temporarily unavailable'))
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  const observed = document.querySelector('.agent-native-information time')?.getAttribute('dateTime')
  await click(document.querySelector('[aria-label="Refresh Agent information"]')!)
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('Native Team')
  expect(document.querySelector('.agent-native-information [role="status"]')?.textContent).toContain('Last confirmed values are kept')
  expect(document.querySelector('.agent-native-information time')?.getAttribute('dateTime')).toBe(observed)
  expect(dom.draft()).toBe('Keep my draft')
})

it('ignores the old Run observation after the same Session changes Run and never reads while hidden', async () => {
  const original = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValueOnce(original.promise)
  await dom.render(<AgentSessionComposer sessionId="agent-1" visible={false} />)
  expect(api.sessions.inspectInformation).not.toHaveBeenCalled()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  const changed = { ...composerSession(), control: { ...composerSession().control, run: { runId: 'new-original-run' } } }
  vi.mocked(api.sessions.inspectInformation).mockResolvedValueOnce(inspection(changed, { ...information, plan: { id: 'new-plan', name: 'New Run Plan' } }))
  await act(async () => useAppStore.setState({ sessions: [changed] }))
  await act(async () => original.resolve(inspection()))
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('New Run Plan')
  expect(document.querySelector('.agent-native-information')?.textContent).not.toContain('Native Team')
  expect(api.sessions.inspectInformation).toHaveBeenCalledTimes(2)
})

it('combines duplicate refreshes for one mounted exact target and ignores late hidden results', async () => {
  let reading!: ReturnType<typeof useAgentNativeInformation>
  function Harness({ visible = true }) {
    reading = useAgentNativeInformation(composerSession().control, visible)
    return <span>{reading.information?.plan?.name ?? 'No native plan'}</span>
  }
  const request = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValueOnce(request.promise)
  await dom.render(<Harness />)
  let first!: Promise<void>, second!: Promise<void>
  await act(async () => { first = reading.refresh(); second = reading.refresh() })
  expect(first).toBe(second)
  expect(api.sessions.inspectInformation).toHaveBeenCalledTimes(1)
  await dom.render(<Harness visible={false} />)
  await act(async () => request.resolve(inspection()))
  expect(dom.container.textContent).toBe('No native plan')
})

it('only Provider model category creates a direct selector; names and IDs are not model roles', async () => {
  await dom.render(<NativeConfigurationPicker snapshot={{ revision: 'native', options: [{ ...configuration.options[0]!, id: 'model', name: 'Model', category: 'other' }] }} onSet={vi.fn()} />)
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).toBe('Model')
  await openModel()
  expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(0)
  expect(document.querySelector('.model-picker__unavailable')?.textContent).toContain('not available')
})

it('makes a direct model choice with its original revision, keeps unknown feedback and checks the same original recipe', async () => {
  const pending = deferred<AgentConfigurationReceipt | undefined>()
  const receipt = { action: 'agent-configuration', phase: 'settled', outcome: 'unknown', operationId: 'original-switch', diskDurability: 'confirmed', issue: 'Native acknowledgement missing' } as AgentConfigurationReceipt
  const set = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(receipt)
  await dom.render(<NativeConfigurationPicker snapshot={configuration} information={information} onSet={set} />)
  await openModel()
  const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.includes('Next Native Model'))!
  await act(async () => { option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); (option as HTMLElement).click() })
  expect(set).toHaveBeenCalledExactlyOnceWith('native-picker-not-named-model', 'model-b', 'original-native-revision')
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).toContain('Original Model')
  expect(dom.container.querySelector('.composer-model-picker')?.getAttribute('data-pending')).toBe('true')
  await act(async () => pending.resolve(receipt))
  await openModel()
  expect(document.querySelector('.model-picker__feedback')?.textContent).toContain('Native acknowledgement missing')
  await click(document.querySelector('.model-picker__feedback button')!)
  expect(set.mock.calls).toEqual([['native-picker-not-named-model', 'model-b', 'original-native-revision'], ['native-picker-not-named-model', 'model-b', 'original-native-revision']])
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).toContain('Original Model')
})

it('an acknowledged local configuration cannot be overwritten by an earlier native information read', async () => {
  const request = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValueOnce(request.promise)
  let reading!: ReturnType<typeof useAgentNativeInformation>
  function Harness() {
    reading = useAgentNativeInformation(composerSession().control, true, information, configuration)
    return <span>{reading.configuration?.options[0]?.currentValue}</span>
  }
  await dom.render(<Harness />)
  const changed = { ...configuration, revision: 'acknowledged-next', options: [{ ...configuration.options[0]!, currentValue: 'model-b' }] } as AgentConfigurationSnapshot
  await act(async () => { reading.adoptConfiguration(changed); request.resolve(inspection()) })
  expect(dom.container.textContent).toBe('model-b')
})

it('a failed earlier observation preserves the newer acknowledged configuration', async () => {
  const request = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValueOnce(request.promise)
  let reading!: ReturnType<typeof useAgentNativeInformation>
  function Harness() {
    reading = useAgentNativeInformation(composerSession().control, true, information, configuration)
    return <span>{reading.configuration?.options[0]?.currentValue}</span>
  }
  await dom.render(<Harness />)
  const changed = { ...configuration, revision: 'acknowledged-next', options: [{ ...configuration.options[0]!, currentValue: 'model-b' }] } as AgentConfigurationSnapshot
  await act(async () => { reading.adoptConfiguration(changed); request.reject(new Error('late original read failed')) })
  expect(dom.container.textContent).toBe('model-b')
  expect(reading.issue).toBe('late original read failed')
})

it('allows a new explicit choice after a fresh native revision while retaining the old unknown recipe', async () => {
  const set = vi.fn().mockResolvedValue({ outcome: 'unknown', phase: 'settled', diskDurability: 'confirmed', operationId: 'unknown-original', issue: 'Original acknowledgement unavailable' } as AgentConfigurationReceipt)
  await dom.render(<NativeConfigurationPicker snapshot={configuration} onSet={set} />)
  await openModel()
  const selectNext = async () => {
    const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.includes('Next Native Model'))!
    await act(async () => { option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); (option as HTMLElement).click() })
  }
  await selectNext(); await openModel()
  expect([...document.querySelectorAll('[role="menuitemradio"]')].every(item => item.hasAttribute('data-disabled'))).toBe(true)
  await dom.render(<NativeConfigurationPicker snapshot={{ ...configuration, revision: 'fresh-native-revision' }} onSet={set} />)
  expect(document.querySelector('.model-picker__feedback')?.textContent).toContain('Original acknowledgement unavailable')
  expect([...document.querySelectorAll('[role="menuitemradio"]')].some(item => item.hasAttribute('data-disabled'))).toBe(false)
  await selectNext()
  expect(set.mock.calls.map(call => call[2])).toEqual(['original-native-revision', 'fresh-native-revision'])
})

it('drops the prior Run pending model projection when the actual Composer changes Run', async () => {
  const request = deferred<AgentConfigurationReceipt | undefined>()
  vi.spyOn(useAppStore.getState(), 'setConfiguration').mockReturnValueOnce(request.promise)
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel()
  const next = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.includes('Next Native Model'))!
  await act(async () => { next.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); (next as HTMLElement).click() })
  expect(dom.container.querySelector('.composer-model-picker')?.getAttribute('data-pending')).toBe('true')
  const changed = { ...composerSession(), control: { ...composerSession().control, run: { runId: 'another-original-run' } } }
  vi.mocked(api.sessions.inspectInformation).mockResolvedValueOnce(inspection(changed))
  await act(async () => useAppStore.setState({ sessions: [changed] }))
  expect(dom.container.querySelector('.composer-model-picker')?.hasAttribute('data-pending')).toBe(false)
  await act(async () => request.resolve(undefined))
  expect(dom.container.querySelector('.composer-model-picker')?.getAttribute('aria-label')).not.toContain('unconfirmed')
})

it('the real Composer changes its model through the existing Store and original native receipt while keeping input untouched', async () => {
  const changed = { ...configuration, revision: 'confirmed-next-revision', options: [{ ...configuration.options[0]!, currentValue: 'model-b' }, configuration.options[1]!] } as AgentConfigurationSnapshot
  const set = vi.spyOn(api.sessions, 'setConfiguration').mockImplementation(async (_control, input) => ({
    action: 'agent-configuration', phase: 'settled', outcome: 'applied', operationId: input.operationId,
    diskDurability: 'confirmed', acknowledgement: changed
  } as AgentConfigurationReceipt))
  const submit = vi.spyOn(api.sessions, 'submitPrompt').mockResolvedValue()
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await openModel()
  const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.includes('Next Native Model'))!
  await act(async () => { option.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); (option as HTMLElement).click() })
  expect(set).toHaveBeenCalledOnce()
  expect(set.mock.calls[0]![0]).toEqual(composerSession().control)
  expect(set.mock.calls[0]![1]).toMatchObject({ configId: 'native-picker-not-named-model', value: 'model-b', expectedRevision: 'original-native-revision' })
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).toContain('Next Native Model')
  expect(submit).not.toHaveBeenCalled()
  expect(dom.draft()).toBe('Keep my draft')
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('Next Native Model')
})


it('the mounted Composer accepts a same-clock Core source gap and never lets the older read restore its current model', async () => {
  const request = deferred<AgentInformationInspection>()
  vi.mocked(api.sessions.inspectInformation).mockReturnValueOnce(request.promise)
  const original = { ...composerSession(), nativeInformation: information, nativeConfiguration: configuration }
  useAppStore.setState({ sessions: [original] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).toContain('Original Model')
  const gap: AgentInformationSnapshot = { ...information, issues: [{ field: 'model', kind: 'unconfirmed', code: 'NATIVE_ACTIVITY_SOURCE_GAP', message: 'Native observation source has a gap' }] }
  await act(async () => useAppStore.setState({ sessions: [{ ...composerSession(), nativeInformation: gap }] }))
  await act(async () => request.resolve(inspection()))
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).not.toContain('Original Model')
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('Last model')
  expect(document.querySelector('.agent-native-information')?.textContent).toContain('Unconfirmed')
  expect(document.querySelector('.agent-native-information time')?.getAttribute('dateTime')).toBe(new Date(information.observedAt).toISOString())
  expect(dom.draft()).toBe('Keep my draft')
})

it('an explicit empty owner inspection clears the mounted prior model and plan instead of retaining a competing cache', async () => {
  useAppStore.setState({ sessions: [{ ...composerSession(), nativeInformation: information, nativeConfiguration: configuration }] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  vi.mocked(api.sessions.inspectInformation).mockResolvedValueOnce({ ...inspection(), snapshot: null, configuration: null })
  await click(document.querySelector('[aria-label="Refresh Agent information"]')!)
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).not.toContain('Original Model')
  expect(document.querySelector('.agent-native-information')?.textContent).not.toContain('Native Team')
  expect(document.querySelector('.agent-native-information time')).toBeNull()
  expect(dom.draft()).toBe('Keep my draft')
})

it('the full Core Session projection can withdraw a previously supplied native sample without changing Run or sending input', async () => {
  useAppStore.setState({ sessions: [{ ...composerSession(), nativeInformation: information, nativeConfiguration: configuration }] })
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await act(async () => useAppStore.setState({ sessions: [composerSession()] }))
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).not.toContain('Original Model')
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-native-information')?.textContent).not.toContain('Native Team')
  expect(api.sessions.inspectInformation).toHaveBeenCalledTimes(1)
  expect(dom.draft()).toBe('Keep my draft')
})


it('shows equal Provider and executor labels once while preserving a distinct configured executor label', async () => {
  await dom.render(<AgentSessionComposer sessionId="agent-1" />)
  await dom.click('.composer-agent-identity .agent-avatar')
  expect(document.querySelector('.agent-state-face__provider')?.textContent).toBe('Codex')
  await act(async () => useAppStore.setState({ config: { ...composerConfig, executors: { ...composerConfig.executors,
    codex: { ...composerConfig.executors.codex!, label: 'Team Codex' } } } }))
  expect(document.querySelector('.agent-state-face__provider')?.textContent).toBe('Codex · Team Codex')
})


it('the unknown original model operation is reachable and checkable through the actual menu keyboard collection', async () => {
  const receipt = { outcome: 'unknown', phase: 'settled', diskDurability: 'confirmed', operationId: 'keyboard-original', issue: 'Original acknowledgement unavailable' } as AgentConfigurationReceipt
  const set = vi.fn().mockResolvedValue(receipt)
  await dom.render(<NativeConfigurationPicker snapshot={configuration} onSet={set} onRefresh={async () => {}} />)
  async function openWithKeyboard(phase: string) {
    const trigger = dom.container.querySelector<HTMLButtonElement>('.composer-model-picker')!
    await act(async () => { trigger.focus(); trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })) })
    await vi.waitFor(() => expect(document.querySelector('[role="menu"][aria-label="Model"]'), phase).not.toBeNull())
  }
  await openWithKeyboard('initial keyboard open')
  const next = [...document.querySelectorAll('[role="menuitemradio"]')].find(item => item.textContent?.includes('Next Native Model'))!
  await act(async () => { next.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); (next as HTMLElement).click() })
  await vi.waitFor(() => expect(document.querySelector('[role="menu"][aria-label="Model"]')).toBeNull())
  await vi.waitFor(() => expect(document.activeElement).toBe(dom.container.querySelector('.composer-model-picker')))
  await openWithKeyboard('reopen after original focus returns')
  const menu = document.querySelector<HTMLElement>('[role="menu"][aria-label="Model"]')!
  await act(async () => menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Check original change'))
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  expect(set.mock.calls).toEqual([['native-picker-not-named-model', 'model-b', 'original-native-revision'], ['native-picker-not-named-model', 'model-b', 'original-native-revision']])
  expect(document.querySelector('[role="menu"][aria-label="Model"]')).not.toBeNull()
  expect(dom.container.querySelector('.composer-model-picker')?.textContent).toContain('Original Model')
})

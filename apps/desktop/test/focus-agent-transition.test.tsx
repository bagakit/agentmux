// @vitest-environment happy-dom
import { webcrypto } from 'node:crypto'
import { act, useMemo } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createFocusProjectionSelector } from '../src/renderer/src/lib/focus-context'
import { spatialCatalog } from '../src/renderer/src/lib/space-agent-control'
import { FocusContextRow } from '../src/renderer/src/components/FocusContextRow'
import { takeOverSession, takeoverRequestId, type TakeoverSource } from '../src/renderer/src/lib/session-takeover'
import { agentNewTabDestinations } from '../src/renderer/src/lib/agent-new-tab-destination'

vi.mock('../src/renderer/src/components/AgentAvatar', async importOriginal => ({ ...await importOriginal<typeof import('../src/renderer/src/components/AgentAvatar')>(), AgentAvatar: () => <span /> }))
const initial = useAppStore.getState()
const target = { ...composerSession('focus-presentation'), control: { ...composerSession('focus-presentation').control, agentSessionId: 'focus-canonical' },
  nativeHandle: { kind: 'provider' as const, providerId: 'codex', sessionId: 'native-current' },
  capabilities: { ...composerSession().capabilities, providerFork: { current: true } } }
let root: Root, host: HTMLDivElement, execute: ReturnType<typeof vi.fn>
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) })
function Scene() {
  const selector = useMemo(createFocusProjectionSelector, []), { contexts } = useAppStore(selector)
  return <>{contexts.map(context => <FocusContextRow key={context.id} context={context} selected={false} onSelect={() => {}} />)}<input aria-label="Later work" /></>
}
const catalog = () => spatialCatalog(useAppStore.getState(), [])
async function open() {
  const card = host.querySelector<HTMLElement>(`[data-session-id="${target.id}"]`)!
  await act(async () => { card.focus(); card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 })) }); await settle()
}
async function click(label: string) {
  const element = [...document.querySelectorAll<HTMLElement>('[role="menuitem"],button')].find(item => (item.getAttribute('aria-label') ?? item.textContent?.trim()) === label)
  expect(element, `Actual Focus action ${label}`).toBeTruthy()
  await act(async () => element!.click()); await settle()
}
async function selectDestination(label: string, select: (destination: Record<string, unknown>) => boolean = () => true) {
  const trigger = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
  expect(trigger).toBeTruthy()
  await act(async () => trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', ctrlKey: false }))); await settle()
  const candidates = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].filter(item => item.dataset.value?.includes('"newTab":true'))
  const choices = candidates.map(item => JSON.parse(item.dataset.value!))
  const option = candidates.find(item => select(JSON.parse(item.dataset.value!)))
  expect(option, 'Explicit existing spatial destination').toBeTruthy()
  await act(async () => option!.click()); await settle()
  return choices
}
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.setState({ ...initial, config: composerConfig, sessions: [target], tabs: {}, layouts: { workspace: createWorkspaceLayout('destination-group', []) },
    spatialRequests: {}, spaceZoneBindings: {}, scratchTopicSnapshots: {}, timelines: {}, mainSurface: 'agents', agentNames: { [target.id]: 'Original Agent' },
    agentComposerDrafts: { [target.id]: 'Unsent original' }, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } } }, true)
  execute = vi.fn(async request => request.operation === 'space.inspect' ? { operation: 'space.inspect', catalog: catalog() } : {
    operation: 'agent.open', requestId: request.requestId, outcome: 'unknown', from: null, to: null, agent: null, resource: null,
    save: { layoutApplied: false, localStorageWritten: false, storageFlushRequested: false, diskDurability: 'unconfirmed', reason: 'Private fixture' },
    issues: [{ step: 'creation', code: 'PRIVATE_UNKNOWN', message: 'Original result is unknown', recovery: 'Inspect same request' }] })
  useAppStore.setState({ executeControl: execute as never })
  vi.spyOn(useAppStore.getState(), 'detectExecutors').mockResolvedValue(undefined)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
  await act(async () => root.render(<Scene />))
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('actual Focus forks without an original Region only after explicit destination; uses canonical source and retains the unknown operation', async () => {
  const before = useAppStore.getState()
  await open(); await click('Fork current conversation…')
  expect(document.querySelector('[data-current-fork-review]')).toBeTruthy(); expect(execute).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLButtonElement>('[data-current-fork-review] .small-button')!.disabled).toBe(true)
  await selectDestination('Fork destination'); await click('Fork in new Tab')
  const creations = execute.mock.calls.map(([request]) => request).filter(request => request.operation === 'agent.open')
  expect(creations).toHaveLength(1)
  expect(creations[0]).toMatchObject({ focus: false, content: { kind: 'fork-agent', source: {
    agentSessionId: target.control.agentSessionId, expectedRun: target.control.run, expectedNativeHandle: target.nativeHandle } },
    destination: { groupId: 'destination-group', displayWorkspaceId: 'workspace', newTab: true } })
  expect(creations[0].destination).not.toHaveProperty('regionId')
  const operationId = creations[0].requestId
  await click('Check fork operation')
  expect(execute.mock.calls.at(-1)?.[0]).toMatchObject({ operation: 'space.inspect', target: { requestId: operationId } })
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(1)
  for (const key of ['sessions', 'tabs', 'layouts', 'agentComposerDrafts', 'agentFocus'] as const) expect(useAppStore.getState()[key]).toBe(before[key])
})

it('canceling Focus fork/takeover creates nothing and preserves the original work', async () => {
  await open(); await click('Fork current conversation…'); await click('Cancel fork')
  expect(execute).not.toHaveBeenCalled()
  await click('Take over')
  expect(document.querySelector('[aria-label="Take over this work"]')).toBeTruthy()
  expect(document.querySelector<HTMLButtonElement>('.agent-pick')!.disabled).toBe(true)
  await click('Cancel takeover'); await settle()
  expect(execute).not.toHaveBeenCalled(); expect(useAppStore.getState().agentComposerDrafts[target.id]).toBe('Unsent original')
})

it('actual Focus Takeover uses the original surface, explicit execution Zone and canonical source prompt without Region substitution', async () => {
  await open(); await click('Take over'); await selectDestination('Takeover destination')
  const pick = document.querySelector<HTMLButtonElement>('.agent-pick[data-executor-id="codex"]')!
  expect(pick.disabled).toBe(false)
  await act(async () => { pick.click(); pick.click() }); await settle()
  const creations = execute.mock.calls.filter(([request]) => request.operation === 'agent.open')
  expect(creations).toHaveLength(1)
  expect(creations[0]![0]).toMatchObject({ content: { kind: 'new-agent', executorId: 'codex' }, destination: { groupId: 'destination-group', newTab: true }, focus: false })
  expect(creations[0]![0].content.prompt).toContain(`--session '${target.control.agentSessionId}'`)
  expect(creations[0]![0].content.prompt).not.toContain(`--session '${target.id}'`)
  expect(document.querySelector('[aria-label="Take over this work"]')?.textContent).toContain('Original result is unknown')
})

it('a source Run changing during original destination inspection prevents only this reviewed fork', async () => {
  await open(); await click('Fork current conversation…'); await selectDestination('Fork destination')
  execute.mockImplementationOnce(async () => {
    useAppStore.setState({ sessions: [{ ...target, control: { ...target.control, run: { runId: 'replacement-run' } } }] })
    return { operation: 'space.inspect', catalog: catalog() }
  })
  await click('Fork in new Tab')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(0)
  expect(document.querySelector('.focus-context-menu')?.textContent).toContain('source conversation changed')
  expect(useAppStore.getState().agentComposerDrafts[target.id]).toBe('Unsent original')
})

it('Focus Fork offers only source-Host resource Zones while retaining an explicitly chosen display Group on another Host', async () => {
  await act(async () => useAppStore.setState({ config: { ...composerConfig,
    hosts: [...composerConfig.hosts, { ...composerConfig.hosts[0]!, id: 'second-host', label: 'Other execution Host' }],
    workspaces: [...composerConfig.workspaces, { ...composerConfig.workspaces[0]!, id: 'foreign-display', hostId: 'second-host', name: 'Other display' }] },
    layouts: { ...useAppStore.getState().layouts, 'foreign-display': createWorkspaceLayout('foreign-group', []) } }))
  await open(); await click('Fork current conversation…')
  const choices = await selectDestination('Fork destination', destination => destination.displayWorkspaceId === 'foreign-display')
  expect(choices.length).toBeGreaterThan(0)
  expect(choices.every(choice => catalog().zones.find(zone => zone.zoneId === choice.zoneId)?.hostId === target.control.hostId)).toBe(true)
  expect(choices.some(choice => choice.displayWorkspaceId === 'foreign-display' && choice.groupId === 'foreign-group')).toBe(true)
  await click('Fork in new Tab')
  const request = execute.mock.calls.find(([request]) => request.operation === 'agent.open')?.[0]
  expect(request).toMatchObject({ content: { kind: 'fork-agent', source: { agentSessionId: target.control.agentSessionId } },
    destination: { displayWorkspaceId: 'foreign-display', groupId: 'foreign-group', newTab: true } })
  expect(catalog().zones.find(zone => zone.zoneId === request.destination.zoneId)?.hostId).toBe(target.control.hostId)
})

it('a chosen Zone moving to another Host is rejected before admitting a Fork and leaves a fresh review available', async () => {
  await open(); await click('Fork current conversation…'); await selectDestination('Fork destination')
  execute.mockImplementationOnce(async () => ({ operation: 'space.inspect', catalog: { ...catalog(),
    zones: catalog().zones.map(zone => ({ ...zone, hostId: 'second-host' })) } }))
  await click('Fork in new Tab')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(0)
  expect(document.querySelector('.focus-context-menu')?.textContent).toContain('chosen Space, Zone or Group changed')
  expect(document.querySelector('[data-current-fork-action]')?.hasAttribute('data-disabled')).toBe(false)
  expect(useAppStore.getState().spatialRequests).toEqual({})
  expect(useAppStore.getState().agentComposerDrafts[target.id]).toBe('Unsent original')
})

it('Session-source takeover rejects stale Run or destination, and destination changes cannot mint a new retry identity', async () => {
  const destination = agentNewTabDestinations(catalog(), useAppStore.getState().layouts, { hostId: target.control.hostId, cwd: target.workspacePath })[0]!.destination
  const source: TakeoverSource = { kind: 'session', agentSessionId: target.control.agentSessionId, presentationSessionId: target.id, expectedRun: target.control.run,
    hostId: target.control.hostId, cwd: target.workspacePath, executorId: target.executorId, label: target.label, diagnostic: '', origin: { sessionId: target.id }, destination }
  expect(await takeoverRequestId(source)).toBe(await takeoverRequestId({ ...source, destination: { ...destination, groupId: 'different-group' } }))
  await expect(takeOverSession({ ...source, destination: { ...destination, groupId: 'missing-group' } }, 'codex', () => true)).rejects.toThrow('chosen Space, Zone or Group changed')
  useAppStore.setState({ sessions: [{ ...target, control: { ...target.control, run: { runId: 'new-run' } } }] })
  await expect(takeOverSession(source, 'codex', () => true)).rejects.toThrow('original Region or Session changed')
  expect(execute.mock.calls.filter(([request]) => request.operation === 'agent.open')).toHaveLength(0)
})

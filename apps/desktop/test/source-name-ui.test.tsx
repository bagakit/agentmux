import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.hoisted(() => { vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
import { createClientUiRoot } from './helpers/client-ui-render'
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import type { AgentMuxStoredAgentSession } from '@agentmux/core'
import { spatialAgentFact, isSpatialAgentAssociation } from '../../../packages/core/src/spatial-agent-open-contract'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec'
import { spaceMountTransport } from './helpers/space-mount-fixture'
import { initializeSpatialControlFixture } from './helpers/spatial-control-owner-fixture'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { mountedAgentOpenInput, mountedAgentOpenKey, type MountedAgentOpenInput } from '../src/renderer/src/lib/space-mount-launch'
import { sourceCoordinatorInput, sourceCoordinatorInputKey, type SourceCoordinatorInput } from '../src/renderer/src/lib/source-coordinator-input'
import { applyOriginalLaunchNames, originalLaunchName, type LaunchNameOwner } from '../src/renderer/src/lib/original-launch-names'
import { sendSourceLauncherRequest } from '../src/renderer/src/lib/source-launcher-request'
import { SourceLauncherRequest } from '../src/renderer/src/components/SourceLauncherRequest'
import { OriginalLaunchNames } from '../src/renderer/src/components/OriginalLaunchNames'
import type { NameChangeResult } from '@agentmux/core/name-control'
import type { AppConfig } from '../src/shared/contracts'

const cleanup: Array<() => unknown | Promise<unknown>> = [], initial = useAppStore.getState()
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private observer' }], executors: {}, workspaces: [],
  appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, saveBookmark: true, viewport: true, more: true } } }
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); useAppStore.setState(initial, true); localStorage.clear() })
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes }); return { promise, resolve } }
async function fixture() {
  const f = await createSpaceSessionsFixture(cleanup), sameLocal = await f.b.put('same-SID'), before = await f.d.put('same-SID')
  const session: AgentMuxStoredAgentSession = { ...before, creation: { createOperationId: 'original-C', initialPrompt: 'unknown' } }
  await (f.d.core as unknown as { registry: { put(session: AgentMuxStoredAgentSession, expected: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(session, before.run)
  const admitted = await f.admit('D-in-B', f.d.owner.runtimeId, session.agentSessionId, 'original-C')
  const transport = spaceMountTransport(cleanup, [
    { id: 'B-in-observer', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } },
    { id: 'independent-original-owner', carrier: { forwardRpc: f.d.rpc.call.bind(f.d.rpc), subscribeRpc: f.d.rpc.subscribe.bind(f.d.rpc) } }
  ])
  if (admitted.address.zoneId === null) throw Error('This fixture requires the original registered Source Zone')
  const native = vi.spyOn(f.d.core, 'connectRuntime').mockRejectedValue(Error('Names must not connect Native'))
  const subject = vi.spyOn(f.d.core, 'runtimeSubject').mockRejectedValue(Error('Names must not inspect Run state'))
  const source = { hostId: 'B-in-observer', reference: f.reference, workspaceId: 'original-b-project', zoneId: admitted.address.zoneId }
  const report = { operationId: 'original-C', outcome: 'opened' as const, from: null, to: admitted.address, agent: spatialAgentFact(session, 'D-in-B'), resource: null,
    issues: [], save: { layoutApplied: true, clientStateWritten: true, storageFlushRequested: true, diskDurability: 'confirmed' as const, reason: null } }
  const input: MountedAgentOpenInput = { kind: 'agent-open', target: source, slot: { kind: 'region', tabId: 'observer-launcher-tab', regionId: 'observer-launcher-region' },
    submitted: false, origin: { kind: 'ordinary-launcher', launcherId: 'observer-launcher', project: { id: 'observer-project', hostId: source.hostId, path: '/b/project' },
      names: { agentName: '  Original D Agent  ', tabName: ' Original B Tab ' } }, request: { operationId: 'original-C', content: { kind: 'new-agent', executorId: 'test-executor',
      agentTarget: { hostId: 'D-in-B', runtimeId: f.d.owner.runtimeId } }, destination: { spaceId: f.reference.spaceId, zoneId: source.zoneId, newTab: true }, focus: false } }
  useAppStore.setState({ config, sessions: [], mountedSpaceInputs: {}, agentNames: {}, launcherNameDrafts: { 'other-launcher': { agentName: 'Unsent later private edit', tabName: 'Keep this Tab draft' } } })
  await initializeSpatialControlFixture()
  const call = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, params, signal) => method === 'open' ? report as never : await transport.api.call(method, params, signal))
  return { ...f, ...transport, sameLocal, session, admitted, source, input, report, call, native, subject }
}
function sourceOwner(input: MountedAgentOpenInput): LaunchNameOwner { return { kind: 'source', input } }
function retained(f: Awaited<ReturnType<typeof fixture>>) { return mountedAgentOpenInput(useAppStore.getState().mountedSpaceInputs, mountedAgentOpenKey(f.input.target, f.input.slot))! }
async function renderNames(owner: LaunchNameOwner) {
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  await act(async () => root.render(createElement(OriginalLaunchNames, { owner })))
  cleanup.push(async () => { await act(async () => root.unmount()); container.remove() }); return container
}

it('ordinary Source producer and real trusted Name owners save separate D Agent/B Tab OPs; remount only reads and keeps original private drafts', async () => {
  const f = await fixture(), before = useAppStore.getState(), original = await f.d.core.readAgentSession(f.session.agentSessionId)
  await sendSourceLauncherRequest(f.input)
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'agent')?.response ?? originalLaunchName(sourceOwner(retained(f)), 'agent')?.issue).toBeDefined())
  expect(originalLaunchName(sourceOwner(retained(f)), 'agent')).toMatchObject({ response: { save: { diskDurability: 'confirmed' } } })
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'tab')?.response?.save.diskDurability).toBe('confirmed'))
  const owner = sourceOwner(retained(f)), agent = originalLaunchName(owner, 'agent')!, tab = originalLaunchName(owner, 'tab')!
  expect(agent.change.operationId).not.toBe(tab.change.operationId)
  expect(agent.target).toMatchObject({ kind: 'member', name: { object: 'agent', target: { runtimeId: f.d.owner.runtimeId, expectedAdmission: { kind: 'creation', operationId: 'original-C' } } } })
  expect(tab.response).toMatchObject({ target: { runtimeId: f.b.owner.runtimeId, id: f.admitted.address.tabId }, current: { override: 'Original B Tab' } })
  expect(agent.response).toMatchObject({ target: { runtimeId: f.d.owner.runtimeId, id: f.session.agentSessionId }, current: { override: 'Original D Agent' } })
  const bytes = JSON.stringify(useAppStore.getState().mountedSpaceInputs), writes = f.call.mock.calls.filter(([method]) => method.endsWith('Change')).length
  const container = document.createElement('div'); document.body.append(container); const root = createClientUiRoot(container)
  try {
    await act(async () => root.render(createElement(SourceLauncherRequest, { input: retained(f), active: true, busy: false, onContinue: () => { throw Error('No create continuation during name restore') } })))
    await vi.waitFor(() => expect(container.textContent).toContain('Agent name: Original D Agent'))
    expect(container.textContent).toContain('Tab name: Original B Tab')
    expect(f.call.mock.calls.filter(([method]) => method.endsWith('Change'))).toHaveLength(writes)
    expect(JSON.stringify(useAppStore.getState().mountedSpaceInputs)).toBe(bytes)
  } finally { await act(async () => root.unmount()); container.remove() }
  expect(useAppStore.getState().agentNames).toBe(before.agentNames); expect(useAppStore.getState().launcherNameDrafts).toBe(before.launcherNameDrafts)
  expect((await f.b.spatial.readDisplayLabel({ kind: 'agent-session', id: f.sameLocal.agentSessionId })).label).toBeNull()
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toEqual(original)
  expect(f.subject).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled(); expect(f.b.inventory).not.toHaveBeenCalled()
})

it('Reach names go independently to the original A C and B Tab L; association never becomes an Agent name carrier', async () => {
  const f = await fixture(), binding = { bindingId: 'original-A-binding', agentSessionId: f.session.agentSessionId, createOperationId: 'original-C' }
  const request = rpcControlRequest('agent.open', { operationId: 'original-L', content: { kind: 'agent-session', reference: { kind: 'coordinator-agent', runtimeId: f.d.owner.runtimeId, binding },
    expectedResource: { runtimeId: f.b.owner.runtimeId, workspaceId: 'original-b-project', workspacePath: '/b/project' } }, destination: { spaceId: f.reference.spaceId, zoneId: f.source.zoneId, newTab: true }, focus: false })
  if (!isSpatialAgentAssociation(request)) throw Error('Expected the original L')
  const association = await f.b.spatial.associateAgentOpen(request, f.b.owner.runtimeId, async () => {})
  const input: SourceCoordinatorInput = { kind: 'source-coordinator-launch', target: f.source,
    origin: { launcherId: 'reach-launcher', slot: { tabId: 'reach-tab', regionId: 'reach-region' }, project: { id: 'original-b-project', hostId: f.source.hostId, path: '/b/project' }, names: { agentName: 'Original independent A', tabName: 'Original linked B Tab' } },
    request: { hostId: 'independent-original-owner', executorId: 'test-executor', workspacePath: f.session.workspacePath, agentSessionId: f.session.agentSessionId, createOperationId: 'original-C',
      sourceCoordinator: { hostId: 'independent-original-owner', runtimeId: f.d.owner.runtimeId, resourceRuntimeId: f.b.owner.runtimeId, workingDirectory: 'device-home' },
      toolWorkspace: { hostId: f.source.hostId, id: 'original-b-project', path: '/b/project' } }, submitted: true,
    acknowledged: { target: { coordinator: { hostId: 'independent-original-owner', runtimeId: f.d.owner.runtimeId }, reference: binding }, run: f.session.run },
    association: { operationId: 'original-L', request: { operationId: 'original-L', content: request.content, destination: request.destination!, focus: false }, submitted: true,
      receipt: { ...f.report, operationId: 'original-L', to: association.record.address, agent: null } } }
  useAppStore.getState().retainSourceCoordinatorInput(sourceCoordinatorInputKey(input.request), () => input)
  await applyOriginalLaunchNames({ kind: 'reach', input })
  const current = sourceCoordinatorInput(useAppStore.getState().mountedSpaceInputs, sourceCoordinatorInputKey(input.request))!, owner: LaunchNameOwner = { kind: 'reach', input: current }
  expect(originalLaunchName(owner, 'agent')?.response).toMatchObject({ applied: true, target: { runtimeId: f.d.owner.runtimeId }, current: { override: 'Original independent A' } })
  expect(originalLaunchName(owner, 'tab')).toMatchObject({ response: { applied: true, target: { runtimeId: f.b.owner.runtimeId }, current: { override: 'Original linked B Tab' } } })
  const changes = f.call.mock.calls.filter(([method]) => method.endsWith('Change'))
  expect(changes.map(([method]) => method).sort()).toEqual(['agentNameChange', 'memberNameChange'])
  expect(changes.find(([method]) => method === 'agentNameChange')![1]).toMatchObject({ hostId: 'independent-original-owner', expectedRuntimeId: f.d.owner.runtimeId, name: { createOperationId: 'original-C' } })
  expect(changes.find(([method]) => method === 'memberNameChange')![1]).toMatchObject({ hostId: f.source.hostId, name: { object: 'tab', target: { expectedAdmission: { kind: 'association', operationId: 'original-L' } } } })
  expect(f.native).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
})

it('a higher revision owner clear stays current when the original lower revision name ACK arrives late; original ACK and later private draft both survive', async () => {
  const f = await fixture(), delayed = deferred<NameChangeResult>(), base = f.call.getMockImplementation()!
  let originalReply!: NameChangeResult
  f.call.mockImplementation(async (method, params, signal) => {
    const reply = await base(method, params, signal)
    if (method === 'memberNameChange' && 'name' in params && 'object' in params.name && params.name.object === 'agent') { originalReply = reply as NameChangeResult; return await delayed.promise as never }
    return reply
  })
  await sendSourceLauncherRequest(f.input)
  await vi.waitFor(() => expect(originalReply).toBeDefined())
  const owner = sourceOwner(retained(f)), name = originalLaunchName(owner, 'agent')!
  if (name.target.kind !== 'member') throw Error('Expected the original member')
  const changed = await f.api.call('memberNameChange', { ...name.target.carrier, name: { ...name.target.name, change: { kind: 'rename', name: null, source: 'manual', expectedNameRevision: 1, operationId: 'later-manual-clear' } } })
  expect(changed.current).toEqual({ override: null, source: 'manual', nameRevision: 2 })
  const privateDraft = { agentName: 'A later unsent private name', tabName: 'A later Tab draft' }
  useAppStore.setState({ launcherNameDrafts: { 'observer-launcher-region': privateDraft } })
  const container = await renderNames(owner)
  await vi.waitFor(() => expect(container.querySelector('summary')!.textContent).toBe('Agent name: Automatic name'))
  await act(async () => delayed.resolve(originalReply))
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'agent')?.response).toBeDefined())
  expect(container.querySelector('summary')!.textContent).toBe('Agent name: Automatic name')
  expect(container.textContent).toContain('Original name write saved.')
  expect(originalLaunchName(sourceOwner(retained(f)), 'agent')!.response).toEqual(originalReply)
  expect(useAppStore.getState().launcherNameDrafts['observer-launcher-region']).toBe(privateDraft)
  expect((await f.d.spatial.readDisplayLabel({ kind: 'agent-session', id: f.session.agentSessionId })).label).toMatchObject({ value: null, nameRevision: 2 })
})

it('name inspection is not a lost disk ACK; explicit confirm uses the same role OP and does not rewrite its CAS or replay creation', async () => {
  const f = await fixture(), base = f.call.getMockImplementation()!
  f.call.mockImplementation(async (method, params, signal) => {
    const reply = await base(method, params, signal)
    return method === 'memberNameChange' && 'name' in params && 'object' in params.name && params.name.object === 'agent' && 'change' in params.name && params.name.change.kind === 'rename'
      ? { ...reply, save: { diskDurability: 'unconfirmed', issue: 'The original disk ACK was not received by this client.' } } as never : reply
  })
  await sendSourceLauncherRequest(f.input)
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'agent')?.response).toBeDefined())
  const owner = sourceOwner(retained(f)), operationId = originalLaunchName(owner, 'agent')!.change.operationId, container = await renderNames(owner)
  await vi.waitFor(() => expect(container.textContent).toContain('disk acknowledgement is unconfirmed'))
  expect(container.querySelector('details')!.open).toBe(true)
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Check agent name')!.click())
  expect(originalLaunchName(sourceOwner(retained(f)), 'agent')!.response!.save.diskDurability).toBe('unconfirmed')
  await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Confirm original agent name')!.click())
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'agent')!.response!.save.diskDurability).toBe('confirmed'))
  const confirms = f.call.mock.calls.filter(([method, params]) => method === 'memberNameChange' && 'name' in params && 'change' in params.name && params.name.change.kind === 'confirm')
  expect(confirms).toHaveLength(1); expect(confirms[0]![1]).toMatchObject({ name: { change: { kind: 'confirm', operationId } } })
  expect(originalLaunchName(sourceOwner(retained(f)), 'agent')!.change).toMatchObject({ operationId, expectedNameRevision: 0 })
  expect(f.call.mock.calls.filter(([method]) => method === 'open')).toHaveLength(1)
})

it('an opaque Agent-name intent does not hide the valid Tab save or alter any original C, draft or opaque bytes', async () => {
  const f = await fixture(), opaque = { future: { raw: ['  keep original bytes ', { version: 9 }] } }
  const input = { ...f.input, submitted: true, receipt: f.report, nameInputs: { agent: opaque } }
  useAppStore.getState().retainSpaceMountAgentOpen(mountedAgentOpenKey(input.target, input.slot), () => input)
  const before = useAppStore.getState(), owner = sourceOwner(input)
  await applyOriginalLaunchNames(owner)
  expect(() => originalLaunchName(owner, 'agent')).toThrow('unreadable')
  expect(originalLaunchName(owner, 'tab')?.response).toMatchObject({ applied: true, save: { diskDurability: 'confirmed' } })
  expect((retained(f).nameInputs as Record<string, unknown>).agent).toBe(opaque)
  expect(JSON.stringify((retained(f).nameInputs as Record<string, unknown>).agent)).toBe(JSON.stringify(opaque))
  const container = await renderNames(owner)
  await vi.waitFor(() => expect(container.textContent).toContain('Original name write saved.'))
  expect(container.textContent).toContain('original name input is unreadable')
  expect(f.call.mock.calls.filter(([method]) => method.endsWith('Change')).map(([method]) => method)).toEqual(['memberNameChange'])
  expect(f.call.mock.calls.filter(([method]) => method === 'open')).toHaveLength(0)
  expect(useAppStore.getState().launcherNameDrafts).toBe(before.launcherNameDrafts)
  expect((await f.d.spatial.readDisplayLabel({ kind: 'agent-session', id: f.session.agentSessionId })).label).toBeNull()
})

it('a failed name checkpoint keeps its exact unsent OP while the already-created Agent and original Source work remain healthy', async () => {
  const f = await fixture(), input = { ...f.input, submitted: true, receipt: f.report }
  useAppStore.getState().retainSpaceMountAgentOpen(mountedAgentOpenKey(input.target, input.slot), () => input)
  const before = useAppStore.getState(), owner = sourceOwner(input), original = await f.d.core.readAgentSession(f.session.agentSessionId)
  const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw Error('Original private name intent ACK unavailable') })
  await applyOriginalLaunchNames(owner, ['agent'])
  write.mockRestore()
  const pending = originalLaunchName(owner, 'agent')!
  expect(pending).toMatchObject({ submitted: false, change: { name: 'Original D Agent', expectedNameRevision: 0 }, issue: expect.stringContaining('not sent in this attempt') })
  expect(pending.change.operationId).toBeTruthy(); expect(f.call.mock.calls.filter(([method]) => method.endsWith('Change'))).toHaveLength(0)
  expect(await f.d.core.readAgentSession(f.session.agentSessionId)).toEqual(original)
  expect(useAppStore.getState().launcherNameDrafts).toBe(before.launcherNameDrafts)
  expect(retained(f).request).toBe(input.request); expect(retained(f).receipt).toBe(f.report)
})

it('blank names and an inactive original-name surface do not sample Name owners or alter healthy Source work', async () => {
  const f = await fixture(), input = { ...f.input, origin: { ...f.input.origin!, names: { agentName: '', tabName: '' } } }
  await sendSourceLauncherRequest(input)
  const before = f.call.mock.calls.length, owner = sourceOwner(retained(f)), container = await renderNames(owner)
  expect(container.textContent).toBe('')
  expect(f.call.mock.calls.slice(before).filter(([method]) => method.includes('Name'))).toHaveLength(0)
  const root = createClientUiRoot(document.createElement('div'))
  try { await act(async () => root.render(createElement(OriginalLaunchNames, { owner: { kind: 'source', input: { ...retained(f), origin: f.input.origin! } }, active: false }))) }
  finally { await act(async () => root.unmount()) }
  expect(f.call.mock.calls.filter(([method]) => method.includes('Name'))).toHaveLength(0)
  expect(f.native).not.toHaveBeenCalled(); expect(f.subject).not.toHaveBeenCalled()
})

it('a late explicit continuation of the same original C preserves already-retained Name OPs instead of replacing them from its stale input', async () => {
  const f = await fixture()
  await sendSourceLauncherRequest(f.input)
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'agent')?.response?.save.diskDurability).toBe('confirmed'))
  await vi.waitFor(() => expect(originalLaunchName(sourceOwner(retained(f)), 'tab')?.response?.save.diskDurability).toBe('confirmed'))
  const names = retained(f).nameInputs, before = JSON.stringify(names), writes = f.call.mock.calls.filter(([method]) => method.endsWith('Change')).length
  await sendSourceLauncherRequest(f.input, true)
  expect(retained(f).nameInputs).toBe(names); expect(JSON.stringify(retained(f).nameInputs)).toBe(before)
  expect(f.call.mock.calls.filter(([method]) => method.endsWith('Change'))).toHaveLength(writes)
  const opens = f.call.mock.calls.filter(([method]) => method === 'open')
  expect(opens).toHaveLength(2); expect(opens[1]![1]).toEqual(opens[0]![1])
  expect(f.subject).not.toHaveBeenCalled(); expect(f.native).not.toHaveBeenCalled()
})

// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { focusSourceContextId } from '../src/renderer/src/lib/focus-source-model'
import { useAppStore } from '../src/renderer/src/store'
import { spaceMountKey } from '../src/shared/space-mount'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'

const dom = composerDOM({ agentInformation: true }), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  try { await dom.render(null) }
  finally { for (const close of cleanup.splice(0).reverse()) await close() }
})
const SID = 'legacy-original-name', savedName = '原 Source 已保存的任务名', decoyName = '另一 Runtime 的同 SID 名字'
const cardFor = (runtimeId: string) => [...dom.container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')]
  .find(card => card.dataset.sessionId === focusSourceContextId(runtimeId, SID))

/** Original label owner → public RPC → trusted Main/IPC/preload → real Focus.
 * Only the unavailable metadata/Native observation edges are substituted.
 * No Context, name receipt, hook or card is mocked. */
async function fixture(options: { foreign?: boolean; clear?: boolean; history?: boolean; name?: string } = {}) {
  const f = await createSpaceSessionsFixture(cleanup), sourceSession = await f.b.put(SID), foreignSession = await f.d.put(SID)
  const originalName = options.name ?? savedName
  const nameContext = { actor: { kind: 'user' as const, id: 'private-original-user', verified: true },
    source: 'private-owner-fixture', entryPoint: 'original-name-intent', transport: null, location: {} }
  // Seed the original historical intent at its private persistence owner, before
  // making Session/Native observations unavailable. The consumer never writes it.
  for (const [owner, value] of [[f.b, originalName], [f.d, decoyName]] as const) await owner.spatial.mutateDisplayLabel({
    operationId: 'original-saved-name', target: { kind: 'agent-session', id: SID }, value, source: 'manual', expectedNameRevision: 0
  }, nameContext, { initializeAgentLabel: true })
  if (options.clear) {
    const label = await f.b.spatial.readDisplayLabel({ kind: 'agent-session', id: SID })
    await f.b.spatial.mutateDisplayLabel({ operationId: 'original-explicit-clear', target: { kind: 'agent-session', id: SID }, value: null,
      source: 'manual', expectedNameRevision: label.label!.nameRevision }, nameContext)
  }
  const runtimeId = options.foreign ? f.d.owner.runtimeId : f.b.owner.runtimeId
  const admitted = await f.admit(options.foreign ? 'D-in-B' : 'local', runtimeId, SID, 'old-region-C')
  const original = (await f.b.spatial.read())!, regionId = 'legacy-region-without-admission', originalId = admitted.address.regionId
  const oldRegion = original.graph.regions.find(region => region.regionId === originalId)!
  const { creationOperationId: _creation, ...legacy } = oldRegion
  const remap = (node: import('@agentmux/layout').WorkbenchViewLayout['root']): import('@agentmux/layout').WorkbenchViewLayout['root'] => node.type === 'leaf'
    ? { ...node, regionId: node.regionId === originalId ? regionId : node.regionId }
    : { ...node, first: remap(node.first), second: remap(node.second) }
  const layout = original.graph.tabLayouts[admitted.address.tabId]!
  await f.b.spatial.commit({ expectedRevision: original.revision, allowEntityRemoval: true, graph: { ...original.graph,
    tabs: original.graph.tabs.map(tab => tab.tabId === admitted.address.tabId ? { ...tab, regionIds: [regionId] } : tab),
    regions: [...original.graph.regions.filter(region => region.regionId !== originalId), { ...legacy, regionId }],
    tabLayouts: { ...original.graph.tabLayouts, [admitted.address.tabId]: { ...layout, root: remap(layout.root), activeRegionId: regionId } } } })
  const config = structuredClone(DEFAULT_CONFIG)
  config.hosts = [{ id: 'local', kind: 'local', label: 'Observer owner' }, { id: 'source-route', kind: 'ssh', hostname: 'private.invalid', label: 'Exact original Source' }]
  config.workspaces = [{ id: 'original-b-project', kind: 'folder', name: 'Original project', hostId: 'local', path: '/b/project' }]
  const observer = options.foreign ? f.b : f.d
  const main = spaceMountTransport(cleanup, [
    { id: 'local', carrier: { forwardRpc: observer.rpc.call.bind(observer.rpc), subscribeRpc: observer.rpc.subscribe.bind(observer.rpc) } },
    { id: 'source-route', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }
  ], config)
  let readFailure = false
  const call = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'resources') {
      const identity = await observer.rpc.call('runtime.owner.identity', {})
      return { hostId: (input as { hostId: string }).hostId, runtimeId: identity.owner.runtimeId, workspaces: [] } as never
    }
    if (method === 'agentNameInspect' && readFailure) throw Error('Original name read temporarily unavailable')
    return await main.api.call(method, input as never, signal) as never
  })
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(async (target, listener, signal) => {
    const snapshot = await main.api.call('snapshot', target, signal)
    const opening = { reference: snapshot.reference, source: snapshot.source, revision: snapshot.revision }
    listener({ type: 'observation', observation: { ...opening, type: 'member', member: {
      hostId: options.foreign ? 'D-in-B' : 'local', runtimeId, agentSessionId: SID },
      state: { status: 'unknown', issue: { code: 'ORIGINAL_METADATA_UNAVAILABLE', message: 'Original Session metadata unavailable' } } } })
    return { initial: opening, dispose() {} }
  })
  const member = vi.spyOn(api.spaceMounts, 'member').mockRejectedValue(Error('Native observation is unavailable'))
  const reading = vi.spyOn(api.spaceMounts, 'reading').mockRejectedValue(Error('No original admission exists for conversation reading'))
  const sessionRead = vi.spyOn(f.b.core, 'readAgentSession').mockRejectedValue(Error('Original Session observation unavailable'))
  const native = vi.spyOn(f.b.core, 'runtimeSubject').mockRejectedValue(Error('Original Native observation unavailable')).mockClear()
  const effects = [f.b, f.d].flatMap(owner => (['createAgent', 'resumeAgent', 'restartAgent', 'reopenAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt'] as const).map(method => vi.spyOn(owner.core, method)))
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/b/project' })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const decoy = { ...composerSession(SID), workspacePath: '/b/project' }
  useAppStore.setState({ config, sessions: [decoy], agentNames: { [SID]: options.foreign ? originalName : decoyName }, timelines: {}, tabs: {}, layouts: {},
    mainSurface: 'agents', focusView: 'list', loading: false, mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {},
    agentFocus: { execution: { sessionId: null, history: options.history ? [{ sessionId: focusSourceContextId(runtimeId, SID), focusedAt: 1,
      identity: { kind: 'agent', name: originalName, providerId: 'codex', hostId: 'original-reading', workspacePath: '/b/project', source: { runtimeId, agentSessionId: SID } } }] : [] }, pmo: { sessionId: null } },
    scratchTopicSnapshots: {}, agentComposerDrafts: { [SID]: 'Keep original unsent draft' }, agentSteerQueues: {} })
  const target = { hostId: 'source-route', reference: f.reference, zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  useAppStore.getState().mountSpace(target, false)
  await dom.render(<GlobalFocusSurface />)
  await vi.waitFor(() => { expect(cardFor(runtimeId)).toBeDefined(); expect(useAppStore.getState().mountedSpaceSessions[spaceMountKey(f.reference)]?.reading).toBe(false) })
  const assertPreserved = async () => {
    expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep original unsent draft')
    expect(useAppStore.getState().sessions).toEqual([decoy])
    expect((await Reflect.get(f.b.core, 'store').readMetadata(SID)).run).toEqual(sourceSession.run)
    expect((await f.d.core.readAgentSession(SID))!.run).toEqual(foreignSession.run)
    expect(member).not.toHaveBeenCalled(); expect(reading).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled(); expect(sessionRead).not.toHaveBeenCalled()
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
    expect(call.mock.calls.filter(([method]) => method === 'agentNameChange' || method === 'memberNameChange')).toEqual([])
  }
  return { ...f, runtimeId, call, card: () => cardFor(runtimeId)!, assertPreserved, failRead: () => { readFailure = true } }
}

async function access(f: Awaited<ReturnType<typeof fixture>>) {
  await act(async () => f.card().dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await vi.waitFor(() => expect(agentInformationPreview.get()?.context.access).toBeDefined())
  return agentInformationPreview.get()!.context.access!
}

it('legacy no-C Source reads its saved name through the public owner while Session/Native metadata is unavailable', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.card().querySelector('strong')?.textContent).toBe(savedName))
  const reads = f.call.mock.calls.filter(([method]) => method === 'agentNameInspect')
  expect(reads).toHaveLength(1)
  expect(reads[0]![1]).toEqual({ hostId: 'source-route', expectedRuntimeId: f.b.owner.runtimeId, name: { runtimeId: f.b.owner.runtimeId, agentSessionId: SID } })
  expect(f.card().textContent).not.toContain(decoyName)
  expect(f.card().textContent).toMatch(/unknown|unavailable|unconfirmed/i)
  const originalAccess = await access(f)
  expect(originalAccess.rename).toBeUndefined(); expect(originalAccess.session).toBeUndefined(); expect(originalAccess.conversationPort).toBeUndefined()
  await f.assertPreserved()
})

it('a foreign Runtime legacy member cannot use the Source-local label route or borrow a same-SID observer name', async () => {
  const f = await fixture({ foreign: true })
  expect(f.card().querySelector('strong')?.textContent).toBe(`Agent · ${SID}`)
  expect(f.call.mock.calls.filter(([method]) => method === 'agentNameInspect')).toEqual([])
  expect(f.card().textContent).not.toContain(savedName); expect(f.card().textContent).not.toContain(decoyName)
  await f.assertPreserved()
})

it('an explicit current clear supersedes an exact visit-time name without granting rename', async () => {
  const f = await fixture({ clear: true, history: true })
  await vi.waitFor(() => expect(f.card().querySelector('strong')?.textContent).toBe(`Agent · ${SID}`))
  expect(f.card().textContent).not.toContain(savedName)
  expect((await access(f)).rename).toBeUndefined()
  await f.assertPreserved()
})

it('a later read failure retains the last confirmed original name and its reading identity', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.card().querySelector('strong')?.textContent).toBe(savedName))
  const id = f.card().dataset.sessionId, originalAccess = await access(f)
  f.failRead(); await act(async () => originalAccess.refresh())
  // main keeps the card concise; its existing Session details menu owns the
  // exact observation diagnostic. Open that real consumer instead of scraping
  // the old card wording or treating a hidden Context fact as accessible UI.
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => f.card().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 20 })))
  let details: HTMLElement | undefined
  await vi.waitFor(() => { details = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('Session details')); expect(details).toBeDefined() })
  await act(async () => { details!.focus(); details!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  await vi.waitFor(() => expect(document.querySelector('.agent-region-menu__diagnostic')?.textContent).toContain('Original name read temporarily unavailable'))
  expect(f.card().querySelector('strong')?.textContent).toBe(savedName)
  expect(f.card().dataset.sessionId).toBe(id)
  await f.assertPreserved()
})

it('unrelated Session output does not repeat original label reads or reclassify the unknown member', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.card().querySelector('strong')?.textContent).toBe(savedName))
  const count = f.call.mock.calls.filter(([method]) => method === 'agentNameInspect').length, original = f.card()
  await act(async () => { useAppStore.setState(state => ({ sessions: [...state.sessions, { ...composerSession('unrelated-output'), latestOutputBytes: 8000 }] })) })
  expect(f.call.mock.calls.filter(([method]) => method === 'agentNameInspect')).toHaveLength(count)
  expect(f.card()).toBe(original); expect(f.card().querySelector('strong')?.textContent).toBe(savedName)
  expect((await access(f)).session).toBeUndefined()
})

it('the mounted Source page reads the full saved name and separates original Host, Runtime and Session without an empty Run', async () => {
  const name = '核对发布版本、业务数据与长期保留的原始分析记录 / Review the complete investigation context across reconnects'
  const f = await fixture({ name })
  await vi.waitFor(() => expect(f.card().querySelector('strong')?.textContent).toBe(name))
  const originalAccess = await access(f)
  expect(originalAccess.executionHostId).toBe('local')
  const sourceButton = [...document.querySelectorAll<HTMLButtonElement>('.agent-information-reader__service button')].find(button => button.textContent === 'Source')
  expect(sourceButton).toBeDefined()
  await act(async () => sourceButton!.click())
  await vi.waitFor(() => expect(document.querySelector('.agent-information-reader__source')).not.toBeNull())
  const rows = new Map([...document.querySelectorAll('.agent-information-reader__source > div')].map(row => [row.querySelector('dt')?.textContent, row.querySelector('dd')?.textContent]))
  expect(rows.get('Name')).toBe(name)
  expect(rows.get('Host')).toBe('local')
  expect(rows.get('Runtime')).toBe(f.b.owner.runtimeId)
  expect(rows.get('Session')).toBe(SID)
  expect(rows.has('Run')).toBe(false)
  expect(document.querySelector('.agent-information-details__tabs [aria-current="page"]')?.textContent).toBe('Source')
  expect(originalAccess.rename).toBeUndefined()
  await f.assertPreserved()
})

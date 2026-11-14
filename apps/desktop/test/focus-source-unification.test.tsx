// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
// Native terminal/PTY painting is the only product leaf replaced in this scene.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string; control: { run: { runId: string } } } }) => createElement('div', { 'data-fixture-original-terminal': session.id, 'data-native-run': session.control.run.runId }) }))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import type { AgentMuxAgentSessionStore } from '../../../packages/core/src/agent-session-store'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import type { AgentMuxStoredAgentSession, AgentTimelineSnapshot } from '@agentmux/core'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { mainFocusPresentation } from '../src/renderer/src/lib/focus-tab-projection'
import { workbenchSelectionCatalog } from '../src/renderer/src/lib/desktop-focus-navigation'
import { workbenchProjectionSlotId, workbenchRegionProjectionSlotId, type WorkbenchProjectionSelection } from '../src/renderer/src/lib/workbench-projection'
import type { WorkbenchViewTargets } from '../src/renderer/src/lib/workbench-presentation'
import { api } from '../src/renderer/src/lib/api'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { restoreAgentFocus } from '../src/renderer/src/lib/agent-focus'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { spaceMountKey } from '../src/shared/space-mount'
import { originalSourceInputOwnerKey, originalSourceRegionProjectionId, originalSourceTabProjectionId, originalSourceWorkspaceId } from '../src/renderer/src/lib/original-space-navigation'
import { mountedRegionKey, mountedSpaceInput } from '../src/renderer/src/lib/space-mount-view'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'

const dom = composerDOM({ agentInformation: true }), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { await dom.render(null); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const foreignRecap = '原远端自己的非空分析结论，沿原 Provider 和有界阅读载体消费。'
const SID = 'same-original-sid', localName = '原本机任务：核对分析结果', localRecap = '原本机已经核对的业务结论，不能借给另一个 Runtime。'
const timeline = (sid: string, text: string): AgentTimelineSnapshot => ({ agentSessionId: sid, revision: 1, items: [{ id: 'original-answer', agentSessionId: sid, kind: 'assistant_message', title: 'Original answer', source: 'native-hook', status: 'complete', content: text, createdAt: 1, updatedAt: 1 }] })

/** App's single window owner plus the exact Focus projection destination. */
function MainFocusFixture({ navigate, regionOnly = false }: { navigate: (id: string) => void; regionOnly?: boolean }) {
  const state = useAppStore(), catalog = workbenchSelectionCatalog(state)
  const select = (reference: WorkbenchProjectionSelection) => { state.selectMainRegion(reference, state.workbenchSpaceSelection) }
  const presentation = mainFocusPresentation(state.workbenchSpaceSelection, state.tabs, catalog, select, regionOnly ? 'region' : 'tab')
  const projection = presentation.projection, reference = projection?.selection[0]
  const focusVisible = state.mainSurface === 'agents' && state.focusView === 'list'
  const viewTargets: WorkbenchViewTargets = reference && projection ? { [reference.tabId]: [{
    hostId: (projection.entity.kind === 'region' ? workbenchRegionProjectionSlotId : workbenchProjectionSlotId)(`${projection.presentationId}-slot`, reference),
    active: focusVisible, visible: focusVisible, surface: 'focus', retainedRegionId: reference.regionId, projection, reference,
    onSelectRegion: regionId => select({ ...reference, regionId })
  }] } : {}
  return <>
    <GlobalFocusSurface workspaceOpen={Boolean(state.workbenchSpaceSelection)} onSelectContext={navigate} onSelectLocation={select}
      presentation={presentation} regionOnly={regionOnly} viewTargets={viewTargets} />
    {[...new Set(Object.values(state.tabs).map(tab => tab.workspaceId))].map(workspaceId => <WorkspaceWorkbench key={workspaceId}
      workspaceId={workspaceId} visible={state.mainSurface === 'workbench' && state.activeWorkspaceId === workspaceId} viewTargets={viewTargets} />)}
  </>
}

/** Real original Core/Space and scoped Unix→Main→IPC→Preload→Renderer.
 * Native process state is the existing source fixture leaf. No unified hook,
 * Context, lane, card, filter, menu or preview implementation is mocked. */
async function fixture(options: { foreign?: boolean; unavailable?: boolean; nativeUnavailable?: boolean; metadataUnknown?: boolean; sourceOnly?: boolean; legacyNoAdmission?: boolean; multiple?: boolean; missing?: boolean; unconfirmed?: boolean; staleRun?: boolean; unobservedRun?: boolean } = {}) {
  const privateCleanup: Array<() => unknown | Promise<unknown>> = []
  const original = await createSpaceSessionsFixture(privateCleanup)
  const privateRoots = new Set([original.b.root, original.d.root])
  // A cancelled public Reader can finish its final physical IO just after its
  // logical release. Retry removal only for this scene's known private roots.
  cleanup.push(...privateCleanup.map(dispose => async () => {
    try { await dispose() } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code !== 'ENOTEMPTY' || !error.path || !privateRoots.has(error.path)) throw cause
      await rm(error.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }))
  for (const source of [original.b, original.d]) source.core.providers.register(new AgentProviderRegistry().get('codex'))
  const physicalReads: Promise<unknown>[] = []
  for (const source of [original.b, original.d]) {
    // Disposal instrumentation observes physical work below the cancellable public reader.
    const history = source.core as unknown as { readSessionHistoryPage(...args: unknown[]): Promise<unknown> }
    const read = history.readSessionHistoryPage.bind(source.core)
    vi.spyOn(history, 'readSessionHistoryPage').mockImplementation((...args) => { const pending = read(...args); physicalReads.push(pending); return pending })
  }
  // A cancelled logical Reader can settle before its physical Provider file read.
  // Drain exactly those owned reads before the fixture removes its private roots.
  cleanup.push(async () => { await Promise.allSettled(physicalReads) })

  const owner = options.foreign ? original.d : original.b, creationId = 'original-source-creation', now = Date.now()
  const before = await owner.put(SID)
  const transcriptPath = join(owner.root, 'original-native.jsonl')
  await writeFile(transcriptPath, [{ type: 'session_meta', payload: { id: 'original-native-history', cwd: options.foreign ? '/runtime-d/home' : '/b/project' } }, { type: 'response_item', timestamp: new Date(now - 2000).toISOString(), payload: { type: 'message', id: 'original-native-prompt', role: 'user', content: [{ type: 'input_text', text: '原远端自己的输入，不是同 SID 本机输入。' }] } }, { type: 'response_item', timestamp: new Date(now - 1000).toISOString(), payload: { type: 'message', id: 'original-native-response', role: 'assistant', content: [{ type: 'output_text', text: foreignRecap }] } }].map(value => JSON.stringify(value)).join('\n')+'\n')
  const session: AgentMuxStoredAgentSession = { ...before, updatedAt: now, workspacePath: options.foreign ? '/runtime-d/home' : '/b/project',
    creation: { createOperationId: creationId, initialPrompt: 'unknown' }, nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-native-history', transcriptPath }, semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now } }
  await (owner.core as unknown as { registry: { put(value: AgentMuxStoredAgentSession, expected: AgentMuxStoredAgentSession['run']): Promise<void> } }).registry.put(session, before.run)
  const admitted = await original.admit(options.foreign ? 'D-in-B' : 'local', owner.owner.runtimeId, SID, creationId)
  let readMode: 'missing' | 'pending' | 'observed' = options.missing ? 'missing' : 'observed'
  let checkGate: Promise<void> | undefined, releaseCheck: (() => void) | undefined
  const store = Reflect.get(owner.core, 'store') as AgentMuxAgentSessionStore, originalRead = store.readMetadata.bind(store)
  // Both Core.readAgentSession and its authoritative opening cut consume this
  // original persistence leaf. No Core Session/summary protocol is mocked.
  const missingRead = options.missing ? vi.spyOn(store, 'readMetadata').mockImplementation(async id => {
    if (id !== SID) return originalRead(id)
    if (readMode === 'missing') return null
    if (readMode === 'pending') await checkGate
    return originalRead(id)
  }) : undefined
  // The controlled native leaf never leaves an unresolvable read in cleanup.
  cleanup.push(() => releaseCheck?.())
  const beginOriginalCheck = () => { readMode = 'pending'; checkGate = new Promise<void>(resolve => { releaseCheck = resolve }) }
  const finishOriginalCheck = () => { readMode = 'observed'; releaseCheck?.() }

  const config = structuredClone(DEFAULT_CONFIG)
  config.hosts = [{ id: 'local', kind: 'local', label: 'Original local owner' }, { id: 'source-route', kind: 'ssh', label: 'Original source route', hostname: 'source.invalid' }]
  config.workspaces = [{ id: 'original-b-project', kind: 'folder', hostId: 'local', path: '/b/project', name: 'Ordinary analysis project' }]
  const main = spaceMountTransport(cleanup, [
    { id: 'local', carrier: { forwardRpc: original.b.rpc.call.bind(original.b.rpc), subscribeRpc: original.b.rpc.subscribe.bind(original.b.rpc) } },
    { id: 'source-route', carrier: { forwardRpc: original.b.rpc.call.bind(original.b.rpc), subscribeRpc: original.b.rpc.subscribe.bind(original.b.rpc) } }
  ], config)
  const sourceDocument = (await original.b.spatial.read())!
  const originalTab = sourceDocument.graph.tabs.find(tab => tab.tabId === admitted.address.tabId)!
  const originalRegion = sourceDocument.graph.regions.find(region => region.regionId === admitted.address.regionId)!
  // The durable member can retain a previous Run while its original Session's
  // conversation remains readable. This is not permission to reuse that Run.
  const retainedMember = options.unobservedRun ? { ...originalRegion, runId: null } : options.staleRun ? { ...originalRegion, runId: 'source-retained-prior-run' } : originalRegion
  const { creationOperationId: _creation, ...retainedRegion } = originalRegion
  const secondRegion = options.multiple ? { ...retainedRegion, regionId: 'another-original-position' }
    : { regionId: 'original-browser-position', tabId: originalTab.tabId, kind: 'browser' as const, agentSessionId: null, runId: null, execution: null }
  const unconfirmedRegion = { ...retainedRegion, regionId: 'unknown-original-position', execution: null, runId: null }
  const otherUnconfirmedRegion = { ...unconfirmedRegion, regionId: 'another-unknown-position' }
  // Seed the complete original owner's business graph and private split together;
  // Source business apply intentionally does not carry another client's layout.
  const originalLayout = sourceDocument.graph.tabLayouts[originalTab.tabId]!
  await original.b.spatial.commit({ expectedRevision: sourceDocument.revision, graph: { ...sourceDocument.graph,
    tabs: sourceDocument.graph.tabs.map(tab => tab.tabId === originalTab.tabId ? { ...tab, regionIds: [...tab.regionIds, secondRegion.regionId, ...(options.unconfirmed ? [unconfirmedRegion.regionId, otherUnconfirmedRegion.regionId] : [])] } : tab),
    regions: [...sourceDocument.graph.regions.map(region => region.regionId === originalRegion.regionId ? retainedMember : region), secondRegion, ...(options.unconfirmed ? [unconfirmedRegion, otherUnconfirmedRegion] : [])],
    tabLayouts: { ...sourceDocument.graph.tabLayouts, [originalTab.tabId]: options.unconfirmed
      ? splitWorkbenchRegion(splitWorkbenchRegion(splitWorkbenchRegion(originalLayout, originalLayout.activeRegionId, 'right', secondRegion.regionId), secondRegion.regionId, 'right', unconfirmedRegion.regionId), unconfirmedRegion.regionId, 'right', otherUnconfirmedRegion.regionId)
      : splitWorkbenchRegion(originalLayout, originalLayout.activeRegionId, 'right', secondRegion.regionId) } } })
  const nameTarget = { reference: original.reference, regionId: admitted.address.regionId, runtimeId: owner.owner.runtimeId, agentSessionId: SID, expectedAdmission: { kind: 'creation' as const, operationId: creationId } }
  if (!options.missing && !options.unconfirmed) await main.api.call('memberNameChange', { hostId: 'source-route', reference: original.reference, name: { object: 'agent', target: nameTarget, change: { kind: 'rename', operationId: 'source-name-operation', name: options.foreign ? '真正远端的独立任务' : localName, expectedNameRevision: 0, source: 'manual' } } })
  if (options.legacyNoAdmission) {
    const before = (await original.b.spatial.read())!, legacyRegionId = 'original-legacy-region'
    const { creationOperationId: _pin, ...legacy } = before.graph.regions.find(region => region.regionId === admitted.address.regionId)!
    const remap = (node: import('@agentmux/layout').WorkbenchViewLayout['root']): import('@agentmux/layout').WorkbenchViewLayout['root'] => node.type === 'leaf'
      ? { ...node, regionId: node.regionId === admitted.address.regionId ? legacyRegionId : node.regionId }
      : { ...node, first: remap(node.first), second: remap(node.second) }
    const layout = before.graph.tabLayouts[originalTab.tabId]!
    await original.b.spatial.commit({ expectedRevision: before.revision, allowEntityRemoval: true, graph: { ...before.graph,
      tabs: before.graph.tabs.map(tab => tab.tabId === originalTab.tabId ? { ...tab, regionIds: tab.regionIds.map(id => id === admitted.address.regionId ? legacyRegionId : id) } : tab),
      regions: [...before.graph.regions.filter(region => region.regionId !== admitted.address.regionId), { ...legacy, regionId: legacyRegionId }],
      tabLayouts: { ...before.graph.tabLayouts, [originalTab.tabId]: { ...layout, root: remap(layout.root), activeRegionId: legacyRegionId } } } })
  }
  vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'resources') {
      // The real original owner answers this witness; workspaces are this scene's
      // already registered resource, not a guessed Host-name/runtime mapping.
      const witnessed = await original.b.rpc.call('runtime.owner.identity', {})
      return { hostId: (input as { hostId: string }).hostId, runtimeId: witnessed.owner.runtimeId, workspaces: [] } as never
    }
    return await main.api.call(method, input as never, signal) as never
  })
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  const sessionListeners = new Set<Parameters<typeof api.spaceMounts.sessions>[1]>()
  const sessionsRead = vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(async (target, listener, signal) => {
    sessionListeners.add(listener); signal?.addEventListener('abort', () => sessionListeners.delete(listener), { once: true })
    if (options.metadataUnknown) {
      // The metadata observation edge is unavailable. Do not start its separate
      // optional Native observer while proving independent name/history IO.
      const snapshot = await main.api.call('snapshot', target, signal)
      const opening = { reference: snapshot.reference, source: snapshot.source, revision: snapshot.revision }
      listener({ type: 'observation', observation: { ...opening, type: 'member', member: {
        hostId: 'D-in-B', runtimeId: owner.owner.runtimeId, agentSessionId: SID },
        state: { status: 'unknown', issue: { code: 'ORIGINAL_METADATA_UNCONFIRMED', message: 'Original metadata is unconfirmed.' } } } })
      return { initial: opening, dispose() {} }
    }
    return await main.api.sessions(target, listener, signal)
  })
  vi.spyOn(api.spaceMounts, 'reading').mockImplementation(main.api.reading)
  const member = vi.spyOn(api.spaceMounts, 'member').mockImplementation(async (input, listener, signal) => { const surface = await main.api.member(input, listener, signal); cleanup.push(() => surface.dispose()); return surface })
  if (options.unavailable) vi.spyOn(owner.core, 'readAgentSession').mockRejectedValue(Error('Exact original Session observation unavailable'))
  if (options.nativeUnavailable) vi.spyOn(owner.core, 'runtimeSubject').mockRejectedValue(Error('The original Native observation is unavailable')).mockClear()
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/b/project' })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const local = { ...composerSession(SID), workspacePath: '/b/project', label: 'Local fallback should not override real name', status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now }, semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now } }
  const tab = createWorkbenchTab('ordinary-tab', { regionId: 'ordinary-region', workspaceId: 'original-b-project', kind: 'agent', phase: 'attached', sessionId: SID })
  useAppStore.setState({ config, sessions: options.sourceOnly ? [] : [local], agentNames: { [SID]: localName }, timelines: { [SID]: timeline(SID, localRecap) }, tabs: { [tab.id]: tab }, layouts: { 'original-b-project': createWorkspaceLayout('ordinary-group', [tab.id]) },
    mainSurface: 'agents', focusView: 'list', loading: false, mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {}, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, scratchTopicSnapshots: {}, agentComposerDrafts: { [SID]: 'Keep this original local draft' } })
  const target = { hostId: 'source-route', reference: original.reference, zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  useAppStore.getState().mountSpace(target, false)
  const navigate = vi.fn()
  await dom.render(<MainFocusFixture navigate={navigate} />)
  const settle = async (count: number) => { await vi.waitFor(async () => { await act(async () => {}); expect(useAppStore.getState().mountedSpaceObservations[spaceMountKey(target.reference)]?.snapshot).toBeDefined(); const members = Object.keys(useAppStore.getState().mountedSpaceSessions[spaceMountKey(target.reference)]?.members ?? {}); if (options.unconfirmed) expect(members.length).toBeGreaterThan(0); else expect(members).toHaveLength(1); expect(cards()).toHaveLength(count) }, { timeout: 10000 }) }
  return { ...original, owner, session, admitted, main, config, target, key: spaceMountKey(target.reference), member, navigate, settle, local, sessionsRead, missingRead, beginOriginalCheck, finishOriginalCheck,
    emitMetadataError: () => { for (const listener of sessionListeners) listener({ type: 'error', error: { code: 'ORIGINAL_METADATA_READER_UNAVAILABLE', message: 'The original metadata stream is unavailable; the independent member remains healthy.' } }) } }
}
const cards = () => [...dom.container.querySelectorAll<HTMLButtonElement>('.focus-context[data-session-id]')]
const cardWith = (name: string) => { const card = cards().find(node => node.textContent?.includes(name)); expect(card, `Card carrying original task ${name}`).toBeDefined(); return card! }
async function query(text: string) {
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Search contexts"]')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })) })
}
async function openFilters() {
  const trigger = dom.container.querySelector<HTMLButtonElement>('[aria-label="Focus filters"]')!
  await act(async () => trigger.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' })))
  await vi.waitFor(() => expect(document.querySelector('.focus-filter-menu')).not.toBeNull())
}
async function chooseFilter(kind: 'project' | 'state' | 'type', text: string) {
  if (!document.querySelector('.focus-filter-menu')) await openFilters()
  let option: HTMLElement | undefined
  await vi.waitFor(async () => { await act(async () => {}); option = [...document.querySelectorAll<HTMLElement>(`.focus-filter-menu [data-focus-${kind}]`)].find(node => node.querySelector('.focus-filter-menu__name')?.textContent === text || node.getAttribute(`data-focus-${kind}`) === text); expect(option, `Actual ${kind} filter ${text}: ${document.querySelector('.focus-filter-menu')?.textContent}`).toBeDefined() })
  await act(async () => option!.click())
}

it('one real local task reached by ordinary and saved Source paths retains its Agent name, working state and original recap in one normal lane/card', async () => {
  const f = await fixture()
  await f.settle(1)
  const card = cardWith(localName)
  expect(card.textContent).toContain(localRecap)
  expect(card.dataset.bucket).toBe('working')
  expect(card.closest('.focus-project-lanes')).not.toBeNull()
  expect(dom.container.querySelector('[data-mounted-focus-source]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Original project Agents"]')).toBeNull()
  const source = await f.main.api.call('snapshot', { hostId: f.target.hostId, reference: f.reference })
  expect(source.scope.tabs.find(tab => tab.tabId === f.admitted.address.tabId)?.name).toBeNull()
  expect(source.scope.regions).toHaveLength(2)
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
})

it('different original Runtimes with the same raw SID remain separate ordinary cards and the foreign name never borrows local recap or control', async () => {
  const f = await fixture({ foreign: true })
  await f.settle(2)
  await vi.waitFor(async () => { await act(async () => {}); const texts = cards().map(node => node.textContent); if (!texts.some(text => text?.includes('真正远端的独立任务'))) throw Error('Original task cards: '+JSON.stringify(texts)) }, { timeout: 10000 })
  const remote = cardWith('真正远端的独立任务'), local = cardWith(localName)
  expect(remote).not.toBe(local)
  expect(remote.dataset.sessionId).not.toBe(SID)
  await vi.waitFor(async () => { await act(async () => {}); expect(cardWith('真正远端的独立任务').textContent).toContain(foreignRecap) })
  expect(remote.textContent).not.toContain(localRecap)
  expect(local.textContent).toContain(localRecap)
  expect(cardWith('真正远端的独立任务').closest('.focus-project-lanes')).not.toBeNull()
  expect(f.member).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ runtimeId: f.d.owner.runtimeId, agentSessionId: SID, regionId: f.admitted.address.regionId }) }), expect.any(Function), expect.anything())
  expect(dom.container.querySelector('[data-mounted-focus-source]')).toBeNull()
  expect(dom.container.querySelector('[aria-label="Original project Agents"]')).toBeNull()
})

it('an unavailable exact foreign Session remains an ordinary unknown card and is not classified as confirmed recovery', async () => {
  const f = await fixture({ foreign: true, unavailable: true })
  await f.settle(2)
  const remote = cards().find(node => node.dataset.sessionId !== SID)!
  expect(remote).toBeDefined()
  expect(remote.textContent).not.toContain(localName)
  expect(remote.dataset.bucket).toBe('idle')
  expect(remote.getAttribute('aria-label')).toMatch(/unknown|unconfirmed|unavailable|not arrived/i)
  await chooseFilter('state', 'recovery')
  await act(async () => { await vi.waitFor(() => expect(cards()).toHaveLength(0)) })
  await chooseFilter('state', 'all')
  await chooseFilter('state', 'unknown')
  await act(async () => { await vi.waitFor(() => expect(cards()).toHaveLength(1)) })
  expect(cards()[0]!.dataset.sessionId).not.toBe(SID)
})

it('an independent original name and bounded recap remain visible when Native observation is unavailable', async () => {
  const f = await fixture({ foreign: true, nativeUnavailable: true }); await f.settle(2)
  await vi.waitFor(() => expect(cards().find(card => card.dataset.sessionId !== SID)?.querySelector('strong')?.textContent).toBe('真正远端的独立任务'))
  const remote = cardWith('真正远端的独立任务')
  await vi.waitFor(() => expect(remote.querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  expect(remote.textContent).toMatch(/unknown|unavailable|unconfirmed/i)
  expect(remote.textContent).not.toContain(localRecap)
})

it('an existing Source-local legacy member keeps its full reader and direct original creation name without inventing a Region admission', async () => {
  const f = await fixture({ sourceOnly: true, legacyNoAdmission: true }); await f.settle(1)
  await vi.waitFor(() => expect(cardWith(localName).querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  expect(f.member).toHaveBeenCalled()
  expect(vi.mocked(api.spaceMounts.reading)).not.toHaveBeenCalled()
  expect(vi.mocked(api.spaceMounts.call).mock.calls.some(([method, input]) => method === 'agentNameInspect' &&
    (input as { name: { agentSessionId: string; createOperationId: string } }).name.agentSessionId === SID)).toBe(true)
  const snapshot = await f.main.api.call('snapshot', { hostId: f.target.hostId, reference: f.reference })
  const legacy = snapshot.scope.regions.find(region => region.regionId === 'original-legacy-region')
  expect(legacy).toMatchObject({ kind: 'agent', agentSessionId: SID })
  expect(legacy).not.toHaveProperty('creationOperationId')
  expect(await f.owner.core.readAgentSession(SID)).toMatchObject({ run: f.session.run, creation: { createOperationId: 'original-source-creation' } })
})

it('a cold unknown member reads its original name and bounded recap without a current Run or Native query', async () => {
  const f = await fixture({ foreign: true, nativeUnavailable: true, metadataUnknown: true }); await f.settle(2)
  await vi.waitFor(() => expect(cards().find(card => card.dataset.sessionId !== SID)?.querySelector('strong')?.textContent).toBe('真正远端的独立任务'))
  await vi.waitFor(() => expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  expect(f.owner.core.runtimeSubject, JSON.stringify({member:f.member.mock.calls.map(call=>call[0]), reading:vi.mocked(api.spaceMounts.reading).mock.calls.map(call=>call[0])})).not.toHaveBeenCalled()
  expect(f.member).not.toHaveBeenCalled()
  expect(vi.mocked(api.spaceMounts.reading).mock.calls[0]![0].target).not.toHaveProperty('expectedRun')
})

it('the same original name and recap survive unavailable metadata and reconnect without a replacement task', async () => {
  const f = await fixture({ foreign: true }); await f.settle(2)
  await vi.waitFor(() => expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  const identity = cardWith('真正远端的独立任务').dataset.sessionId
  await act(async () => f.owner.disconnect())
  await vi.waitFor(() => expect(Object.values(useAppStore.getState().mountedSpaceSessions[f.key]!.members)[0]?.state.status).toMatch(/unknown|unavailable/))
  const retained = cards().find(card => card.dataset.sessionId === identity)!
  expect(retained.querySelector('strong')?.textContent).toBe('真正远端的独立任务')
  expect(retained.querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap)
  expect(retained.textContent).toMatch(/unknown|unavailable|unconfirmed|ended/i)
  await act(async () => f.owner.reconnect())
  await vi.waitFor(() => expect(Object.values(useAppStore.getState().mountedSpaceSessions[f.key]!.members)[0]?.state.status).toBe('observed'), { timeout: 10000 })
  expect(cardWith('真正远端的独立任务').dataset.sessionId).toBe(identity)
  expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap)
  expect((await f.owner.core.readAgentSession(SID))!.run).toEqual(f.session.run)
})

it('a late original name read cannot overwrite a newer explicit rename during refresh', async () => {
  const f = await fixture({ foreign: true }); await f.settle(2)
  await vi.waitFor(() => expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  await act(async () => cardWith('真正远端的独立任务').dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await vi.waitFor(() => expect(agentInformationPreview.get()?.context.access?.rename).toBeDefined())
  const access = agentInformationPreview.get()!.context.access!, originalCall = vi.mocked(api.spaceMounts.call).getMockImplementation()!
  let release!: () => void, observed = false
  const pending = new Promise<void>(resolve => { release = resolve }); cleanup.push(() => release())
  vi.mocked(api.spaceMounts.call).mockImplementation(async (method, input, signal) => {
    const result = await originalCall(method, input as never, signal)
    if (method === 'memberNameInspect') { observed = true; await pending }
    return result as never
  })
  await act(async () => access.refresh())
  await vi.waitFor(() => expect(observed).toBe(true))
  await act(async () => { expect(await access.rename!('原任务的新名称', access.nameRevision!)).toBe(true) })
  await vi.waitFor(() => expect(cardWith('原任务的新名称').querySelector('strong')?.textContent).toBe('原任务的新名称'))
  await act(async () => release())
  expect(cardWith('原任务的新名称').querySelector('strong')?.textContent).toBe('原任务的新名称')
  expect(cardWith('原任务的新名称').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap)
})

it('legacy unknown original member remains identifiable without borrowing the same SID local Session', async () => {
  const f = await fixture({ unconfirmed: true }); await f.settle(3)
  const unknownId = JSON.stringify(['unconfirmed-region', f.reference, 'unknown-original-position'])
  const unknown = cards().find(node => node.dataset.sessionId === unknownId)!
  expect(unknown).toBeDefined()
  expect(unknown.textContent).toContain(`Agent · ${SID}`)
  expect(unknown.textContent).not.toContain(localName)
  expect(unknown.textContent).not.toContain(localRecap)
  expect(unknown.textContent).toContain('Position unknown-original-position')
  const otherId = JSON.stringify(['unconfirmed-region', f.reference, 'another-unknown-position'])
  expect(cards().find(node => node.dataset.sessionId === otherId)?.textContent).toContain('Position another-unknown-position')
  expect(unknown.getAttribute('aria-label')).toMatch(/unknown|unconfirmed|unavailable|not arrived/i)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
  expect((await f.b.spatial.read())!.graph.regions.find(region => region.regionId === 'unknown-original-position')).toMatchObject({ agentSessionId: SID, execution: null, runId: null })
})

it('project, type, state and text compose over the one real local task rather than keeping a bypass source list', async () => {
  const f = await fixture(); await f.settle(1)
  await chooseFilter('project', 'Ordinary analysis project')
  await chooseFilter('type', 'project')
  await chooseFilter('state', 'working')
  await query('核对分析')
  await act(async () => { await vi.waitFor(() => expect(cards()).toHaveLength(1)) })
  expect(cardWith(localName).textContent).toContain(localRecap)
  await query('a text that does not match either access route')
  await act(async () => { await vi.waitFor(() => expect(cards()).toHaveLength(0)) })
  expect(dom.container.textContent).not.toContain('Connected Space')
})

it('the ordinary foreign card opens its shared Reader and name menu against its original owner, then navigates the exact source Region', async () => {
  const f = await fixture({ foreign: true }); await f.settle(2)
  await vi.waitFor(async () => { await act(async () => {}); const texts = cards().map(node => node.textContent); if (!texts.some(text => text?.includes('真正远端的独立任务'))) throw Error('Original task cards: '+JSON.stringify(texts)) }, { timeout: 10000 })
  await vi.waitFor(async () => { await act(async () => {}); expect(cardWith('真正远端的独立任务').textContent).toContain(foreignRecap) })
  const remote = cardWith('真正远端的独立任务'), localRead = vi.spyOn(api.sessions, 'historyPage'), localRename = vi.spyOn(useAppStore.getState(), 'renameAgent')
  await act(async () => remote.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) }); await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.agent-information-reader')).not.toBeNull() })
  const reading = document.querySelector('.agent-information-reader')!
  expect(reading.textContent).toContain('真正远端的独立任务')
  expect(reading.textContent).not.toContain(localRecap)
  await vi.waitFor(async () => { await act(async () => {}); expect(reading.textContent).toContain('原远端自己的输入，不是同 SID 本机输入。') })
  expect(localRead).not.toHaveBeenCalled()
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await act(async () => remote.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 20, clientY: 20 })))
  await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull())
  const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('Rename Agent'))
  expect(rename).toBeDefined()
  await act(async () => rename!.click())
  const input = dom.container.querySelector<HTMLInputElement>('[aria-label="Rename Agent 真正远端的独立任务"]')!
  expect(input).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '重命名原远端任务'); input.dispatchEvent(new Event('input', { bubbles: true })) })
  await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
  await vi.waitFor(() => { const writes = vi.mocked(api.spaceMounts.call).mock.calls.filter(([method]) => method === 'memberNameChange'); expect(writes, 'The shared source menu reaches its exact original name writer').toHaveLength(1); expect(writes[0]![1]).toMatchObject({ name: { change: { name: '重命名原远端任务' } } }) })
  await vi.waitFor(async () => { await act(async () => {}); const currentName = await f.d.spatial.readDisplayLabel({ kind: 'agent-session', id: SID }); expect(currentName.label?.value, 'The original owner completed the requested name').toBe('重命名原远端任务') })
  await vi.waitFor(async () => { await act(async () => {}); expect(cards().map(node => node.textContent).join('\n')).toContain('重命名原远端任务') })
  expect(localRename).not.toHaveBeenCalled()
  expect(useAppStore.getState().agentNames[SID]).toBe(localName)
  const original = await f.main.api.call('memberNameInspect', { hostId: f.target.hostId, reference: f.reference, name: { object: 'agent', target: { reference: f.reference, regionId: f.admitted.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: SID, expectedAdmission: { kind: 'creation', operationId: 'original-source-creation' } } } })
  expect(original.current.override).toBe('重命名原远端任务')
  await act(async () => cardWith('重命名原远端任务').click())
  const state = useAppStore.getState(), selected = (state.mountedSpaceInputs as Record<string, { view?: unknown }>)[f.key]
  const workspaceId = originalSourceWorkspaceId(f.target), tabId = originalSourceTabProjectionId(f.target, f.admitted.address.tabId), regionId = originalSourceRegionProjectionId(f.target, f.admitted.address.regionId)
  expect(selected?.view).toBeUndefined()
  expect(state.mainSurface).toBe('agents')
  expect(state.workbenchSpaceSelection).toMatchObject({ spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, workspaceId, tabId, regionId })
  expect(state.layouts[workspaceId]).toBeDefined(); expect(state.tabs[tabId]?.layout.activeRegionId).toBe(regionId)
  expect(f.navigate).not.toHaveBeenCalled()
  expect(state.agentComposerDrafts[SID]).toBe('Keep this original local draft')
})


it('the ordinary source projection preserves the complete mixed Tab, narrows only with regionOnly and opens Space only through the explicit action', async () => {
  const f = await fixture({ foreign: true }); await f.settle(2)
  await vi.waitFor(async () => { await act(async () => {}); expect(cards().map(node => node.textContent).join('\n')).toContain('真正远端的独立任务') })
  await act(async () => cardWith('真正远端的独立任务').click())
  await vi.waitFor(async () => { await act(async () => {}); expect(dom.container.querySelectorAll('.global-session-workspace [data-source-region]')).toHaveLength(2) })
  expect(useAppStore.getState().mainSurface).toBe('agents')
  const before = useAppStore.getState(), originalInput = before.mountedSpaceInputs
  await dom.render(<MainFocusFixture navigate={f.navigate} regionOnly />)
  expect(dom.container.querySelectorAll('.global-session-workspace [data-source-region]')).toHaveLength(1)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(originalInput)
  await dom.render(<MainFocusFixture navigate={f.navigate} />)
  expect(dom.container.querySelectorAll('.global-session-workspace [data-source-region]')).toHaveLength(2)
  await act(async () => cardWith('真正远端的独立任务').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
  const view = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('View in Space'))
  expect(view).toBeDefined()
  await act(async () => view!.click())
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, workspaceId: originalSourceWorkspaceId(f.target) })
  expect(useAppStore.getState().agentComposerDrafts).toBe(before.agentComposerDrafts)
  expect((await f.b.spatial.read())!.graph.regions).toHaveLength(2)
})

it('several original positions are one Context and primary selection asks for an exact workface without choosing the first', async () => {
  const f = await fixture({ foreign: true, multiple: true }); await f.settle(2)
  // The extra retained position has no creation admission. Its metadata may be
  // unavailable; the original identity and both positions must still be selectable.
  const sourceCard = cards().find(card => card.dataset.sessionId !== SID)!
  expect(sourceCard).toBeDefined()
  await act(async () => sourceCard.click())
  const choices = dom.container.querySelector('[aria-label="Choose original workface"]')!
  expect(choices).not.toBeNull()
  const buttons = [...choices.querySelectorAll<HTMLButtonElement>('.focus-location-choice')]
  expect(buttons).toHaveLength(2)
  expect(useAppStore.getState().workbenchSpaceSelection).toBeNull()
  expect(dom.container.querySelector('.global-session-workspace [data-focus-tab-id]')).toBeNull()
  const requested = buttons.find(node => node.textContent?.includes('another-original-position'))!
  expect(requested).toBeDefined()
  await act(async () => requested.click())
  const state = useAppStore.getState(), workspaceId = originalSourceWorkspaceId(f.target), tabId = originalSourceTabProjectionId(f.target, f.admitted.address.tabId), regionId = originalSourceRegionProjectionId(f.target, 'another-original-position')
  expect((state.mountedSpaceInputs as Record<string, { view?: unknown }>)[f.key]?.view).toBeUndefined()
  expect(state.mainSurface).toBe('agents')
  expect(state.workbenchSpaceSelection).toMatchObject({ spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, workspaceId, tabId, regionId })
  expect(state.layouts[workspaceId]).toBeDefined(); expect(state.tabs[tabId]?.layout.activeRegionId).toBe(regionId)
  expect(cards()).toHaveLength(2)
})


it('a foreign task uses the same durable bookmark and execution-history owners while keeping original source identity', async () => {
  const f = await fixture({ foreign: true }); await f.settle(2)
  await vi.waitFor(async () => { await act(async () => {}); expect(cardWith('真正远端的独立任务').textContent).toContain(foreignRecap) })
  cleanup.push(async () => { for (const bookmark of agentBookmarks.get().bookmarks) agentBookmarks.remove(bookmark.key); await agentBookmarks.flush() })
  const remote = cardWith('真正远端的独立任务')
  await act(async () => remote.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  await vi.waitFor(async () => { await act(async () => {}); expect(document.querySelector('.agent-information-reader')).not.toBeNull() })
  const reader = document.querySelector<HTMLElement>('.agent-information-reader')!
  expect(reader.dataset.dragToPin).toBe('true')
  const originalBounds = { x: 24, y: 72, width: 460, height: 600 }
  // The actual Reader's shared promotion handler is also used by title drag.
  let promotion: ReturnType<typeof agentInformationPreview.ensurePinned>
  await act(async () => { promotion = agentInformationPreview.ensurePinned(agentInformationPreview.get()!.token, originalBounds) })
  expect(promotion!).toBeDefined()
  expect(reader.dataset.pinned).toBe('true')
  const bookmark = agentBookmarks.get().bookmarks.find(item => item.key === promotion!.key)!
  expect(bookmark).toMatchObject({ sourceRuntimeId: f.d.owner.runtimeId, agentSessionId: SID, presentationId: remote.dataset.sessionId, label: '真正远端的独立任务', excerpt: foreignRecap, bounds: originalBounds })
  expect(agentInformationPreview.get()!.control).toBeUndefined()
  await act(async () => remote.click())
  const focus = useAppStore.getState().agentFocus.execution
  expect(focus.sessionId).toBe(remote.dataset.sessionId)
  expect(focus.history[0]?.identity?.source).toEqual({ runtimeId: f.d.owner.runtimeId, agentSessionId: SID })
  expect(focus.history[0]?.identity?.project?.id).toBe('original-b-project')
  expect(dom.container.querySelector(`[data-saved-focus-session='${remote.dataset.sessionId}']`)).toBeNull()
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(useAppStore.getState().sessions[0]!.id).toBe(SID)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
  const originalAccess = agentInformationPreview.get()!.context.access!
  await act(async () => {
    useAppStore.setState({ mountedSpaceInputs: {} })
    originalAccess.select()
  })
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.target.reference.spaceId, zoneId: f.target.zoneId, workspaceId: originalSourceWorkspaceId(f.target) })
  expect(useAppStore.persist.getOptions().partialize!(useAppStore.getState())).not.toHaveProperty('selectedSpaceMount')
  expect(useAppStore.getState().agentFocus.execution).toBe(focus)
})


it('an original missing Session opens the common parked stage and rechecks the same original into pending then observed without losing work or sending input', async () => {
  const f = await fixture({ foreign: true, missing: true }); await f.settle(2)
  const remote = cards().find(node => node.dataset.sessionId !== SID)!
  await vi.waitFor(() => {
    const facts = Object.values(useAppStore.getState().mountedSpaceSessions[f.key]!.members)
    expect(facts).toHaveLength(1); expect(facts[0]!.state).toMatchObject({ status: 'missing', authority: { runtimeId: f.d.owner.runtimeId } })
  })
  const originalSpatial = await f.b.spatial.read(), originalRun = f.session.run
  const sideEffects = [f.b, f.d].flatMap(owner => (['createAgent', 'resumeAgent', 'restartAgent', 'reopenAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt'] as const).map(method => vi.spyOn(owner.core, method)))
  await act(async () => remote.click())
  expect(useAppStore.getState().mainSurface).toBe('agents')
  const region = () => dom.container.querySelector<HTMLElement>(`.global-session-workspace [data-source-region]`)!
  const stage = () => region().querySelector<HTMLElement>('.full-page-loading')!
  await vi.waitFor(() => { expect(stage()).not.toBeNull(); expect(stage().dataset.loadingPhase).toBe('parked') })
  expect(stage().textContent).toContain('Original session unavailable')
  expect(stage().getAttribute('aria-busy')).toBe('false')
  expect(region().textContent).not.toMatch(/Restoring your session|Waiting for this session to reconnect/)
  const composerSelector = '[data-agent-composer="true"] [aria-label="Message Agent"]'
  const draft = () => region().querySelector<HTMLElement & { editor?: import('@tiptap/core').Editor }>(composerSelector)!
  await vi.waitFor(() => expect(draft()?.editor, 'Unconfirmed Native observation still uses the common draft editor.').toBeDefined())
  const heldDraft = `原设备未发送的草稿
必须逐字保留，也不自动补发。`
  await act(async () => {
    draft().editor!.commands.setContent({ type: 'doc', content: heldDraft.split('\n').map(line => ({ type: 'paragraph', content: [{ type: 'text', text: line }] })) })
  })
  expect(draft().editor!.getText({ blockSeparator: '\n' })).toBe(heldDraft)
  const before = f.sessionsRead.mock.calls.length
  f.beginOriginalCheck()
  const check = [...region().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Check again'))!
  expect(check).toBeDefined()
  await act(async () => check.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(f.sessionsRead.mock.calls.length).toBeGreaterThan(before); expect(stage().dataset.loadingPhase).toBe('loading') })
  expect(stage().getAttribute('aria-busy')).toBe('true')
  expect(stage().textContent).toContain('Checking the original session')
  expect(draft().editor!.getText({ blockSeparator: '\n' })).toBe(heldDraft)
  expect(useAppStore.getState().sessions).toHaveLength(1)
  await act(async () => f.emitMetadataError())
  expect(stage().dataset.loadingPhase).toBe('parked')
  expect(stage().getAttribute('aria-busy')).toBe('false')
  expect(stage().textContent).toContain('Session connection unconfirmed')
  const failedCheckCount = f.sessionsRead.mock.calls.length
  const retry = [...region().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Check again'))!
  await act(async () => retry.click())
  await vi.waitFor(async () => { await act(async () => {}); expect(f.sessionsRead.mock.calls.length).toBeGreaterThan(failedCheckCount); expect(stage().dataset.loadingPhase).toBe('loading') })
  await act(async () => f.finishOriginalCheck())
  await vi.waitFor(async () => { await act(async () => {}); expect(region().querySelector('[data-fixture-original-terminal]')).not.toBeNull() }, { timeout: 10000 })
  expect(region().querySelector('.full-page-loading')).toBeNull()
  expect(f.member).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ runtimeId: f.d.owner.runtimeId, agentSessionId: SID, expectedRun: originalRun }) }), expect.any(Function), expect.anything())
  const terminal = region().querySelector<HTMLElement>('[data-fixture-original-terminal]')!
  expect(terminal.dataset.nativeRun).toBe(originalRun.runId)
  // Metadata transport is an independent IO leaf. Its failure cannot revoke the
  // already-confirmed member read, terminal or original input workface.
  await act(async () => f.emitMetadataError())
  expect(region().querySelector('[data-fixture-original-terminal]')).toBe(terminal)
  expect(region().querySelector('.full-page-loading')).toBeNull()
  const originalDraftKey = mountedRegionKey(f.target.reference, f.admitted.address.tabId, f.admitted.address.regionId)
  const ownerKey = originalSourceInputOwnerKey(f.d.owner.runtimeId, SID), legacyDraft = 'Legacy Mounted bytes must remain opaque'
  await act(async () => useAppStore.setState(state => { const entries = state.mountedSpaceInputs as Record<string, { drafts: Record<string, string> }>; return { mountedSpaceInputs: { ...entries, [f.key]: { ...entries[f.key], drafts: { ...entries[f.key]!.drafts, [originalDraftKey]: legacyDraft } } } } }))
  const mountedBefore = structuredClone(useAppStore.getState().mountedSpaceInputs), canonicalBefore = structuredClone(useAppStore.getState().agentComposerDrafts)
  expect(mountedSpaceInput(useAppStore.getState().mountedSpaceInputs, f.key)!.drafts[originalDraftKey]).toBe(legacyDraft)
  const composer = region().querySelector<HTMLElement & { editor?: import('@tiptap/core').Editor }>(composerSelector)
  await vi.waitFor(() => {
    const field = region().querySelector<HTMLElement & { editor?: import('@tiptap/core').Editor }>(composerSelector)
    expect(field?.editor, 'The recovered original Session must mount the shared Message Tool').toBeDefined()
    expect(field!.editor!.getText({ blockSeparator: '\n' })).toBe(heldDraft)
  })
  const nextDraft = heldDraft + '\n恢复后继续编辑，仍只写 canonical owner。'
  await act(async () => composer!.editor!.commands.setContent({ type: 'doc', content: nextDraft.split('\n').map(line => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })) }))
  expect(useAppStore.getState().agentComposerDrafts).toEqual({ ...canonicalBefore, [ownerKey]: nextDraft })
  expect(useAppStore.getState().mountedSpaceInputs).toEqual(mountedBefore)
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
  expect((await f.b.spatial.read())!.graph).toEqual(originalSpatial!.graph)
  expect((await f.d.core.readAgentSession(SID))!.run).toEqual(originalRun)
  for (const effect of sideEffects) expect(effect).not.toHaveBeenCalled()
})


async function savedSourceVisit(f: Awaited<ReturnType<typeof fixture>>) {
  await f.settle(2)
  await vi.waitFor(() => expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  const remote = cardWith('真正远端的独立任务'), contextId = remote.dataset.sessionId!
  await act(async () => remote.click())
  const saved = useAppStore.persist.getOptions().partialize!(useAppStore.getState())
  const restored = restoreAgentFocus(JSON.parse(JSON.stringify(saved.agentFocus)))
  expect(restored.execution.history[0]?.identity).toMatchObject({ name: '真正远端的独立任务', source: { runtimeId: f.d.owner.runtimeId, agentSessionId: SID } })
  await dom.render(null)
  return { contextId, restored }
}
function unavailableOriginalSourceReaders() {
  const originalCall = vi.mocked(api.spaceMounts.call).getMockImplementation()!
  vi.mocked(api.spaceMounts.call).mockImplementation((method, input, signal) => {
    if (method === 'memberNameInspect') return Promise.reject(Error('The original name reader is unavailable.'))
    return originalCall(method, input as never, signal)
  })
  vi.mocked(api.spaceMounts.reading).mockRejectedValue(Error('The original conversation reader is unavailable.'))
  vi.mocked(api.spaceMounts.member).mockRejectedValue(Error('The original Native observation is unavailable.'))
}

it('a restored exact Source visit keeps its original name while the original readers are unavailable', async () => {
  const f = await fixture({ foreign: true }), { contextId, restored } = await savedSourceVisit(f)
  const effects = [f.b, f.d].flatMap(source => (['createAgent', 'resumeAgent', 'restartAgent', 'reopenAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt'] as const).map(method => vi.spyOn(source.core, method)))
  unavailableOriginalSourceReaders()
  await act(async () => useAppStore.setState({ agentFocus: restored }))
  await dom.render(<MainFocusFixture navigate={f.navigate} />); await f.settle(2)
  await vi.waitFor(() => expect(cards().find(card => card.dataset.sessionId === contextId)?.textContent).toContain('The original name reader is unavailable.'))
  const retained = cards().find(card => card.dataset.sessionId === contextId)!
  expect(retained.querySelector('strong')?.textContent, 'The existing persisted exact Runtime/SID visit is a display source even before the original name can be read again.').toBe('真正远端的独立任务')
  expect(retained.textContent).not.toContain(localName)
  expect(retained.textContent).not.toContain(localRecap)
  expect(retained.querySelector('.focus-context__recap')).toBeNull()
  expect(useAppStore.getState().agentFocus).toEqual(restored)
  expect((await f.owner.core.readAgentSession(SID))!.run).toEqual(f.session.run)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
  for (const effect of effects) expect(effect).not.toHaveBeenCalled()
})

it.each(['another-runtime', null] as const)('a saved same-SID visit with Runtime %s cannot name the current original Source', async runtimeId => {
  const f = await fixture({ foreign: true }), { contextId, restored } = await savedSourceVisit(f)
  const identity = restored.execution.history[0]!.identity!
  restored.execution.history[0] = { ...restored.execution.history[0]!, identity: { ...identity, source: { runtimeId, agentSessionId: SID } } }
  unavailableOriginalSourceReaders()
  await act(async () => useAppStore.setState({ agentFocus: restored }))
  await dom.render(<MainFocusFixture navigate={f.navigate} />); await f.settle(2)
  await vi.waitFor(() => expect(cards().find(card => card.dataset.sessionId === contextId)?.textContent).toContain('The original name reader is unavailable.'))
  const remote = cards().find(card => card.dataset.sessionId === contextId)!
  expect(remote.querySelector('strong')?.textContent).toBe(`Agent · ${SID}`)
  expect(remote.textContent).not.toContain('真正远端的独立任务')
  expect(remote.textContent).not.toContain(localName)
  expect(remote.textContent).not.toContain(localRecap)
})

it('a fresh original name reply supersedes the restored visit name', async () => {
  const f = await fixture({ foreign: true }), { contextId, restored } = await savedSourceVisit(f)
  await f.main.api.call('memberNameChange', { hostId: f.target.hostId, reference: f.reference, name: { object: 'agent', target: { reference: f.reference, regionId: f.admitted.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: SID, expectedAdmission: { kind: 'creation', operationId: 'original-source-creation' } }, change: { kind: 'rename', operationId: 'updated-source-name', name: '原端已确认的新名称', expectedNameRevision: 1, source: 'manual' } } })
  await act(async () => useAppStore.setState({ agentFocus: restored }))
  await dom.render(<MainFocusFixture navigate={f.navigate} />); await f.settle(2)
  await vi.waitFor(() => expect(cards().find(card => card.dataset.sessionId === contextId)?.querySelector('strong')?.textContent).toBe('原端已确认的新名称'))
  expect(restored.execution.history[0]!.identity!.name).toBe('真正远端的独立任务')
})

it('an explicit original name clear does not resurrect the restored manual visit name', async () => {
  const f = await fixture({ foreign: true }), { contextId, restored } = await savedSourceVisit(f)
  await f.main.api.call('memberNameChange', { hostId: f.target.hostId, reference: f.reference, name: { object: 'agent', target: { reference: f.reference, regionId: f.admitted.address.regionId, runtimeId: f.d.owner.runtimeId, agentSessionId: SID, expectedAdmission: { kind: 'creation', operationId: 'original-source-creation' } }, change: { kind: 'rename', operationId: 'clear-source-name', name: null, expectedNameRevision: 1, source: 'manual' } } })
  await act(async () => useAppStore.setState({ agentFocus: restored }))
  await dom.render(<MainFocusFixture navigate={f.navigate} />); await f.settle(2)
  await vi.waitFor(() => expect(cards().find(card => card.dataset.sessionId === contextId)?.querySelector('strong')?.textContent).toContain('原远端自己的输入'))
  expect(cards().find(card => card.dataset.sessionId === contextId)?.querySelector('strong')?.textContent).not.toBe('真正远端的独立任务')
  expect(restored.execution.history[0]!.identity!.name).toBe('真正远端的独立任务')
})

it.each([false, true])('the selected original workface reads its real conversation without Native readiness or a current Run, using the shared qualified mode and draft (unobserved Run: %s)', async unobservedRun => {
  const f = await fixture({ foreign: true, nativeUnavailable: true, metadataUnknown: true, staleRun: !unobservedRun, unobservedRun })
  await f.settle(2)
  await vi.waitFor(() => expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  const owner = originalSourceInputOwnerKey(f.d.owner.runtimeId, SID), draft = 'Original Source conversation draft remains unsent'
  const effects = [f.b, f.d].flatMap(source => (['createAgent', 'resumeAgent', 'restartAgent', 'reopenAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt'] as const).map(method => vi.spyOn(source.core, method)))
  const spatial = await f.b.spatial.read()
  await act(async () => {
    useAppStore.getState().setAgentComposerDraft(owner, draft)
    useAppStore.getState().setViewMode(owner, 'activity', { focus: false })
    cardWith('真正远端的独立任务').click()
  })
  const workface = () => dom.container.querySelector<HTMLElement>('.global-session-workspace [aria-label="Original member workface"]')!
  await vi.waitFor(() => expect(workface(), dom.container.querySelector('.global-session-workspace')?.textContent).not.toBeNull())
  const reading = () => workface().querySelector<HTMLElement>('.activity-feed')
  await vi.waitFor(() => {
    expect(reading(), 'A real selected original conversation must mount without a Native Session or current Run.').not.toBeNull()
    expect(reading()!.textContent).toContain(foreignRecap)
    expect(reading()!.textContent).toContain('原远端自己的输入，不是同 SID 本机输入。')
  }, { timeout: 10000 })
  const body = reading(), focus = useAppStore.getState().agentFocus
  expect(body!.textContent).not.toContain(localRecap)
  expect(workface().dataset.agentSurfaceMode).toBe('activity')
  expect(vi.mocked(api.spaceMounts.reading).mock.calls.some(([target]) =>
    target.target.runtimeId === f.d.owner.runtimeId && target.target.agentSessionId === SID &&
    target.target.expectedAdmission.operationId === 'original-source-creation' && !('expectedRun' in target.target))).toBe(true)
  const terminal = () => workface().querySelector<HTMLButtonElement>('[aria-label="Show Terminal"]')
  await vi.waitFor(() => expect(terminal()).not.toBeNull())
  await act(async () => terminal()!.click())
  expect(workface().dataset.agentSurfaceMode).toBe('terminal')
  expect(useAppStore.getState().viewModes[owner]).toBe('terminal')
  expect(useAppStore.getState().agentFocus).toBe(focus)
  const conversation = () => workface().querySelector<HTMLButtonElement>('[aria-label="Show Activity"]')
  await vi.waitFor(() => expect(conversation()).not.toBeNull())
  await act(async () => conversation()!.click())
  expect(workface().dataset.agentSurfaceMode).toBe('activity')
  expect(reading()).toBe(body)
  expect(useAppStore.getState().agentFocus).toBe(focus)
  expect(useAppStore.getState().agentComposerDrafts[owner]).toBe(draft)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
  expect(useAppStore.getState().viewModes[SID]).toBeUndefined()
  expect((await f.b.spatial.read())!.graph).toEqual(spatial!.graph)
  expect((await f.d.core.readAgentSession(SID))!.run).toEqual(f.session.run)
  // A newer Run witness only replaces the Native reader, never this original
  // admitted conversation's React instance or its saved reading preference.
  await act(async () => {
    const current = (await f.b.spatial.read())!
    await f.b.spatial.commit({ expectedRevision: current.revision, graph: { ...current.graph,
      regions: current.graph.regions.map(region => region.regionId === f.admitted.address.regionId ? { ...region, runId: f.session.run.runId } : region) } })
    const snapshot = await f.main.api.call('snapshot', { hostId: f.target.hostId, reference: f.reference })
    useAppStore.getState().observeSpaceMount(f.target, { snapshot, reading: false })
  })
  // Restore this metadata edge to its real Core reader, rather than handing
  // the Renderer a guessed Session. Its observed Run must reach the Native target.
  vi.mocked(api.spaceMounts.sessions).mockImplementation(f.main.api.sessions)
  const refresh = () => [...workface().querySelectorAll<HTMLButtonElement>('button')].find(button =>
    ['Check again', 'Check original status', 'Refresh member observation'].includes(button.textContent ?? ''))
  await vi.waitFor(() => expect(refresh()).toBeDefined())
  await act(async () => refresh()!.click())
  await vi.waitFor(() => expect(f.member.mock.calls.some(([target]) => target.target.expectedRun.runId === f.session.run.runId)).toBe(true))
  await vi.waitFor(() => expect(reading()).toBe(body))
  await act(async () => useAppStore.getState().setMainSurface('board'))
  await act(async () => useAppStore.getState().setMainSurface('agents'))
  await vi.waitFor(() => {
    expect(reading()).toBe(body)
    expect(reading()!.textContent).toContain(foreignRecap)
  })
  expect(useAppStore.getState().viewModes[owner]).toBe('activity')
  expect(useAppStore.getState().agentComposerDrafts[owner]).toBe(draft)
  // A later reader observation failure keeps already accepted original records
  // visible and gives an explicit retry, independent of Native recovery.
  const originalReader = vi.mocked(api.spaceMounts.reading).mock.calls.filter(([target]) =>
    target.target.runtimeId === f.d.owner.runtimeId && target.target.agentSessionId === SID).at(-1)!
  await act(async () => originalReader[1]({ type: 'observation-error', error: { code: 'SOURCE_OBSERVATION_UNAVAILABLE', message: 'The original reading connection is temporarily unavailable.' } }))
  expect(reading()).toBe(body)
  expect(reading()!.textContent).toContain(foreignRecap)
  expect(workface().textContent).toContain('The original reading connection is temporarily unavailable.')
  const retry = [...workface().querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry original reading')!
  await act(async () => retry.click())
  await vi.waitFor(() => expect(workface().textContent).not.toContain('The original reading connection is temporarily unavailable.'))
  expect(reading()).toBe(body)
  for (const effect of effects) expect(effect).not.toHaveBeenCalled()
})

it('the selected original conversation refuses a different admission without borrowing the namesake local records', async () => {
  const f = await fixture({ foreign: true, nativeUnavailable: true, metadataUnknown: true })
  await f.settle(2)
  await vi.waitFor(() => expect(cardWith('真正远端的独立任务').querySelector('.focus-context__recap')?.textContent).toContain(foreignRecap))
  vi.mocked(api.spaceMounts.reading).mockImplementation((input, listener, signal) => f.main.api.reading({ ...input,
    target: { ...input.target, expectedAdmission: { kind: 'creation', operationId: 'another-creation-is-not-this-Agent' } } }, listener, signal))
  const owner = originalSourceInputOwnerKey(f.d.owner.runtimeId, SID)
  await act(async () => {
    useAppStore.getState().setViewMode(owner, 'activity', { focus: false })
    cardWith('真正远端的独立任务').click()
  })
  const body = () => dom.container.querySelector('.global-session-workspace .activity-feed')
  await vi.waitFor(() => expect(body()?.textContent).toContain('The original member creation or association changed.'))
  expect(body()!.textContent).not.toContain(localRecap)
  expect(body()!.textContent).not.toContain(foreignRecap)
  expect(body()!.querySelector('button')).not.toBeNull()
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect((await f.d.core.readAgentSession(SID))!.run).toEqual(f.session.run)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
})

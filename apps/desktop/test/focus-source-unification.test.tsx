// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
// Native terminal/PTY painting is the only product leaf replaced in this scene.
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import type { AgentMuxStoredAgentSession, AgentTimelineSnapshot } from '@agentmux/core'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { api } from '../src/renderer/src/lib/api'
import { agentBookmarks } from '../src/renderer/src/lib/agent-bookmarks'
import { agentInformationPreview } from '../src/renderer/src/lib/agent-information-preview'
import { useAppStore } from '../src/renderer/src/store'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { createWorkspaceLayout, splitWorkbenchRegion } from '@agentmux/layout'
import { spaceMountKey } from '../src/shared/space-mount'
import { DEFAULT_CONFIG } from '../src/main/config-store'
import { composerDOM, composerSession } from './helpers/composer-dom-fixture'
import { spaceMountTransport } from './helpers/space-mount-fixture'

const dom = composerDOM({ agentInformation: true }), cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
const foreignRecap = '原远端自己的非空分析结论，沿原 Provider 和有界阅读载体消费。'
const SID = 'same-original-sid', localName = '原本机任务：核对分析结果', localRecap = '原本机已经核对的业务结论，不能借给另一个 Runtime。'
const timeline = (sid: string, text: string): AgentTimelineSnapshot => ({ agentSessionId: sid, revision: 1, items: [{ id: 'original-answer', agentSessionId: sid, kind: 'assistant_message', title: 'Original answer', source: 'native-hook', status: 'complete', content: text, createdAt: 1, updatedAt: 1 }] })

/** Real original Core/Space and scoped Unix→Main→IPC→Preload→Renderer.
 * Native process state is the existing source fixture leaf. No unified hook,
 * Context, lane, card, filter, menu or preview implementation is mocked. */
async function fixture(options: { foreign?: boolean; unavailable?: boolean; multiple?: boolean } = {}) {
  const original = await createSpaceSessionsFixture(cleanup)
  for (const source of [original.b, original.d]) source.core.providers.register(new AgentProviderRegistry().get('codex'))
  const physicalReads: Promise<unknown>[] = []
  for (const source of [original.b, original.d]) {
    const read = source.core.readSessionHistoryPage.bind(source.core)
    vi.spyOn(source.core, 'readSessionHistoryPage').mockImplementation((...args) => { const pending = read(...args); physicalReads.push(pending); return pending })
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
  const { creationOperationId: _creation, ...retainedRegion } = originalRegion
  const secondRegion = options.multiple ? { ...retainedRegion, regionId: 'another-original-position' }
    : { regionId: 'original-browser-position', tabId: originalTab.tabId, kind: 'browser' as const, agentSessionId: null, runId: null, execution: null }
  // Seed the complete original owner's business graph and private split together;
  // Source business apply intentionally does not carry another client's layout.
  const originalLayout = sourceDocument.graph.tabLayouts[originalTab.tabId]!
  await original.b.spatial.commit({ expectedRevision: sourceDocument.revision, graph: { ...sourceDocument.graph,
    tabs: sourceDocument.graph.tabs.map(tab => tab.tabId === originalTab.tabId ? { ...tab, regionIds: [...tab.regionIds, secondRegion.regionId] } : tab),
    regions: [...sourceDocument.graph.regions, secondRegion],
    tabLayouts: { ...sourceDocument.graph.tabLayouts, [originalTab.tabId]: splitWorkbenchRegion(originalLayout, originalLayout.activeRegionId, 'right', secondRegion.regionId) } } })
  const nameTarget = { reference: original.reference, regionId: admitted.address.regionId, runtimeId: owner.owner.runtimeId, agentSessionId: SID, expectedAdmission: { kind: 'creation' as const, operationId: creationId } }
  await main.api.call('memberNameChange', { hostId: 'source-route', reference: original.reference, name: { object: 'agent', target: nameTarget, change: { kind: 'rename', operationId: 'source-name-operation', name: options.foreign ? '真正远端的独立任务' : localName, expectedNameRevision: 0, source: 'manual' } } })
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
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  const member = vi.spyOn(api.spaceMounts, 'member').mockImplementation(async (input, listener, signal) => { const surface = await main.api.member(input, listener, signal); cleanup.push(() => surface.dispose()); return surface })
  if (options.unavailable) vi.spyOn(owner.core, 'readAgentSession').mockRejectedValue(Error('Exact original Session observation unavailable'))
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: '/b/project' })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const local = { ...composerSession(SID), workspacePath: '/b/project', label: 'Local fallback should not override real name', status: { state: 'working' as const, source: 'native-hook' as const, observedAt: now }, semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: now, stateEnteredAt: now } }
  const tab = createWorkbenchTab('ordinary-tab', { regionId: 'ordinary-region', workspaceId: 'original-b-project', kind: 'agent', phase: 'attached', sessionId: SID })
  useAppStore.setState({ config, sessions: [local], agentNames: { [SID]: localName }, timelines: { [SID]: timeline(SID, localRecap) }, tabs: { [tab.id]: tab }, layouts: { 'original-b-project': createWorkspaceLayout('ordinary-group', [tab.id]) },
    mainSurface: 'agents', focusView: 'list', loading: false, mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {}, selectedSpaceMount: null, agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, scratchTopicSnapshots: {}, agentComposerDrafts: { [SID]: 'Keep this original local draft' } })
  const target = { hostId: 'source-route', reference: original.reference, zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  useAppStore.getState().mountSpace(target, false)
  const navigate = vi.fn()
  await dom.render(<GlobalFocusSurface workspaceOpen={false} onSelectContext={navigate} />)
  const settle = async (count: number) => { await vi.waitFor(async () => { await act(async () => {}); expect(useAppStore.getState().mountedSpaceObservations[spaceMountKey(target.reference)]?.snapshot).toBeDefined(); expect(Object.keys(useAppStore.getState().mountedSpaceSessions[spaceMountKey(target.reference)]?.members ?? {})).toHaveLength(1); expect(cards()).toHaveLength(count) }, { timeout: 10000 }) }
  return { ...original, owner, session, admitted, main, config, target, key: spaceMountKey(target.reference), member, navigate, settle, local }
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
  expect(remote.closest('.focus-project-lanes')).not.toBeNull()
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
  const state = useAppStore.getState(), selected = (state.mountedSpaceInputs as Record<string, { view?: { selection: unknown } }>)[f.key]
  expect(state.mainSurface).toBe('agents')
  expect(dom.container.querySelector('.global-session-workspace [data-focus-tab-id]')?.getAttribute('data-focus-tab-id')).toBe(f.admitted.address.tabId)
  expect(dom.container.querySelectorAll('.global-session-workspace [data-source-region]')).toHaveLength(2)
  expect(state.selectedSpaceMount).toBe(f.key)
  expect(selected?.view?.selection).toMatchObject({ tabId: f.admitted.address.tabId, regionId: f.admitted.address.regionId })
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
  await dom.render(<GlobalFocusSurface workspaceOpen={false} onSelectContext={f.navigate} regionOnly />)
  expect(dom.container.querySelectorAll('.global-session-workspace [data-source-region]')).toHaveLength(1)
  expect(useAppStore.getState().mountedSpaceInputs).toBe(originalInput)
  await dom.render(<GlobalFocusSurface workspaceOpen={false} onSelectContext={f.navigate} />)
  expect(dom.container.querySelectorAll('.global-session-workspace [data-source-region]')).toHaveLength(2)
  await act(async () => cardWith('真正远端的独立任务').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 })))
  const view = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.includes('View in Space'))
  expect(view).toBeDefined()
  await act(async () => view!.click())
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().selectedSpaceMount).toBe(f.key)
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
  expect(useAppStore.getState().selectedSpaceMount).toBeNull()
  expect(dom.container.querySelector('.global-session-workspace [data-focus-tab-id]')).toBeNull()
  const requested = buttons.find(node => node.textContent?.includes('another-original-position'))!
  expect(requested).toBeDefined()
  await act(async () => requested.click())
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().selectedSpaceMount).toBe(f.key)
  expect((useAppStore.getState().mountedSpaceInputs as Record<string, { view: { selection: { regionId: string } } }>)[f.key]!.view.selection.regionId).toBe('another-original-position')
  expect(dom.container.querySelector('.global-session-workspace [data-focus-tab-id]')?.getAttribute('data-focus-tab-id')).toBe(f.admitted.address.tabId)
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
  expect(useAppStore.getState().sessions).toHaveLength(1)
  expect(useAppStore.getState().sessions[0]!.id).toBe(SID)
  expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep this original local draft')
  const originalAccess = agentInformationPreview.get()!.context.access!
  await act(async () => {
    useAppStore.setState({ selectedSpaceMount: null, mountedSpaceInputs: {} })
    originalAccess.select()
  })
  expect(useAppStore.getState().mainSurface).toBe('agents')
  expect(useAppStore.getState().selectedSpaceMount).toBeNull()
  expect(useAppStore.getState().agentFocus.execution).toBe(focus)
})

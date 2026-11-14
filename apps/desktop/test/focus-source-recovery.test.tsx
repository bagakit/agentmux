// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendFile, rm, writeFile } from 'node:fs/promises'
import { fixtureIso, fixturePath } from '../scripts/lib/fixture-values.mjs'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
import { createSpaceSessionsFixture } from '../../../packages/core/test/helpers/space-session-fixture'
import { AgentProviderRegistry } from '../../../packages/core/src/agent-provider'
import type { AgentMuxStoredAgentSession } from '../../../packages/core/src/types'
import type { AgentMuxAgentSessionRegistry } from '../../../packages/core/src/agent-session-registry'
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
const SID = 'original-recovery-agent', originalName = 'Original source task', originalText = 'The original source result remains selected and readable.'
const replacementText = 'A later source result stays behind Show latest.'
afterEach(async () => {
  await dom.render(null)
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})
const cards = () => [...dom.container.querySelectorAll<HTMLElement>('.focus-context[data-session-id]')]
const menu = () => document.querySelector<HTMLElement>('.focus-context-menu[role="menu"]')!
const menuItem = (label: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === label)!

/** Real original Core → public Unix RPC → Main/IPC/preload → Global Focus.
 * Native process observation remains the existing private fixture leaf. */
async function fixture(options: { identityUnknown?: boolean } = {}) {
  const disposers: Array<() => unknown | Promise<unknown>> = []
  const path = fixturePath('recovery-project'), f = await createSpaceSessionsFixture(disposers, path)
  for (const owner of [f.b, f.d]) owner.core.providers.register(new AgentProviderRegistry().get('codex'))
  const privateRoots = new Set([f.b.root, f.d.root])
  cleanup.push(...disposers.map(dispose => async () => {
    try { await dispose() } catch (cause) {
      const error = cause as NodeJS.ErrnoException
      if (error.code !== 'ENOTEMPTY' || !error.path || !privateRoots.has(error.path)) throw cause
      await rm(error.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    }
  }))
  const physicalReads: Promise<unknown>[] = []
  for (const owner of [f.b, f.d]) {
    const history = owner.core as unknown as { readSessionHistoryPage(...args: unknown[]): Promise<unknown> }
    const read = history.readSessionHistoryPage.bind(owner.core)
    vi.spyOn(history, 'readSessionHistoryPage').mockImplementation((...args) => {
      const pending = read(...args); physicalReads.push(pending); return pending
    })
  }
  cleanup.push(async () => { await Promise.allSettled(physicalReads) })
  const previous = await f.b.put(SID), transcriptPath = join(f.b.root, 'original-native.jsonl'), now = Date.now()
  await writeFile(transcriptPath, [
    { type: 'session_meta', payload: { id: 'original-recovery-native', cwd: path } },
    { type: 'response_item', timestamp: fixtureIso(), payload: { type: 'message', id: 'original-user-message', role: 'user', content: [{ type: 'input_text', text: 'Keep the original work.' }] } },
    { type: 'response_item', timestamp: fixtureIso(1), payload: { type: 'message', id: 'original-assistant-message', role: 'assistant', content: [{ type: 'output_text', text: originalText }] } }
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const session: AgentMuxStoredAgentSession = { ...previous, updatedAt: now, workspacePath: path,
    creation: { createOperationId: 'original-recovery-creation', initialPrompt: 'unknown' },
    nativeHandle: { kind: 'provider', providerId: 'codex', sessionId: 'original-recovery-native', transcriptPath },
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: now, stateEnteredAt: now } }
  const registry = Reflect.get(f.b.core, 'registry') as AgentMuxAgentSessionRegistry
  await registry.put(session, previous.run)
  const admitted = await f.admit('local', f.b.owner.runtimeId, SID, 'original-recovery-creation', undefined, path)
  await f.b.spatial.mutateDisplayLabel({ operationId: 'original-recovery-name', target: { kind: 'agent-session', id: SID },
    value: originalName, source: 'manual', expectedNameRevision: 0 }, { actor: { kind: 'user', id: 'original-user', verified: true },
    source: 'original-name-owner', entryPoint: 'original-name-intent', transport: null, location: {} }, { initializeAgentLabel: true })
  if (options.identityUnknown) {
    const state = (await f.b.spatial.read())!
    const regionId = 'unconfirmed-original-position', originalId = admitted.address.regionId
    const remap = (node: import('@agentmux/layout').WorkbenchViewLayout['root']): import('@agentmux/layout').WorkbenchViewLayout['root'] => node.type === 'leaf'
      ? { ...node, regionId: node.regionId === originalId ? regionId : node.regionId }
      : { ...node, first: remap(node.first), second: remap(node.second) }
    const layout = state.graph.tabLayouts[admitted.address.tabId]!
    await f.b.spatial.commit({ expectedRevision: state.revision, allowEntityRemoval: true, graph: { ...state.graph,
      tabs: state.graph.tabs.map(tab => tab.tabId === admitted.address.tabId ? { ...tab, regionIds: [regionId] } : tab),
      tabLayouts: { ...state.graph.tabLayouts, [admitted.address.tabId]: { ...layout, root: remap(layout.root), activeRegionId: regionId } },
      regions: state.graph.regions.map(region => {
      if (region.regionId !== admitted.address.regionId) return region
      const { creationOperationId: _admission, ...retained } = region
      return { ...retained, regionId, runId: null, execution: null }
    }) } })
  }
  const config = structuredClone(DEFAULT_CONFIG)
  config.hosts = [{ id: 'local', kind: 'local', label: 'Observer device' }, { id: 'source-route', kind: 'ssh', hostname: 'source.invalid', label: 'Original source route' }]
  config.workspaces = [{ id: 'original-b-project', kind: 'folder', name: 'Original project', hostId: 'local', path }]
  const main = spaceMountTransport(cleanup, [
    { id: 'local', carrier: { forwardRpc: f.d.rpc.call.bind(f.d.rpc), subscribeRpc: f.d.rpc.subscribe.bind(f.d.rpc) } },
    { id: 'source-route', carrier: { forwardRpc: f.b.rpc.call.bind(f.b.rpc), subscribeRpc: f.b.rpc.subscribe.bind(f.b.rpc) } }
  ], config)
  const call = vi.spyOn(api.spaceMounts, 'call').mockImplementation(async (method, input, signal) => {
    if (method === 'resources') return { hostId: (input as { hostId: string }).hostId, runtimeId: f.d.owner.runtimeId, workspaces: [] } as never
    return await main.api.call(method, input as never, signal) as never
  })
  vi.spyOn(api.spaceMounts, 'watch').mockImplementation(main.api.watch)
  vi.spyOn(api.spaceMounts, 'sessions').mockImplementation(main.api.sessions)
  vi.spyOn(api.spaceMounts, 'member').mockImplementation(main.api.member)
  vi.spyOn(api.spaceMounts, 'reading').mockImplementation(main.api.reading)
  vi.spyOn(api.workspaces, 'listBranches').mockResolvedValue({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: path })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  const effects = [f.b, f.d].flatMap(owner => (['createAgent', 'resumeAgent', 'restartAgent', 'reopenAgent', 'stopAgent', 'writeAgent', 'pasteAgent', 'submitAgentPrompt'] as const).map(method => vi.spyOn(owner.core, method)))
  const decoy = { ...composerSession(SID), workspacePath: path }
  useAppStore.setState({ config, sessions: [decoy], agentNames: { [SID]: 'Unrelated same-SID task' }, timelines: {}, tabs: {}, layouts: {},
    mainSurface: 'agents', focusView: 'list', loading: false, mountedSpaceInputs: {}, mountedSpaceObservations: {}, mountedSpaceSessions: {},
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, scratchTopicSnapshots: {},
    agentComposerDrafts: { [SID]: 'Keep the original unsent draft' }, agentSteerQueues: {} })
  const target = { hostId: 'source-route', reference: f.reference, zoneId: admitted.address.zoneId!, workspaceId: admitted.address.workspaceId! }
  useAppStore.getState().mountSpace(target, false)
  await dom.render(<GlobalFocusSurface />)
  const regionId = options.identityUnknown ? 'unconfirmed-original-position' : admitted.address.regionId
  const id = options.identityUnknown ? JSON.stringify(['unconfirmed-region', f.reference, regionId]) : focusSourceContextId(f.b.owner.runtimeId, SID)
  const card = () => cards().find(node => node.dataset.sessionId === id)!
  await vi.waitFor(() => {
    expect(card()).toBeDefined()
    expect(useAppStore.getState().mountedSpaceSessions[spaceMountKey(f.reference)]?.reading).toBe(false)
  })
  const assertPreserved = async (run = session.run) => {
    expect(useAppStore.getState().agentComposerDrafts[SID]).toBe('Keep the original unsent draft')
    expect(useAppStore.getState().sessions).toEqual([decoy])
    expect((await f.b.core.readAgentSession(SID))!.run).toEqual(run)
    expect((await f.b.spatial.read())!.graph.regions.find(region => region.regionId === regionId)?.agentSessionId).toBe(SID)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  }
  const replaceRun = async () => {
    await appendFile(transcriptPath, JSON.stringify({ type: 'response_item', timestamp: fixtureIso(2), payload: { type: 'message',
      id: 'later-assistant-message', role: 'assistant', content: [{ type: 'output_text', text: replacementText }] } }) + '\n')
    const replacement = { ...session, run: { runId: 'replacement-original-run' }, updatedAt: Date.now() }
    await registry.put(replacement, session.run)
    Reflect.get(f.b.core, 'publishSession').call(f.b.core, replacement)
    return replacement
  }
  return { ...f, session, admitted, call, card, assertPreserved, target, replaceRun }
}

async function openMenu(card: HTMLElement) {
  await act(async () => card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 20, clientY: 20 })))
  await vi.waitFor(() => expect(menu()).toBeTruthy())
}
async function openReader(card: HTMLElement) {
  await act(async () => {
    card.focus()
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  await vi.waitFor(() => expect(document.querySelector('.agent-information-reader')).toBeTruthy())
  return document.querySelector<HTMLElement>('.agent-information-reader')!
}

it('a never-confirmed source preserves its original position and directly checks identity without asserting a lost Run', async () => {
  const f = await fixture({ identityUnknown: true }), reader = await openReader(f.card())
  expect(reader.textContent).toMatch(/unconfirmed|not.*confirmed|not.*observed|not.*arrived/i)
  expect(reader.textContent).not.toMatch(/no longer confirmed|Run.*ended|Run.*died/i)
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await openMenu(f.card())
  const firstMenu = menu(), check = [...firstMenu.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Refresh observation')
  expect(check, 'Original check is an actual first-level action').toBeDefined()
  const originalIssue = useAppStore.getState().mountedSpaceSessions[spaceMountKey(f.reference)]?.members
  expect(firstMenu.textContent).not.toContain('The original member has no confirmed execution Host or Runtime.')
  const readCount = vi.mocked(api.spaceMounts.watch).mock.calls.length
  await act(async () => check!.click())
  await vi.waitFor(() => expect(vi.mocked(api.spaceMounts.watch).mock.calls.length).toBeGreaterThan(readCount))
  expect(vi.mocked(api.spaceMounts.watch).mock.calls.at(-1)![0]).toMatchObject({ hostId: f.target.hostId, reference: f.reference })
  expect(originalIssue).toBeDefined()
  await f.assertPreserved()
})

it('the source menu keeps Runtime separate from Host and retains full diagnostic detail outside its action layer', async () => {
  const f = await fixture({ identityUnknown: true })
  await openMenu(f.card())
  const before = menu().textContent
  expect(before).toContain('Host unknown')
  expect(before).not.toContain(f.b.owner.runtimeId)
  const details = menuItem('Session details')
  await act(async () => { details.focus(); details.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })) })
  await vi.waitFor(() => expect(document.querySelector('.agent-region-menu__details')?.textContent).toContain('The original member has no confirmed execution Host or Runtime.'))
  await f.assertPreserved()
})

it('a confirmed source keeps its independent name, history and precise workface navigation without borrowing local control', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.card().textContent).toContain(originalName))
  await openMenu(f.card())
  expect(menu().textContent).toContain('Rename Agent')
  expect(menu().textContent).toContain('Conversation history')
  expect(menu().querySelector('.agent-region-menu__summary')?.textContent).not.toContain(f.b.owner.runtimeId)
  expect(menu().querySelector('.agent-region-menu__summary')?.textContent).toContain('local')
  await act(async () => menuItem('View in Space').click())
  expect(useAppStore.getState().mainSurface).toBe('workbench')
  expect(useAppStore.getState().workbenchSpaceSelection).toMatchObject({ spaceId: f.reference.spaceId, zoneId: f.target.zoneId })
  await f.assertPreserved()
})

it('an unresolved source card does not remove the real ordinary Agent controls or lend them to a same-SID source', async () => {
  const f = await fixture({ identityUnknown: true }), ordinary = cards().find(card => card.dataset.sessionId === SID)!
  await openMenu(ordinary)
  expect(menu().textContent).toContain('Stop Agent')
  expect(menu().textContent).toContain('Restart Session')
  expect(menu().textContent).toContain('Take over')
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  await openMenu(f.card())
  expect(menu().textContent).not.toContain('Stop Agent')
  expect(menu().textContent).not.toContain('Restart Session')
  expect(menu().textContent).toContain('Close workface')
  expect(menu().textContent).toContain('View in Space')
  await f.assertPreserved()
})

it('a pinned original reading survives an actual later Run while preserving selection, scroll and its original draft', async () => {
  const f = await fixture()
  await vi.waitFor(() => expect(f.card().textContent).toContain(originalName))
  await vi.waitFor(() => expect(f.card().textContent).toContain(originalText), { timeout: 5000 })
  const panel = await openReader(f.card())
  await vi.waitFor(() => expect(panel.textContent, agentInformationPreview.get()?.context.access?.issue).toContain(originalText))
  const reading = panel.querySelector<HTMLElement>('.agent-information-reader__reading')!
  await act(async () => panel.querySelector<HTMLButtonElement>('.agent-information-reader__pin')!.click())
  await vi.waitFor(() => expect(agentInformationPreview.get()?.pinned).toBe(true))
  const text = panel.querySelector('.focus-context-hover__prose p')!.firstChild!
  const range = document.createRange(); range.setStart(text, 4); range.setEnd(text, 18)
  await act(async () => {
    reading.scrollTop = 29
    reading.focus()
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  const selected = document.getSelection()!.toString()
  const replacement = await act(async () => f.replaceRun())
  await vi.waitFor(() => expect(agentInformationPreview.get()?.context.runId).toBe(replacement.run.runId))
  await vi.waitFor(() => expect(f.card().textContent).toContain(replacementText), { timeout: 5000 })
  expect(document.querySelector('.agent-information-reader')).toBe(panel)
  expect(panel.querySelector('.agent-information-reader__reading')).toBe(reading)
  expect(reading.scrollTop).toBe(29)
  expect(document.getSelection()!.toString()).toBe(selected)
  expect(document.getSelection()!.anchorNode).toBe(text)
  expect(panel.textContent).toContain(originalText)
  expect(panel.textContent).not.toContain(replacementText)
  expect(panel.textContent).toMatch(/earlier Run|source.*changed|Run.*changed/i)
  await f.assertPreserved(replacement.run)
})

it('the actual Focus source notice identifies the retained source, keeps raw connection details secondary and refreshes only that source', async () => {
  const f = await fixture(), key = spaceMountKey(f.target.reference)
  await vi.waitFor(() => expect(f.card().textContent).toContain(originalName))
  const known = useAppStore.getState().mountedSpaceObservations[key]!.snapshot!
  const watch = vi.mocked(api.spaceMounts.watch), sessionReads = vi.mocked(api.spaceMounts.sessions)
  const originalWatch = watch.mock.calls.find(call => call[0].hostId === f.target.hostId)!
  await act(async () => {
    originalWatch[1]({ type: 'snapshot', snapshot: { ...known, scope: { ...known.scope, space: null } } })
    originalWatch[1]({ type: 'error', error: { code: 'HOST_SERVICE_UNCONFIRMED', message: 'The original endpoint is not yet confirmed. Keep its namespace.' } })
  })
  const notice = () => [...dom.container.querySelectorAll<HTMLElement>('section[aria-label^="Source status"]')].find(node => node.textContent?.includes('Project updates unavailable'))
  await vi.waitFor(() => expect(notice()).toBeDefined())
  expect(notice()!.getAttribute('aria-label')).toContain(known.scope.space!.name)
  expect(notice()!.getAttribute('aria-label')).toContain('Original source route')
  expect(notice()!.querySelector('.service-window-notice')?.textContent ?? notice()!.textContent).toContain('Some updates from this project are unavailable')
  expect(notice()!.querySelector('details')?.open).toBe(false)
  expect(notice()!.querySelector('details')?.textContent).toContain('The original endpoint is not yet confirmed')
  expect(notice()!.querySelector('details')?.textContent).toContain(f.target.reference.runtimeId)
  expect(notice()!.querySelector('details')?.textContent).toContain(f.target.reference.spaceId)
  const before = sessionReads.mock.calls.length
  await act(async () => notice()!.querySelector<HTMLButtonElement>('button')!.click())
  await vi.waitFor(() => {
    expect(sessionReads.mock.calls.length).toBeGreaterThan(before)
    expect(notice()).toBeUndefined()
  })
  expect(sessionReads.mock.calls.at(-1)![0]).toMatchObject({ hostId: f.target.hostId, reference: f.target.reference })
  await f.assertPreserved()
})

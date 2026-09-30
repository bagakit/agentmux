// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { regionIds, type WorkbenchRegionLayoutNode } from '@agentmux/layout'
import { WorkspaceWorkbench } from '../src/renderer/src/components/WorkspaceWorkbench'
import { api } from '../src/renderer/src/lib/api'
import { captureDesktopInput, desktopElementVisible, desktopInputPreserved } from '../src/renderer/src/lib/desktop-presentation'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { agent, config, decoyTabId, neighborSid, protectedFacts, regionIdA, regionIdB, regionIdC,
  runWorkfaceRestore, startWorkfaceFixture, tabId, targetSid } from './helpers/workface-control-fixture'

// Keep the actual Workbench, split algebra, Store, SessionPane and Composer.
// Native PTY painting is isolated; the browser build of the installed panel library stays real.
vi.mock('react-resizable-panels', async () => {
  const { createRequire } = await import('node:module')
  return createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js')
})
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: ({ session }: { session: { id: string } }) =>
  <div data-private-terminal={session.id}>Original private Terminal painting</div> }))

const original = useAppStore.getState()
const restoring = process.env.AGENTMUX_WORKFACE_RESTORE_PHASE === 'swap-child'
const restoreName = 'ordinary independent process restores the swapped original layout and actual Workbench'
let fixture: Awaited<ReturnType<typeof startWorkfaceFixture>> | undefined
let root: Root, container: HTMLDivElement
beforeEach(async () => {
  vi.restoreAllMocks(); localStorage.clear(); useAppStore.setState(original, true)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  if (!restoring) fixture = await startWorkfaceFixture()
})
afterEach(async () => {
  await act(async () => root.unmount()); container.remove(); await fixture?.stop(); fixture = undefined
  vi.restoreAllMocks(); useAppStore.setState(original, true); vi.unstubAllGlobals()
})
async function swap(a = regionIdA, b = regionIdB, code = 0) {
  const receipt = await fixture!.run(['space', 'swap', '--region', a, '--with', b], code)
  expect(receipt.operation).toBe('space.swap')
  if (receipt.operation !== 'space.swap') throw new Error('Wrong Region swap receipt.')
  return receipt.result
}
async function mount() { await act(async () => root.render(<WorkspaceWorkbench workspaceId="resource" interactiveResize={false} />)) }
function originalRegions() {
  const elements = [...container.querySelectorAll<HTMLElement>('[data-workbench-region-id]')]
    .filter(element => [regionIdA, regionIdB, regionIdC].includes(element.dataset.workbenchRegionId!))
  expect(elements).toHaveLength(3)
  return elements
}
function order() { return originalRegions().map(element => element.dataset.workbenchRegionId) }
function geometry(node: WorkbenchRegionLayoutNode): unknown {
  return node.type === 'leaf' ? { type: 'leaf' } : { type: 'split', direction: node.direction, ratio: node.ratio,
    first: geometry(node.first), second: geometry(node.second) }
}
function retainedFacts() {
  const facts = protectedFacts()
  // The one permitted write is the original Tab's leaf order; all content and focus owners stay exact.
  const { root: _root, ...layout } = facts.tabs[tabId]!.layout
  return { ...facts, tabs: { ...facts.tabs, [tabId]: { ...facts.tabs[tabId], layout } } }
}
const saved = { layoutApplied: true, localStorageWritten: true, storageFlushRequested: true, diskDurability: 'unconfirmed', reason: null }

describe.skipIf(restoring)('Region swap through compiled CLI and original layout consumers', () => {
  it('swaps two nonactive original leaves in the actual Workbench and keeps the eligible neighbor input', async () => {
    await mount(); expect(order()).toEqual([regionIdA, regionIdB, regionIdC])
    const neighbor = originalRegions()[2]!, input = neighbor.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); await act(async () => input.focus()); expect(document.activeElement).toBe(input)
    vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    expect(desktopElementVisible(input)).toBe(true)
    const before = retainedFacts(), tree = structuredClone(useAppStore.getState().tabs[tabId]!.layout.root)
    const owner = vi.spyOn(useAppStore.getState(), 'swapRegions')
    let result!: Awaited<ReturnType<typeof swap>>
    await act(async () => { result = await swap() })
    expect(result).toMatchObject({ scope: 'tab-layout', tabId, workspaceId: 'resource', beforeOrder: [regionIdA, regionIdB, regionIdC],
      afterOrder: [regionIdB, regionIdA, regionIdC], activeRegionId: regionIdC, changed: true, outcome: 'swapped', save: saved, issues: [] })
    expect(owner).toHaveBeenCalledExactlyOnceWith('resource', tabId, regionIdA, regionIdB)
    expect(result.locations.map(location => [location.displayWorkspaceId, location.regionId])).toEqual([
      ['resource', regionIdA], ['resource', regionIdB], ['resource', regionIdC], ['display', regionIdA], ['display', regionIdB], ['display', regionIdC] ])
    expect(order()).toEqual([regionIdB, regionIdA, regionIdC])
    expect(originalRegions().map(element => element.querySelector('[data-private-terminal]')?.getAttribute('data-private-terminal')))
      .toEqual([targetSid, targetSid, neighborSid])
    expect(geometry(useAppStore.getState().tabs[tabId]!.layout.root)).toEqual(geometry(tree))
    expect(geometry(tree)).toEqual({ type: 'split', direction: 'horizontal', ratio: 0.27,
      first: { type: 'leaf' }, second: { type: 'split', direction: 'horizontal', ratio: 0.61, first: { type: 'leaf' }, second: { type: 'leaf' } } })
    expect(retainedFacts()).toEqual(before); expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true)
    expect(input.textContent).toBe('Original unsent neighbor draft'); fixture!.noLifecycle()
    expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.restoredWorkbench.tabs[tabId]).toEqual(useAppStore.getState().tabs[tabId])
  })
  it('uses the original resource owner with only a foreign display and empty Session facts', async () => {
    useAppStore.setState({ layouts: { display: useAppStore.getState().layouts.display! }, sessions: [] })
    await prepareRendererUpdate(); fixture!.flush.mockClear()
    const before = retainedFacts(), owner = vi.spyOn(useAppStore.getState(), 'swapRegions')
    const result = await swap()
    expect(result).toMatchObject({ workspaceId: 'resource', tabId, beforeOrder: [regionIdA, regionIdB, regionIdC],
      afterOrder: [regionIdB, regionIdA, regionIdC], changed: true, outcome: 'swapped', save: saved })
    expect(result.locations.map(location => [location.displayWorkspaceId, location.regionId])).toEqual([
      ['display', regionIdA], ['display', regionIdB], ['display', regionIdC] ])
    expect(owner).toHaveBeenCalledExactlyOnceWith('resource', tabId, regionIdA, regionIdB)
    expect(retainedFacts()).toEqual(before); expect(before.sessions).toEqual([])
    expect(Object.keys(before.tabs)).toEqual([tabId, decoyTabId]); fixture!.noLifecycle()
  })
  it('reports an input whose reused DOM now belongs to another original Region of the same SID as unconfirmed', async () => {
    await mount()
    const input = originalRegions()[0]!.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    await act(async () => input.focus()); expect(desktopElementVisible(input)).toBe(true)
    const before = retainedFacts(), focus = vi.spyOn(HTMLElement.prototype, 'focus'), blur = vi.spyOn(HTMLElement.prototype, 'blur')
    let result!: Awaited<ReturnType<typeof swap>>
    await act(async () => { result = await swap(regionIdA, regionIdB, 1) })
    expect(result).toMatchObject({ changed: true, outcome: 'partial', beforeOrder: [regionIdA, regionIdB, regionIdC],
      afterOrder: [regionIdB, regionIdA, regionIdC], save: saved })
    expect(result.issues.map(issue => issue.code)).toEqual(['INPUT_PRESERVATION_UNCONFIRMED'])
    expect(order()).toEqual([regionIdB, regionIdA, regionIdC])
    expect(retainedFacts()).toEqual(before); expect(focus).not.toHaveBeenCalled(); expect(blur).not.toHaveBeenCalled(); fixture!.noLifecycle()
    // In this owner the input survives at a physical leaf; identity facts reveal its new consumer.
    expect(document.activeElement).toBe(input); expect(input.isConnected).toBe(true)
    expect(input.closest<HTMLElement>('[data-workbench-region-id]')?.dataset.workbenchRegionId).toBe(regionIdB)
    expect(input.textContent).toBe('Original unsent target draft')
  })
  it.each(['tabId', 'regionId', 'sessionId'] as const)('the unique passive owner rejects changed %s despite one eligible DOM object', async key => {
    await mount()
    const input = originalRegions()[2]!.querySelector<HTMLElement>('[aria-label="Message Agent"]')!
    expect(input).not.toBeNull(); vi.spyOn(input, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 48 } as DOMRect)
    await act(async () => input.focus())
    const observed = captureDesktopInput(useAppStore.getState().tabs)
    expect(observed.element).toBe(input)
    expect(observed.fact).toMatchObject({ tabId, regionId: regionIdC, sessionId: neighborSid, connected: true, visible: true, inert: false })
    expect(desktopInputPreserved(observed, observed)).toBe(true)
    expect(desktopInputPreserved(observed, { ...observed, fact: { ...observed.fact, [key]: 'another-original-' + key } })).toBe(false)
    fixture!.noLifecycle()
  })
  it('does not call the original owner or save for a self swap', async () => {
    const owner = vi.spyOn(useAppStore.getState(), 'swapRegions'), before = protectedFacts()
    expect(await swap(regionIdA, regionIdA)).toMatchObject({ outcome: 'unchanged', changed: false, save: null,
      beforeOrder: [regionIdA, regionIdB, regionIdC], afterOrder: [regionIdA, regionIdB, regionIdC] })
    expect(owner).not.toHaveBeenCalled(); expect(fixture!.flush).not.toHaveBeenCalled(); fixture!.noLifecycle()
    expect(protectedFacts()).toEqual(before)
  })
  it.each(['constructor', 'toString', '__proto__'])('refuses missing opaque Region %s without phantom entities', async id => {
    const owner = vi.spyOn(useAppStore.getState(), 'swapRegions'), before = protectedFacts()
    const result = await swap(id, regionIdB, 1)
    expect(result).toMatchObject({ outcome: 'refused', changed: false, tabId: null, save: null })
    expect(result.issues.map(issue => issue.code)).toEqual(['REGION_NOT_OPEN'])
    expect(owner).not.toHaveBeenCalled(); expect(fixture!.flush).not.toHaveBeenCalled(); fixture!.noLifecycle()
    expect(Object.keys(before.tabs)).toEqual([tabId, decoyTabId])
    expect(regionIds(before.tabs[tabId]!.layout.root)).toEqual([regionIdA, regionIdB, regionIdC])
    expect(protectedFacts()).toEqual(before)
  })
  it('accepts a legal own opaque Region in the original nonempty tree', async () => {
    const state = useAppStore.getState(), tab = state.tabs[tabId]!, id = '__proto__'
    const replaceLeaf = (node: WorkbenchRegionLayoutNode): WorkbenchRegionLayoutNode => node.type === 'leaf'
      ? { ...node, regionId: node.regionId === regionIdA ? id : node.regionId }
      : { ...node, first: replaceLeaf(node.first), second: replaceLeaf(node.second) }
    const { [regionIdA]: removed, ...regions } = tab.regions
    expect(removed).toMatchObject({ regionId: regionIdA, kind: 'agent' })
    useAppStore.setState({ tabs: { ...state.tabs, [tabId]: { ...tab, regions: { ...regions, [id]: { ...removed!, regionId: id } },
      layout: { ...tab.layout, root: replaceLeaf(tab.layout.root) } } } })
    await prepareRendererUpdate(); fixture!.flush.mockClear()
    const before = retainedFacts()
    expect(await swap(id, regionIdB)).toMatchObject({ changed: true, outcome: 'swapped',
      beforeOrder: [id, regionIdB, regionIdC], afterOrder: [regionIdB, id, regionIdC], save: saved })
    expect(retainedFacts()).toEqual(before); fixture!.noLifecycle()
  })
  it('refuses another Tab, a closing original Tab and ambiguous original ownership before writing', async () => {
    const owner = vi.spyOn(useAppStore.getState(), 'swapRegions'), before = protectedFacts()
    expect((await swap(regionIdA, 'workface-region-other', 1)).issues.map(issue => issue.code)).toEqual(['SPACE_PARENT_MISMATCH'])
    useAppStore.setState({ closingWorkbenchViews: { [tabId]: { workspaceId: 'resource', tabGroupId: 'resource-group', tabId,
      closesView: true, surfaces: [], resources: [], reservedSessionIds: [] } } })
    expect((await swap(regionIdA, regionIdB, 1)).issues.map(issue => issue.code)).toEqual(['TAB_CLOSING'])
    const state = useAppStore.getState(), decoy = state.tabs[decoyTabId]!
    useAppStore.setState({ closingWorkbenchViews: {}, tabs: { ...state.tabs, [decoyTabId]: { ...decoy,
      regions: { ...decoy.regions, [regionIdA]: state.tabs[tabId]!.regions[regionIdA]! },
      layout: { ...decoy.layout, root: { type: 'leaf', regionId: regionIdA }, activeRegionId: regionIdA } } } })
    expect((await swap(regionIdA, regionIdB, 1)).issues.map(issue => issue.code)).toEqual(['AMBIGUOUS_REGION_TARGET'])
    expect(owner).not.toHaveBeenCalled(); expect(fixture!.flush).not.toHaveBeenCalled(); fixture!.noLifecycle()
    expect(protectedFacts()).toEqual({ ...before, tabs: useAppStore.getState().tabs })
  })
  it('retains an applied original layout and truthful save failure without rolling back a later user swap', async () => {
    const before = retainedFacts()
    fixture!.flush.mockRejectedValue(new Error('Private swap storage unavailable'))
    expect(await swap(regionIdA, regionIdC, 1)).toMatchObject({ outcome: 'partial', changed: true,
      afterOrder: [regionIdC, regionIdB, regionIdA], save: { ...saved, storageFlushRequested: false, reason: 'Private swap storage unavailable' } })
    expect(useAppStore.getState().workbenchSaveWarning).toContain('Private swap storage unavailable')
    expect(retainedFacts()).toEqual(before)
    let release!: () => void
    const saving = new Promise<void>(resolve => { release = resolve })
    fixture!.flush.mockImplementation(() => saving)
    const pending = swap(regionIdA, regionIdB)
    await vi.waitFor(() => expect(regionIds(useAppStore.getState().tabs[tabId]!.layout.root)).toEqual([regionIdC, regionIdA, regionIdB]))
    useAppStore.getState().swapRegions('resource', tabId, regionIdA, regionIdB); release()
    expect(await pending).toMatchObject({ changed: true, afterOrder: [regionIdC, regionIdA, regionIdB] })
    expect(regionIds(useAppStore.getState().tabs[tabId]!.layout.root)).toEqual([regionIdC, regionIdB, regionIdA])
    expect(retainedFacts()).toEqual(before); fixture!.noLifecycle()
  })
})

it(restoreName, async () => {
  if (restoring) {
    const payload = JSON.parse(await readFile(process.env.AGENTMUX_WORKFACE_RESTORE_RECORD!, 'utf8'))
    expect(process.pid).not.toBe(payload.parentPid)
    localStorage.setItem('agentmux-workbench-v1', payload.record)
    vi.spyOn(api.config, 'get').mockResolvedValue(config); vi.spyOn(api.providers, 'list').mockResolvedValue([])
    vi.spyOn(api.demands, 'list').mockResolvedValue([]); vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
    vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [agent(targetSid), agent(neighborSid)], timelines: {}, recoveryCandidates: [] })
    vi.spyOn(api.sessions, 'historyPage').mockImplementation(async control => ({ agentSessionId: control.agentSessionId,
      source: { providerId: 'codex', nativeSessionId: 'private-native-' + control.agentSessionId }, items: [], nextCursor: null }))
    vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue(undefined)
    const dispose = await useAppStore.getState().initialize()
    try {
      expect(useAppStore.getState().sessions.map(session => [session.id, session.control.run.runId, session.hostId, session.workspacePath])).toEqual([
        [targetSid, agent(targetSid).control.run.runId, 'local', '/private/workface-execution'],
        [neighborSid, agent(neighborSid).control.run.runId, 'local', '/private/workface-execution'] ])
      expect(useAppStore.getState().tabs).toEqual(payload.tabs); expect(useAppStore.getState().layouts).toEqual(payload.layouts)
      expect(useAppStore.getState().agentComposerDrafts).toEqual(payload.drafts)
      expect(regionIds(useAppStore.getState().tabs[tabId]!.layout.root)).toEqual([regionIdB, regionIdA, regionIdC])
      expect(useAppStore.getState().tabs[tabId]!.layout.activeRegionId).toBe(regionIdC)
      await mount(); expect(order()).toEqual([regionIdB, regionIdA, regionIdC])
      expect(originalRegions()[2]!.querySelector('[aria-label="Message Agent"]')?.textContent).toBe('Original unsent neighbor draft')
      await writeFile(payload.childProof, JSON.stringify({ parentPid: payload.parentPid, pid: process.pid,
        recordSha256: createHash('sha256').update(payload.record).digest('hex'), order: order(), tabs: useAppStore.getState().tabs,
        layouts: useAppStore.getState().layouts, drafts: useAppStore.getState().agentComposerDrafts }, null, 2))
    } finally { dispose() }
    return
  }
  expect(await swap()).toMatchObject({ changed: true, afterOrder: [regionIdB, regionIdA, regionIdC] })
  const proof = await runWorkfaceRestore('apps/desktop/test/workface-region-swap-control.test.tsx', restoreName, 'swap-child')
  expect(proof.order).toEqual([regionIdB, regionIdA, regionIdC])
}, 40_000)

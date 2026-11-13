// @vitest-environment happy-dom
import { act } from 'react'
import { createRequire } from 'node:module'
import { mkdtemp, rm, appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import { createReadingOwner } from '../scripts/fixtures/mote-reading-continuity/node-owner'
import { mountReadingScene } from '../scripts/fixtures/mote-reading-continuity/scene'
import { readingDraft, readingSessionId } from '../scripts/fixtures/mote-reading-continuity/source'
import { desktopConversationReadBridge } from './helpers/conversation-read-bridge'
import { installNativePopover } from './fixtures/mote-workface'
import { createClientUiRoot } from './helpers/client-ui-render'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { WorkbenchSecondaryView } from '../src/renderer/src/components/WorkspaceWorkbench'
import { SessionActivityPresentation } from '../src/renderer/src/components/SessionActivityPresentation'
import { executionHostProjection } from '../src/renderer/src/lib/region-execution-host'
import { workbenchSessionStageHostId, type WorkbenchViewTarget } from '../src/renderer/src/lib/workbench-presentation'
import { MoteActivityConversation } from '../src/renderer/src/components/MoteActivityConversation'
import { MoteWorkfaceContext } from '../src/renderer/src/lib/mote-workface'
import { MoteDialogueViewContext, type MoteDialogueView } from '../src/renderer/src/lib/mote-dialogue-view'
import { moteConnectionTarget } from '../src/renderer/src/lib/mote-connection-default'
import type { MoteDialoguePage, MoteDialogueLink } from '@agentmux/core/mote-dialogue'
vi.mock('react-resizable-panels', () => createRequire(import.meta.url)('../node_modules/react-resizable-panels/dist/react-resizable-panels.browser.development.cjs.js'))
// PTY painting alone is isolated. The original App, Mote and conversation tree run.
vi.mock('../src/renderer/src/components/TerminalView', () => ({ TerminalView: () => null }))
let directory: string, owner: Awaited<ReturnType<typeof createReadingOwner>>, scene: Awaited<ReturnType<typeof mountReadingScene>>
let restorePopover: () => void, container: HTMLDivElement, closes: Array<() => unknown | Promise<unknown>>, pending: Promise<unknown>[]
let extent: number, offsets: WeakMap<HTMLElement, number>, geometryDescriptors: Array<[string, PropertyDescriptor | undefined]>
const costs: Array<{ unrelated: number; reads: string[]; watchers: number }> = []
const rect = (y: number, height: number) => ({ x: 0, y, top: y, bottom: y + height, left: 0, right: 700, width: 700, height, toJSON() {} }) as DOMRect
async function flush() { for (let i = 0; i < 6; i++) await act(async () => { await Promise.allSettled([...pending]); await new Promise(resolve => setTimeout(resolve, 20)) }) }
async function open() { await act(async () => scene.open()); await vi.waitFor(async () => { await flush(); expect(scene.panel().matches(':popover-open')).toBe(true); expect(scene.facts().nativeIds).toHaveLength(60) }); geometry() }
function geometry() { expect(scene.feed()).not.toBeNull() }
async function scroll(value: number) { await act(async () => { scene.feed().scrollTop = value; scene.feed().dispatchEvent(new Event('scroll')) }); await flush() }
async function diagnose(phase: string) {
  if (!process.env.AGENTMUX_MOTE_READING_FACTS) return
  const slot = document.getElementById('mote-floating-tab-slot:' + JSON.stringify([scene.reference.displayWorkspaceId, scene.reference.groupId, scene.reference.tabId]))
  await appendFile(process.env.AGENTMUX_MOTE_READING_FACTS, JSON.stringify({ phase, feedTop: scene.feed()?.scrollTop,
    slot: slot ? { id: slot.id, children: [...slot.children].map(node => ({ tag: node.tagName, connected: node.isConnected,
      primaryTabId: (node as HTMLElement).dataset.workbenchPrimaryTabId, viewReference: (node as HTMLElement).dataset.workbenchViewReference,
      primaryReference: (node as HTMLElement).dataset.workbenchPrimaryReference, activityCount: node.querySelectorAll('.activity-feed').length })) } : null,
    consumers: scene.facts().consumers.map(value => ({ id: value.consumerId, location: value.location, gates: value.gates, viewport: value.viewport, records: value.accepted?.recordCount })) }) + '\n')
}
async function hideAppend() {
  await diagnose('before-hide')
  await act(async () => scene.hide()); await flush(); expect(scene.facts().panelOpen).toBe(false); expect(scene.facts().mainSurface).toBe('board')
  await diagnose('hidden')
  const count = (await owner.facts()).calls.length
  extent = 4800; await owner.append(); await flush()
  expect((await owner.facts()).calls).toHaveLength(count)
  await act(async () => scene.open()); await vi.waitFor(async () => { await flush(); expect(scene.facts().nativeIds.at(-1)).toBe('reading-original-159') })
  await diagnose('visible-return')
}
async function remount(options: Parameters<typeof mountReadingScene>[2]) {
  await act(async () => scene.close())
  await act(async () => { scene = await mountReadingScene(container, owner.seed, options) }); await flush()
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  restorePopover = installNativePopover(); window.localStorage.clear(); pending = []; closes = []; extent = 1800; offsets = new WeakMap()
  geometryDescriptors = ['scrollHeight', 'clientHeight', 'scrollTop'].map(key => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)])
  Object.defineProperties(HTMLElement.prototype, {
    scrollHeight: { configurable: true, get() { return this.matches('.activity-feed') ? extent : 0 } },
    clientHeight: { configurable: true, get() { return this.matches('.activity-feed') ? 600 : 0 } },
    scrollTop: { configurable: true, get() { return offsets.get(this) ?? 0 }, set(value) { offsets.set(this, Math.max(0, Math.min(Number(value), extent - 600))) } }
  })
  directory = await mkdtemp(join(fixturePath('tmp'), 'mrc-')); owner = await createReadingOwner(directory)
  const bridge = await desktopConversationReadBridge({ root: directory, client: owner.client }, closes)
  for (const method of ['readAgentConversation', 'readConversationChanges'] as const) vi.mocked(api.conversation[method]).mockImplementation(((...args: any[]) => {
    const promise = (bridge[method] as any)(...args); pending.push(promise); return promise
  }) as never)
  container = document.createElement('div'); document.body.append(container)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function(this: HTMLElement) {
    const top = offsets.get(this.closest<HTMLElement>('.activity-feed')!) ?? 0
    if (this.matches('.activity-feed')) return rect(0, 600)
    if (this.matches('[data-conversation-native-tail], [data-conversation-reading-tail], [data-conversation-reading-space]')) return rect(extent - top, 0)
    const record = this.closest<HTMLElement>('[data-native-record-id]')
    if (record) return rect(Number(record.dataset.nativeRecordId!.split('-').at(-1)) * 30 - top, 30)
    return rect(0, 0)
  })
  await act(async () => { scene = await mountReadingScene(container, owner.seed) }); await flush()
})
afterEach(async () => {
  try {
    const facts = await owner.facts(); expect(facts.controls).toEqual([]); expect(facts.store).toBe(facts.originalStore); expect(facts.native).toBe(facts.expectedNative)
    expect(facts.calls.length).toBeGreaterThan(0); expect(scene.facts().writes).toEqual([])
    expect(scene.facts().drafts[readingSessionId]).toBe(readingDraft); expect(scene.facts().control?.run).toEqual(owner.seed.run)
  } finally {
    window.getSelection()?.removeAllRanges(); if (scene) await act(async () => scene.close()); container?.remove(); restorePopover?.()
    for (const close of closes.reverse()) await close(); await owner?.close(); if (directory) await rm(directory, { recursive: true, force: true })
    for (const [key, descriptor] of geometryDescriptors) { if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor); else delete (HTMLElement.prototype as any)[key] }
    vi.restoreAllMocks(); vi.unstubAllGlobals()
  }
})
it('the actual Mote App follows its same-source latest tail after hiding and native append', async () => {
  await open(); await scroll(1200); await hideAppend()
  expect(scene.feed().scrollTop).toBe(4200); expect(scene.panel().querySelector('[data-message-tool-control="jump-to-latest"]')).toBeNull()
})
it('the actual Mote App keeps the upward original record, selection, expansion and viewport offset after hidden append', async () => {
  await open(); await scroll(1200); await scroll(300)
  const body = scene.panel().querySelector<HTMLElement>('[data-native-record-id="reading-original-11"] .log-turn__body')!
  await vi.waitFor(() => expect(body).not.toBeNull())
  const details = body.querySelector('details')!, paragraph = body.querySelector('p')!
  await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')) })
  const range = document.createRange(); range.selectNodeContents(paragraph); const selection = window.getSelection()!; selection.addRange(range)
  const before = { text: selection.toString(), offset: body.getBoundingClientRect().top, top: scene.feed().scrollTop }
  await hideAppend()
  const restoredBody = scene.panel().querySelector<HTMLElement>('[data-native-record-id="reading-original-11"] .log-turn__body')!
  expect(restoredBody).not.toBeNull()
  expect(scene.feed().scrollTop).toBe(before.top); expect(restoredBody.getBoundingClientRect().top).toBe(before.offset)
  expect(restoredBody.querySelector('details')!.open).toBe(true); expect(selection.toString()).toBe(before.text)
  expect(scene.panel().querySelector('[data-message-tool-control="jump-to-latest"]')).not.toBeNull()
  await act(async () => { selection.removeAllRanges(); document.dispatchEvent(new Event('selectionchange')) }); await flush()
  const jump = scene.panel().querySelector<HTMLButtonElement>('[data-message-tool-control="jump-to-latest"]')!
  await act(async () => jump.click()); await flush(); expect(scene.feed().scrollTop).toBe(4200)
})
it.each([0, 24])('only the original Main reader is active with %i unrelated retained Tabs', async unrelated => {
  await remount({ unrelatedTabs: unrelated })
  expect(Object.keys(useAppStore.getState().tabs)).toHaveLength(unrelated + 1)
  expect(document.querySelectorAll('[data-workbench-primary-tab-id^="private-unrelated-"]')).toHaveLength(unrelated)
  await open(); await scroll(1200)
  const before = scene.facts().consumers
  expect(before.filter(value => value.gates.enabled)).toHaveLength(1)
  const id = before.find(value => value.gates.enabled)!.consumerId
  const beforeHide = (await owner.facts()).calls.length
  await act(async () => scene.hide()); await flush()
  expect(scene.facts().consumers.every(value => !value.gates.enabled)).toBe(true)
  expect((await owner.facts()).activeNativeObservers).toBe(0)
  expect((await owner.facts()).calls).toHaveLength(beforeHide)
  await act(async () => scene.open()); await flush()
  expect(scene.facts().consumers.filter(value => value.gates.enabled).map(value => value.consumerId)).toEqual([id])
  const actual = await owner.facts()
  expect(actual.calls.every(value => (value.input as any).agentSessionId === readingSessionId)).toBe(true)
  costs.push({ unrelated, reads: actual.calls.map(value => value.method), watchers: actual.activeNativeObservers })
  if (unrelated === 24) expect(costs.find(value => value.unrelated === 24)).toEqual({ ...costs.find(value => value.unrelated === 0)!, unrelated: 24 })
})
it('an actually used secondary keeps its own reading beside the original focused Space', async () => {
  await remount({ mainSurface: 'workbench' })
  await act(async () => { expect(useAppStore.getState().selectMainRegion(scene.reference)).toBe(true) }); await flush()
  await vi.waitFor(async () => { await flush(); expect(container.querySelector('.agent-surface .ProseMirror')).not.toBeNull() })
  const originalInput = container.querySelector<HTMLElement>('.agent-surface .ProseMirror')!
  expect(originalInput.getAttribute('contenteditable')).toBe('true')
  // happy-dom lacks the native contenteditable eligibility getter used by the
  // real Workbench's existing focused-primary protection.
  Object.defineProperty(originalInput, 'isContentEditable', { configurable: true, get: () => true })
  await act(async () => originalInput.focus()); await open()
  await vi.waitFor(async () => { await flush(); expect(scene.feed().closest('[data-session-presentation]')).not.toBeNull() })
  expect(originalInput.isConnected).toBe(true)
  await scroll(1200); await scroll(300)
  const id = scene.facts().consumers.find(value => value.location.presentationId && value.gates.enabled)!.consumerId
  await act(async () => useAppStore.getState().setMainSurface('board')); await flush()
  await hideAppend()
  expect(scene.facts().consumers.find(value => value.gates.enabled)?.consumerId).toBe(id)
  expect(scene.feed().scrollTop).toBe(300); expect(originalInput.isConnected).toBe(true)
})
it('visible inactive recovery is retained while never-visible and genuinely different secondary targets are not committed', async () => {
  await open(); await act(async () => scene.hide()); await flush()
  const host = document.createElement('div'); document.body.append(host)
  const destinationA = document.createElement('div'), destinationB = document.createElement('div')
  destinationA.id = 'private-secondary-A'; destinationB.id = 'private-secondary-B'; host.append(destinationA, destinationB)
  const root = createClientUiRoot(host.appendChild(document.createElement('div')))
  const reference = scene.reference
  const draw = async (visible: boolean, id = destinationA.id, sourceKey = 'original-source') => {
    const target: WorkbenchViewTarget = { hostId: id, reference, active: false, visible, surface: 'mote' }
    await act(async () => root.render(<>
      <WorkbenchSecondaryView key={id} target={target}><div id={workbenchSessionStageHostId(target, reference.regionId)} /></WorkbenchSecondaryView>
      <SessionActivityPresentation target={target} regionId={reference.regionId} sourceKey={sourceKey} sessionId={readingSessionId}
        name="Original retained Session" executorLabel="Private" executionHost={executionHostProjection('local', owner.seed.workspacePath)}
        header={<h2>Original retained Session</h2>} recovery={<p role="status">Original recovery service · {sourceKey}</p>} eligible={false} readOnly
        resourceOrigin={{ workspaceId: reference.displayWorkspaceId, tabGroupId: reference.groupId, tabId: reference.tabId, regionId: reference.regionId, sessionId: readingSessionId }}
        renderFrame={content => content} selectRegion={() => {}} />
    </>)); await flush()
  }
  try {
    await draw(false); expect(destinationA.children).toHaveLength(0)
    await draw(true); expect(destinationA.textContent).toContain('Original retained Session'); expect(destinationA.textContent).toContain('Original recovery service · original-source')
    const body = destinationA.querySelector('[role="status"]')!
    await draw(false); expect(destinationA.querySelector('[role="status"]')).toBe(body)
    await draw(true); expect(destinationA.querySelector('[role="status"]')).toBe(body)
    await draw(true, destinationA.id, 'replacement-source'); expect(destinationA.textContent).toContain('Original recovery service · replacement-source')
    expect(destinationA.textContent).not.toContain('original-source')
    await draw(false, destinationB.id, 'replacement-source'); expect(destinationB.children).toHaveLength(0)
    await draw(true, destinationB.id, 'replacement-source'); expect(destinationB.textContent).toContain('Original recovery service · replacement-source')
  } finally { await act(async () => root.unmount()); host.remove() }
})
it('current source stays readable through missing or foreign Mote context without retaining another source body', async () => {
  await open(); await act(async () => scene.hide()); await flush()
  const state = useAppStore.getState(), workspace = state.config!.workspaces.find(value => value.id === scene.reference.displayWorkspaceId)!
  const topic = state.scratchTopicSnapshots[workspace.id]!.topics![0]!
  const scopeA = { workspace, topic, rootPath: 'topic--launcher--leader', floating: true, selectTab() {}, selectReference: () => true }
  const topicB = { ...topic, id: 'launcher:reading-other', title: 'Other private Mote', directoryPath: workspace.path + '/topic--launcher--reading-other' }
  const scopeB = { ...scopeA, topic: topicB, rootPath: 'topic--launcher--reading-other' }
  const targetB = moteConnectionTarget(scopeB, state.spaceZoneBindings)!
  const refresh = vi.fn(), older = vi.fn()
  const page = (target: typeof scene.target, moteId: string, hostId = 'local', sessionId = readingSessionId): MoteDialoguePage => ({
    main: { target, identity: { hostId: 'local', moteId }, status: 'ready', resource: null, documentRevision: 'private-document', roleRevision: 'private-role', current: { ...scene.reference, hostId, sessionId }, issue: null },
    links: [], incarnation: 'private-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null })
  const view = (target: typeof scene.target, value: MoteDialoguePage) => ({ key: JSON.stringify(target), target, page: value, active: true, issue: null, refresh, older }) as unknown as MoteDialogueView
  const host = document.createElement('div'); document.body.append(host); const root = createClientUiRoot(host)
  const draw = async (scope: typeof scopeA | null, value: MoteDialogueView | null, visible = true, hostId = 'local', sessionId = readingSessionId, native = 'native-A') => {
    const source = JSON.stringify([hostId, sessionId, native])
    await act(async () => root.render(<MoteWorkfaceContext.Provider value={scope}><MoteDialogueViewContext.Provider value={value}>
      <MoteActivityConversation sessionId={sessionId} executionHostId={hostId} enabled visible={visible} records={[]} sourceRevision={native}
        renderCurrent={() => <section key={source} data-current-source={source}><p>Original source {source}</p><details><summary>Original process</summary>Original expansion</details></section>} />
    </MoteDialogueViewContext.Provider></MoteWorkfaceContext.Provider>)); await flush()
  }
  try {
    await draw(scopeA, view(scene.target, page(scene.target, topic.id)))
    const body = host.querySelector<HTMLElement>('[data-current-source]')!, details = body.querySelector('details')!, paragraph = body.querySelector('p')!
    details.open = true; const range = document.createRange(); range.selectNodeContents(paragraph); document.getSelection()!.addRange(range)
    const selected = document.getSelection()!.toString()
    await draw(null, null, false)
    expect(host.querySelector('[data-current-source]')?.getAttribute('data-current-source')).toBe(body.dataset.currentSource)
    expect(host.querySelector('details')!.open).toBe(true); expect(document.getSelection()!.toString()).toBe(selected)
    expect(host.querySelector('.mote-conversation')).toBeNull(); expect(host.querySelector('[data-mote-discussion]')).toBeNull()
    const count = refresh.mock.calls.length
    await draw(scopeA, view(scene.target, page(targetB, topicB.id)))
    expect(host.querySelector('.mote-conversation')).toBeNull(); expect(refresh).toHaveBeenCalledTimes(count)
    const anotherCurrent = { ...page(scene.target, topic.id, 'foreign-host', 'foreign-session'), next: 'original-owned-cursor' as any }
    const earlierMain: Extract<MoteDialogueLink, { kind: 'main' }> = { kind: 'main', identity: anotherCurrent.main.identity!, operationId: 'original-earlier-main-link', sequence: 1,
      associatedAt: 1, roleRevision: 'original-earlier-role', reference: scene.reference, range: 'whole-session',
      file: { resource: { ...scene.target.expectedResource, zoneId: scene.target.zoneId, zonePath: topic.directoryPath, path: 'MOTE.md' }, revision: 'original-read-revision' } }
    anotherCurrent.links = [earlierMain]
    const earlierView = { ...view(scene.target, anotherCurrent), issue: 'Original earlier Main source remains readable' }
    await draw(scopeA, earlierView)
    expect(host.querySelector('[data-current-source]')?.getAttribute('data-current-source')).toBe(body.dataset.currentSource)
    expect(host.textContent).toContain('Original earlier Main source remains readable')
    expect(host.querySelector('.mote-conversation__link')).toBeNull()
    await draw(scopeA, view(scene.target, page(scene.target, topic.id)))
    expect(host.querySelector('details')!.open).toBe(true); expect(document.getSelection()!.toString()).toBe(selected)
    const beforeB = refresh.mock.calls.length
    await draw(scopeB, view(targetB, page(targetB, topicB.id)))
    expect(refresh, 'a continuously qualified different original target must refresh its own view').toHaveBeenCalledTimes(beforeB + 1)
    expect(host.querySelector('[data-mote-discussion]')?.getAttribute('data-mote-discussion')).toBe(topicB.id)
    expect(host.querySelector('[data-current-source]')?.getAttribute('data-current-source')).toBe(body.dataset.currentSource)
    document.getSelection()!.removeAllRanges()
    await draw(scopeB, view(targetB, page(targetB, topicB.id, 'other-source-host', 'other-source-session')), true, 'other-source-host', 'other-source-session', 'native-B')
    expect(host.querySelector('[data-current-source]')?.getAttribute('data-current-source')).not.toBe(body.dataset.currentSource)
    expect(host.textContent).toContain('other-source-session'); expect(host.textContent).not.toContain('native-A')
  } finally { document.getSelection()?.removeAllRanges(); await act(async () => root.unmount()); host.remove() }
})

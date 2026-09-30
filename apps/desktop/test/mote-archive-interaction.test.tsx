// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ScratchTopicSnapshot } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { scratchMoteTopics, scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customMoteId, customTab, customAgent, moteTopics, quietMoteId, ordinaryTopicId, savedMoteKey, scratchWorkspace, moteConfig } from './fixtures/mote-workface'

let app: MoteAppFixture, catalog: ScratchTopicSnapshot[], generation = 0
beforeEach(() => {
  app = createMoteApp(); generation = 0
  catalog = moteTopics.map(topic => ({ ...topic, ...(topic.soul ? { moteArchive: { state: 'active' as const, version: topic.id === PMO_TEAMS_TOPIC_ID ? 'primary' : 'unwritten' } } : {}) }))
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics: catalog, reading: false, error: null } } })
  app.listTopics.mockImplementation(async () => structuredClone(catalog))
  app.ensureMote.mockImplementation(async (_workspace, id) => structuredClone(catalog.find(topic => topic.id === id)!))
  vi.spyOn(api.scratch, 'setMoteArchived').mockImplementation(async (workspaceId, id, archived, key, expected) => {
    expect(workspaceId).toBe(SCRATCH_WORKSPACE_ID)
    const topic = catalog.find(item => item.id === id)!
    expect(key).toBe(topicSpaceIconTarget(scratchWorkspace, topic).key)
    if (!topic?.moteArchive || topic.moteArchive.state === 'unknown' || topic.moteArchive.version !== expected || id === PMO_TEAMS_TOPIC_ID) throw new Error('Archive state changed')
    const moteArchive = { state: archived ? 'archived' as const : 'active' as const, version: 'confirmed-' + ++generation }
    catalog = catalog.map(item => item.id === id ? { ...item, moteArchive } : item)
    return moteArchive
  })
})
afterEach(async () => { await app.dispose() })
function selected(archived = false) {
  if (archived) catalog = catalog.map(topic => topic.id === customMoteId ? { ...topic, moteArchive: { state: 'archived', version: 'saved-archive' } } : topic)
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics: catalog, reading: false, error: null } } })
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: customMoteId, targetTabId: customTab.id }))
}
function target() { return JSON.parse(localStorage.getItem(savedMoteKey)!) }
function choice(id: string) { return app.panel().querySelector<HTMLButtonElement>(`[data-mote-topic-id="${id}"]`) }
function button(label: string, parent: ParentNode = document) {
  const found = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
async function menu(row: HTMLElement, keyboard = false) {
  await act(async () => row.dispatchEvent(keyboard ? new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }) :
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 10, clientY: 50 })))
  await settleMoteApp()
  const content = document.querySelector<HTMLElement>('[role="menu"]')
  expect(content).not.toBeNull(); expect(content!.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0)
  return content!
}
function quiet(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts); expect(after.sessions).toBe(before.sessions)
  expect(after.activeWorkspaceId).toBe(before.activeWorkspaceId); expect(after.mainSurface).toBe(before.mainSurface)
  expect(after.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
  expect(after.agentFocus).toEqual(before.agentFocus); expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(Object.keys(after.tabs).length).toBeGreaterThan(3); expect(Object.keys(after.agentComposerDrafts).length).toBeGreaterThan(1)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}
async function setArchive(archived: boolean) {
  const topic = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics!.find(topic => topic.id === customMoteId)!
  expect(topic.moteArchive?.state).not.toBe('unknown')
  await useAppStore.getState().setMoteArchived(SCRATCH_WORKSPACE_ID, customMoteId, archived, topicSpaceIconTarget(scratchWorkspace, topic).key,
    (topic.moteArchive as { version: string }).version)
}
it('actual chooser keyboard menu archives only its explicit Mote while retained target, body, two drafts and healthy work stay unchanged', async () => {
  selected(); await app.mount()
  expect([PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId].map(id => choice(id)?.dataset.moteTopicId)).toEqual([PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId])
  expect(choice(ordinaryTopicId)).toBeNull()
  const before = useAppStore.getState(), saved = target(), body = app.panel().querySelector('[aria-label="Message Agent"]')
  expect(body).not.toBeNull(); expect(body!.textContent).toContain('Analyst unsent')
  await act(async () => choice(customMoteId)!.focus())
  const content = await menu(choice(customMoteId)!, true)
  expect(app.panel().contains(content)).toBe(true)
  const item = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Archive Mote')
  expect(item).toBeDefined(); await moteClick(item!)
  expect(choice(customMoteId)).toBeNull(); expect(target()).toEqual(saved)
  expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
  expect(app.panel().querySelector('[data-mote-archived]')?.textContent).toContain('Archived')
  expect(document.activeElement).toBe(button('Restore Mote', app.panel()))
  expect(app.panel().querySelector('[aria-label="Message Agent"]')).toBe(body)
  expect(scratchMoteTopics(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics).map(topic => topic.id)).toEqual([PMO_TEAMS_TOPIC_ID, customMoteId, quietMoteId])
  quiet(before)
  await moteClick(button('Restore Mote', app.panel()))
  expect(choice(customMoteId)).not.toBeNull(); expect(target()).toEqual(saved); quiet(before)
})
it('keyboard menu cancellation returns the original row and late Archive does not steal a newer input focus', async () => {
  selected(); await app.mount(); const original = choice(customMoteId)!
  await act(async () => original.focus()); let content = await menu(original, true)
  await act(async () => content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settleMoteApp()
  expect(document.activeElement).toBe(original)
  let release!: () => void
  const write = vi.mocked(api.scratch.setMoteArchived).getMockImplementation()!
  vi.mocked(api.scratch.setMoteArchived).mockImplementationOnce((...args) => new Promise(resolve => { release = async () => resolve(await write(...args)) }))
  content = await menu(original, true)
  const item = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Archive Mote')
  expect(item).toBeDefined(); await moteClick(item!)
  const input = app.panel().querySelector<HTMLElement>('[aria-label="Message Agent"]')
  expect(input).not.toBeNull(); await act(async () => input!.focus())
  await act(async () => { release() }); await settleMoteApp()
  expect(choice(customMoteId)).toBeNull(); expect(document.activeElement).toBe(input)
})
it('Space keyboard Archive returns to the same visible Motes disclosure after its original row is collected', async () => {
  selected(); localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: customMoteId, targetTabId: customTab.id }))
  useAppStore.setState({ projectRailOpen: true }); await app.mount()
  const original = document.querySelector<HTMLElement>(`[data-space-nav="topic:${customMoteId}"]`)
  expect(original).not.toBeNull(); await act(async () => original!.focus())
  const content = await menu(original!, true), item = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Archive Mote')
  expect(item).toBeDefined(); await moteClick(item!)
  expect(document.querySelector(`[data-space-nav="topic:${customMoteId}"]`)).toBeNull()
  expect(document.activeElement).toBe(button('Show archived Motes in Space'))
})
it('Space Show archived finds the same hidden object and real Restore returns its original pin, icon and order without selecting or replacing work', async () => {
  selected(true); useAppStore.setState({ projectRailOpen: true, spaceObjectIcons: { [topicSpaceIconTarget(scratchWorkspace, catalog[1]!).key]: 'book' },
    pinnedItems: { [SCRATCH_WORKSPACE_ID]: [customMoteId] }, scratchTopicOrder: [quietMoteId, customMoteId] })
  await app.mount(); const before = useAppStore.getState()
  expect(document.querySelector(`[data-space-nav="topic:${customMoteId}"]`)).toBeNull()
  await moteClick(button('Show archived Motes in Space'))
  const row = document.querySelector<HTMLElement>(`[data-space-nav="topic:${customMoteId}"]`)
  expect(row).not.toBeNull(); expect(row!.textContent).toContain('Archived'); expect(row!.querySelector('[data-space-icon="book"]')).not.toBeNull()
  await moteClick(button('Restore Mote ' + catalog[1]!.title))
  expect(document.querySelector(`[data-space-nav="topic:${customMoteId}"]`)?.textContent).not.toContain('Archived')
  expect(useAppStore.getState().pinnedItems).toBe(before.pinnedItems); expect(useAppStore.getState().spaceObjectIcons).toBe(before.spaceObjectIcons)
  expect(useAppStore.getState().scratchTopicOrder).toBe(before.scratchTopicOrder); quiet(before)
})
it('primary menu explains final protection and plain Topics offer no archive action', async () => {
  selected(); useAppStore.setState({ projectRailOpen: true }); await app.mount()
  let content = await menu(choice(PMO_TEAMS_TOPIC_ID)!)
  const primary = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Primary Mote cannot be archived')
  expect(primary).toBeDefined(); expect(primary!.getAttribute('aria-disabled')).toBe('true')
  await act(async () => content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settleMoteApp()
  const plain = document.querySelector<HTMLElement>(`[data-space-nav="topic:${ordinaryTopicId}"]`)
  expect(plain).not.toBeNull(); content = await menu(plain!)
  expect(content.textContent).toContain('Change icon'); expect(content.textContent).not.toContain('Archive')
  expect(api.scratch.setMoteArchived).not.toHaveBeenCalled()
})
it('unknown archive metadata remains a Mote with neutral discovery, retained exact target and a working retry notice', async () => {
  selected(true); catalog = catalog.map(topic => topic.id === customMoteId ? { ...topic, moteArchive: { state: 'unknown', issue: 'Invalid archive metadata' } } : topic)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics![1]!.moteArchive?.state).toBe('archived')
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.error).toContain('Archive state unconfirmed')
  useAppStore.setState({ scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: { scope: scratchTopicsScope(scratchWorkspace), revision: 0, topics: catalog, reading: false, error: null } } })
  await app.mount(); expect(choice(customMoteId)).not.toBeNull()
  expect(app.panel().textContent).toContain('Mote archive state is unconfirmed'); expect(app.panel().textContent).not.toContain('Topic directory is still being confirmed')
  expect(app.panel().dataset.moteTargetTab).toBe(customTab.id)
  const before = useAppStore.getState(); await moteClick(button('Retry directory', app.panel())); quiet(before)
})
it('failed write keeps confirmed discovery and current work until explicit retry, without optimistic hiding', async () => {
  selected(); await app.mount(); const before = useAppStore.getState()
  vi.mocked(api.scratch.setMoteArchived).mockRejectedValueOnce(new Error('Filesystem write unavailable'))
  const content = await menu(choice(customMoteId)!)
  const item = [...content.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent === 'Archive Mote')
  expect(item).toBeDefined(); await moteClick(item!)
  expect(choice(customMoteId)).not.toBeNull(); expect(app.panel().textContent).toContain('Filesystem write unavailable')
  expect(app.panel().textContent).toContain('last confirmed state'); quiet(before)
  await moteClick(button('Retry directory', app.panel())); expect(choice(customMoteId)).not.toBeNull()
})
it.each([true, false])('confirmed archived=%s invalidates a real pending old list before its late result can overwrite the fact', async archived => {
  selected(!archived); const before = useAppStore.getState(), stale = structuredClone(catalog)
  let releaseOld!: (value: ScratchTopicSnapshot[]) => void, releaseNew!: (value: ScratchTopicSnapshot[]) => void
  app.listTopics.mockImplementationOnce(() => new Promise(resolve => { releaseOld = resolve }))
    .mockImplementationOnce(() => new Promise(resolve => { releaseNew = resolve }))
  const oldRead = useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  const mutation = setArchive(archived); await new Promise(resolve => setTimeout(resolve, 0))
  expect(app.listTopics).toHaveBeenCalledTimes(2)
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics![1]!.moteArchive?.state).toBe(archived ? 'archived' : 'active')
  releaseOld(stale); await oldRead
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics![1]!.moteArchive?.state).toBe(archived ? 'archived' : 'active')
  releaseNew(structuredClone(catalog)); await mutation; quiet(before)
})
it('a delayed old write acknowledgement cannot republish A over a newer B confirmation', async () => {
  selected(); let release!: (value: { state: 'archived'; version: string }) => void
  vi.mocked(api.scratch.setMoteArchived).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const old = setArchive(true)
  catalog = catalog.map(topic => topic.id === customMoteId ? { ...topic, moteArchive: { state: 'archived', version: 'server-A' } } : topic)
  await useAppStore.getState().refreshScratchTopics(SCRATCH_WORKSPACE_ID, true)
  await setArchive(false)
  const confirmed = useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics![1]!.moteArchive
  expect(confirmed?.state).toBe('active')
  const observed: string[] = [], unsubscribe = useAppStore.subscribe(state => { const value = state.scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.[1]?.moteArchive; observed.push(value?.state ?? 'absent') })
  release({ state: 'archived', version: 'server-A' }); await old; unsubscribe()
  expect(observed.length).toBeGreaterThan(0); expect(observed).not.toContain('archived')
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]!.topics![1]!.moteArchive).toEqual(confirmed)
})
it('late request and stale visible caller cannot write or publish to replacement config scope', async () => {
  selected(); let release!: (value: { state: 'archived'; version: string }) => void
  vi.mocked(api.scratch.setMoteArchived).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const old = setArchive(true), replacement = { ...scratchWorkspace, path: '/replacement' }
  const snapshot = { scope: scratchTopicsScope(replacement), revision: 0, topics: catalog, reading: false, error: null }
  useAppStore.setState({ config: { ...moteConfig, workspaces: [replacement, moteConfig.workspaces[1]!] }, scratchTopicSnapshots: { [SCRATCH_WORKSPACE_ID]: snapshot } })
  release({ state: 'archived', version: 'old-dir' }); await old
  expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]).toBe(snapshot)
  await expect(setArchive(true)).rejects.toThrow('not confirmed')
  expect(api.scratch.setMoteArchived).toHaveBeenCalledTimes(1)
})
it('unconfirmed write receipt never publishes success or hides the original Mote', async () => {
  selected(); const before = useAppStore.getState()
  vi.mocked(api.scratch.setMoteArchived).mockResolvedValue({ state: 'unknown', issue: 'Readback denied' } as never)
  await expect(setArchive(true)).rejects.toThrow('not confirmed')
  expect(useAppStore.getState().scratchTopicSnapshots).toBe(before.scratchTopicSnapshots); quiet(before)
})
it('Launcher recommends active objects while its explicitly selected archived Mote and nonempty in-flight request retain the same original owner', async () => {
  selected(true); await app.mount()
  const chooser = button('Choose Mote: ' + catalog[1]!.title)
  expect(chooser.textContent).toContain(catalog[1]!.title)
  await act(async () => { chooser.focus(); chooser.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })) }); await settleMoteApp()
  const content = document.querySelector('[role="menu"]')
  expect(content).not.toBeNull(); expect([...content!.querySelectorAll('[role="menuitem"]')].map(node => node.textContent)).toEqual(['Mote', catalog[2]!.title])
  await act(async () => content!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settleMoteApp()
  let release!: () => void
  app.ensureMote.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve(catalog[1]!) }))
  const request = button('Create with Mote'), drafts = useAppStore.getState().agentComposerDrafts
  await moteClick(request)
  expect(button('Submitting…').disabled).toBe(true)
  await act(async () => { release() }); await settleMoteApp()
  expect(app.send).toHaveBeenCalledTimes(1); expect(app.send).toHaveBeenCalledWith(customAgent.id, expect.stringContaining('Launcher unsent'), expect.any(Function), 'manual')
  expect(useAppStore.getState().agentComposerDrafts).toBe(drafts)
  expect(target().targetTopicId).toBe(customMoteId); expect(target().targetTabId).toBe(customTab.id)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled()
})

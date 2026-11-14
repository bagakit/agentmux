// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MoteDialoguePage } from '@agentmux/core/mote-dialogue'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customTab, defaultAgent, defaultTab, moteTopics, scratchWorkspace } from './fixtures/mote-workface'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { MoteWorkface } from '../src/renderer/src/components/MoteWorkface'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import * as motion from '@agentmux/client-ui/mote-face-motion'

let app: MoteAppFixture
const topic = moteTopics[0]!
const reference = { hostId: 'local', sessionId: defaultAgent.id, displayWorkspaceId: scratchWorkspace.id,
  groupId: 'mote-group', tabId: defaultTab.id, regionId: defaultTab.layout.activeRegionId }
const targetKey = () => topicSpaceIconTarget(scratchWorkspace, topic, useAppStore.getState().spaceZoneBindings)!.key
function page(target: MoteDialoguePage['main']['target'], current: typeof reference | null = reference): MoteDialoguePage {
  return { main: { target, identity: { hostId: 'local', moteId: topic.id }, status: 'ready', resource: null,
    documentRevision: 'original-file', roleRevision: 'original-role', current, issue: null }, links: [],
    incarnation: 'original-links', throughSequence: 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'read', sourceIssue: null }
}
beforeEach(() => {
  app = createMoteApp()
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  vi.spyOn(api.moteDialogue, 'read').mockImplementation(async ({ target }) => page(target))
})
afterEach(async () => { await app.dispose() })
const fullHeader = () => app.container.querySelector<HTMLElement>('.mote-space-frame__header')!
const floatHeader = () => app.container.querySelector<HTMLElement>('[data-test-floating] .mote-workface__navigation')!
function identity(header: HTMLElement, expected = topic) {
  expect(header).not.toBeNull()
  const result = header.querySelector<HTMLElement>('[data-mote-conversation-identity]')
  expect(result).not.toBeNull()
  expect(result!.dataset.moteConversationIdentity).toBe(expected.id)
  expect(result!.querySelector('.mote-conversation-identity__name')?.textContent).toBe(expected.title)
  expect(result!.querySelector('.mote-conversation-identity__avatar .space-object-icon')).not.toBeNull()
  return result!
}
function floating(visible = true, selected = topic) {
  return <DesktopClientUiProvider><div data-test-floating><MoteWorkface workspaceId={scratchWorkspace.id} topicId={selected.id}
    floating visible={visible} recoverOnOpen={false} reference={reference} onReferenceSelect={() => false}
    navigationActions={<button type="button">原成员入口</button>}><textarea data-original-float defaultValue="Original floating draft" /></MoteWorkface></div></DesktopClientUiProvider>
}
const button = (parent: ParentNode, label: string) => {
  const found = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label)
  expect(found, label).toBeDefined(); return found!
}
function retained() {
  const state = useAppStore.getState()
  return { tabs: state.tabs, layouts: state.layouts, sessions: state.sessions, drafts: state.agentComposerDrafts,
    queues: state.agentSteerQueues, selection: state.workbenchSpaceSelection }
}
function noExecution() {
  expect(app.launch).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
  expect(app.stop).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}

it('both actual navigation consumers share the saved original avatar, retaining the real App Reader, Composer and input identity', async () => {
  useAppStore.setState({ spaceObjectIcons: { [targetKey()]: 'compass' } })
  const image = vi.spyOn(api.scratch, 'readMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,ORIGINAL' })
  await app.mount(floating())
  for (const header of [fullHeader(), floatHeader()]) expect(identity(header).querySelector('[data-space-icon="compass"]')).not.toBeNull()
  const body = app.container.querySelector('.workbench-context-frame .pane-body')
  const reader = app.container.querySelector('.workbench-context-frame [data-activity-session="default-agent"]')
  const composer = app.container.querySelector('.workbench-context-frame [aria-label="Message Agent"]')
  const floatDraft = app.container.querySelector<HTMLTextAreaElement>('[data-original-float]')!
  expect(body).not.toBeNull(); expect(reader).not.toBeNull(); expect(composer).not.toBeNull(); expect(floatDraft).not.toBeNull()
  const before = retained()
  await act(async () => useAppStore.setState({ spaceObjectIcons: { [targetKey()]: { kind: 'image', fileName: 'original.png' } } }))
  await vi.waitFor(() => {
    for (const header of [fullHeader(), floatHeader()]) expect(identity(header).querySelector<HTMLImageElement>('img')?.getAttribute('src')).toBe('data:image/png;base64,ORIGINAL')
  })
  expect(image.mock.calls.length).toBeGreaterThan(0)
  for (const call of image.mock.calls) expect(call).toEqual([scratchWorkspace.id, topic.id, { kind: 'image', fileName: 'original.png' }, targetKey()])
  for (const label of ['Threads', '返回主对话']) await moteClick(button(floatHeader(), label))
  for (const label of ['Profile', 'Discussion']) await moteClick(button(fullHeader(), label))
  expect(app.container.querySelector('.workbench-context-frame .pane-body')).toBe(body)
  expect(app.container.querySelector('.workbench-context-frame [data-activity-session="default-agent"]')).toBe(reader)
  expect(app.container.querySelector('.workbench-context-frame [aria-label="Message Agent"]')).toBe(composer)
  expect(app.container.querySelector('[data-original-float]')).toBe(floatDraft)
  expect(floatDraft.value).toBe('Original floating draft')
  const after = retained()
  for (const key of ['tabs', 'layouts', 'sessions', 'drafts', 'queues'] as const) expect(after[key]).toBe(before[key])
  expect(after.selection).toEqual(before.selection)
  expect(button(floatHeader(), '原成员入口')).toBeDefined()
  expect(button(fullHeader(), '切换对话')).toBeDefined()
  noExecution()
})

it('both fixed identities remain during initial reading and a failed source observation, outside the changing body', async () => {
  const failures: Array<(error: Error) => void> = []
  vi.mocked(api.moteDialogue.read).mockImplementation(() => new Promise((_resolve, reject) => { failures.push(reject) }))
  await app.mount(floating())
  const full = identity(fullHeader()), float = identity(floatHeader()), before = retained()
  expect(app.container.querySelector('[data-test-floating] .mote-start[data-mode="reading"]')).not.toBeNull()
  expect(failures.length).toBeGreaterThan(0)
  vi.mocked(api.moteDialogue.read).mockRejectedValue(new Error('Controlled source observation gap'))
  await act(async () => { for (const fail of failures) fail(new Error('Controlled source observation gap')) })
  await vi.waitFor(() => expect(app.container.querySelector('[data-test-floating]')?.textContent).toContain('主对话的来源尚未确认'))
  expect(identity(fullHeader())).toBe(full); expect(identity(floatHeader())).toBe(float)
  expect(float.querySelector('[data-mote-expression="unknown"]')).not.toBeNull()
  expect(retained()).toEqual(before); noExecution()
})

it('the original Main expression reaches both saved identities when its process exits, without replacing the Mote with a member', async () => {
  await app.mount(floating())
  const full = identity(fullHeader()), float = identity(floatHeader())
  const original = useAppStore.getState().sessions.find(item => item.id === defaultAgent.id)!
  await act(async () => useAppStore.setState(state => ({ sessions: state.sessions.map(item => item.id === original.id
    ? { ...item, processState: 'exited', status: { ...item.status, state: 'exited' } } : item) })))
  await vi.waitFor(() => {
    for (const node of [identity(fullHeader()), identity(floatHeader())]) expect(node.querySelector('[data-mote-expression="stopped"]')).not.toBeNull()
  })
  expect(identity(fullHeader())).toBe(full); expect(identity(floatHeader())).toBe(float)
  const after = useAppStore.getState().sessions.find(item => item.id === original.id)!
  expect(after.control).toBe(original.control)
  expect(useAppStore.getState().agentComposerDrafts[defaultAgent.id]).toBe('Default unsent')
  noExecution()
})

it('a foreign Main observation preserves the known Mote identity and cannot lend a different Agent expression', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async ({ target }) => ({ ...page(target), main: {
    ...page(target).main, identity: { hostId: 'foreign-host', moteId: topic.id }
  } }))
  await app.mount(floating())
  for (const header of [fullHeader(), floatHeader()]) {
    const node = identity(header)
    expect(node.querySelector('[data-mote-expression="unknown"]')).not.toBeNull()
    expect(node.textContent).not.toContain(defaultAgent.id)
  }
  noExecution()
})

it('opening and returning from an original historical source keeps both fixed identities and the retained input body', async () => {
  vi.mocked(api.moteDialogue.read).mockImplementation(async ({ target }) => ({ ...page(target, null), throughSequence: 1, links: [{
    kind: 'main', sequence: 1, identity: { hostId: 'local', moteId: topic.id }, operationId: 'original-period',
    associatedAt: 1, roleRevision: 'previous-role', reference, range: 'whole-session',
    file: { resource: { hostId: 'local', workspaceId: scratchWorkspace.id, workspacePath: scratchWorkspace.path,
      zoneId: target.zoneId, zonePath: topic.directoryPath!, path: 'MOTE.md' }, revision: 'original-file' }
  }] }))
  await app.mount(floating())
  const full = identity(fullHeader()), float = identity(floatHeader()), before = retained()
  const original = app.container.querySelector('[data-original-float]')
  expect(original).not.toBeNull()
  const row = await vi.waitFor(() => {
    const found = app.container.querySelector<HTMLButtonElement>('[data-test-floating] .mote-start-history li button')
    expect(found, app.container.querySelector('[data-test-floating]')?.textContent).not.toBeNull(); return found!
  })
  await moteClick(row)
  const historical = app.container.querySelector('[data-test-floating] .mote-workface__period')
  expect(historical).not.toBeNull(); expect(historical!.textContent).toContain('此前的交流')
  expect(historical!.textContent).toContain(defaultAgent.id)
  expect(identity(fullHeader())).toBe(full); expect(identity(floatHeader())).toBe(float)
  await moteClick(button(historical!, '← 返回对话'))
  expect(app.container.querySelector('[data-test-floating] .mote-workface__period')).toBeNull()
  expect(app.container.querySelector('[data-original-float]')).toBe(original)
  expect(identity(fullHeader())).toBe(full); expect(identity(floatHeader())).toBe(float)
  expect(retained()).toEqual(before); noExecution()
})

it('a named Mote uses its own long name and saved appearance in both actual shells', async () => {
  const custom = moteTopics[1]!, key = topicSpaceIconTarget(scratchWorkspace, custom, useAppStore.getState().spaceZoneBindings)!.key
  useAppStore.getState().activateTab(scratchWorkspace.id, 'mote-group', customTab.id)
  useAppStore.setState({ spaceObjectIcons: { [key]: 'brain' } })
  vi.mocked(api.moteDialogue.read).mockImplementation(async ({ target }) => ({ ...page(target, null), main: {
    ...page(target, null).main, identity: { hostId: 'local', moteId: custom.id }
  } }))
  await app.mount(floating(true, custom))
  for (const header of [fullHeader(), floatHeader()]) {
    const node = identity(header, custom)
    expect(node.querySelector('[data-space-icon="brain"]')).not.toBeNull()
    expect(node.querySelector('.mote-conversation-identity__name')?.getAttribute('title')).toBe(custom.title)
  }
  expect(useAppStore.getState().agentComposerDrafts['custom-agent']).toBe('Analyst unsent')
  noExecution()
})

it('hidden actual shells add no identity motion consumer and release visible registrations without touching the original input bodies', async () => {
  const observe = motion.observeMoteMotion
  const registrations: Array<{ surface: 'float' | 'full' | null; dispose: ReturnType<typeof vi.fn> }> = []
  vi.spyOn(motion, 'observeMoteMotion').mockImplementation((element, expression, visible) => {
    const registration = observe(element, expression, visible), dispose = vi.fn(() => registration.dispose())
    const surface = element.closest('[data-test-floating] .mote-conversation-identity') ? 'float'
      : element.closest('.mote-space-frame__header .mote-conversation-identity') ? 'full' : null
    registrations.push({ surface, dispose }); return { ...registration, dispose }
  })
  const own = (surface: 'float' | 'full') => registrations.filter(item => item.surface === surface)
  const active = (surface: 'float' | 'full') => own(surface).filter(item => item.dispose.mock.calls.length === 0)
  await app.mount(floating(false))
  const draft = app.container.querySelector('[data-original-float]'), composer = app.container.querySelector('.workbench-context-frame [aria-label="Message Agent"]'), before = retained()
  expect(draft).not.toBeNull(); expect(composer).not.toBeNull()
  identity(floatHeader()); expect(own('float')).toHaveLength(0); expect(active('full')).toHaveLength(1)
  const initialFullCount = own('full').length
  await act(async () => useAppStore.setState({ mainSurface: 'board' }))
  expect(fullHeader().hidden).toBe(true)
  expect(identity(fullHeader()).querySelector('[data-mote-expression]')).toBeNull()
  expect(own('full')).toHaveLength(initialFullCount); expect(active('full')).toHaveLength(0)
  await act(async () => useAppStore.setState({ mainSurface: 'workbench' }))
  await app.mount(floating(true)); await settleMoteApp()
  expect(own('float')).toHaveLength(1); expect(active('full')).toHaveLength(1)
  const reopenedFullCount = own('full').length
  await act(async () => useAppStore.setState({ mainSurface: 'board' }))
  await app.mount(floating(false))
  expect(own('float')).toHaveLength(1); expect(own('float')[0]!.dispose).toHaveBeenCalledOnce()
  expect(own('full')).toHaveLength(reopenedFullCount); expect(active('full')).toHaveLength(0)
  for (const registration of own('full')) expect(registration.dispose).toHaveBeenCalledOnce()
  expect(identity(floatHeader()).querySelector('[data-mote-expression]')).toBeNull()
  expect(app.container.querySelector('[data-original-float]')).toBe(draft)
  expect(app.container.querySelector('.workbench-context-frame [aria-label="Message Agent"]')).toBe(composer)
  expect(retained()).toEqual(before); noExecution()
})

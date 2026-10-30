// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { webcrypto } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import type { ExecutionHost } from '@agentmux/core'
import type { TopicCategory } from '@agentmux/core/control'
import { formatSpaceAddress } from '@agentmux/core/sharing'
import { TopicKnowledgeOwner } from '@agentmux/host/topic-knowledge'
import { TopicSpatialOwner } from '@agentmux/host/topic-spatial-owner'
import { categoriesFromSpatial, UNCLASSIFIED_TOPIC_CATEGORY_ID } from '@agentmux/host/topic-categories'
import { ScratchTopics } from '../src/main/scratch-topics'
import { WorkspaceFiles } from '../src/main/workspace-files'
import type { AppConfig, ScratchTopicSnapshot, WorkspaceRecord } from '../src/shared/contracts'
import { SCRATCH_WORKSPACE_ID } from '../src/shared/scratch-topics'
import { directoryIdentity, homeZoneId } from '../src/shared/space-addresses'
import { createClientUiRoot } from './helpers/client-ui-render'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { GlobalFocusSurface } from '../src/renderer/src/components/GlobalFocusSurface'
import { FocusProjectLanes } from '../src/renderer/src/components/FocusProjectLanes'
import { DesktopClientUiProvider } from '../src/renderer/src/components/DesktopClientUiProvider'
import { WorkbenchDocumentContext } from '../src/renderer/src/lib/workbench-document'
import { FocusSettingsPreview } from '../src/renderer/src/components/settings/FocusSettingsPreview'
import { resolveFocusPreferences } from '../src/shared/focus-preferences'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { desktopBindingsFromSpatial } from '../src/renderer/src/lib/desktop-spatial-state'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'
import type { FocusScanLane } from '../src/renderer/src/lib/focus-collection-lanes'

// Only adjacent Timeline and unselected PTY painting are outside this menu proof.
// Global Focus, its actual source joins, resource menus, Dialogs, Picker and clipboard stay real.
vi.mock('../src/renderer/src/components/RecentFocusTimeline', () => ({ RecentFocusTimeline: () => null }))
vi.mock('../src/renderer/src/components/SessionPane', () => ({ SessionPane: () => null }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => { throw Error('Image encoding is outside this preset and saved-asset Picker proof') } } }))

const initial = useAppStore.getState()
const RESEARCH = '11111111-1111-4111-8111-111111111111', ENGINEERING = '22222222-2222-4222-8222-222222222222'
let root: Root | null, host: HTMLDivElement, fixtureRoot: string
let owner: TopicKnowledgeOwner, spatial: AgentMuxSpatialStateStore, config: AppConfig
let topics: ScratchTopicSnapshot[], research: TopicCategory, engineering: TopicCategory, unclassified: TopicCategory, workspace: WorkspaceRecord
const selected = vi.fn(), selectWorkspace = vi.fn(async (_id: string) => {}), launchTerminal = vi.fn(async (_id: string) => {})
const snapshot = (resource: WorkspaceRecord, entries: readonly ScratchTopicSnapshot[]) => ({ scope: scratchTopicsScope(resource), revision: 0, reading: false, error: null, topics: entries })
const topicSource = (resource: WorkspaceRecord, topic: ScratchTopicSnapshot) => {
  const spaceId = directoryIdentity(resource.hostId, topic.identityDirectoryPath ?? topic.directoryPath)
  return { spaceId, zoneId: homeZoneId(spaceId) }
}
function agent(id: string, resource: WorkspaceRecord, topic?: ScratchTopicSnapshot) {
  const status = { state: 'working' as const, source: 'native-hook' as const, observedAt: Date.now() }
  const base = composerSession(id)
  return { ...base, label: `Original task ${id}`, hostId: resource.hostId, workspacePath: topic ? topic.physicalDirectoryPath ?? topic.identityDirectoryPath ?? topic.directoryPath : resource.path,
    status, semanticStatus: { ...status, stateEnteredAt: Date.now() - 1000 }, control: { ...base.control, hostId: resource.hostId } }
}
function card(id: string) { const node = host.querySelector<HTMLButtonElement>(`button.focus-context[data-session-id="${id}"]`); expect(node, `Original Agent ${id}`).toBeTruthy(); return node! }
function lane(id: string) { const node = card(id).closest<HTMLElement>('.focus-project-lanes__row'); expect(node).toBeTruthy(); return node! }
function heading(id: string) { const node = lane(id).querySelector<HTMLElement>('.focus-project-lanes__axis'); expect(node).toBeTruthy(); return node! }
const menus = () => [...host.ownerDocument.querySelectorAll<HTMLElement>('[role="menu"]')]
const items = () => [...host.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')]
function item(label: string | RegExp) { const found = items().filter(node => typeof label === 'string' ? node.textContent?.trim() === label : label.test(node.textContent ?? '')); expect(found, `Actual menu item ${label}`).toHaveLength(1); return found[0]! }
function button(label: string, within: ParentNode = host.ownerDocument) { const found = [...within.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.trim() === label || node.getAttribute('aria-label') === label); expect(found, label).toBeTruthy(); return found! }
async function until(predicate: () => boolean) { for (let n = 0; n < 100 && !predicate(); n++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) }); expect(predicate()).toBe(true) }
async function click(node: HTMLElement) { await act(async () => node.click()) }
async function input(node: HTMLInputElement, value: string) { await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value); node.dispatchEvent(new Event('input', { bubbles: true })) }) }
async function render() { await act(async () => root!.render(<GlobalFocusSurface currentReference={null} visible workspaceOpen={false} onSelectContext={selected} />)); await until(() => Boolean(host.querySelector('button.focus-context'))) }
async function open(id: string, keyboard = false) {
  const original = heading(id), before = lane(id).getAttribute('data-collapsed')
  await act(async () => {
    original.focus()
    original.dispatchEvent(keyboard ? new KeyboardEvent('keydown', { bubbles: true, cancelable: true, shiftKey: true, key: 'F10' })
      : new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 30, clientY: 30 }))
  })
  await until(() => menus().length > 0)
  expect(lane(id).getAttribute('data-collapsed')).toBe(before)
  expect(selected).not.toHaveBeenCalled()
  return original
}
async function escape(expected?: HTMLElement) {
  const menu = menus().at(-1); expect(menu).toBeTruthy()
  await act(async () => menu!.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' })))
  await until(() => menus().length === 0)
  if (expected) await until(() => document.activeElement === expected)
}
async function sub(label: string) {
  const node = item(label)
  await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowRight' })) })
  await until(() => menus().length === 2)
}
const preservation = () => {
  const state = useAppStore.getState()
  return { sessions: state.sessions, tabs: state.tabs, layouts: state.layouts, focus: state.agentFocus, drafts: state.agentComposerDrafts }
}
function preserved(before: ReturnType<typeof preservation>) { const state = useAppStore.getState(); expect(state.sessions).toBe(before.sessions); expect(state.tabs).toBe(before.tabs); expect(state.layouts).toBe(before.layouts); expect(state.agentFocus).toBe(before.focus); expect(state.agentComposerDrafts).toBe(before.drafts) }
async function moveResearchMembers() {
  const state = useAppStore.getState(), original = (await spatial.read())!
  const moving = new Set(Object.entries(state.spaceZoneBindings).filter(([, binding]) =>
    binding.workspaceId === workspace.id && ['launcher:heading-alpha', 'launcher:heading-beta'].includes(binding.topicId ?? '')).map(([id]) => id))
  await spatial.commit({ expectedRevision: original.revision, graph: { ...original.graph,
    bindings: [...original.graph.bindings.filter(binding => !moving.has(binding.zoneId)), ...[...moving].map(zoneId => ({ zoneId, spaceId: engineering.spaceId }))] } })
  await act(async () => useAppStore.setState(state => ({ spaceZoneBindings: Object.fromEntries(Object.entries(state.spaceZoneBindings).map(([id, binding]) =>
    [id, binding.workspaceId === workspace.id && ['launcher:heading-alpha', 'launcher:heading-beta'].includes(binding.topicId ?? '')
      ? { ...binding, relations: { [engineering.spaceId]: true } } : binding])) })))
}

beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  selected.mockClear(); selectWorkspace.mockClear(); launchTerminal.mockClear(); root = null
  fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), 'focus-heading-owner-')))
  workspace = { id: SCRATCH_WORKSPACE_ID, name: 'Topics', hostId: 'local', kind: 'folder', path: join(fixtureRoot, 'scratch') }
  await mkdir(workspace.path)
  const scratch = new ScratchTopics(), files = new WorkspaceFiles(() => ({ kind: 'local' } as ExecutionHost))
  spatial = new AgentMuxSpatialStateStore(join(fixtureRoot, 'spatial.json'))
  owner = new TopicKnowledgeOwner(scratch, files, () => workspace)
  owner.setSpatialPort(new TopicSpatialOwner({ state: spatial, workspace: () => workspace, topics: () => owner.listTopicSnapshots(), categories: () => owner.listCategories(), ensureDefaultCategory: () => owner.ensureDefaultCategoryContent() }))
  research = (await owner.call('topic.category.create', { categoryId: RESEARCH, title: 'Research' })).category
  engineering = (await owner.call('topic.category.create', { categoryId: ENGINEERING, title: 'Engineering' })).category
  for (const [id, title] of [['alpha', 'Alpha Topic'], ['beta', 'Beta Topic'], ['multi', 'Multi Topic'], ['unknown', 'Unknown Topic']] as const)
    await owner.call('topic.create', { topicId: `launcher:heading-${id}`, title, categoryId: RESEARCH })
  await owner.call('topic.create', { topicId: 'launcher:heading-unclassified', title: 'Actually unclassified Topic' })
  unclassified = (await owner.call('topic.category.ls', {})).categories.find(category => category.categoryId === UNCLASSIFIED_TOPIC_CATEGORY_ID)!
  const listed = await scratch.list(workspace)
  topics = listed.map(topic => ({ ...topic, kind: 'topic' as const }))
  const graph = (await spatial.read())!.graph, bindings = desktopBindingsFromSpatial(graph)
  const byId = (id: string) => topics.find(topic => topic.id === `launcher:heading-${id}`)!
  bindings[topicSource(workspace, byId('multi')).zoneId]!.relations = { [research.spaceId]: true, [engineering.spaceId]: true }
  bindings[topicSource(workspace, byId('unknown')).zoneId]!.relations = {}
  const project: WorkspaceRecord = { id: 'heading-project', name: 'Original project', hostId: 'local', path: join(fixtureRoot, 'repo'), kind: 'folder' }
  const checkout: WorkspaceRecord = { id: 'heading-checkout', name: 'Original checkout', hostId: 'local', path: join(fixtureRoot, 'checkout'), repoPath: project.path, branch: 'feature/heading', kind: 'folder' }
  const sessions = [...topics.map(topic => agent(topic.id.split('-').at(-1)!, workspace, topic)), agent('checkout', checkout)]
  config = { ...composerConfig, workspaces: [workspace, project, checkout], focus: { topicPresentation: 'cards', recentActivityHours: 48 } }
  const tab = { ...createWorkbenchTab('heading-original-tab', { kind: 'agent', phase: 'attached', regionId: 'heading-original-region', workspaceId: workspace.id, sessionId: 'alpha' }), topicId: byId('alpha').id, space: topicSource(workspace, byId('alpha')) }
  useAppStore.setState({ ...initial, loading: false, config, sessions, topicCategories: categoriesFromSpatial(graph), spaceZoneBindings: bindings,
    scratchTopicSnapshots: { [workspace.id]: snapshot(workspace, topics) }, tabs: { [tab.id]: tab },
    layouts: Object.fromEntries(config.workspaces.map(value => [value.id, createWorkspaceLayout('group:' + value.id, value.id === workspace.id ? [tab.id] : [])])),
    activeWorkspaceId: project.id, mainSurface: 'agents', timelines: {}, agentNames: Object.fromEntries(sessions.map(value => [value.id, value.label])),
    agentFocus: { execution: { sessionId: null, history: [] }, pmo: { sessionId: null } }, agentComposerDrafts: { alpha: 'Original unsent draft' },
    selectWorkspace, launchTerminal, localHome: join(fixtureRoot, 'home') }, true)
  vi.spyOn(api.topics, 'call').mockImplementation(owner.call.bind(owner))
  vi.spyOn(api.spatial, 'read').mockImplementation(() => spatial.read())
  vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  vi.spyOn(api.files, 'reveal').mockResolvedValue(undefined)
  vi.spyOn(api.spaceObjects, 'appearance').mockResolvedValue({ local: true, icon: null })
  vi.spyOn(api.spaceObjects, 'saveAvatar').mockRejectedValue(new Error('No image save was authorized in this cancel scene'))
  vi.spyOn(api.workspaces, 'listBranches').mockImplementation(async id => ({ kind: 'not-a-git-repository', hostId: 'local', workspacePath: config.workspaces.find(value => value.id === id)?.path ?? fixtureRoot }))
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: null })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue(topics)
  host = document.createElement('div'); document.body.append(host); root = createClientUiRoot(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  document.body.replaceChildren(); useAppStore.setState(initial, true); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
})

it('actual Collection title opens the shared Category menu by pointer and keyboard without left-click effects, and copies its original Space', async () => {
  await render(); const before = preservation(), original = await open('alpha')
  expect(items().map(node => node.textContent?.trim())).toEqual(['Change avatar…', 'Rename category…', 'Copy Category link', 'Collapse Collection'])
  await click(item('Copy Category link')); await until(() => menus().length === 0)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(formatSpaceAddress({ spaceId: research.spaceId }))
  await until(() => document.activeElement === original)
  await open('alpha', true); await escape(original)
  expect(lane('alpha').getAttribute('data-collapsed')).toBeNull(); expect(selectWorkspace).not.toHaveBeenCalled()
  preserved(before)
})

it('Category rename goes from actual Focus through the original Dialog and real typed owner CAS, preserving IDs, relations and Agents', async () => {
  await render(); const before = preservation(), graph = (await spatial.read())!.graph
  await open('alpha'); await click(item('Rename category…'))
  await until(() => Boolean(document.querySelector('.topic-dialog input')))
  const editor = document.querySelector<HTMLInputElement>('.topic-dialog input')!
  await input(editor, 'Renamed Research'); await click(button('Save category'))
  await until(() => !document.querySelector('.topic-dialog'))
  expect(api.topics.call).toHaveBeenCalledWith('topic.category.rename', { categoryId: research.categoryId, title: 'Renamed Research', expectedRevision: research.revision })
  const saved = (await owner.call('topic.category.ls', {})).categories.find(value => value.categoryId === research.categoryId)!
  expect(saved).toMatchObject({ categoryId: research.categoryId, hostId: research.hostId, spaceId: research.spaceId, directoryPath: research.directoryPath, title: 'Renamed Research' })
  expect(await readFile(join(research.directoryPath, 'category.md'), 'utf8')).toBe('# Renamed Research\n')
  expect((await spatial.read())!.graph.bindings).toEqual(graph.bindings)
  expect(host.querySelectorAll('button.focus-context[data-session-id]')).toHaveLength(before.sessions.length)
  preserved(before)
})

it('a real Category revision conflict keeps the typed rename draft; cancel returns focus without replacing the Agent draft', async () => {
  await render(); const before = preservation(), original = await open('alpha')
  await click(item('Rename category…')); await until(() => Boolean(document.querySelector('.topic-dialog input')))
  const editor = document.querySelector<HTMLInputElement>('.topic-dialog input')!
  await input(editor, 'Unsent conflicting name')
  await owner.call('topic.category.rename', { categoryId: research.categoryId, title: 'Concurrent rename', expectedRevision: research.revision! })
  await click(button('Save category')); await until(() => Boolean(document.querySelector('.topic-dialog [role="alert"]')))
  expect(document.querySelector('.topic-dialog input')).toBe(editor); expect(editor.value).toBe('Unsent conflicting name')
  expect(document.querySelector('.topic-dialog [role="alert"]')!.textContent).not.toBe('')
  expect((await owner.call('topic.category.ls', {})).categories.find(value => value.categoryId === research.categoryId)!.title).toBe('Concurrent rename')
  await click(button('Cancel', document.querySelector('.topic-dialog')!)); await until(() => !document.querySelector('.topic-dialog'))
  await until(() => document.activeElement === original); preserved(before)
})

it('multi-Category menu names every original target and its submenu copies or renames that Category rather than the first', async () => {
  await render(); const before = preservation(), original = await open('multi', true)
  expect(items().some(node => node.textContent?.trim() === 'Research')).toBe(true)
  expect(items().some(node => node.textContent?.trim() === 'Engineering')).toBe(true)
  await sub('Engineering'); await click(item('Copy Category link')); await until(() => menus().length === 0)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(formatSpaceAddress({ spaceId: engineering.spaceId }))
  await open('multi'); await sub('Engineering'); await click(item('Rename category…'))
  await until(() => Boolean(document.querySelector('.topic-dialog input')))
  expect(document.querySelector<HTMLInputElement>('.topic-dialog input')!.value).toBe(engineering.title)
  await click(button('Cancel', document.querySelector('.topic-dialog')!)); await until(() => !document.querySelector('.topic-dialog'))
  await until(() => document.activeElement === original)
  expect(api.topics.call).not.toHaveBeenCalled(); preserved(before)
})

it('remote same-ID/same-revision Category only copies its exact Space and never reaches local rename or avatar writers', async () => {
  const remoteCategory: TopicCategory = { ...research, hostId: 'other-host', spaceId: directoryIdentity('other-host', research.directoryPath) }
  config = { ...config, hosts: [...config.hosts, { id: remoteCategory.hostId, kind: 'ssh', label: 'Other host', hostname: 'private.invalid' }] }
  useAppStore.setState(state => ({ config, topicCategories: [...state.topicCategories, remoteCategory] }))
  // Global's current Scratch catalogue is local. Exercise the actual production lane
  // consumer's typed remote input directly rather than fabricate a second local Scratch.
  const remoteLane: FocusScanLane = { id: JSON.stringify(['focus-collection', remoteCategory.hostId, [remoteCategory.spaceId]]), hostId: remoteCategory.hostId,
    workspaceId: '', projectId: '', projectWorkspaceId: null, name: remoteCategory.title, labels: [remoteCategory.title], path: '', topicId: null,
    recovery: null, summary: null, activeAgentIds: [], contextIds: [], collection: { confirmed: true, categories: [remoteCategory], topics: [] } }
  await act(async () => root!.render(<FocusProjectLanes resourceMenus lanes={[remoteLane]} selectedProjectKey="" onSelect={selected} renderLane={(_lane, title) => title} />))
  const original = host.querySelector<HTMLElement>('.focus-project-lanes__axis')!
  await act(async () => { original.focus(); original.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, shiftKey: true, key: 'F10' })) })
  await until(() => menus().length > 0)
  expect(items().map(node => node.textContent?.trim())).toEqual(['Copy Category link', 'Collapse Collection'])
  await click(item('Copy Category link')); await until(() => menus().length === 0)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(formatSpaceAddress({ spaceId: remoteCategory.spaceId }))
  expect(api.topics.call).not.toHaveBeenCalled(); expect(api.spaceObjects.saveAvatar).not.toHaveBeenCalled()
  expect(document.querySelector('.topic-dialog,.space-icon-picker')).toBeNull()
})

it('unknown membership exposes only the original Collection fold action and never adopts real unclassified or the first Category', async () => {
  await render(); const before = preservation(), original = await open('unknown')
  expect(items()).toHaveLength(1); const fold = item(/Collapse|折叠/i)
  await click(fold); await until(() => menus().length === 0)
  expect(lane('unknown').getAttribute('data-collapsed')).toBe('true')
  await open('unknown', true); await click(item(/Expand|展开/i)); await until(() => menus().length === 0)
  expect(lane('unknown').getAttribute('data-collapsed')).toBeNull()
  expect(api.topics.call).not.toHaveBeenCalled(); expect(api.ui.writeClipboardText).not.toHaveBeenCalled()
  await until(() => document.activeElement === original); preserved(before)
})

it('a confirmed real default unclassified Category retains its original object menu independently from unknown membership', async () => {
  await render(); expect(lane('unclassified')).not.toBe(lane('unknown'))
  const before = preservation(), original = await open('unclassified', true)
  expect(items().map(node => node.textContent?.trim())).toEqual(['Change avatar…', 'Rename category…', 'Copy Category link', 'Collapse Collection'])
  await click(item('Copy Category link')); await until(() => menus().length === 0)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(formatSpaceAddress({ spaceId: unclassified.spaceId }))
  await until(() => document.activeElement === original); preserved(before)
})

it('checkout Project menu sends Reveal/Terminal to the exact checkout Workspace, retaining original copy and Agent menu targets', async () => {
  await render(); const before = preservation(), original = await open('checkout', true)
  await click(item(/Reveal in|Show in/i)); await until(() => menus().length === 0)
  expect(api.files.reveal).toHaveBeenCalledExactlyOnceWith('heading-checkout', '')
  await open('checkout'); await click(item('Copy Path')); await until(() => menus().length === 0)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(join(fixtureRoot, 'checkout'))
  await open('checkout'); await click(item('Open in Terminal')); await until(() => launchTerminal.mock.calls.length > 0)
  expect(selectWorkspace).toHaveBeenCalledExactlyOnceWith('heading-checkout')
  expect(launchTerminal).toHaveBeenCalledExactlyOnceWith('group:heading-checkout')
  expect(selected).not.toHaveBeenCalled(); preserved(before)
  await until(() => document.activeElement === original)
  await act(async () => { card('checkout').focus(); card('checkout').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })) })
  await until(() => Boolean(document.querySelector('.focus-context-menu')))
  expect(document.querySelector<HTMLElement>('.focus-context-menu')!.dataset.agentSessionId).toBe('checkout')
  expect(document.querySelector('.focus-context-menu')!.textContent).toContain('Rename Agent')
})

it('Category Picker is the original shared editor and cancelling it preserves the workface and returns the heading invoker', async () => {
  await render(); const before = preservation(), original = await open('alpha', true)
  await click(item('Change avatar…')); await until(() => Boolean(document.querySelector('.space-icon-picker')))
  expect(document.querySelector('.space-icon-picker')!.textContent).toContain('Change avatar')
  expect(menus()).toHaveLength(0)
  await click(button('Cancel', document.querySelector('.space-icon-picker')!)); await until(() => !document.querySelector('.space-icon-picker'))
  await until(() => document.activeElement === original)
  expect(api.spaceObjects.saveAvatar).not.toHaveBeenCalled(); expect(api.topics.call).not.toHaveBeenCalled(); preserved(before)
})

it('saving a preset through the original Category heading Picker updates that exact heading, and a saved image reads only its original asset', async () => {
  const saveConfig = vi.spyOn(api.config, 'save').mockImplementation(async next => { config = structuredClone(next); return config })
  const readAvatar = vi.spyOn(api.spaceObjects, 'readAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,SAVED_CATEGORY_ASSET' })
  await render(); const before = preservation(), graph = (await spatial.read())!.graph
  const categories = (await owner.call('topic.category.ls', {})).categories, original = heading('alpha'), originalConfig = config
  expect(original.querySelector('[data-space-icon-kind="category"]')).toBeNull()
  await open('alpha'); await click(item('Change avatar…')); await until(() => Boolean(document.querySelector('.space-icon-picker')))
  const preset = document.querySelector<HTMLButtonElement>('.space-icon-picker [data-space-icon-choice="book"]')!
  expect(preset).toBeTruthy(); await click(preset)
  expect(preset.getAttribute('aria-pressed')).toBe('true')
  expect(original.querySelector('[data-space-icon-source="manual"]')).toBeNull()
  await click(button('Save avatar', document.querySelector('.space-icon-picker')!))
  await until(() => !document.querySelector('.space-icon-picker'))
  expect(saveConfig).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ appearance: expect.objectContaining({ spaceObjectIcons: { [research.spaceId]: 'book' } }) }), originalConfig)
  expect(useAppStore.getState().spaceObjectIcons).toEqual({ [research.spaceId]: 'book' })
  expect(heading('alpha')).toBe(original)
  expect(original.querySelector<HTMLElement>('[data-space-icon-source="manual"]')?.dataset.spaceIcon).toBe('book')
  expect(heading('multi').querySelector('[data-space-icon-kind="category"]')).toBeNull()
  expect(heading('unknown').querySelector('[data-space-icon-kind="category"]')).toBeNull()
  await until(() => document.activeElement === original)

  // A restored explicit image uses the existing selected-asset reader. This does
  // not exercise upload/crop/Gallery or enable automatic scans for Collection heads.
  vi.mocked(api.spaceObjects.appearance).mockClear()
  const image = { kind: 'image' as const, fileName: 'a'.repeat(64) + '.png' }
  await act(async () => useAppStore.getState().setSpaceObjectIcon(research.spaceId, image))
  await until(() => original.querySelector('img')?.getAttribute('src') === 'data:image/png;base64,SAVED_CATEGORY_ASSET')
  expect(readAvatar).toHaveBeenCalledExactlyOnceWith({ kind: 'category', categoryId: research.categoryId, objectKey: research.spaceId }, image)
  expect(api.spaceObjects.appearance).not.toHaveBeenCalled()
  expect(api.spaceObjects.saveAvatar).not.toHaveBeenCalled(); expect(api.topics.call).not.toHaveBeenCalled()
  expect((await owner.call('topic.category.ls', {})).categories).toEqual(categories)
  expect((await spatial.read())!.graph.bindings).toEqual(graph.bindings)
  expect(host.querySelectorAll('button.focus-context[data-session-id]')).toHaveLength(before.sessions.length)
  preserved(before)
})

it('a retained checkout with no exact registered Workspace keeps Copy Path and never borrows the repository root for local actions', async () => {
  config = { ...config, workspaces: config.workspaces.filter(value => value.id !== 'heading-checkout') }
  useAppStore.setState({ config })
  await render(); const before = preservation(), original = await open('checkout', true)
  expect(items().some(node => /Reveal in|Show in|Open in Terminal/.test(node.textContent ?? ''))).toBe(false)
  await click(item('Copy Path')); await until(() => menus().length === 0)
  expect(api.ui.writeClipboardText).toHaveBeenCalledExactlyOnceWith(join(fixtureRoot, 'checkout'))
  expect(api.files.reveal).not.toHaveBeenCalled(); expect(selectWorkspace).not.toHaveBeenCalled(); expect(launchTerminal).not.toHaveBeenCalled()
  await until(() => document.activeElement === original); preserved(before)
})

it('regrouping every member out of the original Collection keeps the same Category rename input, draft, selection, focus and original target', async () => {
  await render(); const before = preservation(), original = await open('alpha', true)
  await click(item('Rename category…')); await until(() => Boolean(document.querySelector('.topic-dialog input')))
  const editor = document.querySelector<HTMLInputElement>('.topic-dialog input')!
  await input(editor, 'Unsent original Category name')
  await act(async () => { editor.focus(); editor.setSelectionRange(7, 15) })
  await moveResearchMembers()
  expect(document.querySelector('.topic-dialog input')).toBe(editor)
  expect(editor.value).toBe('Unsent original Category name')
  expect([editor.selectionStart, editor.selectionEnd]).toEqual([7, 15]); expect(document.activeElement).toBe(editor)
  expect(heading('alpha').textContent).toContain(engineering.title)
  expect(original.isConnected).toBe(false)
  await click(button('Save category')); await until(() => !document.querySelector('.topic-dialog'))
  expect(api.topics.call).toHaveBeenCalledWith('topic.category.rename', { categoryId: research.categoryId, title: 'Unsent original Category name', expectedRevision: research.revision })
  expect((await owner.call('topic.category.ls', {})).categories.find(value => value.categoryId === engineering.categoryId)!.title).toBe(engineering.title)
  preserved(before)
})

it('regrouping the source Collection keeps the original shared Picker choice and focus until explicit cancel', async () => {
  await render(); const before = preservation(), original = await open('alpha')
  await click(item('Change avatar…')); await until(() => Boolean(document.querySelector('.space-icon-picker')))
  const picker = document.querySelector<HTMLElement>('.space-icon-picker')!
  const choice = picker.querySelector<HTMLButtonElement>('[data-space-icon-choice]')!
  expect(choice).toBeTruthy(); await click(choice); await act(async () => choice.focus())
  expect(choice.getAttribute('aria-pressed')).toBe('true')
  await moveResearchMembers()
  expect(document.querySelector('.space-icon-picker')).toBe(picker)
  expect(picker.querySelector('[data-space-icon-choice]')).toBe(choice)
  expect(choice.getAttribute('aria-pressed')).toBe('true'); expect(document.activeElement).toBe(choice)
  expect(original.isConnected).toBe(false)
  await click(button('Cancel', picker)); await until(() => !document.querySelector('.space-icon-picker'))
  expect(heading('alpha').textContent).toContain(engineering.title)
  expect(api.spaceObjects.saveAvatar).not.toHaveBeenCalled(); expect(api.topics.call).not.toHaveBeenCalled(); preserved(before)
})

it('the original heading invoker in another ownerDocument receives focus after cancelling its real Category Dialog', async () => {
  await act(async () => root!.unmount()); host.remove()
  const frame = document.createElement('iframe'); document.body.append(frame)
  const ownerDocument = frame.contentDocument!; expect(ownerDocument.defaultView).toBeTruthy()
  host = ownerDocument.createElement('div'); ownerDocument.body.append(host); root = createClientUiRoot(host)
  await act(async () => root!.render(<WorkbenchDocumentContext.Provider value={{ document: ownerDocument, window: null }}>
    <DesktopClientUiProvider document={ownerDocument}><GlobalFocusSurface currentReference={null} visible workspaceOpen={false} onSelectContext={selected} /></DesktopClientUiProvider>
  </WorkbenchDocumentContext.Provider>))
  await until(() => Boolean(host.querySelector('button.focus-context')))
  const original = await open('alpha', true)
  // happy-dom shares element constructors between iframe realms; this proves the
  // actual second Document/focus route, not a native realm-constructor difference.
  expect(ownerDocument).not.toBe(document); expect(original.ownerDocument).toBe(ownerDocument)
  expect(original instanceof ownerDocument.defaultView!.HTMLElement).toBe(true)
  await click(item('Rename category…')); await until(() => Boolean(ownerDocument.querySelector('.topic-dialog input')))
  await click(button('Cancel', ownerDocument.querySelector('.topic-dialog')!))
  await until(() => !ownerDocument.querySelector('.topic-dialog')); await until(() => ownerDocument.activeElement === original)
  expect(api.topics.call).not.toHaveBeenCalled()
})

it('the actual Settings example stays isolated when example IDs collide with real configured resources and a matching collection path', async () => {
  const collisions: WorkspaceRecord[] = ['Atlas', 'Studio', 'Review', 'Research'].map((name, index) => ({
    id: 'example-' + index, name, path: join(fixtureRoot, 'real-example-project-' + index), hostId: 'example', kind: 'folder'
  }))
  config = { ...config, hosts: [...config.hosts, { id: 'example', kind: 'local', label: 'A real configured resource Host' }],
    workspaces: [...config.workspaces, ...collisions, { id: 'example-topic-home', name: 'Example Topics', path: '/example/topics', hostId: 'example', kind: 'folder' }] }
  useAppStore.setState(state => ({ config, layouts: { ...state.layouts, ...Object.fromEntries(collisions.map(value => [value.id, createWorkspaceLayout('real:' + value.id)])) },
    topicCategories: [...state.topicCategories, { categoryId: '33333333-3333-4333-8333-333333333333', spaceId: 'example-collection', hostId: 'example', title: 'Workspace tools', directoryPath: '/example/collections/workspace-tools', revision: research.revision }] }))
  const before = preservation(), saveConfig = vi.spyOn(api.config, 'save').mockResolvedValue(config)
  await act(async () => root!.render(<FocusSettingsPreview values={resolveFocusPreferences(undefined)} active scene="board" onScene={() => {}} />))
  const titles = [...host.querySelectorAll<HTMLElement>('.focus-settings-preview .focus-project-lanes__axis')]
  expect(titles.length).toBeGreaterThanOrEqual(5)
  for (const title of titles) {
    for (const event of [new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }), new KeyboardEvent('keydown', { bubbles: true, cancelable: true, shiftKey: true, key: 'F10' })]) {
      await act(async () => { title.focus(); title.dispatchEvent(event); await new Promise(resolve => setTimeout(resolve, 20)) })
      expect(event.defaultPrevented).toBe(false)
      expect(menus()).toHaveLength(0)
    }
  }
  const collection = host.querySelector<HTMLElement>('[data-example-collection]')!.closest<HTMLElement>('.focus-project-lanes__row')!
  const fold = collection.querySelector<HTMLElement>('.focus-project-lanes__collection')!
  await click(fold); expect(collection.getAttribute('data-collapsed')).toBe('true')
  await click(fold); expect(collection.getAttribute('data-collapsed')).toBeNull()
  expect(api.topics.call).not.toHaveBeenCalled(); expect(api.files.reveal).not.toHaveBeenCalled()
  expect(selectWorkspace).not.toHaveBeenCalled(); expect(launchTerminal).not.toHaveBeenCalled()
  expect(api.spaceObjects.saveAvatar).not.toHaveBeenCalled(); expect(api.ui.writeClipboardText).not.toHaveBeenCalled(); expect(saveConfig).not.toHaveBeenCalled()
  expect(document.querySelector('.topic-dialog,.space-icon-picker')).toBeNull()
  expect(useAppStore.getState().config).toBe(config); preserved(before)
})

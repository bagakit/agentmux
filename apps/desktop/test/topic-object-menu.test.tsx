import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act } from 'react'
import { providerCatalogReader } from './helpers/startup-observation-api-fixture'
import { mkdtemp, rm, mkdir } from 'node:fs/promises'
import { webcrypto } from 'node:crypto'
import { ConfigOwner } from '../src/main/config-owner'
import { ConfigStore } from '../src/main/config-store'
import { SpaceObjectImages } from '../src/main/space-object-images'
import { SpaceObjectAvatarOwner } from '../src/main/space-object-avatar'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { controlledNativeImage, imageInput } from './fixtures/mote-identity-image'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '@agentmux/core/spatial-state'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { TopicCategory } from '@agentmux/core'
import type { AppConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { originalTopicAddress, directoryIdentity } from '../src/shared/space-addresses'
import { SPACE_ICON_CATALOG } from '../src/renderer/src/lib/space-object-appearance'
import { scratchTopicsScope } from '../src/renderer/src/lib/scratch-topic-snapshots'

vi.mock('electron', () => ({ app: { getPath: () => '/private-menu-avatar' }, nativeTheme: { shouldUseDarkColors: true }, nativeImage: { createFromBuffer: (bytes: Buffer) => controlledNativeImage(bytes) } }))
vi.hoisted(() => vi.stubGlobal('__AGENTMUX_WEB_PREVIEW__', true))
let avatarStore: ConfigStore
const workspace = { id: '__scratch__', hostId: 'local', path: _hygiene_fixturePath("private/scratch"), name: 'Topics', kind: 'folder' as const }
const category: TopicCategory = { categoryId: '00000000-0000-4000-8000-000000000000', hostId: 'local',
  directoryPath: _hygiene_fixturePath("private/categories/unclassified"), spaceId: directoryIdentity('local', _hygiene_fixturePath("private/categories/unclassified")),
  title: '未分类', revision: 'original-category-revision' }
const otherCategory: TopicCategory = { ...category, categoryId: '00000000-0000-4000-8000-000000000001',
  title: '工作', directoryPath: _hygiene_fixturePath("private/categories/work"), spaceId: directoryIdentity('local', _hygiene_fixturePath("private/categories/work")) }
const topic: ScratchTopicSnapshot = { id: 'view:disk', directoryPath: 'topic--view--disk', topicPath: 'topic--view--disk/topic.md',
  identityDirectoryPath: _hygiene_fixturePath("private/topics/topic--view--disk"), physicalDirectoryPath: _hygiene_fixturePath("private/topics/topic--view--disk"),
  title: '磁盘', summary: 'Original knowledge', collaborators: [] }
const topicAddress = originalTopicAddress(workspace, topic, {})!
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [workspace], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const baseline = useAppStore.getInitialState()
let root: Root, container: HTMLDivElement, dispose: (() => void) | undefined
let spatialRoot: string
let clipboard: MockInstance<typeof api.ui.writeClipboardText>

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', webcrypto)
  useAppStore.persist.clearStorage(); useAppStore.setState(baseline, true)
  vi.spyOn(api.spaceObjects, 'appearance').mockResolvedValue({ local: true, icon: null })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic])
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  spatialRoot = await mkdtemp(join(tmpdir(), 'object-menu-spatial-'))
  avatarStore = new ConfigStore(join(spatialRoot, 'avatar-config.json')); let avatarConfig = await avatarStore.save(structuredClone(config))
  const avatarConfigOwner = new ConfigOwner({ read: () => avatarConfig, save: value => avatarStore.save(value), publish: value => { avatarConfig = value } })
  const content = join(spatialRoot, 'original-avatar-content'); await mkdir(content)
  const resolveAvatar = async () => ({ hostId: 'local', directoryPath: content })
  const avatarImages = new SpaceObjectImages(resolveAvatar, controlledNativeImage)
  const avatars = new SpaceObjectAvatarOwner(avatarConfigOwner, avatarStore, avatarImages, resolveAvatar)
  const avatarContext = { actor: { kind: 'user' as const, id: 'trusted-private-menu' }, async assertCurrent() {} }
  vi.spyOn(api.objectAvatars, 'call').mockImplementation((method, value) => avatars.call(method, value, avatarContext))
  vi.mocked(api.config.get).mockImplementation(async () => structuredClone(avatarConfig))
  vi.spyOn(api.config, 'save').mockImplementation((next, before) => avatarConfigOwner.edit(before, next))
  const users = new WorkbenchUserStateStore(join(spatialRoot, 'workbench.json'))
  vi.spyOn(api.ui, 'readObjectAvatarRequests').mockImplementation(value => users.readObjectAvatarRequests(value))
  vi.spyOn(api.ui, 'keepObjectAvatarRequest').mockImplementation(value => users.keepObjectAvatarRequest(value))
  vi.spyOn(api.ui, 'retireObjectAvatarRequest').mockImplementation(value => users.retireObjectAvatarRequest(value))
  const owner = new AgentMuxSpatialStateStore(join(spatialRoot, 'spatial.json'))
  await owner.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {}, tabs: [], regions: [], tabLayouts: {}, resources: {} } })
  vi.spyOn(api.spatial, 'read').mockImplementation(() => owner.readForLayout())
  vi.spyOn(api.spatial, 'commit').mockImplementation(input => owner.commit(input))
  vi.spyOn(api.spatial, 'retainLabels').mockImplementation(values => owner.retainDisplayLabels(values))
  vi.spyOn(api.spatial, 'onChange').mockImplementation(listener => owner.subscribe(listener))
  clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue()
  dispose = await useAppStore.getState().initialize()
  await prepareRendererUpdate()
  useAppStore.setState({ topicCategories: [category, otherCategory],
    scratchTopicSnapshots: { [workspace.id]: { scope: scratchTopicsScope(workspace), revision: 0, topics: [topic], error: null, reading: false } },
    spaceZoneBindings: { [topicAddress.zoneId]: { spaceId: category.spaceId,
      workspaceId: workspace.id, topicId: topic.id, contentKind: 'topic', relations: { [category.spaceId]: true } } },
    workbenchSpaceSelection: { spaceId: otherCategory.spaceId, zoneId: null, workspaceId: workspace.id, topicId: null, tabId: null, groupId: null, regionId: null },
    activeWorkspaceId: workspace.id, agentComposerDrafts: { original: 'Unsent original draft' } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount()); await prepareRendererUpdate(); container.remove(); dispose?.(); dispose = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.persist.clearStorage()
  await rm(spatialRoot, { recursive: true, force: true })
})
function Scene() {
  return <><WorkspaceSidebar />
    <WorkspaceTopicsPanel workspace={workspace} categorySpaceId={category.spaceId} onRevealDirectory={() => {}} /></>
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)) }) }
async function waitForUi(ready: () => boolean) { for (let index = 0; index < 100; index++) { await settle(); if (ready()) return }; expect(ready()).toBe(true) }
async function mount() { await act(async () => root.render(<Scene />)); await settle() }
function button(label: string) {
  if (label === 'Save avatar') { const save = document.querySelector<HTMLButtonElement>('.space-icon-picker__save'); if (save) return save }
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(found, label).toBeDefined(); return found!
}
function categoryRow() { return button(category.title + ' overview') }
function topicRow() {
  const rows = [...container.querySelectorAll<HTMLElement>('.workspace-topic-item')]
  expect(rows).toHaveLength(1); return rows[0]!
}
async function click(element: HTMLElement) {
  if (element.classList.contains('space-icon-picker__save')) await waitForUi(() => !(element as HTMLButtonElement).disabled)
  await act(async () => element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse', button: 0 })))
  await act(async () => element.click()); await settle()
}
async function menu(element: HTMLElement, key?: string) {
  await act(async () => { element.focus(); element.dispatchEvent(key
    ? new KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true, cancelable: true })
    : new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 15, clientY: 80 })) })
  await settle()
  const result = document.querySelector<HTMLElement>('[role="menu"]'); expect(result).not.toBeNull(); return result!
}
function menuItems() { return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')] }
async function select(label: string) {
  const item = menuItems().find(node => node.textContent === label); expect(item, label).toBeDefined()
  await click(item!)
}
function quiet(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  expect(after.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
  expect(after.tabs).toEqual(before.tabs); expect(after.layouts).toEqual(before.layouts)
  expect(after.sessions).toEqual(before.sessions); expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
}

it.each([undefined, 'F10', 'ContextMenu'])('Category %s menu targets its own Space and closes on the original row', async key => {
  await mount(); const before = useAppStore.getState(); const row = categoryRow()
  expect(row.dataset.spaceIconTarget).toBe(category.spaceId)
  const content = await menu(row, key)
  expect(menuItems().map(node => node.textContent)).toEqual(['Change avatar…', 'Rename category…', 'Copy Category link'])
  expect(content.textContent).not.toContain('Move to category'); quiet(before)
  await act(async () => content.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settle()
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(row); quiet(before)
})
it('copies Category identity from context and ellipsis without navigating to its member or selected peer', async () => {
  await mount(); const before = useAppStore.getState()
  await menu(categoryRow()); await select('Copy Category link')
  expect(clipboard).toHaveBeenLastCalledWith(`amux://space/${encodeURIComponent(category.spaceId)}`); quiet(before)
  await click(button('Actions for category ' + category.title)); await select('Copy Category link')
  expect(clipboard).toHaveBeenLastCalledWith(`amux://space/${encodeURIComponent(category.spaceId)}`); quiet(before)
})
it.each(['context', 'actions'])('Category rename from %s returns focus to its exact invoker on Cancel', async entry => {
  await mount(); const before = useAppStore.getState()
  const invoker = entry === 'context' ? categoryRow() : button('Actions for category ' + category.title)
  if (entry === 'context') await menu(invoker)
  else await click(invoker)
  await select('Rename category…')
  const input = document.querySelector<HTMLInputElement>('[role="dialog"] input')
  expect(input?.value).toBe(category.title)
  expect(document.activeElement).toBe(input)
  await click(button('Cancel')); expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(invoker); quiet(before)
})
it('uses identical Topic context and ellipsis actions with its durable Zone, including after transfer', async () => {
  await mount(); const before = useAppStore.getState()
  await menu(topicRow()); const first = menuItems().map(node => node.textContent)
  await select('Copy Topic link')
  expect(clipboard).toHaveBeenLastCalledWith(`amux://zone/${encodeURIComponent(topicAddress.zoneId)}`); quiet(before)
  await click(button('Actions for ' + topic.title)); expect(menuItems().map(node => node.textContent)).toEqual(first)
  await select('Copy Topic link')
  const link = `amux://zone/${encodeURIComponent(topicAddress.zoneId)}`; expect(clipboard).toHaveBeenLastCalledWith(link); quiet(before)
  await act(async () => useAppStore.setState({ spaceZoneBindings: { [topicAddress.zoneId]: {
    ...before.spaceZoneBindings[topicAddress.zoneId]!, spaceId: otherCategory.spaceId, relations: { [otherCategory.spaceId]: true } } } }))
  await act(async () => root.render(<WorkspaceTopicsPanel workspace={workspace} categorySpaceId={otherCategory.spaceId} onRevealDirectory={() => {}} />)); await settle()
  await menu(topicRow()); await select('Copy Topic link'); expect(clipboard).toHaveBeenLastCalledWith(link)
})
it('keeps the Category icon draft after save failure, retries via original writer and restores exactly that key', async () => {
  await mount(); const before = useAppStore.getState()
  await menu(categoryRow()); await select('Change avatar…')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(category.title)
  await click(button('Book icon')); await click(button('Cancel')); expect(useAppStore.getState().spaceObjectIcons[category.spaceId]).toBeUndefined(); quiet(before)
  await click(button('Actions for category ' + category.title)); await select('Change avatar…'); await click(button('Book icon'))
  vi.spyOn(avatarStore, 'save').mockRejectedValueOnce(new Error('private owner save unavailable'))
  await click(button('Save avatar')); expect(document.querySelector('[data-object-avatar-save-notice]')?.textContent).toContain('private owner save unavailable')
  expect(button('Book icon').getAttribute('aria-pressed')).toBe('true'); expect(useAppStore.getState().spaceObjectIcons[category.spaceId]).toBeUndefined()
  vi.mocked(api.ui.requestStorageFlush).mockResolvedValue()
  await click(button('Save avatar')); await act(async () => vi.waitFor(() => expect(useAppStore.getState().spaceObjectIcons).toEqual({ [category.spaceId]: 'book' })))
  expect(categoryRow().closest('.space-category-heading')?.querySelector('[data-space-icon="book"]')).not.toBeNull(); quiet(before)
  await menu(categoryRow()); await select('Change avatar…'); await click(button('Restore automatic')); await click(button('Save avatar')); await waitForUi(() => !document.querySelector('.space-icon-picker'))
  expect(useAppStore.getState().spaceObjectIcons[category.spaceId]).toBeUndefined(); expect(categoryRow().closest('.space-category-heading')?.querySelector('[data-space-icon-source="automatic"]')).not.toBeNull(); quiet(before)
})
it('reports clipboard failure through the original error owner and keeps the current workface', async () => {
  await mount(); const before = useAppStore.getState(); const report = vi.spyOn(useAppStore.getState(), 'reportError')
  clipboard.mockRejectedValueOnce(new Error('clipboard unavailable'))
  // The production component selects the current error owner on render.
  await act(async () => useAppStore.setState({ reportError: useAppStore.getState().reportError })); await menu(categoryRow()); await select('Copy Category link')
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'clipboard unavailable' })); quiet(before)
})

function browserBitmap() {
  vi.stubGlobal('Image', class {
    width = 256; height = 256; onload: (() => void) | null = null; onerror: (() => void) | null = null
    set src(_source: string) { queueMicrotask(() => this.onload?.()) }
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(imageInput().dataUrl)
}
async function upload(name: string) {
  const input = document.querySelector<HTMLInputElement>(`input[aria-label="Choose image for ${name}"]`)
  expect(input).not.toBeNull()
  await waitForUi(() => !input!.disabled)
  Object.defineProperty(input!, 'files', { configurable: true, value: [new File(['bounded original image'], 'avatar.png', { type: 'image/png' })] })
  await act(async () => input!.dispatchEvent(new Event('change', { bubbles: true }))); await settle()
}
const uploaded = { kind: 'image' as const, fileName: 'a'.repeat(64) + '.png' }
it.each(['category','topic'] as const)('%s uploads through its original target and publishes only after Save', async kind => {
  browserBitmap()
  vi.spyOn(api.spaceObjects, 'previewAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,PREVIEW' })
  const save = vi.mocked(api.objectAvatars.call); save.mockClear()
  const read = vi.spyOn(api.spaceObjects, 'readAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,ASSET' })
  const key = kind === 'category' ? category.spaceId : topicAddress.spaceId
  const target = kind === 'category' ? { kind, categoryId: category.categoryId, objectKey: key }
    : { kind, workspaceId: workspace.id, topicId: topic.id, objectKey: key }
  await mount(); const before = useAppStore.getState()
  await menu(kind === 'category' ? categoryRow() : topicRow()); await select('Change avatar…')
  expect(document.querySelector('[data-avatar-source=face]')).toBeNull()
  await upload(kind === 'category' ? category.title : topic.title)
  expect(api.spaceObjects.previewAvatar).toHaveBeenCalledWith(target, expect.objectContaining({ mimeType: 'image/png' }))
  expect(document.querySelector('canvas')).not.toBeNull(); expect(save.mock.calls.filter(([method]) => method === 'space.object.avatar.save')).toHaveLength(0)
  expect(useAppStore.getState().spaceObjectIcons[key]).toBeUndefined()
  await click(button('Save avatar'))
  await waitForUi(() => save.mock.calls.some(([method]) => method === 'space.object.avatar.save'))
  expect(save).toHaveBeenCalledWith('space.object.avatar.save', expect.objectContaining({ target, operationId: expect.any(String), choice: { kind: 'png', dataUrl: imageInput().dataUrl } }))
  await act(async () => vi.waitFor(() => expect(useAppStore.getState().spaceObjectIcons[key]).toMatchObject({ kind: 'image' })))
  expect(read).toHaveBeenCalledWith(target, useAppStore.getState().spaceObjectIcons[key]); quiet(before)
})
it('image failure keeps the crop and original request; an explicit fresh save can publish after recovery', async () => {
  browserBitmap()
  vi.spyOn(api.spaceObjects, 'previewAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,PREVIEW' })
  vi.spyOn(avatarStore, 'confirmSaved').mockRejectedValueOnce(new Error('disk unavailable'))
  await mount(); await menu(categoryRow()); await select('Change avatar…'); await upload(category.title)
  await click(button('Save avatar')); await waitForUi(() => document.querySelector('.space-icon-picker__save')?.textContent === 'Save avatar')
  expect(document.querySelector('[data-object-avatar-save-notice]')?.textContent).toContain('disk unavailable')
  expect(document.querySelector('canvas')).not.toBeNull(); expect(useAppStore.getState().spaceObjectIcons).toEqual({})
  const originalRequests = await api.ui.readObjectAvatarRequests({ kind: 'category', categoryId: category.categoryId, objectKey: category.spaceId })
  expect(originalRequests).toHaveLength(1); expect(originalRequests[0]!.request.choice.dataUrl).toBe(imageInput().dataUrl)
  expect(button('Save avatar').disabled).toBe(true)
  await upload(category.title)
  await click(button('Save avatar'))
  await act(async () => vi.waitFor(() => expect(useAppStore.getState().spaceObjectIcons[category.spaceId]).toMatchObject({ kind: 'image' })))
  const requests = await api.ui.readObjectAvatarRequests({ kind: 'category', categoryId: category.categoryId, objectKey: category.spaceId })
  expect(requests).toHaveLength(1)
})
it('automatic Category and Topic images read distinct original targets; manual icons do not scan', async () => {
  const read = vi.mocked(api.spaceObjects.appearance).mockImplementation(async target => ({ local: true,
    icon: 'data:image/png;base64,' + (target.kind === 'category' ? target.categoryId : target.topicId) }))
  await mount()
  expect(categoryRow().closest('.space-category-heading')?.querySelector('img')?.getAttribute('src')).toContain(category.categoryId)
  expect(topicRow().querySelector('img')?.getAttribute('src')).toContain(topic.id)
  expect(read).toHaveBeenCalledWith({ kind: 'category', categoryId: category.categoryId, objectKey: category.spaceId })
  expect(read).toHaveBeenCalledWith({ kind: 'topic', workspaceId: workspace.id, topicId: topic.id, objectKey: topicAddress.spaceId })
  await act(async () => root.render(<div />)); await useAppStore.getState().setSpaceObjectIcon(category.spaceId, 'book')
  await useAppStore.getState().setSpaceObjectIcon(topicAddress.spaceId, 'code'); read.mockClear(); await mount()
  expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'topic' }))
  expect(read).not.toHaveBeenCalledWith(expect.objectContaining({ categoryId: category.categoryId }))
})

it('equivalent image targets preserve manual icon memoization through unrelated Session updates', async () => {
  await useAppStore.getState().setSpaceObjectIcon(topicAddress.spaceId, 'book')
  const book = vi.spyOn(SPACE_ICON_CATALOG.book, 'Icon')
  await mount(); expect(book.mock.calls.length).toBeGreaterThan(0); book.mockClear()
  vi.mocked(api.spaceObjects.appearance).mockClear()
  for (let revision = 0; revision < 10; revision++) await act(async () => {
    useAppStore.setState({ sessions: [], timelines: { unrelated: { agentSessionId: 'unrelated', revision, items: [] } } })
  })
  expect(book).not.toHaveBeenCalled(); expect(api.spaceObjects.appearance).not.toHaveBeenCalled()
})

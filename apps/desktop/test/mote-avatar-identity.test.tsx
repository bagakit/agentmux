// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../src/renderer/src/lib/api'
import { prepareRendererUpdate, useAppStore } from '../src/renderer/src/store'
import { topicSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { SpaceIconPicker } from '../src/renderer/src/components/SpaceIconPicker'
import { createMoteApp, moteClick, settleMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { customAgent, customMoteId, customTab, defaultTab, moteConfig, moteTopics, savedMoteKey, scratchWorkspace } from './fixtures/mote-workface'
import { PMO_TEAMS_TOPIC_ID } from '../src/shared/scratch-topics'
const primary = topicSpaceIconTarget(scratchWorkspace, moteTopics[0]!), custom = topicSpaceIconTarget(scratchWorkspace, moteTopics[1]!)
const primaryRef = { kind: 'image' as const, fileName: 'a'.repeat(64) + '.png' }, customRef = { kind: 'image' as const, fileName: 'b'.repeat(64) + '.png' }
let app: MoteAppFixture, dispose: (() => void) | undefined
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(api.config, 'get').mockResolvedValue(moteConfig)
  vi.spyOn(api.providers, 'list').mockResolvedValue([]); vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  dispose = await useAppStore.getState().initialize(); await prepareRendererUpdate()
  app = createMoteApp()
  vi.spyOn(api.scratch, 'readMoteAvatar').mockImplementation(async (_workspace, topic) => ({ width: 256, height: 256, dataUrl: 'data:image/png;base64,' + (topic === customMoteId ? 'CUSTOM' : 'PRIMARY') }))
})
afterEach(async () => { await app.dispose(); dispose?.(); dispose = undefined; vi.unstubAllGlobals() })
function images(owner: ParentNode = app.container) { return [...owner.querySelectorAll<HTMLImageElement>('[data-space-icon-source="image"] img')] }
function button(label: string) {
  const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(value => value.textContent === label || value.getAttribute('aria-label') === label)
  expect(found, label).toBeDefined(); return found!
}
async function select(topic: string) { const row = app.panel().querySelector<HTMLElement>(`[data-mote-topic-id="${topic}"]`); expect(row).not.toBeNull(); await moteClick(row!) }
async function menu() {
  await act(async () => app.entry().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 10, clientY: 50 })))
  await settleMoteApp()
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(one => one.textContent === 'Change avatar…')
  expect(item).toBeDefined(); await moteClick(item!)
  expect(document.querySelector('.space-icon-picker[role="dialog"]')).not.toBeNull()
}
function quiet(before: ReturnType<typeof useAppStore.getState>) {
  const after = useAppStore.getState()
  expect(after.sessions).toBe(before.sessions); expect(after.tabs).toBe(before.tabs)
  expect(after.agentFocus.execution).toEqual(before.agentFocus.execution); expect(after.agentComposerDrafts).toEqual(before.agentComposerDrafts)
  expect(app.launch).not.toHaveBeenCalled(); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled(); expect(app.enqueue).not.toHaveBeenCalled()
}
it('same selected custom and primary real Footer, cards, avatars and full Space tree resolve distinct original assets', async () => {
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  await useAppStore.getState().setSpaceObjectIcon(primary.key, primaryRef); await useAppStore.getState().setSpaceObjectIcon(custom.key, customRef)
  app.listTopics.mockResolvedValue(moteTopics.map(topic => topic.id === PMO_TEAMS_TOPIC_ID ? { ...topic, title: 'Renamed coordinator' } : topic))
  await useAppStore.getState().refreshScratchTopics(scratchWorkspace.id, true)
  await app.mount(); const before = useAppStore.getState()
  const primaryRow = app.panel().querySelector(`[data-mote-topic-id="${PMO_TEAMS_TOPIC_ID}"]`)
  expect(primaryRow?.getAttribute('aria-label')).toContain('Renamed coordinator · Primary · ')
  expect(primaryRow?.querySelector('.mote-chooser__status-text')?.textContent).toContain('Primary · ')
  expect(app.panel().querySelector(`[data-mote-topic-id="${customMoteId}"]`)?.getAttribute('aria-label')).not.toContain('Primary')
  expect(images().length).toBeGreaterThan(1)
  expect(app.entry().querySelector('img')?.getAttribute('src')).toContain('PRIMARY')
  await select(customMoteId)
  expect(app.entry().dataset.moteTargetTab).toBe(customTab.id)
  expect(app.entry().querySelector('img')?.getAttribute('src')).toContain('CUSTOM')
  expect(app.panel().querySelector(`[data-mote-topic-id="${customMoteId}"] img`)?.getAttribute('src')).toContain('CUSTOM')
  await moteClick(button('Show Mote avatars only'))
  expect(app.panel().querySelector(`[data-mote-topic-id="${customMoteId}"] img`)?.getAttribute('src')).toContain('CUSTOM')
  await moteClick(button('Open Mote Space'))
  await act(async () => useAppStore.setState({ projectRailOpen: true })); await settleMoteApp()
  const space = [...app.container.querySelectorAll<HTMLElement>('[data-space-icon-target]')].filter(node => node.dataset.spaceIconTarget === custom.key)
  expect(space).toHaveLength(1)
  for (const node of space) expect(node.querySelector('img')?.getAttribute('src')).toContain('CUSTOM')
  await act(async () => useAppStore.getState().setSpaceObjectIcon(custom.key, null)); await settleMoteApp()
  expect(app.entry().querySelector('[data-space-icon-source="automatic"]')).not.toBeNull()
  const restored = [...app.container.querySelectorAll<HTMLElement>('[data-space-icon-target]')].filter(node => node.dataset.spaceIconTarget === custom.key)
  expect(restored).toHaveLength(1)
  for (const node of restored) expect(node.querySelector('[data-space-icon-source="image"]')).toBeNull()
  quiet(before)
})
it('unknown exact saved Tab without a confirmed Topic cannot borrow the primary choice or its edit target', async () => {
  await useAppStore.getState().setSpaceObjectIcon(primary.key, primaryRef)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTabId: 'unknown-exact-tab' }))
  await app.mount()
  expect(app.entry().dataset.moteTargetTab).toBe('unknown-exact-tab')
  expect(app.entry().querySelector('[data-space-icon-source="image"]')).toBeNull()
  expect(app.entry().querySelector('img')).toBeNull()
  expect(app.entry().dataset.spaceIconTarget).toBeUndefined()
  expect(JSON.parse(localStorage.getItem(savedMoteKey)!).targetTabId).toBe('unknown-exact-tab')
})
it.each(['localStorage', 'platform'] as const)('failed %s save keeps both original confirmed consumers and actual picker draft, retry publishes once', async failure => {
  await useAppStore.getState().setSpaceObjectIcon(primary.key, primaryRef)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  useAppStore.setState({ projectRailOpen: true }); await app.mount(); const before = useAppStore.getState(); await menu()
  expect(app.panel().matches(':popover-open')).toBe(false)
  await moteClick(button('Book icon'))
  if (failure === 'localStorage') vi.spyOn(window.localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota unavailable') })
  else vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('platform unconfirmed'))
  await moteClick(button('Save avatar'))
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(primaryRef)
  expect(button('Book icon').getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('unconfirmed')
  expect(app.entry().querySelector('img')?.getAttribute('src')).toContain('PRIMARY')
  const other = app.container.querySelector<HTMLElement>(`.project-rail [data-space-icon-target='${primary.key}']`)
  expect(other).not.toBeNull(); expect(other!.querySelector('img')?.getAttribute('src')).toContain('PRIMARY')
  if (failure === 'platform') vi.mocked(api.ui.requestStorageFlush).mockResolvedValue()
  await moteClick(button('Retry saving'))
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toBe('book')
  expect(document.querySelector('.space-icon-picker[role="dialog"]')).toBeNull()
  expect(app.entry().querySelector('[data-space-icon="book"]')).not.toBeNull()
  quiet(before)
})
it('a failing latest local write after the request keeps confirmed choice and current unrelated Workbench facts', async () => {
  await useAppStore.getState().setSpaceObjectIcon(primary.key, primaryRef)
  let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => pending)
  const native = window.localStorage.setItem.bind(window.localStorage); let calls = 0
  vi.spyOn(window.localStorage, 'setItem').mockImplementation(function(name, value) { if (name === 'agentmux-workbench-v1' && ++calls === 2) throw new Error('latest projection quota'); return native(name, value) })
  const saving = useAppStore.getState().setSpaceObjectIcon(primary.key, 'book')
  useAppStore.getState().togglePinnedItem('scope', 'retained-pin')
  release(); await expect(saving).rejects.toThrow('latest projection quota')
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(primaryRef)
  expect(useAppStore.getState().pinnedItems.scope).toEqual(['retained-pin'])
  await new Promise(resolve => setTimeout(resolve, 450))
  const durable = JSON.parse(localStorage.getItem('agentmux-workbench-v1')!)
  expect(durable.state.spaceObjectIcons[primary.key]).toEqual(primaryRef)
  expect(durable.state.pinnedItems.scope).toEqual(['retained-pin'])
})
it('old same-object A rejection cannot replace the later confirmed B choice or latest Workbench data', async () => {
  let reject!: (cause: Error) => void, phase = 'A'
  const pending = new Promise<void>((_resolve, failure) => { reject = failure })
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => phase === 'A' ? pending : Promise.resolve())
  const first = useAppStore.getState().setSpaceObjectIcon(primary.key, primaryRef)
  phase = 'B'; useAppStore.getState().togglePinnedItem('scope', 'later')
  await useAppStore.getState().setSpaceObjectIcon(primary.key, customRef)
  reject(new Error('old A rejected')); await expect(first).rejects.toThrow('old A rejected')
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(customRef)
  expect(useAppStore.getState().pinnedItems.scope).toEqual(['later'])
  expect(JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.spaceObjectIcons[primary.key]).toEqual(customRef)
})
it('late save completion and failure do not close or leave busy in a newly selected or reopened editor', async () => {
  let release!: () => void
  const saving = new Promise<void>(resolve => { release = resolve })
  vi.mocked(api.ui.requestStorageFlush).mockImplementation(() => saving)
  const close = vi.fn()
  await app.mount(<SpaceIconPicker target={primary} onClose={close} />)
  await moteClick(button('Book icon')); await moteClick(button('Save avatar'))
  expect(button('Saving…').disabled).toBe(true)
  await app.mount(<SpaceIconPicker target={custom} onClose={close} />)
  expect(button('Save avatar').disabled).toBe(false)
  release(); await settleMoteApp()
  expect(close).not.toHaveBeenCalled()
  expect(document.querySelector('.space-icon-picker[role="dialog"]')?.textContent).toContain(custom.name)
  expect(button('Save avatar').disabled).toBe(false)
})
it('Cancel and Escape leave choice and asset writes untouched through the real original picker', async () => {
  const save = vi.spyOn(api.scratch, 'saveMoteAvatar')
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: customMoteId, targetTabId: customTab.id }))
  await app.mount(); const before = useAppStore.getState(); await menu()
  await moteClick(button('Book icon')); await moteClick(button('Cancel'))
  expect(useAppStore.getState().spaceObjectIcons).toEqual({})
  await menu(); await moteClick(button('Brain icon'))
  await act(async () => document.querySelector('.space-icon-picker[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))); await settleMoteApp()
  expect(document.querySelector('.space-icon-picker[role="dialog"]')).toBeNull()
  expect(save).not.toHaveBeenCalled(); quiet(before)
})
it('avatar consumer isolates the original directory key when the same workspace/topic locator changes and retains same-key image on read failure', async () => {
  const target = primary.avatarTarget!
  const node = (key: string, ref = primaryRef) => <div data-isolated-avatar><SpaceObjectIcon kind="mote" name="Mote" manualIcon={ref} avatarWorkspaceId={target.workspaceId} avatarTopicId={target.topicId} avatarObjectKey={key} /></div>
  await app.mount(node(primary.key))
  const isolate = () => app.container.querySelector<HTMLElement>('[data-isolated-avatar]')!
  expect(isolate()).not.toBeNull(); expect(isolate().querySelector('img')?.getAttribute('src')).toContain('PRIMARY')
  vi.mocked(api.scratch.readMoteAvatar).mockRejectedValue(new Error('asset read unavailable'))
  await app.mount(node(primary.key, customRef))
  expect(isolate().querySelector('img')?.getAttribute('src')).toContain('PRIMARY')
  await app.mount(node('["local","/replacement/topic--launcher--leader"]'))
  expect(isolate().querySelector('img')).toBeNull()
  expect(api.scratch.readMoteAvatar).toHaveBeenLastCalledWith(target.workspaceId, target.topicId, primaryRef, '["local","/replacement/topic--launcher--leader"]')
})
function browserBitmap() {
  vi.stubGlobal('Image', class {
    width = 256; height = 256; onload: (() => void) | null = null; onerror: (() => void) | null = null
    set src(_source: string) { queueMicrotask(() => this.onload?.()) }
  })
}
async function chooseImage() {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose Mote image"]')
  expect(input).not.toBeNull()
  Object.defineProperty(input!, 'files', { configurable: true, value: [new File(['bounded image'], 'avatar.png', { type: 'image/png' })] })
  await act(async () => input!.dispatchEvent(new Event('change', { bubbles: true }))); await settleMoteApp()
}
it('real image draft previews without asset writes; Save writes the captured original crop and publishes the same choice', async () => {
  browserBitmap()
  const draw = vi.fn()
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: draw } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CROP')
  vi.spyOn(api.scratch, 'previewMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,PREVIEW' })
  const save = vi.spyOn(api.scratch, 'saveMoteAvatar').mockResolvedValue(customRef)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: true, targetTopicId: customMoteId, targetTabId: customTab.id }))
  await app.mount(); await menu(); await chooseImage()
  expect(draw).toHaveBeenCalled(); expect(document.querySelector('canvas[aria-label="Circular avatar preview"]')).not.toBeNull()
  expect(save).not.toHaveBeenCalled(); expect(useAppStore.getState().spaceObjectIcons).toEqual({})
  expect(button('Save avatar').disabled).toBe(false); await moteClick(button('Save avatar'))
  expect(save).toHaveBeenCalledWith(custom.avatarTarget!.workspaceId, customMoteId, { mimeType: 'image/png', dataUrl: 'data:image/png;base64,CROP' }, custom.key)
  expect(useAppStore.getState().spaceObjectIcons[custom.key]).toEqual(customRef)
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toBeUndefined()
})
it('unavailable canvas never reports ready or enables saving an empty crop', async () => {
  browserBitmap(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  vi.spyOn(api.scratch, 'previewMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,PREVIEW' })
  const save = vi.spyOn(api.scratch, 'saveMoteAvatar')
  await app.mount(<SpaceIconPicker target={primary} onClose={vi.fn()} />); await chooseImage()
  expect(document.querySelector('.space-icon-picker [role="alert"]')?.textContent).toContain('canvas is unavailable')
  expect(button('Save avatar').disabled).toBe(true); expect(save).not.toHaveBeenCalled()
})
it('cancelled late preparation cannot populate a new editor or write either object asset', async () => {
  let resolve!: (image: { width: number; height: number; dataUrl: string }) => void
  vi.spyOn(api.scratch, 'previewMoteAvatar').mockImplementation(() => new Promise(success => { resolve = success }))
  const save = vi.spyOn(api.scratch, 'saveMoteAvatar')
  await app.mount(<SpaceIconPicker target={primary} onClose={vi.fn()} />); await chooseImage()
  expect(api.scratch.previewMoteAvatar).toHaveBeenCalledTimes(1)
  await app.mount(<SpaceIconPicker target={null} onClose={vi.fn()} />)
  await app.mount(<SpaceIconPicker target={custom} onClose={vi.fn()} />)
  await act(async () => resolve({ width: 256, height: 256, dataUrl: 'data:image/png;base64,LATE' })); await settleMoteApp()
  expect(document.querySelector('canvas')).toBeNull(); expect(save).not.toHaveBeenCalled()
  expect(button('Save avatar').disabled).toBe(false)
})
it('an old image asset finishing after same-key editor B confirms cannot enter the choice owner and overwrite B', async () => {
  browserBitmap(); vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), drawImage: vi.fn() } as never)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CROP')
  vi.spyOn(api.scratch, 'previewMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,PREVIEW' })
  let finish!: (ref: typeof primaryRef) => void
  vi.spyOn(api.scratch, 'saveMoteAvatar').mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const close = vi.fn()
  await app.mount(<SpaceIconPicker target={primary} onClose={close} />); await chooseImage(); await moteClick(button('Save avatar'))
  expect(api.scratch.saveMoteAvatar).toHaveBeenCalledTimes(1)
  await app.mount(<SpaceIconPicker target={null} onClose={close} />)
  await app.mount(<SpaceIconPicker target={primary} onClose={close} />)
  await moteClick(button('Book icon')); await moteClick(button('Save avatar'))
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toBe('book'); expect(close).toHaveBeenCalledTimes(1)
  await act(async () => finish(primaryRef)); await settleMoteApp()
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toBe('book'); expect(close).toHaveBeenCalledTimes(1)
})
it('the reachable same-image explicit Save retries failed Footer and Space consumers without a window reload', async () => {
  vi.mocked(api.scratch.readMoteAvatar).mockRejectedValue(new Error('asset temporarily unavailable'))
  await useAppStore.getState().setSpaceObjectIcon(primary.key, primaryRef)
  localStorage.setItem(savedMoteKey, JSON.stringify({ open: false, targetTopicId: PMO_TEAMS_TOPIC_ID, targetTabId: defaultTab.id }))
  useAppStore.setState({ projectRailOpen: true }); await app.mount()
  const failed = useAppStore.getState().spaceObjectIcons[primary.key]
  expect(app.entry().querySelector('img')).toBeNull(); expect(app.entry().querySelector('[data-space-icon-source="image"]')?.getAttribute('title')).toContain('Change avatar')
  vi.mocked(api.scratch.readMoteAvatar).mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,RECOVERED' })
  await menu(); await moteClick(button('Save avatar'))
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(primaryRef)
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).not.toBe(failed)
  expect(app.entry().querySelector('img')?.getAttribute('src')).toContain('RECOVERED')
  expect(app.container.querySelector(`.project-rail [data-space-icon-target='${primary.key}'] img`)?.getAttribute('src')).toContain('RECOVERED')
})
it('preparation rejection exposes choose-image-again rather than a false saving retry and never publishes a choice', async () => {
  vi.spyOn(api.scratch, 'previewMoteAvatar').mockRejectedValue(new Error('image cannot decode'))
  const save = vi.spyOn(api.scratch, 'saveMoteAvatar')
  await app.mount(<SpaceIconPicker target={primary} onClose={vi.fn()} />); await chooseImage()
  const notice = document.querySelector('.space-icon-picker [role="alert"]')
  expect(notice).not.toBeNull(); expect(notice!.textContent).toContain('Image preparation failed')
  expect(notice!.textContent).toContain('choose image again'); expect(notice!.textContent).not.toContain('Saving is unconfirmed')
  expect([...document.querySelectorAll('button')].map(node => node.textContent)).not.toContain('Retry saving')
  expect(save).not.toHaveBeenCalled(); expect(useAppStore.getState().spaceObjectIcons).toEqual({})
})

it('the original image picker declares PNG/JPEG and rejects unsupported formats without preview or asset writes', async () => {
  const preview = vi.spyOn(api.scratch, 'previewMoteAvatar'), save = vi.spyOn(api.scratch, 'saveMoteAvatar')
  await app.mount(<SpaceIconPicker target={primary} onClose={vi.fn()} />)
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Choose Mote image"]')
  expect(input).not.toBeNull(); expect(input!.accept).toBe('image/png,image/jpeg')
  Object.defineProperty(input!, 'files', { configurable: true, value: [new File(['unsupported image'], 'avatar.webp', { type: 'image/webp' })] })
  await act(async () => input!.dispatchEvent(new Event('change', { bubbles: true }))); await settleMoteApp()
  expect(document.querySelector('.space-icon-picker [role="alert"]')?.textContent).toContain('Choose a static PNG or JPEG')
  expect(preview).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  expect(useAppStore.getState().spaceObjectIcons).toEqual({})
})

it.each(['ready', 'unavailable-canvas'] as const)('choosing the same image again remounts the actual crop and makes Save reachable after %s', async first => {
  browserBitmap(); const draw = vi.fn(), context = { clearRect: vi.fn(), drawImage: draw }
  const get = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(first === 'ready' ? context as never : null)
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,CROP')
  const preview = vi.spyOn(api.scratch, 'previewMoteAvatar').mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,SAME-PREVIEW' })
  const save = vi.spyOn(api.scratch, 'saveMoteAvatar').mockResolvedValue(primaryRef)
  await app.mount(<SpaceIconPicker target={primary} onClose={vi.fn()} />); await chooseImage()
  const firstCanvas = document.querySelector('canvas[aria-label="Circular avatar preview"]')
  expect(firstCanvas).not.toBeNull(); expect(button('Save avatar').disabled).toBe(first !== 'ready')
  get.mockReturnValue(context as never); const before = draw.mock.calls.length
  await chooseImage()
  expect(preview).toHaveBeenCalledTimes(2)
  expect(document.querySelector('canvas[aria-label="Circular avatar preview"]')).not.toBe(firstCanvas)
  expect(draw.mock.calls.length).toBeGreaterThan(before); expect(button('Save avatar').disabled).toBe(false)
  await moteClick(button('Save avatar')); expect(save).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().spaceObjectIcons[primary.key]).toEqual(primaryRef)
})

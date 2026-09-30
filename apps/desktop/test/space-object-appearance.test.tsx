// @vitest-environment happy-dom
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppConfig, ScratchTopicSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import { SPACE_ICON_CATALOG, folderSpaceIconTarget, topicSpaceIconTarget, type SpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { WorkspaceSidebar } from '../src/renderer/src/components/WorkspaceSidebar'
import { WorkspaceTopicsPanel } from '../src/renderer/src/components/WorkspaceTopicsPanel'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { SpaceIconPicker } from '../src/renderer/src/components/SpaceIconPicker'

const scratch = { id: '__scratch__', hostId: 'local', path: '/topics', name: 'Topics', kind: 'folder' as const }
const folderWorkspace = { id: 'project', hostId: 'local', path: '/work/project', name: 'Project', kind: 'folder' as const }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [scratch, folderWorkspace], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const topic: ScratchTopicSnapshot = { id: 'view:notes', directoryPath: 'topic--view--notes', topicPath: 'topic--view--notes/topic.md', title: 'Planning notes', summary: 'Shared notes', collaborators: [] }
const mote: ScratchTopicSnapshot = { ...topic, id: 'view:researcher', directoryPath: 'topic--view--researcher', title: 'Researcher',
  soul: { path: 'topic--view--researcher/SOUL.md', content: 'Research', version: 'one' } }
const topicTarget = topicSpaceIconTarget(scratch, topic)
const moteTarget = topicSpaceIconTarget(scratch, mote)
const folderTarget = folderSpaceIconTarget({ hostId: 'local', repoPath: folderWorkspace.path, name: folderWorkspace.name })
let root: Root
let container: HTMLDivElement
let dispose: (() => void) | undefined
const state = useAppStore.getInitialState()

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useAppStore.persist.clearStorage()
  useAppStore.setState(state, true)
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([topic, mote])
  vi.spyOn(api.workspaces, 'appearance').mockResolvedValue({ kind: 'repository', icon: 'data:image/png;base64,automatic' })
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  dispose = await useAppStore.getState().initialize()
  expect(useAppStore.getState().loading).toBe(false)
  await prepareRendererUpdate()
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); dispose?.(); dispose = undefined
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  useAppStore.persist.clearStorage()
})

async function mount(children: ReactNode = <><WorkspaceSidebar /><WorkspaceTopicsPanel workspace={scratch} onRevealDirectory={() => {}} /></>) {
  await act(async () => root.render(children))
}
function row(key: string, overview = false) {
  const scope = overview ? container.querySelector('.workspace-topic-list') : container.querySelector('.project-rail')
  expect(scope).not.toBeNull()
  const rows = [...scope!.querySelectorAll<HTMLElement>('[data-space-icon-target]')]
  expect(rows.length).toBeGreaterThan(0)
  const value = rows.find(node => node.dataset.spaceIconTarget === key)
  expect(value).toBeDefined()
  return value!
}
function button(label: string) {
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')]
  expect(buttons.length).toBeGreaterThan(0)
  const result = buttons.find(node => node.getAttribute('aria-label') === label || node.textContent === label)
  expect(result, label).toBeDefined()
  return result!
}
async function click(label: string) {
  await act(async () => button(label).click())
  // Radix releases its focus scope on a task after the DOM unmount.
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
}
async function menuFor(key: string, overview = false) {
  const target = row(key, overview)
  target.focus()
  await act(async () => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2, clientX: 12, clientY: 80 })))
  const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
  expect(items.length).toBeGreaterThan(0)
  const item = items.find(node => node.textContent === 'Change icon…' || node.textContent === 'Change avatar…')
  expect(item).toBeDefined()
  await act(async () => item!.click())
  await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
}
function manual(key: string, overview = false) { return row(key, overview).querySelector<HTMLElement>('[data-space-icon-source="manual"]') }
function storedIcons() { return JSON.parse(localStorage.getItem('agentmux-workbench-v1')!).state.spaceObjectIcons }

it.each(['F10', 'ContextMenu'] as const)('opens live object menus with %s and returns focus to the current object after Escape', async key => {
  await mount()
  const targets = [row(moteTarget.key), row(topicTarget.key), row(folderTarget.key), row(topicTarget.key, true)]
  expect(targets).toHaveLength(4)
  for (const target of targets) {
    target.focus()
    await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey: key === 'F10', bubbles: true })))
    const menu = document.querySelector<HTMLElement>('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(menu!.textContent).toMatch(/Change (icon|avatar)…/)
    await act(async () => menu!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => new Promise(resolve => setTimeout(resolve, 10)))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(target)
  }
})

it('changes real Mote, Topic and Folder rows through their actual menus and shares Topic identity with the overview', async () => {
  await mount()
  const targets = [moteTarget, topicTarget, folderTarget]
  expect(targets).toHaveLength(3)
  for (const target of targets) {
    await menuFor(target.key)
    const choices = document.querySelectorAll('[data-space-icon-choice]')
    expect(choices).toHaveLength(Object.keys(SPACE_ICON_CATALOG).length)
    expect(choices.length).toBeGreaterThan(0)
    await click('Book icon'); await click(target.avatarTarget ? 'Save avatar' : 'Save icon')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(manual(target.key)?.dataset.spaceIcon).toBe('book')
  }
  expect(manual(topicTarget.key, true)?.dataset.spaceIcon).toBe('book')
  expect(storedIcons()).toEqual({ [moteTarget.key]: 'book', [topicTarget.key]: 'book', [folderTarget.key]: 'book' })
  await menuFor(topicTarget.key, true)
  await click('Compass icon'); await click('Save icon')
  expect(manual(topicTarget.key)?.dataset.spaceIcon).toBe('compass')
  expect(manual(topicTarget.key, true)?.dataset.spaceIcon).toBe('compass')
  expect(document.activeElement).toBe(row(topicTarget.key, true))
})

it('leaves cancellation untouched and Restore automatic removes exactly one authored override', async () => {
  await useAppStore.getState().setSpaceObjectIcon(moteTarget.key, 'brain')
  await useAppStore.getState().setSpaceObjectIcon(topicTarget.key, 'book')
  await mount()
  await menuFor(topicTarget.key)
  await click('Folder icon'); await click('Cancel')
  expect(storedIcons()).toEqual({ [moteTarget.key]: 'brain', [topicTarget.key]: 'book' })
  expect(manual(topicTarget.key)?.dataset.spaceIcon).toBe('book')
  await menuFor(topicTarget.key)
  await click('Restore automatic'); await click('Save icon')
  expect(storedIcons()).toEqual({ [moteTarget.key]: 'brain' })
  expect(manual(topicTarget.key)).toBeNull()
  expect(row(topicTarget.key).querySelector('[data-space-icon-source="automatic"]')).not.toBeNull()
})

it('manual Folder beats the automatic image including a response arriving after the choice', async () => {
  let release!: (appearance: { kind: 'repository'; icon: string }) => void
  vi.mocked(api.workspaces.appearance).mockImplementation(() => new Promise(resolve => { release = resolve }))
  await mount()
  expect(api.workspaces.appearance).toHaveBeenCalledWith(folderWorkspace.id)
  await menuFor(folderTarget.key)
  await click('Code icon'); await click('Save icon')
  expect(manual(folderTarget.key)?.dataset.spaceIcon).toBe('code')
  await act(async () => release({ kind: 'repository', icon: 'data:image/png;base64,late' }))
  expect(manual(folderTarget.key)?.dataset.spaceIcon).toBe('code')
  expect(row(folderTarget.key).querySelector('img')).toBeNull()
})

it('a restored manual Folder does not mount or probe the automatic consumer', async () => {
  await useAppStore.getState().setSpaceObjectIcon(folderTarget.key, 'code')
  vi.mocked(api.workspaces.appearance).mockClear()
  await mount()
  expect(manual(folderTarget.key)?.dataset.spaceIcon).toBe('code')
  expect(api.workspaces.appearance).not.toHaveBeenCalled()
  await menuFor(folderTarget.key); await click('Restore automatic'); await click('Save icon')
  expect(api.workspaces.appearance).toHaveBeenCalledTimes(1)
  expect(row(folderTarget.key).querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,automatic')
})

it.each(['localStorage', 'platform'] as const)('keeps the actual picker draft open after %s failure and saves it on Retry', async failure => {
  await mount()
  await menuFor(topicTarget.key)
  await click('Book icon')
  if (failure === 'localStorage') vi.spyOn(window.localStorage, 'setItem').mockImplementationOnce(() => { throw new Error('quota unavailable') })
  else vi.mocked(api.ui.requestStorageFlush).mockRejectedValue(new Error('storage owner unconfirmed'))
  await click('Save icon')
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  expect(document.querySelector('.space-icon-picker [role="alert"]')?.textContent).toContain('Your choice is kept')
  expect(button('Book icon').getAttribute('aria-pressed')).toBe('true')
  expect(useAppStore.getState().workbenchSaveWarning).not.toBeNull()
  if (failure === 'platform') vi.mocked(api.ui.requestStorageFlush).mockResolvedValue()
  await click('Retry saving')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(storedIcons()).toEqual({ [topicTarget.key]: 'book' })
  expect(useAppStore.getState().workbenchSaveWarning).toBeNull()
})

it('memo identities ignore unrelated Session/timeline and different-key manual changes without adding per-row store consumers', async () => {
  await useAppStore.getState().setSpaceObjectIcon(topicTarget.key, 'book')
  await useAppStore.getState().setSpaceObjectIcon(folderTarget.key, 'code')
  const book = vi.spyOn(SPACE_ICON_CATALOG.book.Icon as unknown as { render: (...args: unknown[]) => ReactNode }, 'render')
  const code = vi.spyOn(SPACE_ICON_CATALOG.code.Icon as unknown as { render: (...args: unknown[]) => ReactNode }, 'render')
  await mount()
  expect(book.mock.calls.length).toBeGreaterThan(0)
  expect(code.mock.calls.length).toBeGreaterThan(0)
  book.mockClear(); code.mockClear(); vi.mocked(api.workspaces.appearance).mockClear()
  const stringify = vi.spyOn(JSON, 'stringify')
  for (let index = 0; index < 100; index += 1) await act(async () => {
    useAppStore.setState({ sessions: [], timelines: { unrelated: { agentSessionId: 'unrelated', revision: index, items: [] } } })
  })
  expect(book).not.toHaveBeenCalled(); expect(code).not.toHaveBeenCalled()
  expect(api.workspaces.appearance).not.toHaveBeenCalled()
  // Existing row geometry/keys may serialize small values; no durable workbench projection is written.
  const projectedWrites = stringify.mock.calls.filter(([value]) => value && typeof value === 'object' && 'state' in value)
  expect(projectedWrites).toEqual([])
  stringify.mockRestore()
  await act(async () => useAppStore.getState().setSpaceObjectIcon(moteTarget.key, 'brain'))
  expect(book).not.toHaveBeenCalled(); expect(code).not.toHaveBeenCalled()
  expect(manual(moteTarget.key)?.dataset.spaceIcon).toBe('brain')
})

it('the pure icon reads a manual choice first even when an automatic Folder can be resolved immediately', async () => {
  function Consumer() {
    const [target, setTarget] = useState<SpaceIconTarget | null>(null)
    const overrides = useAppStore(state => state.spaceObjectIcons)
    return <><button data-space-icon-target={folderTarget.key} onClick={() => setTarget(folderTarget)}>
      <SpaceObjectIcon kind="folder" name="Project" workspaceId={folderWorkspace.id} manualIcon={overrides[folderTarget.key] ?? null} />
    </button><SpaceIconPicker target={target} onClose={() => setTarget(null)} /></>
  }
  await useAppStore.getState().setSpaceObjectIcon(folderTarget.key, 'code')
  await mount(<Consumer />)
  expect(container.querySelector('[data-space-icon="code"]')).not.toBeNull()
  expect(api.workspaces.appearance).not.toHaveBeenCalled()
})

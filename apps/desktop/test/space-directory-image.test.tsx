import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { act, useState } from 'react'
import type { Root } from 'react-dom/client'
import { createClientUiRoot } from './helpers/client-ui-render'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpaceObjectIcon } from '../src/renderer/src/components/SpaceObjectIcon'
import { SpaceIconPicker } from '../src/renderer/src/components/SpaceIconPicker'
import { categorySpaceIconTarget, folderSpaceIconTarget } from '../src/renderer/src/lib/space-object-appearance'
import { directoryIdentity } from '../src/shared/space-addresses'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore, prepareRendererUpdate } from '../src/renderer/src/store'
import type { AppConfig } from '../src/shared/contracts'

const initial = useAppStore.getState()
const target = categorySpaceIconTarget({ categoryId: '00000000-0000-4000-8000-000000000007',
  spaceId: directoryIdentity('local', _hygiene_fixturePath("private/category/retry")), title: 'Retry this Category' })
const saved = { kind: 'image' as const, fileName: 'b'.repeat(64) + '.png' }
const folder = folderSpaceIconTarget({ hostId: 'local', repoPath: _hygiene_fixturePath("private/project/retry"), name: 'Retry this Project' })
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }], executors: {},
  workspaces: [{ id: 'original-project-workspace', hostId: 'local', path: _hygiene_fixturePath("private/project/retry"), name: folder.name, kind: 'folder' }],
  appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
let root: Root, container: HTMLDivElement, dispose: (() => void) | undefined
function Scene() {
  const [editing, setEditing] = useState(false)
  const choice = useAppStore(state => state.spaceObjectIcons[target.key] ?? null)
  return <><div data-original-row><SpaceObjectIcon kind="category" name={target.name} manualIcon={choice} imageTarget={target.imageTarget} /></div>
    <button type="button" onClick={() => setEditing(true)}>Change avatar</button>
    <SpaceIconPicker target={editing ? target : null} onClose={() => setEditing(false)} /></>
}
function FolderScene() {
  const [editing, setEditing] = useState(false)
  const choice = useAppStore(state => state.spaceObjectIcons[folder.key] ?? null)
  return <><div data-original-row><SpaceObjectIcon kind="folder" name={folder.name} manualIcon={choice}
    workspaceId="original-project-workspace" folderIdentityKey={folder.key} /></div>
    <button type="button" onClick={() => setEditing(true)}>Change icon</button>
    <SpaceIconPicker target={editing ? folder : null} onClose={() => setEditing(false)} /></>
}
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) }) }
async function click(label: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label)
  expect(button, label).toBeDefined(); await act(async () => button!.click()); await settle()
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); window.localStorage.clear(); useAppStore.setState(initial, true)
  vi.spyOn(api.ui, 'requestStorageFlush').mockResolvedValue()
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockResolvedValue([])
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.scratch, 'listTopics').mockResolvedValue([])
  dispose = await useAppStore.getState().initialize()
  await prepareRendererUpdate()
  vi.spyOn(useAppStore.getState(), 'reportError').mockImplementation(() => {})
  container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); useAppStore.setState(initial, true); window.localStorage.clear() })

it.each(['automatic', 'uploaded'] as const)('%s same-object retry restores the original mounted row after an unavailable image read', async kind => {
  const originalChoice = kind === 'uploaded' ? saved : undefined
  if (originalChoice) useAppStore.setState({ spaceObjectIcons: { [target.key]: originalChoice } })
  const read = kind === 'uploaded' ? vi.spyOn(api.spaceObjects, 'readAvatar') : vi.spyOn(api.spaceObjects, 'appearance')
  read.mockRejectedValueOnce(new Error('Original directory temporarily unavailable'))
  if (kind === 'uploaded') vi.mocked(api.spaceObjects.readAvatar).mockResolvedValue({ width: 256, height: 256, dataUrl: 'data:image/png;base64,RECOVERED' })
  else vi.mocked(api.spaceObjects.appearance).mockResolvedValue({ local: true, icon: 'data:image/png;base64,RECOVERED' })
  await act(async () => root.render(<Scene />)); await settle()
  expect(container.querySelector('[data-original-row] img')).toBeNull()
  expect(container.querySelector('[data-original-row] [title]')?.getAttribute('title')).toContain('Reopen Change avatar to retry')
  await click('Change avatar')
  expect(document.querySelector('[role="dialog"] img')?.getAttribute('src')).toBe('data:image/png;base64,RECOVERED')
  await click('Save avatar')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(useAppStore.getState().spaceObjectIcons[target.key]).toStrictEqual(originalChoice)
  expect(container.querySelector('[data-original-row] img')?.getAttribute('src')).toBe('data:image/png;base64,RECOVERED')
  expect(read).toHaveBeenCalledTimes(2)
})

it('a confirmed remote appearance preserves its explicit notice and neutral glyph without retrying a local scan', async () => {
  const read = vi.spyOn(api.spaceObjects, 'appearance').mockResolvedValue({ local: false, icon: null })
  await act(async () => root.render(<Scene />)); await settle()
  const original = container.querySelector('[data-original-row] [data-space-icon-source="automatic"]')
  expect(original?.getAttribute('title')).toContain('unavailable for this remote object')
  expect(original?.querySelector('svg')).not.toBeNull(); expect(original?.querySelector('img')).toBeNull()
  expect(read).toHaveBeenCalledExactlyOnceWith(target.imageTarget)
  await click('Change avatar')
  expect(document.querySelector('[role="dialog"] [title*="remote object"]')).not.toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().reportError).not.toHaveBeenCalled()
  expect(useAppStore.getState().spaceObjectIcons).toEqual({})
})

it('the original Folder picker and preference writer make the advertised manual-to-automatic image retry reachable', async () => {
  const read = vi.spyOn(api.workspaces, 'appearance').mockRejectedValueOnce(new Error('Original project directory unavailable'))
    .mockResolvedValue({ kind: 'directory', icon: 'data:image/png;base64,FOLDER_RECOVERED' })
  const before = useAppStore.getState()
  await act(async () => root.render(<FolderScene />)); await settle()
  expect(read).toHaveBeenCalledExactlyOnceWith('original-project-workspace')
  expect(container.querySelector('[data-original-row] img')).toBeNull()
  expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('Restore automatic to retry') }))
  await click('Change icon'); await click('Book icon'); await click('Save icon')
  expect(useAppStore.getState().spaceObjectIcons[folder.key]).toBe('book')
  expect(container.querySelector('[data-original-row] [data-space-icon="book"]')).not.toBeNull()
  expect(read).toHaveBeenCalledTimes(1)
  await click('Change icon'); await click('Restore automatic'); await click('Save icon')
  expect(useAppStore.getState().spaceObjectIcons[folder.key]).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(2)
  expect(read).toHaveBeenLastCalledWith('original-project-workspace')
  expect(container.querySelector('[data-original-row] img')?.getAttribute('src')).toBe('data:image/png;base64,FOLDER_RECOVERED')
  const after = useAppStore.getState()
  expect(after.tabs).toBe(before.tabs); expect(after.layouts).toBe(before.layouts)
  expect(after.sessions).toBe(before.sessions); expect(after.agentComposerDrafts).toBe(before.agentComposerDrafts)
})

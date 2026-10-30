// @vitest-environment happy-dom
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, documentKey } from '../src/renderer/src/lib/workbench-tabs'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { readBookmark } from '../src/main/bookmark-file'

const initial = useAppStore.getState(), uri = 'amux://capsule/23456789ABCD'
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

it('opens an actual saved Capsule bookmark through its original container while retaining the dirty workface', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capsule-bookmark-'))
  try {
    const config = { ...await api.config.get(), workspaces: [{ id: 'workspace', name: 'Original', hostId: 'local', path: directory, kind: 'folder' as const }] }
    const tab = createWorkbenchTab('original-tab', { kind: 'file', regionId: 'original-region', workspaceId: 'workspace', path: 'draft.md' })
    const key = documentKey('workspace', 'draft.md')
    useAppStore.setState({ ...initial, config, activeWorkspaceId: 'workspace', tabs: { [tab.id]: tab }, layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) },
      documents: { [key]: { path: 'draft.md', content: 'Unsent original draft', revision: 'original' } }, dirtyDocuments: { [key]: true } }, true)
    vi.spyOn(api.files, 'write').mockImplementation(async (_workspace, input) => {
      await writeFile(join(directory, input.path), input.content, { flag: 'wx' })
      return { status: 'written', path: input.path, revision: 'original-write' }
    })
    const path = await useAppStore.getState().saveBrowserBookmark('workspace', uri, 'Capsule result')
    const bytes = await readFile(join(directory, path))
    expect(bytes.toString()).toContain(uri)
    vi.spyOn(api.files, 'readBookmark').mockImplementation(async () => readBookmark('webloc', bytes, async () => { throw new Error('Text bookmarks need no conversion') }))
    const snapshot = await api.browser.create('source-page', 'http://127.0.0.1:49152/', 'workspace')
    const create = vi.spyOn(api.browser, 'create').mockImplementation(async (id, _url, _workspace, _profile, _mode, _viewport, capsuleId) => ({
      ...snapshot, id, ...(capsuleId ? { capsuleId } : {}), profileId: null, capsuleOrigin: new URL(snapshot.url).origin, objectLink: uri
    }))
    const open = vi.spyOn(api.ui, 'openObjectLink'), read = vi.spyOn(api.files, 'read')
    const before = useAppStore.getState()
    await before.openFile(path, undefined, undefined, 'workspace')
    expect(create).toHaveBeenCalledOnce()
    expect(create.mock.calls[0]!.slice(1)).toEqual([uri, 'workspace', undefined, undefined, undefined, '23456789ABCD'])
    expect(open).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled()
    const after = useAppStore.getState()
    expect(after.tabs[tab.id]).toEqual(before.tabs[tab.id]); expect(after.documents).toEqual(before.documents); expect(after.dirtyDocuments).toEqual(before.dirtyDocuments)
    const pages = Object.values(after.tabs).flatMap(tab => Object.values(tab.regions)).filter(region => region.kind === 'browser')
    expect(pages).toHaveLength(1)
    expect(pages[0]).toMatchObject({ capsuleId: '23456789ABCD', objectLink: uri, url: snapshot.url, bookmarkOrigin: { path, binary: false } })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('keeps the original workface and operation diagnosis when a Capsule bookmark owner cannot confirm opening', async () => {
  const config = { ...await api.config.get(), workspaces: [{ id: 'workspace', name: 'Original', hostId: 'local', path: join(tmpdir(), 'capsule-bookmark-fixture'), kind: 'folder' as const }] }
  useAppStore.setState({ ...initial, config, activeWorkspaceId: 'workspace', layouts: { workspace: createWorkspaceLayout('original-group') } }, true)
  vi.spyOn(api.files, 'readBookmark').mockResolvedValue({ url: uri, binary: false })
  const create = vi.spyOn(api.browser, 'create').mockRejectedValue(new Error('Capsule opening is unconfirmed. Inspect original operation original-bookmark-open'))
  const read = vi.spyOn(api.files, 'read'), before = useAppStore.getState()
  expect(await before.openFile('Original.webloc', undefined, undefined, 'workspace')).toBe(false)
  expect(useAppStore.getState().error).toContain('original-bookmark-open')
  expect(create).toHaveBeenCalledOnce(); expect(read).not.toHaveBeenCalled()
  expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)).some(region => region.kind === 'browser')).toBe(false)
})

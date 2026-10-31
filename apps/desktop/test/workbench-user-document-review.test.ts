// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY as key } from '../src/renderer/src/lib/workbench-user-storage'

const roots: string[] = []
beforeEach(() => { vi.resetModules(); localStorage.clear() })
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }))) })
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function fixture(fragments: Record<string, unknown> = { launcher: null }) {
  const root = await mkdtemp(join(tmpdir(), 'amux-user-document-review-')); roots.push(root)
  const owner = new WorkbenchUserStateStore(join(root, 'workbench-user-state.json'))
  await owner.write(JSON.stringify({ state: { draft: 'Original' }, version: 1, desktopFragments: fragments }))
  return { owner, saved: async () => JSON.parse(await readFile(owner.path, 'utf8')) }
}

it('review: a later fragment checkpoint cannot erase the projection written after an ordered clear', async () => {
  const f = await fixture(), entered = barrier(), release = barrier()
  let first = true
  const doc = createWorkbenchUserDocument({ readWorkbenchState: () => f.owner.read(), importWorkbenchState: value => f.owner.importIfAbsent(value),
    writeWorkbenchState: async value => { if (first) { first = false; entered.resolve(); await release.promise }; return f.owner.write(value) }
  }, () => localStorage)
  await doc.hydrate(); await doc.load('launcher', () => {})
  doc.persistent.storage.setItem(key, { state: { draft: 'Before clear' }, version: 1 })
  const saving = doc.persistent.flush()
  await entered.promise
  const clearing = doc.persistent.storage.removeItem(key)
  doc.persistent.storage.setItem(key, { state: { draft: 'After clear' }, version: 1 })
  release.resolve(); await Promise.all([saving, clearing]); await doc.persistent.flush()
  expect((await f.saved()).state).toEqual({ draft: 'After clear' })
  doc.write('launcher', JSON.stringify({ state: { drafts: { original: { prompt: 'Later fragment edit' } } }, version: 0 }))
  await doc.checkpoint('launcher')
  expect((await f.saved()).state).toEqual({ draft: 'After clear' })
})

it('review: early Launcher edits must survive a root checkpoint after hydration clears its unread overlay', async () => {
  const launcherBytes = JSON.stringify({ state: { sections: {}, drafts: { original: { prompt: 'Old saved prompt', note: 'Original sibling' } }, executors: {}, moteTopicId: null }, version: 0 })
  const f = await fixture({ launcher: launcherBytes }), hold = barrier()
  const { api } = await import('../src/renderer/src/lib/api')
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(async () => { await hold.promise; return f.owner.read() })
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => f.owner.write(value))
  const launcher = await import('../src/renderer/src/lib/launcher-state')
  const { desktopUserDocument: document } = await import('../src/renderer/src/lib/desktop-user-state')
  const loading = launcher.initializeLauncherState()
  launcher.useLauncherState.getState().setDraft('original', 'prompt', 'New early prompt')
  hold.resolve(); await loading
  expect(launcher.useLauncherState.getState().drafts.original?.prompt).toBe('New early prompt')
  expect(launcher.launcherUnreadEditsPending()).toBe(false)
  await document.persistent.checkpoint(key, { state: { draft: 'Root explicit checkpoint' }, version: 1 })
  expect(JSON.parse((await f.saved()).desktopFragments.launcher).state.drafts.original).toMatchObject({
    prompt: 'New early prompt', note: 'Original sibling'
  })
})

it('review: Note hydration cannot retarget the original click to a later Resource Workspace selection', async () => {
  const f = await fixture(), hold = barrier(), entered = barrier()
  const { api } = await import('../src/renderer/src/lib/api')
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(async () => { entered.resolve(); await hold.promise; return f.owner.read() })
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(value => f.owner.write(value))
  const { useAppStore: store } = await import('../src/renderer/src/store')
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs')
  const { createWorkspaceLayout } = await import('@agentmux/layout')
  const tab = createWorkbenchTab('original-note-tab', { regionId: 'original-note-region', kind: 'launcher', workspaceId: 'original-workspace' })
  const config: any = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private Note review' }], executors: {},
    workspaces: [{ id: 'original-workspace', hostId: 'local', name: 'Original', kind: 'folder', path: join(f.owner.path, '../original-resource') },
      { id: 'later-workspace', hostId: 'local', name: 'Later', kind: 'folder', path: join(f.owner.path, '../later-resource') }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  store.setState({ config, loading: false, mainSurface: 'workbench', activeWorkspaceId: 'original-workspace', tabs: { [tab.id]: tab },
    layouts: { 'original-workspace': createWorkspaceLayout('original-note-group', [tab.id]) } })
  const write = vi.spyOn(api.files, 'write').mockResolvedValue({ status: 'error', code: 'REVIEW_NO_FILE_EFFECT', message: 'Only record the captured target.' })
  const creating = store.getState().createNote('original-note-group', { tabId: tab.id, regionId: 'original-note-region' }, 'Original click input')
  await entered.promise
  store.setState({ tabs: { [tab.id]: { ...tab, regions: { ...tab.regions,
    'original-note-region': { ...tab.regions['original-note-region']!, workspaceId: 'later-workspace' } } } } })
  hold.resolve(); await creating
  const { desktopUserDocument } = await import('../src/renderer/src/lib/desktop-user-state')
  await desktopUserDocument.persistent.flush()
  expect(write).not.toHaveBeenCalledWith('later-workspace', expect.anything())
})

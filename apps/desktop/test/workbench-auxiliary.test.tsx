// @vitest-environment happy-dom
import { act, createElement as h } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchUserStateStore } from '../src/main/workbench-user-state'
import { createWorkbenchUserDocument, WORKBENCH_USER_STATE_KEY } from '../src/renderer/src/lib/workbench-user-storage'
import { auxiliaryUserValues } from './helpers/auxiliary-user-values'
import { providerCatalogReader, historySourcesReader } from './helpers/startup-observation-api-fixture'

const roots: string[] = [], disposers: (() => void | Promise<void>)[] = []
beforeEach(() => { vi.resetModules(); localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true) })
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); vi.restoreAllMocks();
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
function barrier() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
async function host() {
  const root = await mkdtemp(join(tmpdir(), 'amux-auxiliary-')); roots.push(root)
  const path = join(root, 'workbench-user-state.json'), user = new WorkbenchUserStateStore(path)
  return { root, path, user, saved: async () => JSON.parse(await readFile(path, 'utf8')) }
}
async function fixture(importOld = false) {
  const f = await host(), values = auxiliaryUserValues()
  const { api } = await import('../src/renderer/src/lib/api')
  const { useAppStore: store, prepareRendererUpdate } = await import('../src/renderer/src/store')
  const { desktopUserDocument: document } = await import('../src/renderer/src/lib/desktop-user-state')
  const launcher = await import('../src/renderer/src/lib/launcher-state')
  const bookmarks = await import('../src/renderer/src/lib/agent-bookmarks')
  const floating = await import('../src/renderer/src/lib/pmo-teams-topic-floating')
  const avatar = await import('../src/renderer/src/lib/mote-avatar-save-draft')
  const patrol = await import('../src/renderer/src/lib/global-goal-patrol-state')
  const config: any = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
    workspaces: [{ id: 'original-workspace', name: 'Original', hostId: 'local', kind: 'folder', path: f.root }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
  const session: any = { id: 'original-agent', kind: 'agent', providerId: 'codex', executorId: 'original-executor', hostId: 'local',
    workspacePath: f.root, label: 'Original', processState: 'running', createdAt: 1, updatedAt: 1, agentSessionUpdatedAt: 1,
    promptSubmissionPredecessor: null, latestOutputBytes: 0, status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: 'original-agent', run: { runId: 'original-run' } } }
  await f.user.write(JSON.stringify({ state: { activeWorkspaceId: 'original-workspace' }, version: 1,
    ...(importOld ? {} : { desktopFragments: values.fragments }) }))
  if (importOld) for (const [key, raw] of Object.entries(values.legacy)) localStorage.setItem(key, raw)
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => f.user.read())
  vi.spyOn(api.ui, 'importWorkbenchState').mockImplementation(raw => f.user.importIfAbsent(raw))
  const writes = vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => f.user.write(raw))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await f.user.read() })
  vi.spyOn(api.config, 'get').mockResolvedValue(config)
  vi.spyOn(api.providers, 'list').mockImplementation(providerCatalogReader())
  vi.spyOn(api.sessions, 'historySources').mockImplementation(historySourcesReader())
  vi.spyOn(api.sessions, 'snapshot').mockResolvedValue({ sessions: [session], timelines: {}, recoveryCandidates: [] })
  vi.spyOn(api.demands, 'list').mockResolvedValue([])
  disposers.push(await store.getState().initialize())
  disposers.push(async () => { try { await document.persistent.flush() } catch { /* Stop this private failed batch before removing its test root. */ } })
  await prepareRendererUpdate('quit')
  const holdWrites = (fail = false) => {
    const entered = barrier(), release = barrier()
    disposers.push(release.resolve)
    writes.mockImplementation(async raw => { entered.resolve(); await release.promise; if (fail) throw new Error('Native disk ACK unavailable'); return f.user.write(raw) })
    return { entered: entered.promise, release: release.resolve }
  }
  return { ...f, values, api, store, document, launcher, bookmarks, floating, avatar, patrol, config, session, writes, holdWrites, prepareRendererUpdate }
}
async function render(node: React.ReactNode) {
  const { createRoot } = await import('react-dom/client'), { DesktopClientUiProvider } = await import('../src/renderer/src/components/DesktopClientUiProvider')
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container)
  await act(async () => root.render(h(DesktopClientUiProvider, null, node)))
  disposers.push(async () => { await act(async () => root.unmount()); container.remove() })
  return container
}

async function coldLauncher() {
  const f = await host(), values = auxiliaryUserValues(), entered = barrier(), release = barrier()
  disposers.push(release.resolve)
  const { api } = await import('../src/renderer/src/lib/api'), { useAppStore: store } = await import('../src/renderer/src/store')
  const launcher = await import('../src/renderer/src/lib/launcher-state')
  const target = { hostId: 'local', agentSessionId: 'original-agent', providerId: 'codex', workspacePath: f.root }
  const session: any = { id: target.agentSessionId, kind: 'agent', ...target, label: 'Original', processState: 'running', status: { state: 'working', source: 'native-hook', observedAt: 1 },
    capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond', providerResume: true, replyCorrelation: 'none' },
    control: { kind: 'agent', hostId: 'local', agentSessionId: target.agentSessionId, run: { runId: 'original-run' } } }
  const config: any = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Private' }], executors: {},
    workspaces: [{ id: 'original-workspace', name: 'Original', hostId: 'local', kind: 'folder', path: f.root }],
    appearance: { terminalTheme: 'graphite' }, browser: { toolbar: {} } }
  store.setState({ config, sessions: [session], activeWorkspaceId: 'original-workspace' })
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(async () => { entered.resolve(); await release.promise; return f.user.read() })
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => f.user.write(raw))
  vi.spyOn(api.ui, 'requestStorageFlush').mockImplementation(async () => { await f.user.read() })
  const seed = async (drafts: Record<string, unknown>) => {
    const raw = JSON.stringify({ state: { sections: {}, drafts, executors: {}, moteTopicId: null }, version: 0 })
    await f.user.write(JSON.stringify({ state: { original: 'Kept' }, version: 1, desktopFragments: { ...values.fragments, launcher: raw } }))
  }
  return { ...f, values, entered: entered.promise, release: release.resolve, api, store, launcher, target, session, seed }
}

it('actual root and all five consumers import exact original bytes into the same native document', async () => {
  const f = await fixture(true)
  expect((await f.saved()).desktopFragments).toEqual(f.values.fragments)
  for (const key of Object.keys(f.values.legacy)) expect(localStorage.getItem(key)).toBeNull()
  expect(f.launcher.useLauncherState.getState().drafts['original-launcher']?.prompt).toBe('Original unsent prompt')
  expect(f.bookmarks.agentBookmarks.get().bookmarks[0]?.excerpt).toBe('Original protected excerpt')
  expect(f.floating.readPmoTeamsTopicFloatingState()?.size).toEqual({ width: 680, height: 460 })
  expect(f.avatar.readMoteAvatarSaveDraft(f.values.avatar.target)).toEqual(f.values.avatar)
  expect(f.patrol.globalGoalPatrolSnapshot()?.operationId).toBe('original-patrol-operation')
  const native = new WorkbenchUserStateStore(f.path)
  expect(JSON.parse((await native.read())!).desktopFragments).toEqual(f.values.fragments)
})

it('main projection writes preserve all private fragments and a late ACK keeps newer fragment input', async () => {
  const f = await fixture(), hold = f.holdWrites()
  f.launcher.useLauncherState.getState().setDraft('original-launcher', 'prompt', 'Earlier native input')
  const saving = f.launcher.checkpointLauncherState(); await hold.entered
  f.launcher.useLauncherState.getState().setDraft('original-launcher', 'prompt', 'Latest native input')
  f.store.getState().setAgentComposerDraft('original-region', 'New root draft')
  hold.release(); await saving; await f.prepareRendererUpdate('quit')
  const saved = await f.saved()
  expect(JSON.parse(saved.desktopFragments.launcher).state.drafts['original-launcher'].prompt).toBe('Latest native input')
  expect(saved.desktopFragments.moteAvatarSaveDrafts).toEqual(f.values.fragments.moteAvatarSaveDrafts)
  expect(saved.desktopFragments.agentBookmarks).toBe(f.values.fragments.agentBookmarks)
  expect(saved.state.agentComposerDrafts['original-region']).toBe('New root draft')
  expect(f.document.persistent.pending()).toBe(false)
})

it('unknown fragment read never becomes absence or overwrites original bytes after host read refusal', async () => {
  const f = await host(), held = JSON.stringify({ state: { original: 'Keep' }, version: 1, desktopFragments: auxiliaryUserValues().fragments })
  await f.user.write(held)
  const doc = createWorkbenchUserDocument({ readWorkbenchState: async () => { throw Error('Host read unavailable') },
    writeWorkbenchState: raw => f.user.write(raw), importWorkbenchState: raw => f.user.importIfAbsent(raw) }, () => localStorage)
  expect(doc.encodeProjection()).toBeNull()
  expect(() => doc.read('globalGoalPatrolOperation')).toThrow('not yet readable')
  await expect(doc.load('launcher', () => {})).rejects.toThrow('Host read unavailable')
  expect(() => doc.write('launcher', '{}')).toThrow('not yet readable')
  expect(await readFile(f.path, 'utf8')).toBe(held)
})

it('malformed original fragment stays untouched while unrelated original fragments remain usable', async () => {
  const f = await host(), values = auxiliaryUserValues()
  await f.user.write(JSON.stringify({ state: { original: true }, version: 1 }))
  localStorage.setItem('agentmux-launcher', '{original broken bytes')
  const doc = createWorkbenchUserDocument({ readWorkbenchState: () => f.user.read(), writeWorkbenchState: raw => f.user.write(raw),
    importWorkbenchState: raw => f.user.importIfAbsent(raw) }, () => localStorage)
  await expect(doc.load('launcher', raw => { if (raw) JSON.parse(raw) })).rejects.toThrow()
  await doc.load('globalGoalPatrolOperation', () => {})
  doc.write('globalGoalPatrolOperation', values.fragments.globalGoalPatrolOperation)
  await doc.checkpoint('globalGoalPatrolOperation')
  expect(localStorage.getItem('agentmux-launcher')).toBe('{original broken bytes')
  expect((await f.saved()).desktopFragments).not.toHaveProperty('launcher')
  expect((await f.saved()).state.original).toBe(true)
})

it.each(['missing', 'void', 'foreign-body', 'wrong-size', 'empty-owner', 'unknown-durability', 'invalid-time'])(
  'native %s acknowledgement cannot clear the submitted whole-document pending input', async variant => {
    const f = await host(), values = auxiliaryUserValues()
    await f.user.write(JSON.stringify({ state: { original: true }, version: 1, desktopFragments: values.fragments }))
    let invalid = true
    const doc = createWorkbenchUserDocument({ readWorkbenchState: () => f.user.read(), importWorkbenchState: raw => f.user.importIfAbsent(raw),
      writeWorkbenchState: async raw => {
        const receipt = await f.user.write(raw)
        if (!invalid) return receipt
        if (variant === 'missing') return null
        if (variant === 'void') return undefined
        return { ...receipt, ...(variant === 'foreign-body' ? { contentDigest: 'f'.repeat(64) } :
          variant === 'wrong-size' ? { sizeBytes: receipt.sizeBytes + 1 } : variant === 'empty-owner' ? { path: '' } :
          variant === 'unknown-durability' ? { diskDurability: 'unconfirmed' } : { confirmedAt: NaN }) }
      } }, () => localStorage)
    await doc.load('launcher', () => {})
    const raw = JSON.stringify({ state: { drafts: { original: { prompt: 'New protected input' } } }, version: 0 })
    doc.write('launcher', raw)
    await expect(doc.checkpoint('launcher')).rejects.toThrow('acknowledgement did not confirm')
    expect(doc.persistent.pending()).toBe(true); expect(doc.read('launcher')).toBe(raw)
    invalid = false; await doc.checkpoint('launcher')
    expect(doc.persistent.pending()).toBe(false); expect((await f.saved()).desktopFragments.launcher).toBe(raw)
  })

it('actual Launcher retains early edits across delayed original hydration without replacing saved sibling fields', async () => {
  const f = await host(), values = auxiliaryUserValues(), hold = barrier()
  await f.user.write(JSON.stringify({ state: {}, version: 1, desktopFragments: values.fragments }))
  const { api } = await import('../src/renderer/src/lib/api')
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(async () => { await hold.promise; return f.user.read() })
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => f.user.write(raw))
  const launcher = await import('../src/renderer/src/lib/launcher-state')
  const loading = launcher.initializeLauncherState()
  launcher.useLauncherState.getState().setDraft('original-launcher', 'prompt', 'Early new prompt')
  hold.resolve(); await loading; await launcher.checkpointLauncherState()
  const draft = JSON.parse((await f.saved()).desktopFragments.launcher).state.drafts['original-launcher']
  expect(draft.prompt).toBe('Early new prompt'); expect(draft.note).toBe('Original unsaved Note')
  expect(draft.unknownUserField).toBe('Retain original opaque user bytes')
})

it('actual bookmark retry reopens the same failed native read and merges current pins without restarting', async () => {
  const f = await host(), values = auxiliaryUserValues()
  await f.user.write(JSON.stringify({ state: { original: true }, version: 1, desktopFragments: values.fragments }))
  const { api } = await import('../src/renderer/src/lib/api')
  const reading = vi.spyOn(api.ui, 'readWorkbenchState').mockRejectedValue(new Error('Original native read unavailable'))
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => f.user.write(raw))
  const { agentBookmarks } = await import('../src/renderer/src/lib/agent-bookmarks')
  await agentBookmarks.retry()
  expect(agentBookmarks.get().persistenceIssue?.phase).toBe('read')
  agentBookmarks.pin({ hostId: 'local', agentSessionId: 'new-user-pin', presentationId: 'new-view', label: 'New visible reading',
    workspaceName: 'Original', bounds: { x: 10, y: 10, width: 400, height: 300 } })
  reading.mockImplementation(() => f.user.read())
  await agentBookmarks.retry()
  expect(agentBookmarks.get().bookmarks.map(item => item.agentSessionId)).toEqual(['original-retained-agent', 'new-user-pin'])
  expect(agentBookmarks.get().persistenceIssue).toBeNull()
  expect(JSON.parse((await f.saved()).desktopFragments.agentBookmarks).bookmarks).toHaveLength(2)
})

it('a repaired original native fragment can be reread in place without replacing current root or neighboring data', async () => {
  const f = await host(), values = auxiliaryUserValues()
  await f.user.write(JSON.stringify({ state: { original: true }, version: 1, desktopFragments: { ...values.fragments, launcher: '{broken native fragment' } }))
  const { api } = await import('../src/renderer/src/lib/api')
  vi.spyOn(api.ui, 'readWorkbenchState').mockImplementation(() => f.user.read())
  vi.spyOn(api.ui, 'writeWorkbenchState').mockImplementation(raw => f.user.write(raw))
  const launcher = await import('../src/renderer/src/lib/launcher-state')
  await expect(launcher.initializeLauncherState()).rejects.toThrow()
  launcher.useLauncherState.getState().setDraft('original-launcher', 'prompt', 'Current input after failed original read')
  await f.user.write(JSON.stringify({ state: { original: true }, version: 1, desktopFragments: values.fragments }))
  await launcher.initializeLauncherState(); await launcher.checkpointLauncherState()
  const saved = await f.saved(), draft = JSON.parse(saved.desktopFragments.launcher).state.drafts['original-launcher']
  expect(draft.prompt).toBe('Current input after failed original read'); expect(draft.note).toBe('Original unsaved Note')
  expect(saved.state).toEqual({ original: true }); expect(saved.desktopFragments.moteAvatarSaveDrafts).toEqual(values.fragments.moteAvatarSaveDrafts)
})

it('quit cannot silently discard current auxiliary input while the original root hydration remains unknown', async () => {
  const f = await coldLauncher(); await f.seed({})
  f.launcher.useLauncherState.getState().setDraft('early-launcher', 'prompt', 'New early unsaved input')
  const { prepareRendererUpdate } = await import('../src/renderer/src/store')
  await expect(prepareRendererUpdate('quit')).rejects.toThrow('Current Desktop input is not yet saved')
  expect(f.launcher.useLauncherState.getState().drafts['early-launcher']?.prompt).toBe('New early unsaved input')
})

it('actual global patrol waits for native ACK and preserves the original operation before dispatch', async () => {
  const f = await fixture(), hold = f.holdWrites()
  const effect = vi.fn(async input => ({ operation: input.operation, issues: [] }))
  f.store.setState({ executeControl: effect as any })
  const pending = f.patrol.requestGlobalGoalPatrol(); await Promise.race([hold.entered, pending])
  expect(effect).not.toHaveBeenCalled()
  expect(f.patrol.globalGoalPatrolSnapshot()?.operationId).toBe('original-patrol-operation')
  hold.release(); await pending
  expect(effect).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ requestId: 'original-patrol-operation' }))
  expect((await f.saved()).desktopFragments.globalGoalPatrolOperation).toBe('original-patrol-operation')
})

it('actual global patrol does not dispatch or invent a replacement when the original native read is unknown', async () => {
  const { api } = await import('../src/renderer/src/lib/api'), { useAppStore } = await import('../src/renderer/src/store')
  vi.spyOn(api.ui, 'readWorkbenchState').mockRejectedValue(new Error('Native read unconfirmed'))
  const effect = vi.fn(); useAppStore.setState({ executeControl: effect })
  const patrol = await import('../src/renderer/src/lib/global-goal-patrol-state')
  await patrol.requestGlobalGoalPatrol()
  expect(effect).not.toHaveBeenCalled(); expect(patrol.globalGoalPatrolSnapshot()?.operationId).toBeUndefined()
  expect(patrol.globalGoalPatrolSnapshot()?.issue).toContain('Native read unconfirmed')
})

it('actual avatar keep awaits native ACK, preserves exact target/body and refuses a neighbor request', async () => {
  const f = await fixture(), hold = f.holdWrites()
  vi.stubGlobal('navigator', { locks: { request: async (_key: string, work: () => unknown) => await work() } })
  let admitted = false
  const pending = f.avatar.keepMoteAvatarSaveDraft(f.values.avatar).then(() => { admitted = true })
  await Promise.race([hold.entered, pending]); expect(admitted).toBe(false)
  hold.release(); await pending; expect(admitted).toBe(true)
  await expect(f.avatar.keepMoteAvatarSaveDraft({ ...f.values.avatar, operationId: 'other-operation' })).rejects.toThrow('Another original')
  expect(f.avatar.readMoteAvatarSaveDraft(f.values.avatar.target)).toEqual(f.values.avatar)
  await f.avatar.retireMoteAvatarSaveDraft(f.values.avatar)
  expect((await f.saved()).desktopFragments.moteAvatarSaveDrafts).toEqual({})
})

it('actual Note creation issues no file effect before native Launcher ACK and retains its original identity on refusal', async () => {
  const f = await fixture(), hold = f.holdWrites(true)
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs'), { createWorkspaceLayout } = await import('@agentmux/layout')
  const tab = createWorkbenchTab('note-launcher', { kind: 'launcher', regionId: 'note-region', workspaceId: 'original-workspace' })
  f.store.setState({ tabs: { [tab.id]: tab }, layouts: { 'original-workspace': createWorkspaceLayout('note-group', [tab.id]) } })
  const effect = vi.spyOn(f.api.files, 'write')
  const pending = f.store.getState().createNote('note-group', { tabId: tab.id, regionId: 'note-region' }, 'Original Note input').catch(error => error)
  await hold.entered; expect(effect).not.toHaveBeenCalled()
  hold.release(); expect(await pending).toMatchObject({ status: 'error', issue: expect.stringContaining('Native disk ACK unavailable') }); expect(effect).not.toHaveBeenCalled()
  const retained = Object.values(f.launcher.useLauncherState.getState().drafts).find(draft => draft.noteCreation)?.noteCreation
  expect(retained?.draft).toBe('Original Note input'); expect(retained?.intentId).toBeTruthy()
  const launcherId = Object.entries(f.launcher.useLauncherState.getState().drafts).find(([, draft]) => draft.noteCreation)?.[0]!
  f.writes.mockImplementation(raw => f.user.write(raw))
  effect.mockResolvedValue({ status: 'written', revision: 'original-note-revision' })
  f.store.setState({ openFile: vi.fn(async () => true) })
  const retried = await f.store.getState().retryCreatedNote(launcherId)
  expect(retried?.intentId).toBe(retained?.intentId); expect(retried?.noteId).toBe(retained?.noteId)
  expect(effect).toHaveBeenCalledTimes(1)
})

it('actual schedule controller waits for native Launcher ACK before its original API request', async () => {
  const f = await fixture(), hold = f.holdWrites()
  const { useScheduleOperation } = await import('../src/renderer/src/lib/schedule-controller')
  const effect = vi.spyOn(f.api.schedule, 'pause').mockRejectedValue(new Error('Controlled original owner reply'))
  const request: any = { action: 'pause', params: { operationId: 'original-schedule-operation', scheduleId: 'original-schedule', expectedRevision: 1 } }
  function Probe() { const operation = useScheduleOperation('original-schedule-draft', () => {}); return h('button', { onClick: () => void operation.perform(request) }, 'Original schedule action') }
  const container = await render(h(Probe)); await act(async () => container.querySelector('button')!.click())
  await hold.entered; expect(effect).not.toHaveBeenCalled()
  await act(async () => { hold.release() })
  await vi.waitFor(() => expect(effect).toHaveBeenCalledExactlyOnceWith(request.params))
})

it('actual progress control waits for native Launcher ACK before updating the retained request', async () => {
  const f = await fixture(), hold = f.holdWrites()
  const { ContinuousProgressControl } = await import('../src/renderer/src/components/ContinuousProgressControl')
  const loop: any = { hostId: 'local', agentSessionId: f.session.id, providerId: 'codex', workspacePath: f.root,
    loopId: 'original-loop', intervalMs: 60000, prompt: 'Original continuation', status: 'active', nextCheckAt: 60000, lastTickAt: null, lastDecision: null }
  vi.spyOn(f.api.continuousProgress, 'list').mockResolvedValue([loop])
  vi.spyOn(f.api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  const effect = vi.spyOn(f.api.continuousProgress, 'update').mockRejectedValue(new Error('Controlled original update reply'))
  const target = { hostId: 'local', agentSessionId: f.session.id, providerId: 'codex', workspacePath: f.root }
  const key = 'progress-update:' + JSON.stringify(Object.values(target)), request = { target, loopId: loop.loopId, expectedLoop: loop,
    intervalMs: 120000, prompt: 'Original requested continuation', operationId: 'original-progress-operation' }
  f.launcher.useLauncherState.getState().setProgressUpdate(key, request)
  const container = await render(h(ContinuousProgressControl, { session: f.session }))
  await vi.waitFor(() => expect(container.querySelector('form[aria-label="Continuous progress setup"]')).not.toBeNull())
  await act(async () => container.querySelector('form[aria-label="Continuous progress setup"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await hold.entered; expect(effect).not.toHaveBeenCalled()
  await act(async () => { hold.release() })
  await vi.waitFor(() => expect(effect).toHaveBeenCalledExactlyOnceWith(request))
})

it('delayed Launcher read cannot replace or dispatch an original Note request from an early new action', async () => {
  const f = await coldLauncher()
  const { createWorkbenchTab } = await import('../src/renderer/src/lib/workbench-tabs'), { createWorkspaceLayout } = await import('@agentmux/layout')
  const { warmLauncherId } = await import('../src/renderer/src/lib/warm-terminal-preview')
  const tab = createWorkbenchTab('cold-note-tab', { kind: 'launcher', regionId: 'cold-note-region', workspaceId: 'original-workspace' })
  f.store.setState({ tabs: { [tab.id]: tab }, layouts: { 'original-workspace': createWorkspaceLayout('cold-note-group', [tab.id]) } })
  const id = warmLauncherId({ tabGroupId: 'cold-note-group', regionId: 'cold-note-region' })
  const original: any = { intentId: 'original-note-intent', createdAt: 1, noteId: 'original-note-id', blockIds: ['original-block'],
    draft: 'Original retained Note', path: 'original.note.md', status: 'unknown', revealed: false,
    target: { workspaceId: 'original-workspace', hostId: 'local', workspacePath: f.root, directoryPath: f.root,
      relativeDirectory: '', zoneId: null, sourceSpaceId: null, displayWorkspaceId: 'original-workspace', groupId: 'cold-note-group' } }
  await f.seed({ [id]: { browser: '', note: 'Newer visible input', noteCreation: original } })
  const effect = vi.spyOn(f.api.files, 'write')
  const action = f.store.getState().createNote('cold-note-group', { tabId: tab.id, regionId: 'cold-note-region' }, 'New early input')
  await f.entered; expect(effect).not.toHaveBeenCalled()
  f.release(); expect(await action).toEqual(original)
  expect(effect).not.toHaveBeenCalled()
  expect(f.launcher.useLauncherState.getState().drafts[id]?.noteCreation).toEqual(original)
})

it('delayed Launcher read cannot overwrite or dispatch the original schedule from an early competing action', async () => {
  const f = await coldLauncher(), key = 'cold-schedule'
  const original: any = { action: 'pause', params: { operationId: 'original-schedule-intent', scheduleId: 'original-schedule', expectedRevision: 1 } }
  await f.seed({ [key]: { browser: '', note: '', schedule: { pending: original } } })
  const { useScheduleOperation } = await import('../src/renderer/src/lib/schedule-controller')
  const effect = vi.spyOn(f.api.schedule, 'pause'), competing = { ...original, params: { ...original.params, operationId: 'competing-new-operation' } }
  let action: Promise<unknown> | undefined
  function Probe() { const operation = useScheduleOperation(key, () => {}); return h('button', { onClick: () => { action = operation.perform(competing) } }, 'New schedule action') }
  const container = await render(h(Probe)); await act(async () => container.querySelector('button')!.click())
  await f.entered; expect(effect).not.toHaveBeenCalled()
  await act(async () => { f.release(); await action })
  expect(effect).not.toHaveBeenCalled()
  expect(f.launcher.useLauncherState.getState().drafts[key]?.schedule?.pending).toEqual(original)
  expect(JSON.parse((await f.saved()).desktopFragments.launcher).state.drafts[key].schedule.pending).toEqual(original)
})

it('delayed Launcher read restores progress identity before deciding an early save and requires explicit original retry', async () => {
  const f = await coldLauncher(), key = 'progress-update:' + JSON.stringify(Object.values(f.target))
  const loop: any = { ...f.target, loopId: 'original-loop', intervalMs: 60000, prompt: 'Original loop', status: 'active', nextCheckAt: 60000, lastTickAt: null, lastDecision: null }
  const original = { target: f.target, loopId: loop.loopId, expectedLoop: loop, intervalMs: 120000,
    prompt: 'Original unconfirmed update', operationId: 'original-progress-intent' }
  await f.seed({ [key]: { browser: '', note: '', progressUpdate: original } })
  vi.spyOn(f.api.continuousProgress, 'list').mockResolvedValue([loop])
  vi.spyOn(f.api.schedule, 'list').mockResolvedValue({ schedules: [], executionScope: 'connected-host' })
  const effect = vi.spyOn(f.api.continuousProgress, 'update').mockRejectedValue(new Error('Controlled original reply'))
  const { ContinuousProgressControl } = await import('../src/renderer/src/components/ContinuousProgressControl')
  const container = await render(h(ContinuousProgressControl, { session: f.session }))
  const submit = () => container.querySelector('form[aria-label="Continuous progress setup"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await act(async () => { submit() }); await f.entered; expect(effect).not.toHaveBeenCalled()
  await act(async () => { f.release() })
  await vi.waitFor(() => expect(container.textContent).toContain('An original save request was restored'))
  expect(effect).not.toHaveBeenCalled()
  expect(f.launcher.useLauncherState.getState().drafts[key]?.progressUpdate).toEqual(original)
  await act(async () => { submit() })
  await vi.waitFor(() => expect(effect).toHaveBeenCalledExactlyOnceWith(original))
})

// @vitest-environment happy-dom
import { rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { act, createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/src/store'
import { api } from '../src/renderer/src/lib/api'
import { createMoteApp, type MoteAppFixture } from './fixtures/mote-app'
import { moteAgent, quietMoteId, quietTab } from './fixtures/mote-workface'
import { SCRATCH_WORKSPACE_ID, parseMoteQuickMode } from '@agentmux/host/mote-model'
import { agentCreationFixture } from './helpers/agent-creation-fixture'
import { moteQuickOwner, type MoteQuickOwnerFixture } from './helpers/mote-quick-owner'
import type { AgentLaunchResult } from '../src/shared/contracts'
import { MoteQuickModeDialog } from '../src/renderer/src/components/MoteQuickMode'
import { checkpointLauncherState, useLauncherState } from '../src/renderer/src/lib/launcher-state'
import { createClientUiRoot } from './helpers/client-ui-render'
import * as primary from '../src/renderer/src/lib/mote-primary-agent'

const originalLaunch = useAppStore.getState().launchAgent
const phase = process.env.MOTE_QUICK_RESTART_PHASE
const views: Array<() => Promise<void>> = [], releases: Array<() => void> = []
const adoptions: Promise<void>[] = []
let app: MoteAppFixture, f: MoteQuickOwnerFixture, result: AgentLaunchResult | undefined
beforeEach(async () => {
  app = createMoteApp(); result = undefined
  f = await moteQuickOwner({ ...(process.env.MOTE_QUICK_RESTART_ROOT ? { root: process.env.MOTE_QUICK_RESTART_ROOT } : {}), ...(phase === 'reader' ? { restore: true } : {}) })
  const establish = primary.establishFirstMoteAgent
  vi.spyOn(primary, 'establishFirstMoteAgent').mockImplementation((...args) => { const result = establish(...args); adoptions.push(result); return result })
  useAppStore.setState({ launchAgent: originalLaunch })
  vi.spyOn(api.files, 'readDirectory').mockResolvedValue([])
  vi.spyOn(api.files, 'observe').mockResolvedValue(); vi.spyOn(api.files, 'unobserve').mockResolvedValue()
  vi.spyOn(api.sessions, 'launchAgent').mockImplementation(async input => {
    const session = { ...moteAgent(input.agentSessionId!, quietMoteId), workspacePath: f.scope.topic.directoryPath }
    result = { created: agentCreationFixture(session), session, projectionFailures: [] }
    return result
  })
  vi.spyOn(api.sessions, 'creation').mockImplementation(async () => result!.created)
})
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  if (f) {
    f.nativeWrites.mockImplementation(raw => f.user.write(raw))
    await Promise.allSettled(f.saves.mock.results.filter(result => result.type === 'return').map(result => result.value))
    await vi.waitFor(() => expect(document.querySelector('.mote-quick-mode-dialog__footer .primary-button')?.textContent).not.toBe('Saving…'))
    await f.disconnect()
  }
  await Promise.allSettled(adoptions.splice(0))
  for (const close of views.splice(0).reverse()) await close()
  await f?.close(); await app?.dispose()
})
async function start() {
  await useAppStore.getState().launchAgent('fixture', 'Launcher unsent', 'mote-group', {
    tabId: quietTab.id, regionId: quietTab.layout.activeRegionId
  })
}
const draftKey = () => 'mote-quick:' + JSON.stringify(f.target)
async function nativeDraft() {
  const raw = await f.user.read()
  const launcher = raw && JSON.parse(raw).desktopFragments?.launcher
  return launcher ? JSON.parse(launcher).state?.drafts?.[draftKey()]?.moteQuick ?? null : null
}
async function quick() {
  const container = document.createElement('div'); document.body.append(container)
  const root = createClientUiRoot(container), onClose = vi.fn()
  await act(async () => root.render(createElement(MoteQuickModeDialog, { scope: f.scope, onOpenPath: async () => null, onClose, returnFocus: () => null, focusHeartbeat: true })))
  const close = async () => { await act(async () => root.unmount()); container.remove() }
  views.push(close)
  await vi.waitFor(() => expect(document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')).not.toBeNull())
  await vi.waitFor(() => expect(document.body.textContent).toContain('Saved settings loaded'))
  const save = () => document.querySelector<HTMLButtonElement>('.mote-quick-mode-dialog__footer .primary-button')!
  return { close, onClose, save }
}
async function minutes(value: string) {
  const input = document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await checkpointLauncherState()
}
function holdWrite() {
  let release!: () => void, entered = false, unknown = false
  const wait = new Promise<void>(resolve => { release = resolve }); releases.push(release)
  const write = f.files.write.bind(f.files)
  vi.spyOn(f.files, 'write').mockImplementation(async (...args) => { entered = true; await wait; return unknown
    ? { resource: null, result: { status: 'unknown', code: 'WRITE_UNCONFIRMED', message: 'Original native writer receipt unavailable' } }
    : write(...args) })
  return { release, entered: () => entered, unknown: () => { unknown = true } }
}

it.each(['existing', 'missing'] as const)('source-only first Launcher saves its exact first Agent with %s preferences and keeps focus', async state => {
  if (state === 'missing') await rm(f.path)
  // A full initial read would call this unrelated port and remain pending.
  f.discovery.executors.mockImplementation(() => new Promise(() => {}))
  const write = vi.spyOn(f.files, state === 'missing' ? 'create' : 'write')
  const before = useAppStore.getState()
  await start()
  await vi.waitFor(() => expect(f.reads).toHaveBeenCalledTimes(1))
  expect(f.reads.mock.calls.map(([input]) => input), 'the first Launcher read keeps includeChoices:false without unrelated discovery').toEqual([{ kind: 'quick', target: f.target, includeChoices: false }])
  expect(f.discovery.executors).not.toHaveBeenCalled()
  await vi.waitFor(() => expect(f.saves).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
  await vi.waitFor(() => expect(useAppStore.getState().scratchTopicSnapshots[SCRATCH_WORKSPACE_ID]?.topics?.find(t => t.id === quietMoteId)?.quickMode?.status).toBe('saved'))
  expect(f.discovery.catalog).toHaveBeenCalledTimes(1) // The changed Main save still validates its own location.
  await vi.waitFor(async () => {
    expect(parseMoteQuickMode(await f.bytes())).toMatchObject({ status: 'valid', defaults: { conversation: {
      hostId: 'local', sessionId: result!.created.agentSessionId, displayWorkspaceId: SCRATCH_WORKSPACE_ID,
      groupId: 'mote-group', tabId: quietTab.id, regionId: quietTab.layout.activeRegionId
    } } })
  })
  const parsed = parseMoteQuickMode(await f.bytes())
  if (state === 'existing') {
    expect(parsed).toMatchObject({ defaults: { executorId: 'fixture' } })
    expect(await f.bytes()).toContain('# Keep my cooperation notes.')
  }
  const after = useAppStore.getState()
  expect(after.activeWorkspaceId).toBe(before.activeWorkspaceId)
  expect(after.workbenchSpaceSelection).toEqual(before.workbenchSpaceSelection)
  expect(after.tabs[quietTab.id]?.regions[quietTab.layout.activeRegionId]).toMatchObject({ kind: 'agent', sessionId: result!.created.agentSessionId, phase: 'attached' })
  expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(app.stop).not.toHaveBeenCalled(); expect(app.send).not.toHaveBeenCalled()
})

it('an unknown preference Save preserves the created Agent, original Run and original request', async () => {
  const source = await f.owner.read({ kind: 'quick', target: f.target, includeChoices: false })
  vi.spyOn(f.files, 'write').mockResolvedValue({ resource: source.source!.resource,
    result: { status: 'unknown', code: 'WRITE_UNCONFIRMED', message: 'Private save receipt unavailable' } })
  await start()
  await vi.waitFor(() => expect(useAppStore.getState().reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({
    summary: expect.stringContaining('Main Agent setup is unconfirmed')
  })))
  const state = useAppStore.getState()
  expect(state.tabs[quietTab.id]?.regions[quietTab.layout.activeRegionId]).toMatchObject({ kind: 'agent', phase: 'attached', sessionId: result!.created.agentSessionId })
  expect(state.sessions.find(s => s.id === result!.created.agentSessionId)?.control.run).toEqual(result!.created.run)
  expect(f.saves.mock.calls).toHaveLength(1)
  expect(f.saves.mock.calls[0]![0]).toMatchObject({ kind: 'quick', target: f.target, baseline: { defaults: { executorId: 'fixture' } } })
  const retained = await nativeDraft()
  expect(retained, 'the first-Launcher original request reaches canonical native custody').toMatchObject({ pending: { phase: 'may-have-dispatched', input: f.saves.mock.calls[0]![0] } })
  const view = await quick()
  expect(view.save().textContent).toBe('Check original save'); expect(f.saves).toHaveBeenCalledTimes(1)
  await minutes('55')
  await act(async () => view.save().click())
  await vi.waitFor(() => expect(f.saves).toHaveBeenCalledTimes(2))
  expect(f.saves.mock.calls[1]![0]).toEqual(retained.pending.input)
  expect(await nativeDraft()).toMatchObject({ minutes: '55', pending: retained.pending })
  expect(await f.bytes()).toBe(f.original)
  expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1); expect(app.stop).not.toHaveBeenCalled()
})

it('a clean-open Quick edit keeps the held first-Launcher pending in its actual native document', async () => {
  const view = await quick(), held = holdWrite()
  await start(); await vi.waitFor(() => expect(held.entered()).toBe(true))
  const original = await nativeDraft()
  expect(original.pending?.input.operationId).toEqual(expect.any(String))
  await minutes('55')
  expect(await nativeDraft(), 'editing the original open form retains the held original pending').toMatchObject({ minutes: '55', pending: original.pending })
  expect(useLauncherState.getState().drafts[draftKey()]?.moteQuick?.pending).toEqual(original.pending)
  expect(view.save().textContent).toBe('Check original save'); expect(f.saves).toHaveBeenCalledTimes(1)
})

it('an older background acknowledgement clears only its request and keeps later Quick fields', async () => {
  const view = await quick(), held = holdWrite()
  await start(); await vi.waitFor(() => expect(held.entered()).toBe(true))
  await minutes('55')
  held.release()
  await vi.waitFor(() => expect(useLauncherState.getState().drafts[draftKey()]?.moteQuick?.pending).toBeUndefined())
  const retained = await nativeDraft()
  expect(retained, 'the original acknowledgement keeps the later editable fields').toMatchObject({ minutes: '55', draft: { presence: { intervalMs: 3300000 } } })
  expect(retained.pending).toBeUndefined(); expect(view.onClose).not.toHaveBeenCalled()
  expect(document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')!.value).toBe('55')
  expect(f.saves).toHaveBeenCalledTimes(1)
})

it('a manual Quick pending is preserved before optional first-Agent adoption without another save', async () => {
  const view = await quick(); await minutes('44')
  const held = holdWrite(); await act(async () => view.save().click())
  await vi.waitFor(() => expect(held.entered()).toBe(true))
  const original = await nativeDraft()
  await start()
  await vi.waitFor(() => expect(useAppStore.getState().reportError).toHaveBeenCalled())
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(await nativeDraft()).toEqual(original)
  expect(result!.created.agentSessionId).toEqual(expect.any(String)); expect(app.stop).not.toHaveBeenCalled()
  // A raw empty edit is still later input while the original manual save is held.
  await minutes(''); held.release()
  await vi.waitFor(() => expect(view.save().textContent).not.toBe('Saving…'))
  expect(view.onClose).not.toHaveBeenCalled()
  expect(await nativeDraft()).toMatchObject({ minutes: '', draft: { presence: { intervalMs: 2640000 } } })
  expect((await nativeDraft()).pending).toBeUndefined()
})

it('a failed native retention checkpoint refuses only the optional binding and preserves the healthy created Agent', async () => {
  const write = f.nativeWrites.getMockImplementation()!
  vi.mocked(api.ui.writeWorkbenchState).mockRejectedValue(new Error('Original native document writer unavailable'))
  await start()
  await vi.waitFor(() => expect(adoptions).toHaveLength(1))
  await Promise.allSettled(adoptions)
  await vi.waitFor(() => expect(useAppStore.getState().reportError).toHaveBeenCalled())
  expect(f.saves).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(f.original)
  expect(useAppStore.getState().sessions.find(s => s.id === result!.created.agentSessionId)?.control.run).toEqual(result!.created.run)
  expect(useLauncherState.getState().drafts[draftKey()]?.moteQuick?.pending?.phase).toBe('not-dispatched')
  expect(app.stop).not.toHaveBeenCalled()
  vi.mocked(api.ui.writeWorkbenchState).mockImplementation(write)
  await checkpointLauncherState()
  expect((await nativeDraft()).pending.phase).toBe('not-dispatched')
  expect(f.saves).not.toHaveBeenCalled()
})

it.runIf(phase === 'producer')('native original Quick producer checkpoints the actual first-Launcher pending and later form fields', async () => {
  const view = await quick(), held = holdWrite()
  await start(); await vi.waitFor(() => expect(held.entered()).toBe(true))
  await minutes('55')
  const retained = await nativeDraft()
  expect(retained).toMatchObject({ minutes: '55', pending: { phase: 'may-have-dispatched', input: { target: f.target, operationId: expect.any(String) } } })
  expect(view.save().textContent).toBe('Check original save')
  // A genuine unknown receipt preserves the request; it never fabricates a commit.
  held.unknown(); held.release(); await Promise.allSettled(adoptions)
  const raw = await f.user.read()
  await writeFile(process.env.MOTE_QUICK_RESTART_RECEIPT!, JSON.stringify({ pid: process.pid, nativePath: f.nativePath,
    documentSha256: createHash('sha256').update(raw!).digest('hex'), requestSha256: createHash('sha256').update(JSON.stringify(retained.pending.input)).digest('hex'),
    retained, saves: f.saves.mock.calls.length }) + '\n')
})

it.runIf(phase === 'reader')('native original Quick reader loads the same request and fields without seeding or dispatch', async () => {
  const before = await f.user.read()
  expect(f.nativeReads.mock.calls.length).toBeGreaterThan(0); expect(f.nativeWrites).not.toHaveBeenCalled()
  const view = await quick(), retained = await nativeDraft()
  expect(retained).toMatchObject({ minutes: '55', pending: { phase: 'may-have-dispatched', input: { target: f.target, operationId: expect.any(String) } } })
  expect(view.save().textContent).toBe('Check original save')
  expect(document.querySelector<HTMLInputElement>('[aria-label="Heartbeat interval (minutes)"]')!.value).toBe('55')
  expect(f.saves).not.toHaveBeenCalled(); expect(api.sessions.launchAgent).not.toHaveBeenCalled()
  expect(f.nativeWrites).not.toHaveBeenCalled(); expect(await f.user.read()).toBe(before)
  await writeFile(process.env.MOTE_QUICK_RESTART_RECEIPT!, JSON.stringify({ pid: process.pid, nativePath: f.nativePath,
    documentSha256: createHash('sha256').update(before!).digest('hex'), requestSha256: createHash('sha256').update(JSON.stringify(retained.pending.input)).digest('hex'),
    retained, saves: 0, extraNativeWrites: f.nativeWrites.mock.calls.length }) + '\n')
})

it('first Launcher source-only does not bypass changed-Main catalog validation or original File CAS', async () => {
  const write = vi.spyOn(f.files, 'write')
  f.discovery.catalog.mockRejectedValue(new Error('Original display discovery unavailable'))
  await start()
  await vi.waitFor(() => expect(adoptions).toHaveLength(1))
  await Promise.allSettled(adoptions)
  await vi.waitFor(() => expect(useAppStore.getState().reportError).toHaveBeenCalled())
  expect(f.saves).toHaveBeenCalledTimes(1); expect(f.discovery.catalog).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled(); expect(await f.bytes()).toBe(f.original)
  expect(await nativeDraft()).toMatchObject({ draft: { conversation: { sessionId: result!.created.agentSessionId } } })
  expect((await nativeDraft()).pending).toBeUndefined()
  expect(useAppStore.getState().sessions.find(s => s.id === result!.created.agentSessionId)?.control.run).toEqual(result!.created.run)
  // A concurrent original file edit is independently rejected before a catalog read or write.
  f.discovery.catalog.mockClear()
  const held = f.saves.mock.calls[0]![0]
  await writeFile(f.path, f.original + '\nConcurrent original note.\n')
  expect(await api.motePreferences.save(held)).toMatchObject({ status: 'refused-before-write', message: expect.stringContaining('MOTE.md changed') })
  expect(f.discovery.catalog).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
  expect(await f.bytes()).toContain('Concurrent original note.')
})

it('an existing unobserved member is never treated as an empty Mote for automatic primary adoption', async () => {
  const state = useAppStore.getState()
  useAppStore.setState({ tabs: { ...state.tabs, old: { ...quietTab, id: 'old', regions: { old: {
    kind: 'agent', phase: 'attached', workspaceId: SCRATCH_WORKSPACE_ID, regionId: 'old', sessionId: 'original-unobserved'
  } }, layout: { ...quietTab.layout, activeRegionId: 'old' } } } })
  await start()
  expect(api.sessions.launchAgent).toHaveBeenCalledTimes(1)
  expect(f.reads).not.toHaveBeenCalled(); expect(f.saves).not.toHaveBeenCalled()
  expect(useAppStore.getState().tabs.old?.regions.old).toMatchObject({ sessionId: 'original-unobserved' })
})

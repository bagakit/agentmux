import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig } from './helpers/composer-dom-fixture'
import { api } from '../src/renderer/src/lib/api'
import { createWorkbenchTab, addWorkbenchRegion, replaceWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { useAppStore } from '../src/renderer/src/store'
import type { SessionSnapshot } from '../src/shared/contracts'

const original = useAppStore.getState()
const target = { tabId: 'opening', regionId: 'opening-region' }
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function shell(id: string): Extract<SessionSnapshot, { kind: 'terminal' }> {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: _hygiene_fixturePath("repo"),
    label: id, createdAt: 1, updatedAt: 1, processState: 'running',
    status: { state: 'running', source: 'run-process', observedAt: 1 }, latestOutputBytes: 0,
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}
beforeEach(() => {
  const opening = addWorkbenchRegion(createWorkbenchTab(target.tabId, { regionId: target.regionId,
    kind: 'launcher', workspaceId: 'workspace' }), target.regionId, 'right', {
    regionId: 'survivor-region', kind: 'launcher', workspaceId: 'workspace' })
  useAppStore.setState({ ...original, config: { ...structuredClone(composerConfig),
    hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
    workspaces: [{ id: 'workspace', kind: 'folder', name: 'Project', hostId: 'local', path: _hygiene_fixturePath("repo") }] },
    activeWorkspaceId: 'workspace', tabs: { opening }, layouts: { workspace: createWorkspaceLayout('group', ['opening']) },
    sessions: [], warmTerminal: null, unclaimedTerminalSessionIds: [], closingWorkbenchViews: {},
    agentComposerDrafts: { 'survivor-region': 'Keep the other work' } }, true)
  vi.spyOn(api.sessions, 'refresh').mockImplementation(async control => shell(control.run.runId))
})
afterEach(() => { vi.restoreAllMocks() })

it.each((['cold', 'busy-cache'] as const).flatMap(mode => (['region', 'tab', 'replacement'] as const).map(action => ({ mode, action }))))(
  'late $mode success survives actual $action removal without borrowing the warm slot', async ({ mode, action }) => {
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
    const before = useAppStore.getState()
    const openingTab = addWorkbenchRegion(createWorkbenchTab(target.tabId, { regionId: target.regionId,
      kind: 'launcher', workspaceId: 'workspace' }), target.regionId, 'right', {
      regionId: 'survivor-region', kind: 'launcher', workspaceId: 'workspace' })
    const unrelated = { key: ("local:" + _hygiene_fixturePath("repo")), ownerLauncherId: 'unrelated', ready: Promise.resolve(shell('unrelated')),
      session: shell('unrelated'), claimToken: {}, explicitOpening: true as const }
    useAppStore.setState({ tabs: { opening: openingTab }, layouts: { workspace: createWorkspaceLayout('group', ['opening']) },
      warmTerminal: mode === 'busy-cache' ? unrelated : null })
    const reply = deferred<SessionSnapshot>()
    const create = vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => reply.promise)
    const opening = mode === 'cold'
      ? useAppStore.getState().launchTerminal('group', target)
      : useAppStore.getState().promoteWarmTerminal('group', target)
    const pending = useAppStore.getState().tabs.opening!.regions[target.regionId]!
    expect(pending).toMatchObject({ kind: 'terminal', phase: 'launching' })
    if (action === 'region') await useAppStore.getState().closeRegion('workspace', 'opening', target.regionId)
    else if (action === 'tab') await useAppStore.getState().closeTab('workspace', 'group', 'opening')
    else {
      const tab = useAppStore.getState().tabs.opening!
      useAppStore.setState({ tabs: { opening: replaceWorkbenchRegion(tab, target.regionId, {
        regionId: target.regionId, kind: 'launcher', workspaceId: 'workspace' }) } })
    }
    const presentation = useAppStore.getState().tabs
    const run = shell(mode + '-' + action)
    reply.resolve(run); await opening
    expect(stop).not.toHaveBeenCalled()
    expect(useAppStore.getState().sessions).toContainEqual(run)
    expect(useAppStore.getState().tabs).toBe(presentation)
    expect(useAppStore.getState().warmTerminal).toBe(mode === 'busy-cache' ? unrelated : null)
    expect(useAppStore.getState().agentComposerDrafts).toEqual(before.agentComposerDrafts)
    expect(create).toHaveBeenCalledOnce()
})

it.each(['cold', 'busy-cache'] as const)('a closing attached sibling does not authorize stopping the late %s Run', async mode => {
  const known = shell('attached-sibling'), stopReply = deferred<void>(), late = deferred<SessionSnapshot>()
  const tab = useAppStore.getState().tabs.opening!
  useAppStore.setState({ tabs: { opening: replaceWorkbenchRegion(tab, 'survivor-region', {
    regionId: 'survivor-region', kind: 'terminal', phase: 'attached', workspaceId: 'workspace', sessionId: known.id }) }, sessions: [known] })
  const stop = vi.spyOn(api.sessions, 'stop').mockImplementation(async control => {
    expect(control).toEqual(known.control); await stopReply.promise
  })
  vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => late.promise)
  const unrelated = { key: 'elsewhere', ownerLauncherId: 'unrelated', ready: Promise.resolve(shell('unrelated')), session: shell('unrelated'), claimToken: {} }
  if (mode === 'busy-cache') useAppStore.setState({ warmTerminal: unrelated })
  const open = mode === 'cold' ? useAppStore.getState().launchTerminal('group', target)
    : useAppStore.getState().promoteWarmTerminal('group', target)
  const close = useAppStore.getState().closeTab('workspace', 'group', 'opening')
  expect(useAppStore.getState().closingWorkbenchViews.opening?.resources).toEqual([
    expect.objectContaining({ sessionId: known.id, control: known.control }) ])
  late.resolve(shell('late')); await open
  expect(stop).toHaveBeenCalledTimes(1)
  expect(useAppStore.getState().sessions).toContainEqual(shell('late'))
  expect(useAppStore.getState().tabs.opening!.regions[target.regionId]).toMatchObject({ phase: 'launching' })
  stopReply.resolve(); expect(await close).toBe(true)
  expect(useAppStore.getState().tabs.opening).toBeUndefined()
  expect(stop).toHaveBeenCalledTimes(1)
})

it('preserves fresher known facts instead of overwriting them with the late creation snapshot', async () => {
  const reply = deferred<SessionSnapshot>()
  vi.spyOn(api.sessions, 'launchTerminal').mockImplementationOnce(() => reply.promise)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  const open = useAppStore.getState().launchTerminal('group', target)
  await useAppStore.getState().closeRegion('workspace', 'opening', target.regionId)
  const fresher = { ...shell('late'), processState: 'exited' as const, updatedAt: 20, latestOutputBytes: 100 }
  useAppStore.setState({ sessions: [fresher] })
  reply.resolve(shell('late')); await open
  expect(useAppStore.getState().sessions).toEqual([fresher]); expect(stop).not.toHaveBeenCalled()
})

it('still attaches a current opening and stops only an attached last full View through its original frozen plan', async () => {
  const run = shell('normal')
  vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValueOnce(run)
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  await useAppStore.getState().launchTerminal('group', target)
  expect(useAppStore.getState().tabs.opening!.regions[target.regionId]).toMatchObject({ phase: 'attached', sessionId: run.id })
  expect(stop).not.toHaveBeenCalled()
  expect(await useAppStore.getState().closeTab('workspace', 'group', 'opening')).toBe(true)
  expect(stop).toHaveBeenCalledExactlyOnceWith(run.control)
})

it('keeps explicit Stop on the original exact Run owner', async () => {
  const run = shell('explicit')
  const stop = vi.spyOn(api.sessions, 'stop').mockResolvedValue()
  useAppStore.setState({ sessions: [run] })
  await useAppStore.getState().stopSession(run.id)
  expect(stop).toHaveBeenCalledExactlyOnceWith(run.control)
})

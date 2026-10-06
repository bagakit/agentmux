import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWorkspaceLayout } from '@agentmux/layout'
import { fixturePath } from '../scripts/lib/fixture-values.mjs'
import type { AppConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { warmLauncherId, warmTerminalForLauncher, warmTerminalPreview } from '../src/renderer/src/lib/warm-terminal-preview'
import { useAppStore, warmTerminalKey } from '../src/renderer/src/store'

const initial = useAppStore.getState()
const project = { id: 'project', name: 'Project', hostId: 'local', path: fixturePath('repo'), kind: 'folder' as const }
const other = { ...project, id: 'other', name: 'Other', path: fixturePath('other') }
const config: AppConfig = { version: 9, hosts: [{ id: 'local', kind: 'local', label: 'Local' }],
  executors: {}, workspaces: [project, other], appearance: { terminalTheme: 'graphite' },
  browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }
const key = warmTerminalKey(project.hostId, project.path)
const otherKey = warmTerminalKey(other.hostId, other.path)
function shell(id: string): SessionSnapshot {
  return { id, kind: 'terminal', providerId: null, hostId: 'local', workspacePath: project.path,
    label: 'Terminal', createdAt: 1, updatedAt: 1, processState: 'running', latestOutputBytes: 0,
    status: { state: 'running', source: 'run-process', observedAt: 1 },
    control: { kind: 'terminal', hostId: 'local', runId: id, run: { runId: id } } }
}
function candidate(ownerLauncherId: string | null, id = 'shell') {
  const session = shell(id)
  return { key, ownerLauncherId, session, ready: Promise.resolve(session) }
}

beforeEach(() => useAppStore.setState({ config, warmTerminals: {}, unclaimedTerminalSessionIds: [] }))
afterEach(() => { vi.restoreAllMocks(); useAppStore.setState(initial, true) })

describe('reusable candidates preserve each live preview', () => {
  it('prefers the exact owner over an earlier unused candidate', () => {
    const unused = candidate(null, 'unused'), owned = candidate('A', 'owned')
    expect(warmTerminalForLauncher([unused, owned], 'A')).toBe(owned)
  })

  it('does not borrow another live preview or an unresolved explicit opening', () => {
    const active = candidate('A'), opening = { ...candidate(null, 'opening'), session: null, explicitOpening: true as const }
    const claimed = { ...candidate(null, 'claimed'), claimToken: {} }
    expect(warmTerminalForLauncher([active, opening, claimed], 'B')).toBeNull()
  })

  it('can reuse a released candidate while keeping the original Run and request', () => {
    const available = candidate(null)
    expect(warmTerminalForLauncher([candidate('A'), available], 'B')).toBe(available)
  })

  it('can reuse a ready orphan after its explicit opening has released the presentation', () => {
    const orphan = { ...candidate(null, 'orphan'), explicitOpening: true as const }
    expect(warmTerminalForLauncher([candidate('A'), orphan], 'B')).toBe(orphan)
  })

  it('only the exact owner renders a ready or pending Run', () => {
    const owned = candidate('A')
    expect(warmTerminalPreview({ warmTerminal: owned, warmKey: key, launcherId: 'A' }))
      .toMatchObject({ session: owned.session, pending: false, state: 'ready' })
    expect(warmTerminalPreview({ warmTerminal: owned, warmKey: key, launcherId: 'B' }).session).toBeNull()
    const pending = { ...owned, session: null }
    expect(warmTerminalPreview({ warmTerminal: pending, warmKey: key, launcherId: 'A' }).pending).toBe(true)
    expect(warmTerminalForLauncher([pending], 'B')).toBeNull()
  })

  it('does not confuse the same directory on different Hosts', () => {
    expect(key).not.toBe(warmTerminalKey('remote', project.path))
  })

  it('gives empty Groups and actual Regions distinct, stable owner identities', () => {
    expect(warmLauncherId({ tabGroupId: 'group', regionId: undefined })).toBe('group:group')
    expect(warmLauncherId({ tabGroupId: 'group', regionId: 'region' })).toBe('region:region')
    expect(warmLauncherId({ tabGroupId: 'same', regionId: undefined }))
      .not.toBe(warmLauncherId({ tabGroupId: 'other', regionId: 'same' }))
  })
})

describe('the real Store allocates candidates without a project or preview quota', () => {
  it('keeps different project creations and their late receipts independently', async () => {
    let resolveFirst!: (session: SessionSnapshot) => void
    const first = new Promise<SessionSnapshot>(resolve => { resolveFirst = resolve })
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockReturnValueOnce(first).mockResolvedValueOnce(shell('other'))
    const stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.getState().prewarmTerminal(project.id, 'A')
    useAppStore.getState().prewarmTerminal(other.id, 'B')
    const original = useAppStore.getState().warmTerminals[key]![0]!
    resolveFirst(shell('original'))
    await Promise.all([original.ready, useAppStore.getState().warmTerminals[otherKey]![0]!.ready])
    expect(launch).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().warmTerminals[key]![0]?.session?.id).toBe('original')
    expect(useAppStore.getState().warmTerminals[otherKey]![0]?.session?.id).toBe('other')
    expect(launch.mock.calls[0]![0].createOperationId).not.toBe(launch.mock.calls[1]![0].createOperationId)
    expect(stop).not.toHaveBeenCalled()
  })

  it('creates another candidate instead of stealing a live preview in the same project', async () => {
    const active = candidate('A', 'original')
    useAppStore.setState({ warmTerminals: { [key]: [active] } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(shell('independent'))
    useAppStore.getState().prewarmTerminal(project.id, 'B')
    const candidates = useAppStore.getState().warmTerminals[key]!
    expect(candidates).toHaveLength(2)
    expect(candidates.find(item => item.ownerLauncherId === 'A')).toBe(active)
    await candidates.find(item => item.ownerLauncherId === 'B')!.ready
    expect(launch).toHaveBeenCalledOnce()
    expect(useAppStore.getState().warmTerminals[key]!.find(item => item.ownerLauncherId === 'B')?.session?.id).toBe('independent')
  })

  it('the same owner is idempotent and a released preview is reusable without spawning', () => {
    const active = candidate('A')
    useAppStore.setState({ warmTerminals: { [key]: [active] } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal'), stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.getState().prewarmTerminal(project.id, 'A')
    expect(useAppStore.getState().warmTerminals[key]![0]).toBe(active)
    useAppStore.getState().releaseWarmTerminal(project.id, 'A')
    expect(useAppStore.getState().warmTerminals[key]![0]?.ownerLauncherId).toBeNull()
    useAppStore.getState().prewarmTerminal(project.id, 'B')
    expect(useAppStore.getState().warmTerminals[key]![0]).toMatchObject({ ownerLauncherId: 'B', session: active.session })
    expect(useAppStore.getState().warmTerminals[key]![0]?.ready).toBe(active.ready)
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })

  it('releasing a preview does not erase an explicit opening or lend its claimed Run', async () => {
    const opening = { ...candidate('A'), explicitOpening: true as const, claimToken: {} }
    useAppStore.setState({ warmTerminals: { [key]: [opening] } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockResolvedValue(shell('B'))
    const stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.getState().releaseWarmTerminal(project.id, 'A')
    useAppStore.getState().prewarmTerminal(project.id, 'B')
    const candidates = useAppStore.getState().warmTerminals[key]!
    expect(candidates.find(item => item.claimToken === opening.claimToken)).toBe(opening)
    await candidates.find(item => item.ownerLauncherId === 'B')!.ready
    expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
  })

  it('a ready orphan used as a preview becomes reusable again when that preview is released', () => {
    const orphan = { ...candidate('A', 'orphan'), explicitOpening: true as const }
    useAppStore.setState({ warmTerminals: { [key]: [orphan] } })
    const launch = vi.spyOn(api.sessions, 'launchTerminal'), stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.getState().releaseWarmTerminal(project.id, 'A')
    expect(useAppStore.getState().warmTerminals[key]![0]).toMatchObject({ ownerLauncherId: null, explicitOpening: true })
    useAppStore.getState().prewarmTerminal(project.id, 'B')
    expect(useAppStore.getState().warmTerminals[key]![0]).toMatchObject({ ownerLauncherId: 'B', session: orphan.session, explicitOpening: true })
    expect(launch).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
  })

  it('an empty Group removed during its explicit opening keeps the original Run reachable elsewhere', async () => {
    let resolve!: (session: SessionSnapshot) => void
    const receipt = new Promise<SessionSnapshot>(yes => { resolve = yes })
    const session = shell('original')
    const launch = vi.spyOn(api.sessions, 'launchTerminal').mockReturnValue(receipt)
    vi.spyOn(api.sessions, 'refresh').mockResolvedValue(session)
    const stop = vi.spyOn(api.sessions, 'stop')
    useAppStore.setState({ activeWorkspaceId: project.id, tabs: {}, closingWorkbenchViews: {},
      layouts: { [project.id]: createWorkspaceLayout('opening') } })
    useAppStore.getState().prewarmTerminal(project.id, 'group:opening')
    const opening = useAppStore.getState().promoteWarmTerminal('opening')
    const rejected = expect(opening).rejects.toThrow('no longer available')
    useAppStore.setState({ layouts: { [project.id]: createWorkspaceLayout('recovery') } })
    resolve(session); await rejected
    expect(useAppStore.getState().warmTerminals[key]![0]?.ownerLauncherId).toBeNull()
    await useAppStore.getState().promoteWarmTerminal('recovery')
    expect(useAppStore.getState().sessions.map(item => item.id)).toEqual(['original'])
    expect(Object.values(useAppStore.getState().tabs).flatMap(tab => Object.values(tab.regions)))
      .toEqual([expect.objectContaining({ kind: 'terminal', sessionId: 'original' })])
    expect(launch).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled()
  })
})

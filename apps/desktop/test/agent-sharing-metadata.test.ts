import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { AgentCatalogEntry } from '@agentmux/core'
import type { AgentExecutorConfig, SessionSnapshot } from '../src/shared/contracts'
import { api } from '../src/renderer/src/lib/api'
import { resolveAgentSharingMetadata } from '../src/renderer/src/lib/agent-sharing-metadata'
import { agentRosterMenuActions } from '../src/renderer/src/lib/agent-roster-menu'
import { terminalIdentityMenuActions } from '../src/renderer/src/lib/terminal-identity-menu'
import { createRegionCopyModel } from '../src/renderer/src/components/RegionContextMenu'
import { createWorkbenchTabCopyModel } from '../src/renderer/src/components/WorkbenchTabContextMenu'

type SharingFacts = Parameters<typeof resolveAgentSharingMetadata>[1]
let base: Extract<SessionSnapshot, { kind: 'agent' }>
let catalog: AgentCatalogEntry
let executor: AgentExecutorConfig
beforeAll(async () => {
  const [snapshot, entries, config] = await Promise.all([api.sessions.snapshot(), api.providers.list(), api.config.get()])
  const agent = snapshot.sessions.find(session => session.kind === 'agent')
  expect(agent).toBeDefined()
  base = agent!
  expect(entries.length).toBeGreaterThan(0)
  catalog = entries[0]!
  executor = config.executors[base.executorId]!
  expect(executor).toBeDefined()
})
function facts(): SharingFacts {
  return {
    sessions: [
      { ...base, id: 'same-name-first', providerId: 'shared-provider', executorId: 'author', nativeSessionId: 'native-author', label: 'Same name' },
      { ...base, id: 'target', providerId: 'shared-provider', executorId: 'reviewer', nativeSessionId: 'native-review', label: 'Same name' }
    ],
    providerCatalog: [{ ...catalog, id: 'shared-provider', label: 'Shared Provider' }],
    config: { executors: {
      author: { ...executor, providerId: 'shared-provider', label: 'Author Executor' },
      // Configuration can change after launch: Provider identity still belongs to the original Session.
      reviewer: { ...executor, providerId: 'reconfigured-provider', label: 'Review Executor' }
    } }
  }
}

describe('Sharing metadata follows the exact Session execution identity', () => {
  it('distinguishes two Executors of one Provider even with identical Session display names', () => {
    const input = facts()
    expect(resolveAgentSharingMetadata('target', input)).toEqual({ nativeSessionId: 'native-review', provider: 'Shared Provider', executor: 'Review Executor' })
    expect(resolveAgentSharingMetadata('same-name-first', input)).toEqual({ nativeSessionId: 'native-author', provider: 'Shared Provider', executor: 'Author Executor' })
  })
  it('keeps persisted Provider and Executor IDs when current configuration is absent', () => {
    const input = facts()
    expect(resolveAgentSharingMetadata('target', { ...input, providerCatalog: [], config: null }))
      .toEqual({ nativeSessionId: 'native-review', provider: 'shared-provider', executor: 'reviewer' })
    expect(resolveAgentSharingMetadata('target', { ...input, config: { executors: {} } }))
      .toEqual({ nativeSessionId: 'native-review', provider: 'Shared Provider', executor: 'reviewer' })
  })
  it('does not claim identity from empty configuration labels', () => {
    const input = facts()
    input.providerCatalog = [{ ...catalog, id: 'shared-provider', label: '' }]
    input.config = { executors: { reviewer: { ...executor, label: '' } } }
    expect(resolveAgentSharingMetadata('target', input)).toEqual({ nativeSessionId: 'native-review', provider: 'shared-provider', executor: 'reviewer' })
  })
  it('does not substitute the Core SID when a known Agent lacks native identity', () => {
    const input = facts()
    input.sessions = input.sessions.map(session => {
      if (session.kind !== 'agent') return session
      const { nativeSessionId: _native, ...unknown } = session
      return unknown
    })
    const metadata = resolveAgentSharingMetadata('target', input)
    expect(metadata.nativeSessionId).toBeUndefined()
    expect(metadata).toMatchObject({ provider: 'Shared Provider', executor: 'Review Executor' })
  })
  it('leaves unknown observation and plain terminals without invented Agent metadata', () => {
    const terminal: SessionSnapshot = {
      ...base, kind: 'terminal', id: 'terminal', providerId: null,
      control: { kind: 'terminal', hostId: 'local', runId: 'terminal-run', run: { runId: 'terminal-run' } }
    }
    const input = { ...facts(), sessions: [terminal] }
    expect(resolveAgentSharingMetadata('target', input)).toEqual({})
    expect(resolveAgentSharingMetadata('terminal', input)).toEqual({})
    expect(resolveAgentSharingMetadata(null, input)).toEqual({})
  })
})

describe('Production identity menu models copy one current card', () => {
  it('gives Region, Tab, Terminal and Roster identical SID cards while only a clicked Region adds its position', async () => {
    const copied: string[] = []
    const sharingMetadata = vi.fn(() => resolveAgentSharingMetadata('target', facts()))
    const input = { sessionId: 'target', sharingMetadata, writeClipboardText: async (text: string) => { copied.push(text) } }
    const region = createRegionCopyModel({ ...input, regionId: 'region:clicked', agentSessionId: input.sessionId })
    const tab = createWorkbenchTabCopyModel({ ...input, tabId: 'tab:multiple-projections', agentSessionId: input.sessionId })
    const terminal = terminalIdentityMenuActions({ ...input, sessionKind: 'agent' })
    const roster = agentRosterMenuActions(input)
    expect(terminal.map(action => action.label)).toEqual(['Message this Agent', 'Copy Session Address'])
    expect(roster.map(action => action.label)).toEqual(['Message this Agent', 'Copy Session Address'])
    expect(sharingMetadata).not.toHaveBeenCalled()
    expect(region.sessionAddress).toBeDefined()
    expect(tab.sessionAddress).toBeDefined()
    await region.sessionAddress!.onSelect()
    await tab.sessionAddress!.onSelect()
    await terminal[1]!.onSelect()
    await roster[1]!.onSelect()
    expect(copied).toHaveLength(4)
    expect(new Set(copied).size).toBe(1)
    expect(copied[0]).toContain('ID: target\n')
    expect(copied[0]).toContain('Exe: native-review | Review Executor (Shared Provider)\n')
    expect(copied[0]).not.toContain('Author Executor')
    expect(copied[0]).not.toContain('region:')
    copied.length = 0
    expect(region.handoff).toBeDefined()
    await region.handoff!.onSelect()
    await tab.handoff!.onSelect()
    await terminal[0]!.onSelect()
    await roster[0]!.onSelect()
    expect(copied).toHaveLength(4)
    expect(copied[0]).toContain('region:clicked')
    expect(copied[0]).toContain('ID: target\n')
    expect(copied[0]).toContain('Exe: native-review | Review Executor (Shared Provider)\n')
    expect(new Set(copied.slice(1)).size).toBe(1)
    expect(copied[1]).not.toContain('region:')
    expect(sharingMetadata).toHaveBeenCalledTimes(8)
  })
  it('resolves display labels at each selection, preserving an unknown SID copy action', async () => {
    let current = facts()
    const writeClipboardText = vi.fn(async (_text: string) => {})
    const actions = agentRosterMenuActions({ sessionId: 'target', writeClipboardText,
      sharingMetadata: () => resolveAgentSharingMetadata('target', current) })
    current = { ...current, config: { executors: { reviewer: { ...executor, label: 'Renamed Executor' } } } }
    await actions[1]!.onSelect()
    expect(writeClipboardText.mock.calls[0]![0]).toContain('Exe: native-review | Renamed Executor (Shared Provider)\n')
    current = { ...current, sessions: current.sessions.map(session => session.kind === 'agent'
      ? { ...session, nativeSessionId: 'updated-native' } : session) }
    await actions[1]!.onSelect()
    expect(writeClipboardText.mock.calls[1]![0]).toContain('Exe: updated-native | Renamed Executor (Shared Provider)\n')
    expect(writeClipboardText.mock.calls[1]![0]).toContain("--to-session='target'")
    current = { ...current, sessions: [] }
    await actions[0]!.onSelect()
    expect(writeClipboardText.mock.calls).toHaveLength(3)
    expect(writeClipboardText.mock.calls[2]![0]).toContain('ID: target\n')
    expect(writeClipboardText.mock.calls[2]![0]).toContain('Exe: ? | ? (?)')
  })
})

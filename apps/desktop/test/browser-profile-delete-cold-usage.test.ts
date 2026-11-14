import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { createBrowserProfileUsage, savedBrowsersUsingProfile, type BrowserProfileUsagePorts } from '../src/main/browser-profile-usage.js'

const approval = { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: 'profile-work' } as const

function graphWith(regions: Array<{ regionId: string; browserId: string; data: Record<string, unknown> }>): AgentMuxSpatialGraph {
  return {
    spaces: [], zones: [], bindings: [], layouts: {}, tabLayouts: {},
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'workspace', name: null, regionIds: regions.map(r => r.regionId) }],
    regions: regions.map(r => ({ regionId: r.regionId, tabId: 'tab', kind: 'browser', browserId: r.browserId,
      agentSessionId: null, runId: null, execution: null })),
    resources: Object.fromEntries(regions.map(r => ['region:' + r.regionId,
      { browserId: r.browserId, workspaceId: 'workspace', url: 'https://example.test/', ...r.data }]))
  } as unknown as AgentMuxSpatialGraph
}

function owner(overrides: Partial<BrowserProfileUsagePorts> = {}) {
  const ports = {
    open: vi.fn<BrowserProfileUsagePorts['open']>(() => []),
    readSaved: vi.fn<BrowserProfileUsagePorts['readSaved']>(async () => null),
    nativeUse: vi.fn<BrowserProfileUsagePorts['nativeUse']>(() => ({status:'idle',pages:0,workers:0,requests:0,downloads:0})),
    deleteProfile: vi.fn<BrowserProfileUsagePorts['deleteProfile']>(async (_id, _approval, _token, assertUnused) => { await assertUnused(); return { revision:1,archive:{} } as never }),
    ...overrides
  }
  return { ports, usage: createBrowserProfileUsage(ports) }
}

describe('saved Browsers that still need a Profile', () => {
  it('finds a normal saved Browser naming the Profile and ignores private, Capsule and other Profiles', () => {
    const graph = graphWith([
      { regionId: 'r1', browserId: 'b-work', data: { profileId: 'profile-work' } },
      { regionId: 'r2', browserId: 'b-other', data: { profileId: 'profile-other' } },
      { regionId: 'r3', browserId: 'b-private', data: { mode: 'private', profileId: 'profile-work' } },
      { regionId: 'r4', browserId: 'b-capsule', data: { capsuleId: 'cap', profileId: 'profile-work' } }
    ])
    expect(savedBrowsersUsingProfile(graph, 'profile-work').map(use => use.browserId)).toEqual(['b-work'])
    expect(savedBrowsersUsingProfile(graph, 'profile-other').map(use => use.browserId)).toEqual(['b-other'])
    expect(savedBrowsersUsingProfile(graph, 'profile-none')).toEqual([])
  })

  it('ignores a normal Region without a Profile (it restores into the default) and a Region outside every Tab', () => {
    const graph = graphWith([
      { regionId: 'r1', browserId: 'b-default', data: {} },
      { regionId: 'r2', browserId: 'b-work', data: { profileId: 'profile-work', title: 'Launch' } }
    ])
    expect(savedBrowsersUsingProfile(graph, 'profile-work')).toEqual([{ browserId: 'b-work', workspaceId: 'workspace', title: 'Launch', url: 'https://example.test/' }])
    graph.tabs[0]!.regionIds = ['r1']
    expect(savedBrowsersUsingProfile(graph, 'profile-work')).toEqual([])
  })
})

describe('Profile usage owner', () => {
  it('lists open Browsers first, then saved Browsers once each, and never counts an open one twice', async () => {
    const graph = graphWith([
      { regionId: 'r1', browserId: 'b-open', data: { profileId: 'profile-work', title: 'Saved copy' } },
      { regionId: 'r2', browserId: 'b-saved', data: { profileId: 'profile-work', title: 'Notes' } },
      { regionId: 'r3', browserId: 'b-saved', data: { profileId: 'profile-work', title: 'Notes' } }
    ])
    const { usage } = owner({ open: () => [{ browserId: 'b-open', workspaceId: null, title: 'Live', url: 'https://live.test/' }], readSaved: async () => ({ graph }) })
    expect(await usage.usage('profile-work')).toEqual({ complete: true, native:{status:'idle',pages:0,workers:0,requests:0,downloads:0}, browsers: [
      { browserId: 'b-open', title: 'Live', url: 'https://live.test/', state: 'open' },
      { browserId: 'b-saved', workspaceId: 'workspace', title: 'Notes', url: 'https://example.test/', state: 'saved' }
    ] })
  })

  it('treats absent saved Tabs as known empty and an unreadable file as incomplete, keeping open Browsers', async () => {
    const live = () => [{ browserId: 'b-open', workspaceId: 'workspace', title: '', url: 'https://live.test/' }]
    expect(await owner({ open: live }).usage.usage('profile-work')).toMatchObject({ complete: true, browsers: [{ browserId: 'b-open', state: 'open' }] })
    expect(await owner({ open: live, readSaved: async () => { throw new Error('EIO') } }).usage.usage('profile-work'))
      .toMatchObject({ complete: false, browsers: [{ browserId: 'b-open', workspaceId: 'workspace', title: '', url: 'https://live.test/', state: 'open' }] })
  })
})

describe('Profile deletion refuses a Profile a Browser still needs', () => {
  it('refuses while a saved Browser that is not loaded names the Profile, and deletes once none does', async () => {
    let graph = graphWith([{ regionId: 'r1', browserId: 'b-work', data: { profileId: 'profile-work' } }])
    const { ports, usage } = owner({ readSaved: async () => ({ graph }) })
    await expect(usage.deleteProfile('profile-work', approval, 'exact-token')).rejects.toMatchObject({
      code: 'BROWSER_PROFILE_IN_USE',
      message: expect.stringContaining('still used by the saved Browser "https://example.test/". Open it and switch it to another Profile, or close it'),
      details: { browsers: [{ browserId: 'b-work', workspaceId: 'workspace', title: '', url: 'https://example.test/', state: 'saved' }] }
    })
    expect(ports.deleteProfile).toHaveBeenCalledOnce()
    graph = graphWith([{ regionId: 'r1', browserId: 'b-work', data: { profileId: 'profile-other' } }])
    await usage.deleteProfile('profile-work', approval, 'exact-token')
    expect(ports.deleteProfile).toHaveBeenLastCalledWith('profile-work', approval, 'exact-token', expect.any(Function))
  })

  it('sees a Browser that starts using the Profile while saved Tabs are being read', async () => {
    let live = false
    const { ports, usage } = owner({
      open: () => live ? [{ browserId: 'b-new', workspaceId: null, title: 'New', url: 'https://new.test/' }] : [],
      readSaved: async () => { live = true; return null }
    })
    await expect(usage.deleteProfile('profile-work', approval, 'exact-token')).rejects.toMatchObject({
      code: 'BROWSER_PROFILE_IN_USE', message: 'Browser Profile is still used by an open Browser',
      details: { browsers: [{ browserId: 'b-new', title: 'New', url: 'https://new.test/', state: 'open' }] }
    })
    expect(ports.deleteProfile).toHaveBeenCalledOnce()
  })

  it('deletes nothing when saved Tabs cannot be read, and keeps the original cause', async () => {
    const { ports, usage } = owner({ readSaved: async () => { throw new Error('EIO') } })
    await expect(usage.deleteProfile('profile-work', approval, 'exact-token')).rejects.toMatchObject({
      code: 'BROWSER_PROFILE_USAGE_UNKNOWN', message: expect.stringContaining('Its original data is kept'), cause: expect.objectContaining({ message: 'EIO' })
    })
    expect(ports.deleteProfile).toHaveBeenCalledOnce()
  })

  it('still deletes an unused Profile when no saved Tabs exist yet', async () => {
    const { ports, usage } = owner()
    await usage.deleteProfile('profile-work', approval, 'exact-token')
    expect(ports.deleteProfile).toHaveBeenCalledOnce()
  })

  it('does not clear previews when the manager refuses the deletion', async () => {
    const refusal = Object.assign(new Error('Browser Profile deletion requires explicit user approval'), { code: 'BROWSER_DESTRUCTIVE_APPROVAL_REQUIRED' })
    const { ports, usage } = owner({ deleteProfile: async () => { throw refusal } })
    await expect(usage.deleteProfile('profile-work', approval, 'exact-token')).rejects.toBe(refusal)
  })
})

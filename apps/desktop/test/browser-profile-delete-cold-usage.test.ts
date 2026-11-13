import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxSpatialGraph } from '@agentmux/core/spatial-graph'
import { savedBrowsersUsingProfile } from '../src/main/browser-profile-usage.js'

const approval = { kind: 'user-confirmed', operation: 'delete-profile', scope: 'profile', profileId: 'profile-work' }

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

// Runs the registered production callback from ipc.ts with its real collaborators replaced.
function productionDeleteHandler(dependencies: {
  usesProfile: (id: string) => boolean
  read: () => Promise<{ graph: AgentMuxSpatialGraph } | null>
  deleteProfile: (id: string, approval: unknown) => Promise<void>
}): (event: unknown, id: string, approval: unknown) => Promise<void> {
  const source = readFileSync(new NodeURL('../src/main/ipc.ts', import.meta.url), 'utf8')
  const parsed = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true)
  const callbacks: ts.Node[] = []
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'handleWithEvent' &&
      node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'browser:deleteProfile') callbacks.push(node.arguments[1]!)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  expect(callbacks).toHaveLength(1)
  const compiled = ts.transpileModule(`const handler = ${callbacks[0]!.getText(parsed)}; return handler;`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  return new Function('browsers', 'spatialState', 'savedBrowsersUsingProfile', 'browserProfiles', 'browserRecoveryPreviews', compiled)(
    { usesProfile: dependencies.usesProfile }, { read: dependencies.read }, savedBrowsersUsingProfile,
    { deleteProfile: dependencies.deleteProfile }, { clearProfile: async () => ({ status: 'cleared' }) }
  ) as ReturnType<typeof productionDeleteHandler>
}

describe('saved Browsers that still need a Profile', () => {
  it('finds a normal saved Browser naming the Profile and ignores private, Capsule and other Profiles', () => {
    const graph = graphWith([
      { regionId: 'r1', browserId: 'b-work', data: { profileId: 'profile-work' } },
      { regionId: 'r2', browserId: 'b-other', data: { profileId: 'profile-other' } },
      { regionId: 'r3', browserId: 'b-private', data: { mode: 'private', profileId: 'profile-work' } },
      { regionId: 'r4', browserId: 'b-capsule', data: { capsuleId: 'cap', profileId: 'profile-work' } }
    ])
    expect(savedBrowsersUsingProfile(graph, 'profile-work')).toEqual(['b-work'])
    expect(savedBrowsersUsingProfile(graph, 'profile-other')).toEqual(['b-other'])
    expect(savedBrowsersUsingProfile(graph, 'profile-none')).toEqual([])
  })
})

describe('Main deletion refuses a Profile a saved Browser still needs', () => {
  it('refuses while a saved Browser that is not loaded names the Profile, and deletes once none does', async () => {
    const deleteProfile = vi.fn(async () => {})
    let graph = graphWith([{ regionId: 'r1', browserId: 'b-work', data: { profileId: 'profile-work' } }])
    const handler = productionDeleteHandler({ usesProfile: () => false, read: async () => ({ graph }), deleteProfile })
    await expect(handler({}, 'profile-work', approval)).rejects.toThrow('saved Browser that has not been opened since restart')
    expect(deleteProfile).not.toHaveBeenCalled()
    graph = graphWith([{ regionId: 'r1', browserId: 'b-work', data: { profileId: 'profile-other' } }])
    await handler({}, 'profile-work', approval)
    expect(deleteProfile).toHaveBeenCalledExactlyOnceWith('profile-work', approval)
  })

  it('deletes nothing when saved Tabs cannot be read, and says so', async () => {
    const deleteProfile = vi.fn(async () => {})
    const handler = productionDeleteHandler({ usesProfile: () => false, read: async () => { throw new Error('EIO') }, deleteProfile })
    await expect(handler({}, 'profile-work', approval)).rejects.toThrow('Nothing was deleted')
    expect(deleteProfile).not.toHaveBeenCalled()
  })

  it('still deletes an unused Profile when no saved Tabs exist yet', async () => {
    const deleteProfile = vi.fn(async () => {})
    const handler = productionDeleteHandler({ usesProfile: () => false, read: async () => null, deleteProfile })
    await handler({}, 'profile-work', approval)
    expect(deleteProfile).toHaveBeenCalledOnce()
  })
})

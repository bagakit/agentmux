import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentMuxSpatialStateStore } from '../dist/spatial-state.js'
import { AgentMuxControlServer } from '../dist/public-rpc-server.js'
import { connectAgentMuxRpc } from '../dist/public-rpc-client.js'
import type { AgentMuxSpatialGraph, AgentMuxSpatialCommit } from '../src/spatial-graph.js'
import { createWorkspaceLayout } from '../src/spatial-layout.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function originalOwner() {
  const root = await mkdtemp(join(tmpdir(), 'amx-group-write-')); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const graph: AgentMuxSpatialGraph = {
    projectGroups: [{ groupId: 'review,purpose', name: 'Review', projectIds: ['local-project', 'remote-project'] },
      { groupId: 'original-group', name: 'Original', projectIds: ['local-project', 'remote-project'] }],
    spaces: ['local', 'remote'].map(hostId => ({ spaceId: hostId, kind: 'folder', name: 'Original', hostId, directoryPath: fixturePath("original"), projectId: hostId + '-project' })),
    zones: [{ zoneId: 'zone', workspaceId: 'original', kind: 'directory', hostId: 'remote', directoryPath: fixturePath("original"), branch: null }],
    tabs: [{ tabId: 'tab', zoneId: 'zone', workspaceId: 'original', name: null, regionIds: ['region'] }],
    regions: [{ regionId: 'region', tabId: 'tab', kind: 'agent', agentSessionId: 'original-session', runId: 'original-run', execution: { hostId: 'remote', cwd: fixturePath("execution") } }],
    bindings: [{ zoneId: 'zone', spaceId: 'remote' }], layouts: { original: createWorkspaceLayout('original-display-group', ['tab']) },
    tabLayouts: { tab: { root: { type: 'leaf', regionId: 'region' }, activeRegionId: 'region' } }, resources: { original: { draft: 'unsaved original work' } }
  }
  const store = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
  const saved = await store.commit({ expectedRevision: 0, graph })
  const server = new AgentMuxControlServer({ socketPath: join(root, 'control.sock'), coreClients: () => [], spatialState: store })
  await server.start(); cleanup.push(() => server.stop())
  const client = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); cleanup.push(() => client.dispose())
  const changed = structuredClone(saved.graph); changed.projectGroups!.shift()
  const cli = (args: string[]) => runCompiledObjectCli(['space', 'commit', ...args], objectCliEnvironment(root), JSON.stringify(changed))
  return { root, store, saved, changed, client, cli }
}
function expectOnlyGroupDissolved(actual: AgentMuxSpatialGraph, original: AgentMuxSpatialGraph) {
  expect(actual.projectGroups).toEqual([original.projectGroups![1]])
  const { projectGroups: _groups, ...rest } = actual, { projectGroups: _originalGroups, ...originalRest } = original
  expect(rest).toEqual(originalRest)
  expect(actual.regions[0]).toMatchObject({ agentSessionId: 'original-session', runId: 'original-run', execution: { hostId: 'remote', cwd: fixturePath("execution") } })
}
it('typed public client dissolves one exact overlapping group through the original Core owner', async () => {
  const h = await originalOwner()
  const reply = await h.client.call('space.commit', { expectedRevision: h.saved.revision, graph: h.changed, removedProjectGroupIds: ['review,purpose'] })
  expect(reply.state.revision).toBe(h.saved.revision + 1); expectOnlyGroupDissolved(reply.state.graph, h.saved.graph)
  expect((await h.client.call('space.state', {})).state).toEqual(await h.store.read())
})
it('public owner refuses omitted or malformed dissolution without changing any original bytes', async () => {
  const h = await originalOwner(), before = await readFile(h.store.path)
  for (const [intent, code] of [
    [{}, 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED'], [{ allowEntityRemoval: true }, 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED'],
    [{ removedProjectGroupIds: ['other-group'] }, 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED'],
    [{ removedProjectGroupIds: ['review,purpose', 'review,purpose'] }, 'SPATIAL_STATE_INVALID'],
    [{ removedProjectGroupIds: 'review,purpose' }, 'SPATIAL_STATE_INVALID']
  ] as const) {
    await expect(h.client.call('space.commit', { expectedRevision: h.saved.revision, graph: h.changed, ...intent } as AgentMuxSpatialCommit)).rejects.toMatchObject({ code })
    expect(await readFile(h.store.path)).toEqual(before)
  }
})
it('actual compiled CLI discovers and consumes exact group removal JSON without changing execution or other groups', async () => {
  const h = await originalOwner(), file = join(h.root, 'removal.json')
  const help = await runCompiledObjectCli(['space', 'commit', '--help'], objectCliEnvironment(h.root))
  expect(help.code).toBe(0); expect(help.stdout).toContain('--removed-project-groups FILE')
  await writeFile(file, JSON.stringify(['review,purpose']))
  const reply = await h.cli(['--revision', String(h.saved.revision), '--removed-project-groups', file])
  expect(reply.code, reply.stderr).toBe(0); expect(reply.stderr).toBe('')
  const actual = JSON.parse(reply.stdout).result.state
  expect(actual.revision).toBe(h.saved.revision + 1); expectOnlyGroupDissolved(actual.graph, h.saved.graph)
  expect(await h.store.read()).toEqual(actual)
})
it('actual compiled CLI rejects missing intent, invalid arrays, shared stdin and stale revisions without a write', async () => {
  const h = await originalOwner(), before = await readFile(h.store.path), file = join(h.root, 'removal.json')
  const check = async (args: string[], code: string) => {
    const reply = await h.cli(args); expect(reply.code).not.toBe(0)
    expect(JSON.parse(reply.stderr).error.code).toBe(code); expect(await readFile(h.store.path)).toEqual(before)
  }
  await check(['--revision', '1'], 'SPATIAL_ENTITY_REMOVAL_UNCONFIRMED')
  await writeFile(file, JSON.stringify(['review,purpose', 'review,purpose']))
  await check(['--revision', '1', '--removed-project-groups', file], 'SPATIAL_STATE_INVALID')
  await check(['--revision', '1', '--removed-project-groups', '-'], 'INVALID_CLI_ARGUMENT')
  await writeFile(file, JSON.stringify(['review,purpose']))
  await check(['--revision', '0', '--removed-project-groups', file], 'SPATIAL_STATE_CONFLICT')
})

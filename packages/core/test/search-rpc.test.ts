import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import type { AgentMuxRpcSnapshot } from '../src/public-rpc.js'
import type { AgentMuxSpaceCatalog } from '../src/space-control.js'
import type { AgentMuxSearchInput } from '../src/search-contract.js'
import { createHistoryQueryFixture } from './helpers/session-history-query.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function fixture() {
  const f = await createHistoryQueryFixture(cleanups)
  const catalog: AgentMuxSpaceCatalog = {
    spaces: [], zones: [], bindings: [],
    tabs: [{ tabId: 'original-tab', zoneId: null, workspaceId: 'resource-workspace', name: 'Original task', regionIds: ['original-region'] }],
    regions: [{ regionId: 'original-region', tabId: 'original-tab', kind: 'agent', agentSessionId: f.session.agentSessionId, runId: 'original-run', execution: { hostId: 'local', cwd: f.root } }],
    locations: ['group-one', 'group-two'].map(groupId => ({ spaceId: null, zoneId: null, workspaceId: 'resource-workspace', displayWorkspaceId: 'display-workspace', groupId, tabId: 'original-tab', regionId: 'original-region' }))
  }
  const projects: AgentMuxRpcSnapshot['projects'] = Array.from({ length: 1002 }, (_, index) => ({ hostId: 'local', projectId: `original-project-${index}`, name: `Project ${index}`, kind: 'folder', path: `project-root-${index}`, repoPath: null, branch: null, activeAgentSessionIds: [] }))
  const execute = vi.fn(async (request: { operation: string }) => {
    if (request.operation === 'space.ls') return { operation: 'space.ls' as const, catalog }
    if (request.operation === 'list.projects') return { operation: 'list.projects' as const, projects }
    throw new Error('Search cannot operate a Run or fabricate another owner')
  })
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'control.sock'), coreClients: () => [{ hostId: 'local', client: f.client }], execute,
    snapshot: async () => ({ workspaces: [], topics: [], motes: [], unavailable: [] }) })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(f.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  return { ...f, rpc, execute }
}
it('searches the full original catalogs and preserves all exact Agent locations through Unix RPC and compiled CLI', async () => {
  const f = await fixture()
  const page = await f.rpc.call('app.search', { mode: 'metadata', query: 'original-native' })
  expect(page.coverage.unavailable).toEqual([])
  const agent = page.hits.find(hit => hit.kind === 'object' && hit.target.kind === 'agent')
  expect(agent).toMatchObject({ target: { hostId: 'local', sourceHostId: 'local', agentSessionId: f.session.agentSessionId }, locations: [{ reference: { groupId: 'group-one' } }, { reference: { groupId: 'group-two' } }] })
  const project = await f.rpc.call('app.search', { mode: 'metadata', query: 'original-project-1001' })
  expect(project.hits).toContainEqual({ kind: 'object', target: { kind: 'project', hostId: 'local', projectId: 'original-project-1001' }, name: 'Project 1001', locations: [] })
  const cli = await runCompiledObjectCli(['app', 'search', '--mode', 'metadata', '--query', 'original-native'], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.hits).toEqual(page.hits)
  for (const args of [['app', 'search', '--help'], ['app', '--help'], ['--skill']]) {
    const help = await runCompiledObjectCli(args, objectCliEnvironment(f.root)); expect(help.code, help.stderr).toBe(0); expect(help.stdout).toContain('search')
  }
  expect(f.execute.mock.calls.every(([request]) => ['space.ls', 'list.projects'].includes(request.operation))).toBe(true)
  await f.noControls()
})
it('continues real captured text and native Provider records through the public service and compiled CLI with truthful unavailable coverage', async () => {
  const f = await fixture(), original = (await f.store.readMetadata(f.session.agentSessionId))!
  await f.store.compareAndSwap(original, { ...original, hostId: 'original-execution-host' })
  await f.store.applyTimelineMutation({ type: 'append', agentSessionId: original.agentSessionId, item: f.captured(10, 'captured needle') })
  const input: AgentMuxSearchInput = { mode: 'history', query: 'needle', hostId: 'local', agentSessionId: original.agentSessionId, source: 'captured', limit: 1, scanLimit: 2 }
  const page = await f.rpc.call('app.search', input)
  expect(page.hits[0]).toMatchObject({ reference: { hostId: 'local', sourceHostId: 'original-execution-host', source: 'captured' }, page: { items: [{ item: { content: 'captured needle' } }] } })
  expect(page.nextCursor).toBeTypeOf('string')
  const cli = await runCompiledObjectCli(['app', 'search', '--mode', 'history', '--query', 'needle', '--host', 'local', '--session', original.agentSessionId,
    '--source', 'captured', '--limit', '1', '--scan-limit', '2', '--cursor', page.nextCursor!], objectCliEnvironment(f.root))
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result.coverage.examined).toBe(2)
  await expect(f.rpc.call('app.search', { ...input, query: 'changed', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'AGENTMUX_SEARCH_SOURCE_CHANGED' })
  const native = await f.rpc.call('app.search', { ...input, source: 'native', scanLimit: 50 })
  expect(native.hits[0]).toMatchObject({ reference: { sourceHostId: 'original-execution-host', source: 'native' }, page: { items: [{ item: { id: 'record-0' } }] } })
  const absent = await f.rpc.call('app.search', { mode: 'history', query: 'needle', hostId: 'missing-host' })
  expect(absent.hits).toEqual([]); expect(absent.coverage).toMatchObject({ complete: false, unavailableCount: 1 })
  await f.noControls()
})
it('keeps identical Session scalars on two original endpoint routes separate', async () => {
  const a = await createHistoryQueryFixture(cleanups), b = await createHistoryQueryFixture(cleanups)
  await a.store.applyTimelineMutation({ type: 'append', agentSessionId: a.session.agentSessionId, item: a.captured(20, 'route A needle') })
  await b.store.applyTimelineMutation({ type: 'append', agentSessionId: b.session.agentSessionId, item: b.captured(20, 'route B needle') })
  const server = new AgentMuxControlServer({ socketPath: join(a.root, 'control.sock'), coreClients: () => [{ hostId: 'route-a', client: a.client }, { hostId: 'route-b', client: b.client }] })
  await server.start(); cleanups.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(a.root, 'control.sock') } }); cleanups.push(() => rpc.dispose())
  const page = await rpc.call('app.search', { mode: 'history', query: 'needle', source: 'captured', scanLimit: 50 })
  expect(page.hits).toHaveLength(2)
  expect(page.hits.map(hit => hit.kind === 'history' ? [hit.reference.hostId, hit.reference.sourceHostId, hit.page.items[0]?.kind === 'item' && 'content' in hit.page.items[0].item ? hit.page.items[0].item.content : null] : null)).toEqual([
    ['route-a', 'local', 'route A needle'], ['route-b', 'local', 'route B needle']])
  expect(page.coverage.complete).toBe(true); await a.noControls(); await b.noControls()
})

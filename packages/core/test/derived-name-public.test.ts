import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { AgentMuxSpatialStateStore } from '../src/spatial-state.js'
import { displayLabel, type AgentMuxNameContext } from '../src/display-label.js'
import { parseRpcNativeResult } from '../src/rpc-native-codec.js'
import { parseSpaceControlRequest } from '../src/space-control-parser.js'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from './helpers/object-cli-rpc.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks() })
const original = { sid: 'coordinator', tab: 'discussion', region: 'original-region' }
const context: AgentMuxNameContext = { actor: { kind: 'device', id: 'private-person', verified: true },
  source: 'explicit-edit', entryPoint: 'test', transport: 'unix', location: {} }
async function fixture() {
  const h = await rpcOwnerFixture([original.sid]); cleanup.push(h.close)
  const spatial = new AgentMuxSpatialStateStore(join(h.root, 'spatial.json'))
  await spatial.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {},
    tabs: [{ tabId: original.tab, workspaceId: 'private-workspace', zoneId: null, name: null, regionIds: [original.region] }],
    regions: [{ regionId: original.region, tabId: original.tab, kind: 'agent', agentSessionId: original.sid,
      runId: 'run-' + original.sid, execution: { hostId: 'local', cwd: h.root } }],
    tabLayouts: { [original.tab]: { root: { type: 'leaf', regionId: original.region }, activeRegionId: original.region } },
    resources: { 'private-draft': 'Keep my next thought' } } })
  const server = new AgentMuxControlServer({ spatialState: spatial, coreClients: h.coreClients, socketPath: join(h.root, 'control.sock') })
  await server.start(); cleanup.push(() => server.stop())
  const env = objectCliEnvironment(h.root, { AGENTMUX_AGENT_SESSION_ID: original.sid, AGENTMUX_AGENT_CAPABILITY: h.capability })
  const rawCli = (args: string[]) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, ...args], env)
  const cli = async (args: string[], expectedCode = 0) => {
    const result = await rawCli(args)
    expect(result.code, result.stderr || result.stdout).toBe(expectedCode)
    expect(result.stdout.trim(), result.stderr).not.toBe('')
    return JSON.parse(result.stdout).result
  }
  return { ...h, spatial, cli, rawCli }
}
const target = (kind: 'agent-session' | 'tab') => ({ kind, id: kind === 'tab' ? original.tab : original.sid })
const command = (kind: 'agent-session' | 'tab') => kind === 'tab' ? ['space', 'rename', '--tab', original.tab] : ['agent', 'rename', '--session', original.sid]

it('compiled CLI refines derived Session and Tab names through the original owner without claiming a human edit', async () => {
  const h = await fixture(), before = await h.spatial.readForLayout()
  for (const kind of ['agent-session', 'tab'] as const) {
    for (const [revision, name] of ['New goal · PMO', 'Recover reports · PMO'].entries()) {
      const result = await h.cli([...command(kind), '--derived', '--name', name, '--name-revision', String(revision)])
      expect(result).toMatchObject({ override: name, outcome: 'renamed', nameRevision: revision + 1,
        save: { diskDurability: 'confirmed' }, record: { context: { actor: { kind: 'agent', id: original.sid, verified: true } } } })
      expect(displayLabel((await h.spatial.readForLayout())!.graph, target(kind))).toMatchObject({ value: name, source: 'derived', nameRevision: revision + 1 })
    }
  }
  const inspection = await h.cli(['agent', 'inspect', '--session', original.sid])
  expect(inspection.displayName).toEqual({ override: 'Recover reports · PMO', source: 'derived', nameRevision: 2, availability: 'observed' })
  expect(() => parseRpcNativeResult('agent.inspect', inspection, { target: { kind: 'agent-session', agentSessionId: original.sid } })).not.toThrow()
  const missing = structuredClone(inspection); delete missing.displayName.source
  expect(() => parseRpcNativeResult('agent.inspect', missing, { target: { kind: 'agent-session', agentSessionId: original.sid } })).toThrow()
  const after = (await new AgentMuxSpatialStateStore(h.spatial.path).readForLayout())!
  expect(after.graph.regions).toEqual(before!.graph.regions)
  expect(after.graph.tabLayouts).toEqual(before!.graph.tabLayouts)
  expect(after.graph.resources['private-draft']).toBe('Keep my next thought')
  for (const name of ['attach', 'detach', 'stop', 'input']) expect(h.inner.kernel[name]).not.toHaveBeenCalled()
})

it.each(['manual', 'clear', 'launch', 'retained'] as const)('derived CLI protects %s intent on both exact targets and preserves its source', async source => {
  const h = await fixture()
  for (const kind of ['agent-session', 'tab'] as const) {
    if (source === 'retained') await h.spatial.retainDisplayLabels([{ target: target(kind), value: 'Saved original' }])
    else await h.spatial.mutateDisplayLabel({ target: target(kind), operationId: 'original-' + kind, expectedNameRevision: 0,
      source: source === 'clear' ? 'manual' : source, value: source === 'clear' ? null : 'Chosen original' }, context)
    const before = displayLabel((await h.spatial.readForLayout())!.graph, target(kind))!
    const result = await h.cli([...command(kind), '--derived', '--name', 'Automatic suggestion', '--name-revision', String(before.nameRevision)], 1)
    expect(result).toMatchObject({ override: before.value, changed: false, outcome: 'partial', record: { status: 'failed', reason: expect.stringContaining('protected') } })
    expect(displayLabel((await h.spatial.readForLayout())!.graph, target(kind))).toEqual(before)
  }
  const inspection = await h.cli(['agent', 'inspect', '--session', original.sid])
  expect(inspection.displayName).toMatchObject({ source: source === 'clear' ? 'manual' : source, availability: 'observed' })
  if (source === 'clear') expect(inspection.displayName.override).toBeNull()
})

it('an explicit edit remains available, and an older derived request cannot replace its newer revision', async () => {
  const h = await fixture()
  await h.cli([...command('agent-session'), '--derived', '--name', 'Temporary · PMO', '--name-revision', '0'])
  const explicit = await h.cli([...command('agent-session'), '--name', 'My original title', '--name-revision', '1'])
  expect(explicit).toMatchObject({ override: 'My original title', nameRevision: 2, outcome: 'renamed' })
  const stale = await h.cli([...command('agent-session'), '--derived', '--name', 'Late refinement', '--name-revision', '1'], 1)
  expect(stale).toMatchObject({ override: 'My original title', nameRevision: 2, outcome: 'partial', record: { reason: expect.stringContaining('changed since') } })
})

it('the new source selector accepts only derived and never accepts caller-supplied actor credentials', () => {
  const request = { schemaVersion: 5, requestId: 'precise-name-operation', operation: 'agent.rename',
    agentSessionId: original.sid, name: 'Name', expectedNameRevision: 0 }
  const derived = () => parseSpaceControlRequest({ ...request, nameSource: 'derived' })
  expect(derived).not.toThrow()
  expect(derived()).toMatchObject({ nameSource: 'derived' })
  for (const nameSource of ['manual', 'launch', 'user', null]) expect(() => parseSpaceControlRequest({ ...request, nameSource })).toThrow()
  expect(() => parseSpaceControlRequest({ ...request, actor: { kind: 'user' } })).toThrow()
})

it('the original naming operation freezes derived versus explicit intent across retries', async () => {
  const h = await fixture()
  for (const kind of ['agent-session', 'tab'] as const) {
    const args = [...command(kind), '--operation-id', 'frozen-name-' + kind, '--name', 'Original name', '--name-revision', '0']
    const first = await h.cli([...args, '--derived'])
    expect(first.record.context).toMatchObject({ source: 'derived', actor: { kind: 'agent', id: original.sid } })
    const changed = await h.rawCli(args)
    expect(changed.code).toBe(1)
    expect(JSON.parse(changed.stderr).error.code).toBe('NAME_OPERATION_CONFLICT')
    expect(displayLabel((await h.spatial.readForLayout())!.graph, target(kind))).toMatchObject({ source: 'derived', nameRevision: 1, value: 'Original name' })
    const replay = await h.cli([...args, '--derived'], 1)
    expect(replay).toMatchObject({ override: 'Original name', changed: false, save: { diskDurability: 'unconfirmed' } })
  }
})

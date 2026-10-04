import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AgentMuxSpatialStateStore, displayLabel } from '../../../packages/core/src/spatial-state'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'

it('reuses both actual public name commands and the original durable owner without lifecycle actions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-tab-public-'))
  const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial.json'))
  const sid = 'original-agent', tabId = 'original-tab'
  const session = { kind: 'agent', agentSessionId: sid, hostId: 'local', workspacePath: _hygiene_fixturePath("original-cwd"), run: { runId: 'original-run' } }
  const originalRegion = { regionId: 'original-region', tabId, kind: 'agent' as const, agentSessionId: sid,
    runId: 'original-run', execution: { hostId: 'local', cwd: _hygiene_fixturePath("original-cwd") } }
  await owner.commit({ expectedRevision: 0, graph: { spaces: [], zones: [], bindings: [], layouts: {}, resources: {},
    tabs: [{ tabId, workspaceId: 'original-workspace', zoneId: null, name: null, regionIds: [originalRegion.regionId] }],
    regions: [originalRegion], tabLayouts: { [tabId]: { root: { type: 'leaf', regionId: originalRegion.regionId }, activeRegionId: originalRegion.regionId } } } })
  // This read-only SDK seam supplies one exact private Session; it cannot stop, resume or send input.
  const client = { agentSessions: () => [session], readAgentSessions: async () => [session] }
  const server = new AgentMuxControlServer({ spatialState: owner, coreClients: () => [{ hostId: 'local', client: client as never }], socketPath: join(directory, 'control.sock') })
  await server.start(); const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_')))
    env.AGENTMUX_RUNTIME_DIRECTORY = directory
    const run = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath,
      [resolve('packages/core/dist/agentmux.js'), ...args], { env, timeout: 10000 })).stdout.trim())
    const agent = await run(['agent', 'rename', '--session', sid, '--name-revision', '0', '--name', 'Shared public name'])
    const tab = await run(['space', 'rename', '--tab', tabId, '--name-revision', '0', '--name', 'Shared public name'])
    expect(agent).toMatchObject({ ok: true, result: { agentSessionId: sid, override: 'Shared public name', nameRevision: 1, save: { diskDurability: 'confirmed' } } })
    expect(tab).toMatchObject({ ok: true, result: { tabId, override: 'Shared public name', nameRevision: 1, save: { diskDurability: 'confirmed' } } })
    const conflict = await rpc.call('space.rename', { tabId, name: 'Stale name', expectedNameRevision: 0 })
    expect(conflict).toMatchObject({ outcome: 'partial', override: 'Shared public name', record: { status: 'failed' } })
    const history = await rpc.call('name.history', { target: { kind: 'tab', id: tabId } })
    expect(history.records).toHaveLength(2); expect(history.records[0]?.target).toEqual({ kind: 'tab', id: tabId })
    const graph = (await owner.read())!.graph
    expect(displayLabel(graph, { kind: 'agent-session', id: sid })?.value).toBe('Shared public name')
    expect(graph.tabs[0]?.name).toBe('Shared public name'); expect(graph.regions).toEqual([originalRegion])
  } finally { await rpc.dispose(); await server.stop(); await rm(directory, { recursive: true, force: true }) }
})

// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { composerConfig, composerSession } from './helpers/composer-dom-fixture'
import { createWorkbenchTab } from '../src/renderer/src/lib/workbench-tabs'
import { spatialCatalog, type SpatialWorkbench } from '../src/renderer/src/lib/space-agent-control'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'

function fixture() {
  const session = composerSession('original-source'), tab = createWorkbenchTab('original-tab', { kind: 'agent', phase: 'attached', workspaceId: 'workspace', regionId: 'original-region', sessionId: session.id })
  const state: SpatialWorkbench = { config: composerConfig, sessions: [session], tabs: { [tab.id]: tab },
    layouts: { workspace: createWorkspaceLayout('original-group', [tab.id]) }, spaceZoneBindings: {}, spatialRequests: {} }
  const original = desktopSpatialGraph(state, []), region = original.regions[0]!
  region.execution!.runtimeId = 'original-runtime'
  expect(region.creationOperationId).toBeUndefined()
  return { state, original, region }
}
it('native presentation and its bulk save retain the exact accepted Core Runtime without requiring a creation admission', () => {
  const { state, original } = fixture()
  expect(spatialCatalog({ ...state, originalSpatialGraph: original }, []).regions[0]!.execution?.runtimeId).toBe('original-runtime')
  expect(desktopSpatialGraph(state, [], original).regions[0]!.execution?.runtimeId).toBe('original-runtime')
})
it.each(['session', 'run', 'host', 'directory'] as const)('a changed %s never inherits the original Core Runtime', field => {
  const { state, original, region } = fixture()
  if (field === 'session') region.agentSessionId = 'another-session'
  else if (field === 'run') region.runId = 'another-run'
  else if (field === 'host') region.execution!.hostId = 'another-host'
  else region.execution!.cwd = '/project/another-directory'
  expect(spatialCatalog({ ...state, originalSpatialGraph: original }, []).regions[0]!.execution?.runtimeId).toBeUndefined()
  expect(desktopSpatialGraph(state, [], original).regions[0]!.execution?.runtimeId).toBeUndefined()
})

it('saving a pending Agent preserves its provisional reference without treating an unrelated previous graph as source admission', () => {
  const { state } = fixture(), previous = desktopSpatialGraph({ ...state, tabs: {}, sessions: [] }, [])
  const surface = state.tabs['original-tab']!.regions['original-region']!
  if (surface.kind !== 'agent') throw new Error('Expected the original Agent surface')
  surface.phase = 'launching'
  state.sessions = []
  const graph = desktopSpatialGraph(state, [], previous)
  expect(graph.regions[0]!.agentSessionId).toBe(surface.sessionId)
  expect(graph.tabs[0]!.issue).toBeUndefined()
  // An explicit control-source read still refuses to invent an admitted identity.
  expect(spatialCatalog({ ...state, originalSpatialGraph: previous }, []).regions[0]!.agentSessionId).toBeNull()
})

it('two fresh client processes keep the original non-admitted Region, Session, Run and Runtime through real durable saves', async () => {
  const root = await mkdtemp(resolve('.tmp/source-runtime-restart-'))
  try {
    await symlink(resolve('packages/core/node_modules'), join(root, 'node_modules'), 'dir')
    const { state, original } = fixture(), owner = new AgentMuxSpatialStateStore(join(root, 'spatial.json'))
    await owner.commit({ expectedRevision: 0, graph: original })
    const require = createRequire(resolve('packages/core/package.json')), { build } = require('esbuild') as typeof import('esbuild')
    const worker = join(root, 'client.mjs'), built = await build({ stdin: { resolveDir: process.cwd(), contents: `
import {AgentMuxSpatialStateStore} from './packages/core/src/spatial-state.ts';
import {desktopSpatialGraph,desktopWorkbenchFromSpatial} from './apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts';
import {restorePersistedWorkbench} from './apps/desktop/src/renderer/src/lib/workbench-persistence.ts';
const [path,input]=process.argv.slice(2),{config,sessions}=JSON.parse(input),owner=new AgentMuxSpatialStateStore(path),before=await owner.read();
const restored=restorePersistedWorkbench({config,sessions,persisted:desktopWorkbenchFromSpatial(before.graph),createTabGroupId:()=> 'unused',preserveEntityIds:new Set(before.graph.tabs.map(tab=>tab.tabId))});
const graph=desktopSpatialGraph({...restored,config,sessions,spaceZoneBindings:{},spatialRequests:{}},[],before.graph);
const saved=await owner.commit({expectedRevision:before.revision,graph});
console.log(JSON.stringify({pid:process.pid,region:saved.graph.regions.find(region=>region.regionId==='original-region'),surface:restored.tabs['original-tab'].regions['original-region']}));
` }, outfile: worker, bundle: true, platform: 'node', format: 'esm', metafile: true, logLevel: 'silent', external: ['fs-native-extensions'],
      banner: { js: "import {createRequire as __workerRequire} from 'node:module';const require=__workerRequire(import.meta.url);" },
      alias: Object.fromEntries([
        ['@agentmux/core/agent-session-id', 'packages/core/src/agent-session-id.ts'], ['@agentmux/core/spatial-graph', 'packages/core/src/spatial-graph.ts'],
        ['@agentmux/core/space-control', 'packages/core/src/space-control.ts'], ['@agentmux/core/public-rpc', 'packages/core/src/public-rpc.ts'],
        ['@agentmux/core/errors', 'packages/core/src/errors.ts'], ['@agentmux/layout', 'packages/core/src/spatial-layout.ts'],
        ['@agentmux/browser', 'packages/browser/src'],
        ['@agentmux/client-ui/ime-keyboard-event', 'packages/client-ui/src/lib/ime-keyboard-event.ts']
      ].map(([key, path]) => [key!, resolve(path!)])) })
    const receipts = []
    for (let count = 0; count < 2; count++) {
      const result = await new Promise<{ pid: number; region: typeof original.regions[number]; surface: { sessionId: string } }>((accept, reject) => {
        const child = spawn(process.execPath, [worker, owner.path, JSON.stringify({ config: state.config, sessions: state.sessions })], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        child.stdout.on('data', value => { stdout += value }); child.stderr.on('data', value => { stderr += value })
        child.once('error', reject); child.once('close', code => { if (code !== 0) reject(Error(stderr)); else { try { accept(JSON.parse(stdout)) } catch (error) { reject(error) } } })
      })
      expect(result.region).toEqual(original.regions[0]); expect(result.region.creationOperationId).toBeUndefined()
      expect(result.surface.sessionId).toBe(state.sessions[0]!.id)
      receipts.push(result)
    }
    expect(new Set(receipts.map(receipt => receipt.pid)).size).toBe(2)
    if (process.env.AGENT_TAKEOVER_SOURCE_RESTART_RECEIPT) {
      const inputs = Object.fromEntries(await Promise.all(Object.keys(built.metafile!.inputs).filter(path => path !== '<stdin>' && !path.includes('node_modules')).map(async path =>
        [path, createHash('sha256').update(await readFile(resolve(path))).digest('hex')])))
      await writeFile(process.env.AGENT_TAKEOVER_SOURCE_RESTART_RECEIPT, JSON.stringify({ passed: true, inputs, receipts,
        boundary: 'Two real new client processes preserve the original Core Region and exact native Session/Run/Runtime references through durable read/restore/save. Deterministic Session metadata; no live Native process or user Agent continuity claim.' }, null, 2))
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

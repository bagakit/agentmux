// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'

type ProcessProof = {
  pid: number; work: { workspaceId: string; tabId: string; groupId: string; regionId: string }
  survey: { zoneId: string; selection: { tabId: string; regionId: string }[]; active: { tabId: string; regionId: string } }
  floating: { open: boolean; targetTabId: string; reference: { displayWorkspaceId: string; groupId: string; tabId: string; regionId: string } }
  surveyResolved: { active: { tabId: string; regionId: string; groupId: string } }
  workProjection: { confirmed: boolean; issues: string[] }
  focus: { selection: unknown; issue: string | null }
  mote: { selection: unknown; retainedTabId: string; issue: string | null }
  tabs: Record<string, unknown>; layouts: Record<string, unknown>; sessions: unknown[]
  graph: NonNullable<Awaited<ReturnType<AgentMuxSpatialStateStore['read']>>>['graph']
  storage: Record<string, string>; lifecycleCalls: string[]
}
const directories: string[] = []
let worker: string
beforeAll(async () => {
  const directory = resolve('.tmp/navigation-context-process')
  await mkdir(directory, { recursive: true })
  worker = join(directory, 'worker.mjs')
  const coreRequire = createRequire(resolve('packages/core/package.json'))
  const desktopRequire = createRequire(resolve('apps/desktop/package.json'))
  const { build } = coreRequire('esbuild') as typeof import('../../../packages/core/node_modules/esbuild/lib/main')
  await build({ entryPoints: [resolve('apps/desktop/test/fixtures/navigation-context-process-worker.ts')],
    outfile: worker, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
    banner: { js: `import { createRequire as nodeCreateRequire } from 'node:module'; const require = nodeCreateRequire(${JSON.stringify(resolve('packages/core/package.json'))});` },
    plugins: [{ name: 'native-and-browser-runtime-boundaries', setup(build) {
      // File painting is a speculative dynamic import, never invoked by this
      // navigation-only startup. Keep it outside the Node worker bundle.
      build.onResolve({ filter: /\/components\/(FileSourceEditor|FileSurfaceView)$/ }, args => ({
        path: resolve(dirname(args.importer), args.path + '.tsx'), external: true
      }))
      // Keep Core's native-lock module at its published package location so its
      // own createRequire resolves the real native dependency.
      build.onResolve({ filter: /^@agentmux\/core\/spatial-state$/ }, () => ({ path: resolve('packages/core/dist/spatial-state.js'), external: true }))
      build.onResolve({ filter: /^(happy-dom|react(?:\/.*)?|react-dom(?:\/.*)?|fs-native-extensions)$/ }, args => ({
        path: (args.path === 'fs-native-extensions' ? coreRequire : desktopRequire).resolve(args.path), external: true
      }))
    } }]
  })
}, 30_000)
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

function launch(phase: 'save' | 'restore', spatial: string, storage: string): Promise<ProcessProof> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, phase, spatial, storage], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    const timeout = setTimeout(() => { child.kill(); no(new Error('Navigation restore child timed out: ' + errors)) }, 20_000)
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no)
    child.once('close', code => {
      clearTimeout(timeout)
      try { if (code !== 0) throw new Error(errors || output); yes(JSON.parse(output)) } catch (error) { no(error) }
    })
  })
}

it.each(['confirmed', 'unknown-occurrences'] as const)('restores three independent navigation owners across two real processes (%s)', async mode => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-navigation-context-')); directories.push(directory)
  const spatialPath = join(directory, 'spatial.json'), storagePath = join(directory, 'browser-storage.json')
  const saved = await launch('save', spatialPath, storagePath)
  const originalStorage = JSON.parse(await readFile(storagePath, 'utf8'))
  expect(Object.keys(originalStorage)).toEqual(expect.arrayContaining(['agentmux-workbench-v1', 'agentmux.leader-topic-floating.v1']))
  const ui = JSON.parse(originalStorage['agentmux-workbench-v1']).state
  expect(ui.workbenchSpaceSelection).toEqual(saved.work)
  expect(ui.surveyZoneSelection).toEqual(saved.survey)
  expect(ui).not.toHaveProperty('restoredWorkbench') // Core owns entities and topology.
  expect(saved.work).toMatchObject({ workspaceId: 'project', groupId: 'work-group', tabId: 'work-tab', regionId: 'work-agent' })
  expect(saved.survey.active).toEqual({ tabId: 'ordinary-tab', regionId: 'ordinary-region' })
  expect(saved.floating.reference).toEqual({ displayWorkspaceId: '__scratch__', groupId: 'mote-group', tabId: 'default-tab', regionId: 'default-region' })
  expect(saved.workProjection.confirmed).toBe(true)
  expect(saved.mote.selection).toEqual([saved.floating.reference])

  if (mode === 'unknown-occurrences') {
    // The shared owner confirms new display topology, but no user selected its
    // neighboring occurrences. Saved Work/Mote addresses must remain verbatim.
    const owner = new AgentMuxSpatialStateStore(spatialPath)
    const state = (await owner.read())!
    state.graph.layouts.project = createWorkspaceLayout('neighbor-work-group', ['work-tab', 'default-tab'])
    state.graph.layouts.__scratch__ = createWorkspaceLayout('neighbor-mote-group', Object.keys(saved.tabs).filter(id => id !== 'work-tab'))
    await owner.commit({ expectedRevision: state.revision, graph: state.graph })
  }
  const restored = await launch('restore', spatialPath, storagePath)
  expect(saved.pid).not.toBe(restored.pid)
  expect(saved.pid).not.toBe(process.pid)
  expect(restored.pid).not.toBe(process.pid)
  expect(restored.work).toEqual(saved.work)
  expect(restored.survey).toEqual(saved.survey)
  expect(restored.floating).toEqual(saved.floating)
  expect(restored.tabs).toEqual(saved.tabs)
  expect(restored.sessions).toEqual(saved.sessions)
  expect(restored.sessions).toHaveLength(5)
  expect(restored.graph.tabs).toEqual(saved.graph.tabs)
  expect(restored.graph.regions).toEqual(saved.graph.regions)
  expect(restored.graph.tabLayouts).toEqual(saved.graph.tabLayouts)
  expect(saved.lifecycleCalls).toEqual([])
  expect(restored.lifecycleCalls).toEqual([])
  expect(restored.graph.regions.find(region => region.regionId === 'work-agent')).toMatchObject({
    agentSessionId: 'execution-agent', runId: 'original-run-execution-agent'
  })
  expect(restored.surveyResolved.active).toMatchObject(saved.survey.active)
  if (mode === 'confirmed') {
    expect(restored.layouts).toEqual(saved.layouts)
    expect(restored.graph.layouts).toEqual(saved.graph.layouts)
    expect(restored.workProjection.confirmed).toBe(true)
    expect(restored.focus.selection).toEqual(saved.focus.selection)
    expect(restored.mote.selection).toEqual([saved.floating.reference])
  } else {
    expect(restored.workProjection.confirmed).toBe(false)
    expect(restored.workProjection.issues.length).toBeGreaterThan(0)
    expect(restored.focus.selection).toBeNull()
    expect(restored.focus.issue).toBeTruthy()
    expect(restored.mote.selection).toBeNull()
    expect(restored.mote.issue).toBeTruthy()
    expect(restored.mote.retainedTabId).toBe('default-tab')
    expect(restored.surveyResolved.active.groupId).toBe('neighbor-mote-group')
    expect(restored.graph.layouts.project).toEqual(createWorkspaceLayout('neighbor-work-group', ['work-tab', 'default-tab']))
  }
  // Keep real process IDs and production-owner snapshots as ignored task evidence.
  await writeFile(resolve('.tmp/navigation-context-process/' + mode + '.json'), JSON.stringify({ saved, restored }, null, 2))
}, 45_000)

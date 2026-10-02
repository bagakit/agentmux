import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { AgentMuxSpatialStateStore } from '../../../packages/core/src/spatial-state'
import { createWorkspaceLayout } from '@agentmux/layout'
import { createWorkbenchTab, addWorkbenchRegion } from '../src/renderer/src/lib/workbench-tabs'
import { desktopSpatialGraph } from '../src/renderer/src/lib/desktop-spatial-state'
import { persistedSurveyZoneSelection } from '../src/renderer/src/lib/survey-workface'
import type { AppConfig } from '../src/shared/contracts'
const config: AppConfig = { version: 9, hosts: [{ id: 'host', kind: 'local', label: 'Local' }], executors: {}, workspaces: [{ id: 'resource', name: 'Project', hostId: 'host', path: _hygiene_fixturePath("project"), kind: 'folder' }], appearance: { terminalTheme: 'graphite' }, browser: { toolbar: { selectElement: true, screenshot: true, devTools: true, viewport: true, saveBookmark: true, more: true } } }

let worker: string
const directories: string[] = []
beforeAll(async () => {
  worker = resolve('.tmp/durable-spatial-index/survey-restore-worker.mjs')
  await mkdir(resolve('.tmp/durable-spatial-index'), { recursive: true })
  const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { readFile } from 'node:fs/promises';
    import { AgentMuxSpatialStateStore } from './packages/core/src/spatial-state.ts';
    import { spatialCatalog } from './packages/core/src/spatial-graph.ts';
    import { desktopWorkbenchFromSpatial } from './apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts';
    import { restorePersistedWorkbench } from './apps/desktop/src/renderer/src/lib/workbench-persistence.ts';
    import { restoredSurveyZoneSelection } from './apps/desktop/src/renderer/src/lib/survey-workface.ts';
    import { resolveWorkbenchZone } from './apps/desktop/src/renderer/src/lib/workbench-projection.ts';
    const state = await new AgentMuxSpatialStateStore(process.argv[2]).read();
    const prefs = restoredSurveyZoneSelection(JSON.parse(await readFile(process.argv[3], 'utf8')));
    const config = JSON.parse(process.argv[4]);
    const restored = restorePersistedWorkbench({ config, sessions: [], persisted: desktopWorkbenchFromSpatial(state.graph),
      preserveEntityIds: new Set(state.graph.tabs.map(t => t.tabId)), createTabGroupId: () => { throw new Error('Identity replacement'); } });
    const scope = resolveWorkbenchZone(prefs.zoneId, spatialCatalog(state.graph), restored.layouts, restored.tabs, 'survey-workbench', prefs.selection, () => {});
    console.log(JSON.stringify({ pid: process.pid, revision: state.revision, prefs, scope, restored }));
  ` }, outfile: worker, bundle: true, platform: 'node', format: 'esm', external: ['fs-native-extensions'],
    alias: { '@agentmux/core/agent-session-id': resolve('packages/core/src/agent-session-id.ts'), '@agentmux/core/spatial-graph': resolve('packages/core/src/spatial-graph.ts'), '@agentmux/core/space-control': resolve('packages/core/src/space-control.ts'), '@agentmux/core/public-rpc': resolve('packages/core/src/public-rpc.ts'), '@agentmux/core/errors': resolve('packages/core/src/errors.ts'), '@agentmux/layout': resolve('packages/core/src/spatial-layout.ts'), '@agentmux/client-ui/ime-keyboard-event': resolve('packages/client-ui/src/lib/ime-keyboard-event.ts') }, logLevel: 'silent' })
})
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
function launch(args: string[]): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no); child.once('close', code => {
      try { if (code !== 0) throw new Error(errors); yes(JSON.parse(output)) } catch (error) { no(error) }
    })
  })
}
it('restores the same Survey Zone in two real processes after its old display Group disappears', async () => {
  const workspace = config.workspaces[0]!
  const original = addWorkbenchRegion(createWorkbenchTab('original', { regionId: 'browser', kind: 'browser', workspaceId: workspace.id,
    browserId: 'original-browser', id: 'original-browser', navigationId: 'navigation', profileId: 'original-profile',
    url: 'https://example.test/research', title: 'Original page', loading: false, canGoBack: true, canGoForward: false,
    viewport: 'responsive', driving: false, appLinkPrompt: null, error: null }), 'browser', 'right',
    { regionId: 'note', kind: 'file', workspaceId: workspace.id, path: 'research.note.json' })
  const graph = desktopSpatialGraph({ config: config, sessions: [], tabs: { original },
    layouts: { [workspace.id]: createWorkspaceLayout('old-group', ['original']), foreign: createWorkspaceLayout('foreign-group', ['original']) }, spaceZoneBindings: {} }, [])
  const zoneId = graph.tabs[0]!.zoneId!
  const directory = await mkdtemp(join(tmpdir(), 'amux-survey-zone-')); directories.push(directory)
  const statePath = join(directory, 'spatial-state.json'), prefsPath = join(directory, 'survey-prefs.json')
  const owner = new AgentMuxSpatialStateStore(statePath)
  await owner.commit({ expectedRevision: 0, graph })
  const ref = { displayWorkspaceId: workspace.id, groupId: 'old-group', tabId: original.id, regionId: 'note' }
  const prefs = persistedSurveyZoneSelection({ zoneId, selection: [ref], active: ref })!
  await writeFile(prefsPath, JSON.stringify(prefs))
  const first = await launch([statePath, prefsPath, JSON.stringify(config)])
  graph.layouts[workspace.id] = createWorkspaceLayout('new-group', ['original'])
  await owner.commit({ expectedRevision: 1, graph })
  const second = await launch([statePath, prefsPath, JSON.stringify(config)])
  expect(first.pid).not.toBe(second.pid)
  expect(first.scope.entity).toEqual({ kind: 'zone', zoneId })
  expect(second.scope.entity).toEqual(first.scope.entity)
  expect(first.scope.selection[0].groupId).toBe('old-group')
  expect(second.scope.selection[0].groupId).toBe('new-group')
  expect(second.prefs).toEqual(prefs)
  expect(second.prefs.active).not.toHaveProperty('groupId')
  expect(second.restored.tabs.original.regions.browser.browserId).toBe('original-browser')
  expect(second.restored.tabs.original.regions.browser.profileId).toBe('original-profile')
  expect(second.restored.tabs.original.regions.note.path).toBe('research.note.json')
  expect(second.restored.tabs.original.layout).toEqual(first.restored.tabs.original.layout)
  expect(second.restored.layouts.foreign).toEqual(first.restored.layouts.foreign)
  expect(second.scope.catalog.locations.some((location: { displayWorkspaceId: string }) => location.displayWorkspaceId === 'foreign')).toBe(true)
})

import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

let worker: string
const directories: string[] = []
beforeAll(async () => {
  worker = resolve('.tmp/survey-membership-process/worker.mjs')
  await mkdir(resolve('.tmp/survey-membership-process'), { recursive: true })
  const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
  const alias: Record<string, string> = { '@agentmux/layout': resolve('packages/layout/src/index.ts') }
  for (const pkg of ['core', 'demand']) {
    const manifest = JSON.parse(readFileSync(resolve('packages', pkg, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports) as [string, { import?: string }][]) {
      if (value.import) alias[key === '.' ? `@agentmux/${pkg}` : `@agentmux/${pkg}/${key.slice(2)}`] = resolve('packages', pkg,
        value.import.replace('./dist/', pkg === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
    }
  }
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: ("\n    import { readFileSync, writeFileSync, existsSync } from 'node:fs';\n    import { join } from 'node:path';\n    import { AgentMuxSpatialStateStore } from './packages/core/src/spatial-state.ts';\n    const [mode, directory] = process.argv.slice(2), prefs = join(directory, 'ui.json');\n    const events = new EventTarget();\n    globalThis.window = { localStorage: { getItem: () => existsSync(prefs) ? readFileSync(prefs, 'utf8') : null,\n      setItem: (_, value) => writeFileSync(prefs, value), removeItem: () => {} },\n      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };\n    const { api } = await import('./apps/desktop/src/renderer/src/lib/api.ts');\n    const { useAppStore, prepareRendererUpdate } = await import('./apps/desktop/src/renderer/src/store.ts');\n    const { createWorkbenchTab } = await import('./apps/desktop/src/renderer/src/lib/workbench-tabs.ts');\n    const { desktopSpatialGraph } = await import('./apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts');\n    const { spatialCatalog } = await import('./apps/desktop/src/renderer/src/lib/space-agent-control.ts');\n    const { createWorkspaceLayout } = await import('./packages/layout/src/index.ts');\n    const { surveyZoneItems } = await import('./apps/desktop/src/renderer/src/lib/survey-workface.ts');\n    const config = { ...(await api.config.get()), workspaces: [{id:'resource', hostId:'local', path:'" + _hygiene_fixturePath("research") + "', name:'Research', kind:'folder'}] };\n    const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json'));\n    api.spatial.read = () => owner.read(); api.spatial.commit = input => owner.commit(input); api.spatial.onChange = () => () => {};\n    api.config.get = async () => config;\n    const snapshot = await api.sessions.snapshot(); api.sessions.snapshot = async () => ({...snapshot, sessions:[], recoveryCandidates:[]});\n    api.ui.requestStorageFlush = async () => {};\n    const reference = {tabId:'original-tab', regionId:'original-region'};\n    if (mode.startsWith('write')) {\n      const browser = await api.browser.create('original-region', 'https://example.test/research', 'resource');\n      const tab = createWorkbenchTab(reference.tabId, {...browser, kind:'browser', browserId:browser.id, workspaceId:'resource', regionId:reference.regionId});\n      tab.space = {zoneId:'original-zone', spaceId:'[\"local\",\"" + _hygiene_fixturePath("research") + "\"]'};\n      await owner.commit({expectedRevision:0, graph:desktopSpatialGraph({config, sessions:[], tabs:{[tab.id]:tab}, layouts:{resource:createWorkspaceLayout('original-group',[tab.id])}, spaceZoneBindings:{}},[])});\n    }\n    await useAppStore.getState().initialize();\n    if (mode.startsWith('write')) {\n      await prepareRendererUpdate('reload');\n      if (mode === 'write-unconfirmed') api.ui.requestStorageFlush = async () => { throw new Error('Disk confirmation unavailable'); };\n      useAppStore.getState().setSurveyZoneCollected('original-zone', true);\n      useAppStore.getState().setSurveyZoneSelection({zoneId:'original-zone', selection:[reference], active:reference});\n    }\n    if (mode === 'write-unconfirmed') await new Promise(setImmediate);\n    const state = useAppStore.getState(), saved = existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf8')) : null;\n    console.log(JSON.stringify({pid:process.pid, saved, collected:state.surveyCollectedZones, selected:state.surveyZoneSelection, warning:state.workbenchSaveWarning,\n      items:surveyZoneItems(spatialCatalog(state,[]),state.surveyCollectedZones), tab:state.tabs['original-tab'], graph:(await owner.read()).graph}));\n    process.exit(0);\n  ") }, outfile: worker, bundle: true, platform: 'node', format: 'esm', alias, metafile: true,
    plugins: [{ name: 'current-client-ui-source', setup(build) {
      build.onResolve({ filter: /^@agentmux\/client-ui\// }, args => ({ path: resolve('packages/client-ui/src/lib', args.path.slice('@agentmux/client-ui/'.length) + '.ts') }))
    } }, { name: 'installed-dependencies', setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (Object.hasOwn(alias, args.path)) return { path: alias[args.path] }
        if (args.path.startsWith('node:')) return { path: args.path, external: true }
        const installed = createRequire(join(args.resolveDir, 'package.json')).resolve(args.path)
        // Use the installed ESM peer for Tiptap's default exports; keep its actual dependencies.
        return { path: args.path.startsWith('@tiptap/') ? installed.replace(/\.cjs$/, '.js') : installed, external: true }
      })
    } }],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, loader: { '.css': 'empty' }, logLevel: 'silent' })
  const inputs = Object.fromEntries(Object.keys(compiled.metafile!.inputs).filter(file => /^(apps|packages)\//.test(file))
    .map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
  await writeFile(resolve('.tmp/survey-membership-process/compiled-inputs.json'), JSON.stringify(inputs, null, 2))
})
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
function launch(mode: string, directory: string): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, mode, directory], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no); child.once('close', code => {
      try { if (code !== 0) throw new Error(errors); yes(JSON.parse(output)) } catch (error) { no(error) }
    })
  })
}
it('saves Survey membership and selection without waiting for an unrelated edit and restores them in a fresh Store process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-survey-membership-')); directories.push(directory)
  const first = await launch('write', directory)
  expect(first.saved.state.surveyCollectedZones).toEqual({ 'original-zone': true })
  expect(first.saved.state.surveyZoneSelection).toEqual(first.selected)
  const second = await launch('read', directory)
  expect(second.pid).not.toBe(first.pid)
  expect(second.collected).toEqual(first.collected)
  expect(second.selected).toEqual(first.selected)
  expect(second.items.map((item: { zoneId: string }) => item.zoneId)).toEqual(['original-zone'])
  expect(second.tab.id).toBe('original-tab')
  expect(second.tab.regions['original-region'].browserId).toBe('original-region')
  expect(second.tab.regions['original-region'].url).toBe('https://example.test/research')
  expect(second.tab.layout).toEqual(first.tab.layout)
  expect(second.graph).toEqual(first.graph)
  expect(second.saved.state).not.toHaveProperty('restoredWorkbench')
})

it('keeps Survey membership and its original work visible when disk confirmation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-survey-unconfirmed-')); directories.push(directory)
  const first = await launch('write-unconfirmed', directory)
  expect(first.collected).toEqual({ 'original-zone': true })
  expect(first.selected.zoneId).toBe('original-zone')
  expect(first.tab.regions['original-region'].browserId).toBe('original-region')
  expect(first.warning).toContain('Disk confirmation unavailable')
  const second = await launch('read', directory)
  expect(second.collected).toEqual(first.collected)
  expect(second.graph).toEqual(first.graph)
})

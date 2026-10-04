import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'

let worker: string
const directories: string[] = []
beforeAll(async () => {
  worker = resolve('.tmp/survey-notebook/process/worker.mjs')
  await mkdir(resolve('.tmp/survey-notebook/process'), { recursive: true })
  const { build } = createRequire(resolve('packages/core/package.json'))('esbuild') as typeof import('esbuild')
  const alias: Record<string, string> = { '@agentmux/layout': resolve('packages/layout/src/index.ts') }
  for (const pkg of ['core', 'demand']) {
    const manifest = JSON.parse(readFileSync(resolve('packages', pkg, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports) as [string, { import?: string }][]) {
      if (value.import) alias[key === '.' ? `@agentmux/${pkg}` : `@agentmux/${pkg}/${key.slice(2)}`] = resolve('packages', pkg,
        value.import.replace('./dist/', pkg === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
    }
  }
  const helper = resolve('.tmp/survey-notebook/process/workspace-move')
  if (process.platform === 'darwin') execFileSync('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'apps/desktop/native/workspace-move.c', '-o', helper])
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: ("\n    import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';\n    import { join } from 'node:path';\n    import { WorkspaceFiles } from './apps/desktop/src/main/workspace-files.ts';\n    import { AgentMuxNotebookStore } from './packages/core/src/notebook-store.ts';\n    import { AgentMuxSpatialStateStore } from './packages/core/src/spatial-state.ts';\n    const [mode, directory] = process.argv.slice(2), prefs = join(directory, 'ui.json');\n    const events = new EventTarget();\n    globalThis.window = { localStorage: { getItem: key => existsSync(key === 'agentmux-workbench-v1' ? prefs : join(directory,key+'.json')) ? readFileSync(key === 'agentmux-workbench-v1' ? prefs : join(directory,key+'.json'), 'utf8') : null,\n      setItem: (key, value) => writeFileSync(key === 'agentmux-workbench-v1' ? prefs : join(directory,key+'.json'), value), removeItem: () => {} },\n      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };\n    const { api } = await import('./apps/desktop/src/renderer/src/lib/api.ts');\n    const { useAppStore, prepareRendererUpdate } = await import('./apps/desktop/src/renderer/src/store.ts');\n    const { createWorkbenchTab, documentKey } = await import('./apps/desktop/src/renderer/src/lib/workbench-tabs.ts');\n    const { desktopSpatialGraph } = await import('./apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts');\n    const { spatialCatalog } = await import('./apps/desktop/src/renderer/src/lib/space-agent-control.ts');\n    const { createWorkspaceLayout } = await import('./packages/layout/src/index.ts');\n    const { surveyZoneItems } = await import('./apps/desktop/src/renderer/src/lib/survey-workface.ts');\n    const realMove = mode.includes('moved');\n    const resourceRoot = realMove ? join(directory,'resource') : '" + _hygiene_fixturePath("research") + "';\n    if (realMove) mkdirSync(resourceRoot,{recursive:true});\n    const config = { ...(await api.config.get()), workspaces: [{id:'resource', hostId:'local', path:resourceRoot, name:'Research', kind:'folder'}] };\n    const files = new WorkspaceFiles(() => ({id:'local',kind:'local'}),{localMoveHelperPath:process.argv[4]});\n    const notebooks = new AgentMuxNotebookStore(join(directory, 'notebooks.json'));\n    api.notebooks.read = () => notebooks.read(); api.notebooks.apply = input => notebooks.apply(input, {kind:'user',id:'process-user'}); api.notebooks.onChange = listener => notebooks.subscribe(listener);\n    const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json'));\n    api.spatial.read = () => owner.read(); api.spatial.commit = input => owner.commit(input); api.spatial.onChange = () => () => {};\n    api.config.get = async () => config;\n    const snapshot = await api.sessions.snapshot(); api.sessions.snapshot = async () => ({...snapshot, sessions:[], recoveryCandidates:[]});\n    api.ui.requestStorageFlush = async () => {};\n    api.files.observe = async () => {}; api.files.unobserve = async () => {};\n    let writes = 0;\n    api.files.write = async (_workspace, input) => { writes++; writeFileSync(join(directory,'note.json'), input.content); return {status:'written',revision:'disk-note'} };\n    api.files.read = async (_workspace, path) => ({status:'read',document:{path,content:readFileSync(join(directory,'note.json'),'utf8'),revision:'disk-note'}});\n    if (realMove) {\n      api.files.write = async (_workspace,input) => { writes++; return files.write(config.workspaces[0],input); };\n      api.files.read = async (_workspace,path) => files.read(config.workspaces[0],path);\n      api.files.move = async input => files.move(config.workspaces[0],config.workspaces[0],input);\n    }\n    const reference = {tabId:'original-tab', regionId:'original-region'};\n    if (mode.startsWith('write')) {\n      const browser = await api.browser.create('original-region', 'https://example.test/research', 'resource');\n      const tab = createWorkbenchTab(reference.tabId, {...browser, kind:'browser', browserId:browser.id, workspaceId:'resource', regionId:reference.regionId});\n      tab.space = {zoneId:'original-zone', spaceId:JSON.stringify(['local',resourceRoot])};\n      await owner.commit({expectedRevision:0, graph:desktopSpatialGraph({config, sessions:[], tabs:{[tab.id]:tab}, layouts:{resource:createWorkspaceLayout('original-group',[tab.id])}, spaceZoneBindings:{}},[])});\n    }\n    await useAppStore.getState().initialize();\n    if (mode.startsWith('write')) {\n      await prepareRendererUpdate('reload');\n      if (mode === 'write-unconfirmed') api.ui.requestStorageFlush = async () => { throw new Error('Disk confirmation unavailable'); };\n      useAppStore.getState().setSurveyZoneCollected('original-zone', true);\n      useAppStore.getState().setSurveyZoneSelection({zoneId:'original-zone', selection:[reference], active:reference});\n      const state = useAppStore.getState(); state.setMainSurface('survey');\n      state.splitRegion('resource','original-tab','original-region','right');\n      const tab = useAppStore.getState().tabs['original-tab'];\n      const selected = {displayWorkspaceId:'resource',groupId:'original-group',tabId:tab.id,regionId:tab.layout.activeRegionId};\n      await api.notebooks.apply({expectedRevision:0,operationId:'original-book',change:{kind:'create',notebookId:'durable-book',name:'Durable notebook',workface:{zoneId:'original-zone',workspaceId:'resource'}}});\n      state.setSurveyNotebook('durable-book');\n      const receipt = await state.createNote('original-group',{tabId:tab.id,regionId:selected.regionId},'A durable reading note',\n        {entity:{kind:'zone',zoneId:'original-zone'},presentationId:'survey-workbench',displayWorkspaceId:'resource',catalog:spatialCatalog(useAppStore.getState(),[]),selection:[selected],onSelect(ref) { useAppStore.getState().setSurveyZoneSelection({zoneId:'original-zone',selection:[ref],active:ref}); }}, undefined, {notebookId:'durable-book',source:{sourceId:'source-original',url:'https://example.test/research',title:'Original page',recordedAt:100,position:{zoneId:'original-zone',tabId:'original-tab',regionId:'original-region'}}});\n      useAppStore.getState().setSurveyNotebook('durable-book',receipt.noteId);\n      if (mode === 'write-moved' || mode === 'write-moved-lost') {\n        const selected = useAppStore.getState().surveyZoneSelection.active;\n        state.promoteRegionToTab('resource',selected.tabId,selected.regionId);\n        const {refreshNotebookLibrary} = await import('./apps/desktop/src/renderer/src/lib/notebook-library.ts');\n        await refreshNotebookLibrary();\n        if(mode === 'write-moved-lost') { let lost=true;api.notebooks.apply = async input => {const result=await notebooks.apply(input,{kind:'user',id:'process-user'});if(lost){lost=false;throw new Error('Relocation receipt lost');}return result;};}\n        await state.renamePath(receipt.path,'Moved research.note.json','resource');\n        const active = useAppStore.getState().surveyZoneSelection.active;\n        await state.closeTab('resource','original-group',active.tabId);\n      }\n      if (mode === 'write-closed') { const active = useAppStore.getState().surveyZoneSelection.active; await state.closeRegion('resource',active.tabId,active.regionId); }\n      if(!receipt.revealed) throw new Error(JSON.stringify(receipt));\n      await prepareRendererUpdate('reload');\n    }\n    if (mode === 'write-unconfirmed') await new Promise(setImmediate);\n    if (mode === 'read-moved-lost') {\n      const {retryNotebookRecoveries} = await import('./apps/desktop/src/renderer/src/lib/notebook-library.ts');\n      await retryNotebookRecoveries(); await prepareRendererUpdate('reload');\n    }\n    if (mode === 'read-closed' || mode.startsWith('read-moved')) {\n      const {openNotebookPage} = await import('./apps/desktop/src/renderer/src/lib/survey-notebooks.ts');\n      const page = Object.values((await notebooks.read()).pages)[0];\n      useAppStore.getState().setSurveyNotebook(page.notebookId,page.noteId);\n      if (!await openNotebookPage(page)) throw new Error('Notebook page did not reopen');\n    }\n    if (mode === 'read') {\n      const current = useAppStore.getState(), tab = current.tabs['original-tab'], file = Object.values(tab.regions).find(region => region.kind === 'file');\n      if(!file) throw new Error('Original Note Region missing');\n      await current.openFile(file.path,'original-group',undefined,'resource',undefined,{displayWorkspaceId:'resource',space:tab.space,resource:{hostId:'local',path:'" + _hygiene_fixturePath("research") + "'},reference:{displayWorkspaceId:'resource',groupId:'original-group',tabId:tab.id,regionId:file.regionId}});\n    }\n    const state = useAppStore.getState(), saved = existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf8')) : null;\n    const notePath = realMove ? join(resourceRoot,Object.values((await notebooks.read()).pages)[0].resource.path) : join(directory,'note.json');\n    console.log(JSON.stringify({pid:process.pid, writes, recoveries:state.notebookRecoveries, note:JSON.parse(readFileSync(notePath,'utf8')), document:Object.values(state.documents).find(doc=>doc.path.includes('note')), saved, library:await notebooks.read(), selectedNotebook:state.surveyNotebookId, selectedNote:state.surveyNoteId, collected:state.surveyCollectedZones, selected:state.surveyZoneSelection, warning:state.workbenchSaveWarning,\n      items:surveyZoneItems(spatialCatalog(state,[]),state.surveyCollectedZones), tab:state.tabs['original-tab'], graph:(await owner.read()).graph}));\n    process.exit(0);\n  ") }, outfile: worker, bundle: true, platform: 'node', format: 'esm', alias, metafile: true,
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
  await writeFile(resolve('.tmp/survey-notebook/process/compiled-inputs.json'), JSON.stringify(inputs, null, 2))
})
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
function launch(mode: string, directory: string): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, mode, directory, resolve('.tmp/survey-notebook/process/workspace-move')], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no); child.once('close', code => {
      try { if (code !== 0) throw new Error(errors); yes(JSON.parse(output)) } catch (error) { no(error) }
    })
  })
}
it('restores the same Browser and Note Region layout and opens the same saved Note in a fresh process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-note-region-')); directories.push(directory)
  const first = await launch('write', directory), second = await launch('read', directory)
  writeFileSync(resolve('.tmp/survey-notebook/surface-process-receipt.json'), JSON.stringify({first,second},null,2));
  expect(first.writes).toBe(1); expect(second.writes).toBe(0); expect(second.pid).not.toBe(first.pid)
  expect(second.collected).toEqual(first.collected); expect(second.selected).toEqual(first.selected)
  expect(second.tab.id).toBe(first.tab.id); expect(second.tab.layout).toEqual(first.tab.layout); expect(second.graph.tabs).toEqual(first.graph.tabs)
  expect(second.tab.regions['original-region']).toMatchObject({kind:'browser',url:'https://example.test/research'})
  expect(Object.values(second.tab.regions).filter((region:any)=>region.kind==='file')).toHaveLength(1)
  expect(second.note.noteId).toBe(first.note.noteId); expect(second.note).toEqual(first.note)
  expect(second.document.content).toContain(first.note.noteId); expect(second.document.content).toContain('A durable reading note')
})

it('finds a closed Note through the same persistent Notebook in a fresh process without rewriting its body', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-notebook-closed-')); directories.push(directory)
  const first = await launch('write-closed', directory), second = await launch('read-closed', directory)
  writeFileSync(resolve('.tmp/survey-notebook/closed-process-receipt.json'), JSON.stringify({first,second},null,2))
  expect(first.writes).toBe(1); expect(second.writes).toBe(0); expect(first.pid).not.toBe(second.pid)
  expect(first.selectedNote).toBeNull(); expect(second.selectedNote).toBe(first.note.noteId)
  expect(first.graph.tabs.map((tab:any)=>tab.tabId)).toEqual(['original-tab'])
  expect(second.warning).toBeNull()
  expect(second.library).toEqual(first.library)
  const page = second.library.pages[first.note.noteId]
  expect(page.notebookId).toBe('durable-book'); expect(page.sources[0].url).toBe('https://example.test/research')
  expect(second.note).toEqual(first.note); expect(second.document.content).toContain(first.note.noteId)
  expect(second.tab.regions['original-region'].url).toBe('https://example.test/research')
})


it.skipIf(process.platform !== 'darwin').each([false,true])('preserves the same saved Note after a real confined filesystem move, close and process restart (lost receipt: %s)', async lost => {
  const directory = await mkdtemp(join(tmpdir(),'amux-notebook-file-move-')); directories.push(directory)
  const first = await launch(lost ? 'write-moved-lost' : 'write-moved',directory), second = await launch(lost ? 'read-moved-lost' : 'read-moved',directory)
  writeFileSync(resolve('.tmp/survey-notebook/continuity-process-'+(lost?'lost':'confirmed')+'.json'),JSON.stringify({first,second},null,2))
  expect(first.pid).not.toBe(second.pid); expect(first.writes).toBe(1); expect(second.writes).toBe(0)
  expect(first.note).toEqual(second.note); expect(second.document.content).toContain(first.note.noteId)
  expect(first.selectedNote).toBeNull(); expect(second.selectedNote).toBe(first.note.noteId)
  expect(first.graph.tabs.map((tab:any)=>tab.tabId)).toEqual(['original-tab'])
  expect(second.warning).toBeNull()
  expect(second.library).toEqual(first.library)
  const page = second.library.pages[first.note.noteId]
  expect(page.resource.path).toBe('Moved research.note.json'); expect(page.sources[0].url).toBe('https://example.test/research')
  expect(second.library.trail.filter((event:any)=>event.action==='relocated')).toHaveLength(1)
  expect(second.library.trail.at(-1).before.resource.path).not.toBe('Moved research.note.json')
  expect(first.recoveries).toHaveLength(lost ? 1 : 0); expect(second.recoveries).toEqual([])
})

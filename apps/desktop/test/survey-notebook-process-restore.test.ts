import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
// @vitest-environment node
import { afterEach, beforeAll, expect, it } from 'vitest'
import { copyFile, mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

let worker: string
const directories: string[] = []
beforeAll(async () => {
  worker = resolve('.tmp/survey-notebook/process/worker.mjs')
  await mkdir(resolve('.tmp/survey-notebook/process'), { recursive: true })
  await symlink(resolve('packages/core/node_modules'), resolve('.tmp/survey-notebook/process/node_modules'), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  const { build } = browserSourceBuild(createRequire(resolve('packages/core/package.json'))('esbuild')) as typeof import('../../../packages/core/node_modules/esbuild')
  const alias: Record<string, string> = { '@agentmux/layout': resolve('packages/layout/src/index.ts') }
  for (const pkg of ['core', 'demand']) {
    const manifest = JSON.parse(readFileSync(resolve('packages', pkg, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(manifest.exports) as [string, { import?: string }][]) {
      if (value.import) alias[key === '.' ? `@agentmux/${pkg}` : `@agentmux/${pkg}/${key.slice(2)}`] = resolve('packages', pkg,
        value.import.replace('./dist/', pkg === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))
    }
  }
  const helper = process.env.AGENTMUX_WORKSPACE_MOVE_HELPER ?? resolve('.tmp/survey-notebook/process/workspace-move')
  if (process.platform === 'darwin' && !process.env.AGENTMUX_WORKSPACE_MOVE_HELPER) {
    execFileSync('xcrun', ['clang', '-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', 'apps/host/native/workspace-move.c', '-o', helper])
    await mkdir(resolve('.tmp/resources/bin'), {recursive:true})
    await copyFile(helper, resolve('.tmp/resources/bin/agentmux-workspace-move'))
  }
  const compiled = await build({ stdin: { resolveDir: process.cwd(), contents: String.raw`
    import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { readNoteDocument } from './packages/client-ui/src/note/note-document.ts';
    import { AgentMuxNotebookStore } from './packages/core/src/notebook-store.ts';
    import { AgentMuxSpatialStateStore } from './packages/core/src/spatial-state.ts';
    const [mode, directory] = process.argv.slice(2), prefs = join(directory, 'ui.json');
    const events = new EventTarget();
    globalThis.window = { localStorage: { getItem: key => existsSync(key === 'agentmux-workbench-v1' ? prefs : join(directory,key+'.json')) ? readFileSync(key === 'agentmux-workbench-v1' ? prefs : join(directory,key+'.json'), 'utf8') : null,
      setItem: (key, value) => writeFileSync(key === 'agentmux-workbench-v1' ? prefs : join(directory,key+'.json'), value), removeItem: () => {} },
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    globalThis.localStorage = window.localStorage;
    const { api } = await import('./apps/desktop/src/renderer/src/lib/api.ts');
    const { useAppStore, prepareRendererUpdate } = await import('./apps/desktop/src/renderer/src/store.ts');
    const { createWorkbenchTab, documentKey } = await import('./apps/desktop/src/renderer/src/lib/workbench-tabs.ts');
    const { desktopSpatialGraph } = await import('./apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts');
    const { spatialCatalog } = await import('./apps/desktop/src/renderer/src/lib/space-agent-control.ts');
    const { createWorkspaceLayout } = await import('./packages/layout/src/index.ts');
    const { surveyZoneItems } = await import('./apps/desktop/src/renderer/src/lib/survey-workface.ts');
    const realMove = mode.includes('moved');
    const resourceRoot = realMove ? join(directory,'resource') : ${JSON.stringify(_hygiene_fixturePath("research"))};
    if (realMove) mkdirSync(resourceRoot,{recursive:true});
    const config = { ...(await api.config.get()), workspaces: [{id:'resource', hostId:'local', path:resourceRoot, name:'Research', kind:'folder'}] };
    // One private Notes authority is shared by the original UI catalog and Source Files.
    const privateState = join(directory, 'source-state'), notesDirectory = join(directory, 'source-notes');
    let storage;
    if (realMove) {
      mkdirSync(privateState, {recursive:true}); mkdirSync(notesDirectory, {recursive:true});
      for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key) && !key.startsWith('AGENTMUX_TEST_') && key !== 'AGENTMUX_WORKSPACE_MOVE_HELPER') delete process.env[key];
      process.env.AGENTMUX_WORKSPACE_MOVE_HELPER = process.argv[4];
      process.env.AGENTMUX_STATE_DIRECTORY = privateState;
      process.env.AGENTMUX_RUNTIME_DIRECTORY = join(directory, 'source-runtime');
      process.env.AGENTMUX_SPATIAL_STATE_STORE = join(directory, 'spatial-state.json');
      process.env.AGENTMUX_MESSAGE_QUEUE_PATH = join(privateState, 'messages.ndjson');
      mkdirSync(process.env.AGENTMUX_RUNTIME_DIRECTORY, {recursive:true});
      const locator = join(privateState, 'notes-location.json');
      if (!existsSync(locator)) writeFileSync(locator, JSON.stringify({schemaVersion:1,directory:notesDirectory,operations:{},pending:null}));
      const {AgentMuxNotesStorage} = await import('./packages/core/src/notes-storage.ts');
      storage = new AgentMuxNotesStorage(locator, notesDirectory);
    }
    const notebooks = realMove ? new AgentMuxNotebookStore(undefined, storage) : new AgentMuxNotebookStore(join(directory, 'notebooks.json'));
    const sourceCalls = [], sourceMoves = [], sourceReads = [];
    const cleanupSource = [];
    let sourceIdentity, beforeMoveMetadata, sourceRuntime;
    const originalHistory = async page => {
      const query = {noteId:page.noteId,resource:page.resource}, history = await notebooks.readHistory(query);
      const entries = await Promise.all(history.entries.map(async entry => {
        const selected = await notebooks.readHistory({...query,eventId:entry.eventId,includeContent:true});
        return selected.entries.find(item => item.eventId === entry.eventId);
      }));
      return {...history,entries};
    };
    try {
    api.notebooks.read = () => notebooks.read(); api.notebooks.apply = input => notebooks.apply(input, {kind:'user',id:'process-user'}); api.notebooks.onChange = listener => notebooks.subscribe(listener);
    const owner = new AgentMuxSpatialStateStore(join(directory, 'spatial-state.json'));
    api.spatial.read = () => owner.readForLayout(); api.spatial.retainLabels = values => owner.retainDisplayLabels(values); api.spatial.commit = input => owner.commit(input); api.spatial.onChange = () => () => {};
    api.config.get = async () => config;
    const snapshot = await api.sessions.snapshot(); api.sessions.snapshot = async () => ({...snapshot, sessions:[], recoveryCandidates:[]});
    api.ui.requestStorageFlush = async () => {};
    api.files.observe = async () => {}; api.files.unobserve = async () => {};
    let writes = 0;
    api.files.write = async (_workspace, input) => { writes++; writeFileSync(join(directory,'note.json'), input.content); return {status:'written',revision:'disk-note'} };
    api.files.read = async (_workspace, path) => ({status:'read',document:{path,content:readFileSync(join(directory,'note.json'),'utf8'),revision:'disk-note'}});
    const reference = {tabId:'original-tab', regionId:'original-region'};
    if (mode.startsWith('write')) {
      const browser = await api.browser.create('original-region', 'https://example.test/research', 'resource');
      const tab = createWorkbenchTab(reference.tabId, {...browser, kind:'browser', browserId:browser.id, workspaceId:'resource', regionId:reference.regionId});
      tab.space = {zoneId:'original-zone', spaceId:JSON.stringify(['local',resourceRoot])};
      await owner.commit({expectedRevision:0, graph:desktopSpatialGraph({config, sessions:[], tabs:{[tab.id]:tab}, layouts:{resource:createWorkspaceLayout('original-group',[tab.id])}, spaceZoneBindings:{}},[])});
    }
    if (realMove) {
      const {activateRuntime} = await import('@ctxmux/sdk');
      const native = await activateRuntime({executable: join(process.cwd(),'packages/core/vendor/ctxmux',process.platform+'-'+process.arch,'bin/ctxmuxd'),
        socketPath:join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'ctxmux.sock'),stateDir:join(privateState,'ctxmux'),childDisposition:{mode:'detached',stderr:'pipe'}});
      cleanupSource.push(() => native.dispose({shutdown:true}));
      const configurationPath = join(directory,'source-config.json'); writeFileSync(configurationPath, JSON.stringify(config));
      const {AgentMuxFileAgentSessionStore,connectAgentMuxRpc} = await import('./packages/core/src/index.ts');
      const {startAgentMuxHost} = await import('./apps/host/src/host.ts');
      const socketPath = join(process.env.AGENTMUX_RUNTIME_DIRECTORY,'control.sock');
      const source = await startAgentMuxHost({store:new AgentMuxFileAgentSessionStore(join(privateState,'sessions.json')),configurationPath,socketPath,
        desktopSocketPath:join(directory,'no-desktop.sock'),mobileBuildDirectory:join(directory,'no-mobile')});
      cleanupSource.push(() => source.dispose());
      const rpc = await connectAgentMuxRpc({endpoint:{transport:'unix',path:socketPath}}); cleanupSource.push(() => rpc.dispose());
      sourceIdentity = (await rpc.call('runtime.owner.identity',{})).owner;
      const {configuredDesktopAgentMuxHost} = await import('./apps/desktop/src/main/desktop-host.ts');
      const client = await configuredDesktopAgentMuxHost(configurationPath,join(privateState,'connectors'))({id:'local',kind:'local',label:'Private original Source'},new AgentMuxFileAgentSessionStore(join(privateState,'borrowed-sessions.json')));
      cleanupSource.push(() => client.dispose());
      const {RuntimeController} = await import('./apps/desktop/src/main/runtime-controller.ts');
      const runtime = sourceRuntime = Object.assign(Object.create(RuntimeController.prototype),{hosts:new Map([['local',{client}]]),hostReconfigurationReservations:new Map()});
      const {sourceFilesIpcBridge} = await import('./apps/desktop/test/helpers/source-files-ipc-bridge.ts');
      const bridge = sourceFilesIpcBridge(runtime,cleanupSource);
      api.spaceMounts = bridge.spaces;
      api.sourceFiles = {...bridge.files, call:async (...args) => {
        sourceCalls.push({method:args[1],params:structuredClone(args[2])});
        const response = await bridge.files.call(...args);
        if (args[1] === 'file.mutation.inspect') sourceReads.push(response.result);
        if (args[1] === 'file.move') {
          sourceMoves.push(response.result);
          if (mode === 'write-moved-lost') {
            if (response.result.result.filesystem !== 'moved' || response.result.result.noteMetadata?.status !== 'recorded') throw Error('Original Source metadata did not finish before the controlled reply loss');
            throw Error('Relocation receipt lost');
          }
        }
        return response;
      }};
      const target = {hostId:'local',expectedRuntimeId:sourceIdentity.runtimeId};
      const currentQuery = path => {
        const locator = useAppStore.getState().sourceFilesInputs.selections.resource?.locator;
        if (!locator) throw Error('Original Source Files registration is missing');
        return {zoneId:locator.resource.zoneId,path,expectedResource:{hostId:'local',workspaceId:'resource',workspacePath:resourceRoot}};
      };
      api.files.write = async (_workspace,input) => {
        writes++;
        const query = currentQuery(input.path), observed = await rpc.call('file.stat',query);
        if (!observed.resource) throw Error('The original file mapping is unavailable');
        const response = await bridge.files.call(target,input.expectedRevision === null ? 'file.create' : 'file.write',
          {...query,expectedResource:observed.resource,content:input.content,expectedRevision:input.expectedRevision,
            ...(input.operationId ? {operationId:input.operationId} : {})});
        return response.result.result;
      };
      api.files.read = async (_workspace,path) => {
        const response = await bridge.files.call(target,'file.read',currentQuery(path));
        return response.result.result;
      };
    }
    // Use the original Main close owner; a browser-preview record cannot certify this native workface.
    const {WorkbenchUserStateStore} = await import('./apps/desktop/src/main/workbench-user-state.ts');
    const {DesktopControlIpcBridge} = await import('./apps/desktop/src/main/control-ipc-bridge.ts');
    const {createDesktopWorkbenchCloseOwner} = await import('./apps/desktop/src/main/workbench-close-owner.ts');
    const {spaceCloseDigest} = await import('./packages/core/src/space-close.ts');
    let closeBridge;
    closeBridge = new DesktopControlIpcBridge({isAvailable:()=>true,sendCancellation:()=>{},sendRequest(request) {
      if (!request.operation.startsWith('workbench.close.')) throw Error('Unexpected close transport request');
      void useAppStore.getState().executeWorkbenchClose(request).then(result=>closeBridge.accept({requestId:request.requestId,ok:true,result}),
        error=>closeBridge.accept({requestId:request.requestId,ok:false,error:{code:error.code??'CONTROL_UNAVAILABLE',message:error.message}}));
    }});
    cleanupSource.push(() => closeBridge.dispose());
    const user = new WorkbenchUserStateStore(prefs);
    const closing = createDesktopWorkbenchCloseOwner({store:user,bridge:closeBridge,runtime:sourceRuntime??{},closeBrowser:async()=>{throw Error('No Browser is closed by this Note fixture')},
      authority:()=>({ownerId:spaceCloseDigest(prefs),endpoint:'private-notebook-client',documentGeneration:'private-notebook-workface'})});
    api.workbenchClose.call = (method,input) => closing.call(method,input,{actor:{kind:'user',id:'process-user'},originalContext:{}});
    await useAppStore.getState().initialize();
    if (realMove) {
      const observed = await useAppStore.getState().resolveFilesSource('resource');
      if (observed.status === 'registration-required') await useAppStore.getState().useFilesSourceFolder('resource',observed.registration);
      else if (observed.status === 'selection-required') {
        const original = observed.registrations.filter(item => item.zoneId === 'original-zone' && item.workspaceId === 'resource' && item.reference.spaceId === JSON.stringify(['local',resourceRoot]));
        if (original.length !== 1) throw Error('The original Browser/Notebook Zone was not observed by Source');
        const chosen = original[0];
        const selected = await useAppStore.getState().selectFilesRegistration('resource',{hostId:'local',reference:chosen.reference,zoneId:chosen.zoneId,workspaceId:chosen.workspaceId});
        if (selected.status !== 'located') throw Error('The exact original registration is unavailable');
      } else if (observed.status !== 'located') throw Error('Original Source directory: '+JSON.stringify(observed));
    }
    if (mode.startsWith('write')) {
      await prepareRendererUpdate('reload');
      if (mode === 'write-unconfirmed') api.ui.requestStorageFlush = async () => { throw new Error('Disk confirmation unavailable'); };
      useAppStore.getState().setSurveyZoneCollected('original-zone', true);
      useAppStore.getState().setRecallZoneSelection({zoneId:'original-zone', selection:[reference], active:reference});
      const state = useAppStore.getState(); state.setMainSurface('recall');
      state.splitRegion('resource','original-tab','original-region','right');
      const tab = useAppStore.getState().tabs['original-tab'];
      const selected = {displayWorkspaceId:'resource',groupId:'original-group',tabId:tab.id,regionId:tab.layout.activeRegionId};
      await api.notebooks.apply({expectedRevision:0,operationId:'original-book',change:{kind:'create',notebookId:'durable-book',name:'Durable notebook',workface:{zoneId:'original-zone',workspaceId:'resource'}}});
      state.setRecallNotebook('durable-book');
      const receipt = await state.createNote('original-group',{tabId:tab.id,regionId:selected.regionId},'A durable reading note',
        {entity:{kind:'zone',zoneId:'original-zone'},presentationId:'recall-workbench',displayWorkspaceId:'resource',catalog:spatialCatalog(useAppStore.getState(),[]),selection:[selected],onSelect(ref) { useAppStore.getState().setRecallZoneSelection({zoneId:'original-zone',selection:[ref],active:ref}); }}, undefined, {notebookId:'durable-book',source:{sourceId:'source-original',url:'https://example.test/research',title:'Original page',recordedAt:100,position:{zoneId:'original-zone',tabId:'original-tab',regionId:'original-region'}}});
      useAppStore.getState().setRecallNotebook('durable-book',receipt.noteId);
      if (mode === 'write-moved' || mode === 'write-moved-lost') {
        const selected = useAppStore.getState().recallZoneSelection.active;
        state.promoteRegionToTab('resource',selected.tabId,selected.regionId);
        const {refreshNotebookLibrary} = await import('./apps/desktop/src/renderer/src/lib/notebook-library.ts');
        await refreshNotebookLibrary();
        const pageBefore = (await notebooks.read()).pages[receipt.noteId];
        beforeMoveMetadata = {page:pageBefore,history:await originalHistory(pageBefore)};
        try { await state.renamePath(receipt.path,'Moved research.note.md','resource'); }
        catch(cause) { if (mode !== 'write-moved-lost' || cause.message !== 'Relocation receipt lost') throw cause; }
        const active = useAppStore.getState().recallZoneSelection.active;
        await state.closeTab('resource','original-group',active.tabId);
      }
      if (mode === 'write-closed') { const active = useAppStore.getState().recallZoneSelection.active; await state.closeRegion('resource',active.tabId,active.regionId); }
      if(!receipt.revealed) throw new Error(JSON.stringify(receipt));
      await prepareRendererUpdate('reload');
    }
    if (mode === 'write-unconfirmed') await new Promise(setImmediate);
    if (mode === 'read-moved-lost') {
      const pending = Object.keys(useAppStore.getState().sourceFilesInputs.pending);
      if (pending.length !== 1) throw Error('The exact original Source move request was not retained');
      await useAppStore.getState().inspectFilesMutation(pending[0]); await prepareRendererUpdate('reload');
    }
    if (mode === 'read-closed' || mode.startsWith('read-moved')) {
      const {openNotebookPage} = await import('./apps/desktop/src/renderer/src/lib/recall-notebooks.ts');
      const page = Object.values((await notebooks.read()).pages)[0];
      useAppStore.getState().setRecallNotebook(page.notebookId,page.noteId);
      if (!await openNotebookPage(page)) throw new Error('Notebook page did not reopen');
    }
    if (mode === 'read') {
      const current = useAppStore.getState(), tab = current.tabs['original-tab'], file = Object.values(tab.regions).find(region => region.kind === 'file');
      if(!file) throw new Error('Original Note Region missing');
      await current.openFile(file.path,'original-group',undefined,'resource',undefined,{displayWorkspaceId:'resource',space:tab.space,resource:{hostId:'local',path:${JSON.stringify(_hygiene_fixturePath("research"))}},reference:{displayWorkspaceId:'resource',groupId:'original-group',tabId:tab.id,regionId:file.regionId}});
    }
    const state = useAppStore.getState(), saved = existsSync(prefs) ? JSON.parse(readFileSync(prefs, 'utf8')) : null;
    const notePath = realMove ? join(resourceRoot,Object.values((await notebooks.read()).pages)[0].resource.path) : join(directory,'note.json');
    const pageAfter = Object.values((await notebooks.read()).pages)[0];
    const sourceEvidence = realMove ? {sourceIdentity,calls:sourceCalls,moves:sourceMoves,reads:sourceReads,pending:state.sourceFilesInputs.pending,before:beforeMoveMetadata,history:await originalHistory(pageAfter)} : undefined;
    console.log(JSON.stringify({error:state.error,documentIssues:state.documentIssues,sourceEvidence,pid:process.pid, writes, recoveries:state.notebookRecoveries, note:readNoteDocument(readFileSync(notePath,'utf8')).note, document:Object.values(state.documents).find(doc=>doc.path.includes('note')), saved, library:await notebooks.read(), selectedNotebook:state.recallNotebookId, selectedNote:state.recallNoteId, collected:state.surveyCollectedZones, selected:state.recallZoneSelection, warning:state.workbenchSaveWarning,
      items:surveyZoneItems(spatialCatalog(state,[]),state.surveyCollectedZones), tab:state.tabs['original-tab'], graph:(await owner.read()).graph}));
    } finally { for (const close of cleanupSource.reverse()) await close(); }
    process.exit(0);
  ` }, outfile: worker, bundle: true, platform: 'node', format: 'esm', alias, metafile: true,
    plugins: [{ name: 'node-presentation-boundary', setup(build) {
      // Preserve executable-entry and package-publication identities when bundling their sources.
      build.onLoad({ filter: /(?:providers\/(?:codex|claude)-execution-run|control-endpoint-publication)\.ts$/ }, args => ({ contents: readFileSync(args.path, 'utf8').replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href)), loader: 'ts' }))
      // Source IPC has a private Node transport; Electron only supplies its private path leaf.
      build.onResolve({ filter: /^electron$/ }, () => ({ path: 'private-electron-path', namespace: 'node-presentation' }))
      build.onLoad({ filter: /^private-electron-path$/, namespace: 'node-presentation' }, () => ({ contents: 'export const app = { getPath: () => process.argv[3], isPackaged: false }; export const nativeImage = new Proxy({}, {get() { throw Error("No image action belongs to this private file consumer") }})', loader: 'js' }))
      // This separate-process proof exercises file, catalog, spatial and persistence owners.
      // Speculative GUI-module warming has no data authority and is covered by mounted App tests.
      build.onResolve({ filter: /file-surface-loading(?:\.ts)?$/ }, () => ({ path: 'gui-module-warming', namespace: 'node-presentation' }))
      build.onLoad({ filter: /^gui-module-warming$/, namespace: 'node-presentation' }, () => ({ contents: 'export function prepareFileSurface() {}', loader: 'js' }))
    } }, { name: 'current-client-ui-source', setup(build) {
      build.onResolve({ filter: /^@agentmux\/client-ui\// }, args => {
        const manifest = JSON.parse(readFileSync(resolve('packages/client-ui/package.json'), 'utf8'))
        const key = './' + args.path.slice('@agentmux/client-ui/'.length)
        const pattern = Object.keys(manifest.exports).filter(key => key.includes('*')).sort((a, b) => b.length - a.length).find(pattern => key.startsWith(pattern.slice(0, -1)))!
        const entry = manifest.exports[key] ?? manifest.exports[pattern]
        const source = typeof entry === 'string' ? entry : entry.browser ?? entry.types
        return { path: resolve('packages/client-ui', source.replace('*', key.slice(pattern?.length - 1))) }
      })
      build.onResolve({ filter: /\?(url|worker)$/ }, () => ({ path: 'browser-worker-url', namespace: 'stub-browser-url' }))
      build.onLoad({ filter: /.*/, namespace: 'stub-browser-url' }, () => ({ contents: 'export default "unused-browser-worker"', loader: 'js' }))
    } }, { name: 'installed-dependencies', setup(build) {
      build.onResolve({ filter: /^[^./]/ }, args => {
        if (Object.hasOwn(alias, args.path)) return { path: alias[args.path]! }
        if (args.path.startsWith('node:')) return { path: args.path, external: true }
        if (args.path === '@ctxmux/sdk') return { path: resolve('packages/core/node_modules/@ctxmux/sdk/dist/index.js'), external: true }
        if (args.path.startsWith('@agentmux/')) {
          const [name, ...subpath] = args.path.slice('@agentmux/'.length).split('/') as [string, ...string[]]
          const packageRoot = resolve(name === 'host' ? 'apps' : 'packages', name)
          const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
          const key = subpath.length ? './' + subpath.join('/') : '.'
          const pattern = Object.keys(manifest.exports).filter(value => value.endsWith('*') && key.startsWith(value.slice(0,-1))).sort((a,b) => b.length-a.length)[0]
          const entry = manifest.exports[key] ?? manifest.exports[pattern!]
          if (!entry) throw Error('Missing original package export: ' + args.path)
          const target = (typeof entry === 'string' ? entry : entry.import).replace('*', pattern ? key.slice(pattern.length-1) : '')
          return { path: resolve(packageRoot, target), external: !/\.tsx?$/.test(target) }
        }
        const installed = createRequire(join(args.resolveDir, 'package.json')).resolve(args.path)
        // Use the installed ESM peer for Tiptap's default exports; keep its actual dependencies.
        const esm = args.path === 'ws' ? join(installed.slice(0,installed.lastIndexOf('/')), 'wrapper.mjs') : installed.replace(/\.(?:cjs|js)$/, '.mjs')
        return { path: args.path.startsWith('@tiptap/') ? installed.replace(/\.cjs$/, '.js') : existsSync(esm) ? esm : installed, external: !args.path.endsWith('.css') }
      })
    } }],
    define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, loader: { '.css': 'empty', '.png': 'dataurl' }, logLevel: 'silent' })
  const inputs = Object.fromEntries(Object.keys(compiled.metafile!.inputs).filter(file => /^(apps|packages)\//.test(file))
    .map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
  await writeFile(resolve('.tmp/survey-notebook/process/compiled-inputs.json'), JSON.stringify(inputs, null, 2))
})
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
function launch(mode: string, directory: string): Promise<any> {
  return new Promise((yes, no) => {
    const child = spawn(process.execPath, [worker, mode, directory, process.env.AGENTMUX_WORKSPACE_MOVE_HELPER ?? resolve('.tmp/survey-notebook/process/workspace-move')], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => errors += chunk)
    child.once('error', no); child.once('close', code => {
      try { if (code !== 0) throw new Error('Private worker exit '+code+': '+errors+'\n'+output.slice(-3000)); yes(JSON.parse(output)) } catch (error) { no(error) }
    })
  })
}
it('restores the same Browser and Note Region layout and opens the same saved Note in a fresh process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'amux-note-region-')); directories.push(directory)
  const first = await launch('write', directory), second = await launch('read', directory)
  writeFileSync(resolve('.tmp/survey-notebook/surface-process-receipt.json'), JSON.stringify({first,second},null,2));
  expect(first.writes).toBe(1); expect(second.writes).toBe(0); expect(second.pid).not.toBe(first.pid)
  expect(second.collected).toEqual(first.collected); expect(second.selected).toEqual(first.saved.state.recallZoneSelection)
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
  const directory = await mkdtemp('/tmp/amx-nb-mv-'); directories.push(directory)
  const first = await launch(lost ? 'write-moved-lost' : 'write-moved',directory), second = await launch(lost ? 'read-moved-lost' : 'read-moved',directory)
  writeFileSync(resolve('.tmp/survey-notebook/continuity-process-'+(lost?'lost':'confirmed')+'.json'),JSON.stringify({first,second},null,2))
  expect(first.pid).not.toBe(second.pid); expect(first.writes).toBe(1); expect(second.writes).toBe(0)
  expect(first.note).toEqual(second.note); expect(second.document.content).toContain(first.note.noteId)
  expect(first.selectedNote).toBeNull(); expect(second.selectedNote).toBe(first.note.noteId)
  expect(first.graph.tabs.map((tab:any)=>tab.tabId)).toEqual(['original-tab'])
  expect(second.warning).toBeNull()
  expect(second.library).toEqual(first.library)
  const page = second.library.pages[first.note.noteId]
  expect(page.resource.path).toBe('Moved research.note.md'); expect(page.sources[0].url).toBe('https://example.test/research')
  expect(second.library.trail.filter((event:any)=>event.action==='relocated')).toHaveLength(1)
  expect(second.library.trail.at(-1).before.resource.path).not.toBe('Moved research.note.md')
  // Source owns the original move. A cold read cannot reconstruct its lost fsync ACK.
  expect(first.recoveries).toEqual([]); expect(second.recoveries).toEqual([])
  expect(first.sourceEvidence.moves).toHaveLength(1)
  expect(first.sourceEvidence.moves[0].result).toMatchObject({filesystem:'moved',noteMetadata:{status:'recorded'}})
  const pending = Object.values(first.sourceEvidence.pending) as any[]
  expect(pending).toHaveLength(lost ? 1 : 0)
  expect(second.sourceEvidence.calls.filter((call:any) => call.method === 'file.move')).toEqual([])
  if (lost) {
    expect(second.sourceEvidence.calls.filter((call:any) => call.method === 'file.mutation.inspect')).toHaveLength(1)
    expect(second.sourceEvidence.reads).toHaveLength(1)
    expect(second.sourceEvidence.reads[0].result).toMatchObject({action:'move',filesystem:'moved',durability:'unconfirmed'})
    expect(Object.values(second.sourceEvidence.pending)).toHaveLength(1)
    expect(Object.values(second.sourceEvidence.pending)[0]).toEqual(pending[0])
  } else expect(second.sourceEvidence.pending).toEqual({})
  expect(first.sourceEvidence.before.page.resource).toMatchObject({hostId:'local',workspaceId:'resource',workspacePath:page.resource.workspacePath})
  expect(page).toMatchObject({notebookId:first.sourceEvidence.before.page.notebookId,parentNoteId:first.sourceEvidence.before.page.parentNoteId,
    createdAt:first.sourceEvidence.before.page.createdAt,sources:first.sourceEvidence.before.page.sources})
  expect(first.sourceEvidence.before.history.entries.length).toBeGreaterThan(0)
  expect(first.sourceEvidence.history.status).toBe('read'); expect(second.sourceEvidence.history).toEqual(first.sourceEvidence.history)
  const beforeHistory = first.sourceEvidence.before.history
  expect(second.sourceEvidence.history.entries).toEqual(beforeHistory.entries.map((entry:any) => ({...entry,
    resource:{...entry.resource,path:'Moved research.note.md'},
    ...(entry.provenance ? {provenance:{...entry.provenance,resource:{...entry.provenance.resource,path:'Moved research.note.md'}}} : {})})))
  expect(page.resource).toEqual({...first.sourceEvidence.before.page.resource,path:'Moved research.note.md'})
  expect(second.sourceEvidence.sourceIdentity.runtimeId).toBe(first.sourceEvidence.sourceIdentity.runtimeId)
  expect(second.sourceEvidence.sourceIdentity.ownerInstanceId).not.toBe(first.sourceEvidence.sourceIdentity.ownerInstanceId)
})

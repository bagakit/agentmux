import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const validationRoot = path.resolve(import.meta.dirname, '../../..')
const root = path.resolve(process.env.AGENTMUX_FOCUS_NAME_WIDTH_SOURCE_ROOT ?? validationRoot), desktop = path.join(root, 'apps/desktop'), fixture = path.join(validationRoot, 'apps/desktop/scripts/fixtures/focus-timeline-name-width')
assert.equal(path.resolve(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).stdout.trim()), root, 'Actual complete workspace, never ancestor lookup')
assert.ok((await fs.readFile(path.join(root, 'package.json'))).length > 0); assert.ok((await fs.readFile(path.join(root, 'pnpm-workspace.yaml'))).length > 0)
const { runProbeProcess, listProbeProcesses } = await import(pathToFileURL(path.join(root, 'apps/desktop/scripts/probe-process.mjs')).href)
const argumentIndex = process.argv.indexOf('--evidence'); assert.ok(argumentIndex >= 0 && process.argv[argumentIndex + 1], 'Explicit --evidence directory')
const evidence = path.resolve(process.argv[argumentIndex + 1])
const require = createRequire(path.join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite'))('esbuild'), electron = require('electron')
const scrollAddendum = process.argv.includes('--scroll-addendum')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-width-'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/lib/focus-timeline-name-width.ts', 'apps/desktop/src/renderer/src/hooks/useSidebarResize.ts', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/src/renderer/src/components/AgentAvatar.tsx']
const validationPaths = ['apps/desktop/scripts/fixtures/focus-timeline-name-width/entry.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-name-width/main.cjs', 'apps/desktop/scripts/capture-focus-timeline-name-width.mjs']
const validationBinding = async () => Object.fromEntries(await Promise.all(validationPaths.map(async file => [file, hash(await fs.readFile(path.join(validationRoot, file)))])))
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-timeline-name-width-scene.v1', passed: false, candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), sourceRoot: root, validationRoot, inputs: await binding(), validationInputs: await validationBinding(), frames: [], mutations: [], images: [], compiled: {}, actual: { controls: [], scenes: [] }, boundary: 'Bounded esbuild production Timeline/Store, ordinary private Electron process and trusted CDP. Isolated typed presentation I/O, not Core native Reader, true Run/PID, two-GUI restart or normal whole Desktop build. No package/install/user App/Run/Runtime.', phase: scrollAddendum ? 'nonzero-vertical-scroll-addendum' : 'original', independentVisualReview: 'pending' }
await fs.mkdir(evidence, { recursive: true })
try {
 const fresh = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
 await fs.writeFile(path.join(evidence, 'freshness.log'), fresh.stdout + fresh.stderr); assert.equal(fresh.status, 0)
 for (const variant of (scrollAddendum ? ['vertical-scroll-addendum'] : ['baseline', 'shared-column-removed', 'shared-column-removed-exact-restore', 'collapsed-left-fixed', 'collapsed-left-fixed-exact-restore'])) {
  const output = path.join(privateRoot, variant), loaded = [], folder = path.join(evidence, variant); await fs.mkdir(folder, { recursive: true })
  const imports = Object.fromEntries(Object.entries({ 'components/RecentFocusTimeline': 'components/RecentFocusTimeline.tsx', store: 'store.ts', 'lib/api': 'lib/api.ts', 'styles/index.css': 'styles/index.css' }).map(([request, file]) => [`../../../src/renderer/src/${request}`, path.join(root, 'apps/desktop/src/renderer/src', file)]))
  const binder = { name: 'actual-name-column-Source', setup(builder) {
   builder.onResolve({ filter: /.*/ }, args => { if (args.importer === path.join(fixture, 'entry.mjs')) { if (imports[args.path]) return { path: imports[args.path] }; if (args.path === 'react' || args.path === 'react-dom/client') return { path: require.resolve(args.path) } } })
   builder.onLoad({ filter: /\.[cm]?[jt]sx?$|\.css$/ }, async args => {
   if(!args.path.startsWith(root + '/apps/desktop/src/') && !args.path.startsWith(fixture + '/'))return
   const original = await fs.readFile(args.path,'utf8'); let code = original
   if(args.path === path.join(root,'apps/desktop/src/renderer/src/styles/focus.css')) {
    const changes = {
     'shared-column-removed': ['.recent-focus__ruler, .recent-focus__track { display: grid; grid-template-columns: var(--focus-name-width, 112px) minmax(0, 1fr);', '.recent-focus__ruler, .recent-focus__track { display: grid; grid-template-columns: 112px minmax(0, 1fr);'],
     'collapsed-left-fixed': [".recent-focus__project-tracks[data-collapsed='true'] .recent-focus__lane { position: absolute; top: 0; left: var(--focus-name-width, 112px);", ".recent-focus__project-tracks[data-collapsed='true'] .recent-focus__lane { position: absolute; top: 0; left: 112px;"]
    }
    if(changes[variant]){const[before,after]=changes[variant];assert.equal(code.split(before).length,2);code=code.replace(before,after)}
   }
   loaded.push({path:path.relative(root,args.path),originalSHA256:hash(original),sha256:hash(code),bytes:Buffer.byteLength(code),...(code!==original?{mutation:variant}:{})})
   return {contents:code,loader:path.extname(args.path)==='.css'?'css':path.extname(args.path)==='.tsx'?'tsx':path.extname(args.path)==='.ts'?'ts':'js',resolveDir:path.dirname(args.path)}
  }) } }
  const built = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, 'entry.mjs')], outdir: output, bundle: true, format: 'esm', platform: 'browser', target: 'esnext', jsx: 'automatic', metafile: true, logLevel: 'error', plugins: [binder], define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file', '.jpg': 'file' } })
  await fs.writeFile(path.join(output,'index.html'),'<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
  assert.ok(loaded.length > 0)
  for(const file of sourcePaths.slice(0,8)) { assert.ok(Object.hasOwn(built.metafile.inputs,file));assert.ok(loaded.some(item=>item.path===file&&item.originalSHA256===receipt.inputs[file])) }
  const assets = Object.fromEntries(await Promise.all((await fs.readdir(output)).map(async file=>[file,hash(await fs.readFile(path.join(output,file)))])))
  receipt.compiled[variant]={assets,loaded,metafile:built.metafile}; await fs.writeFile(path.join(folder,'compiled.json'),JSON.stringify(receipt.compiled[variant],null,2)+'\n')
  const env={...process.env,AGENTMUX_RUNTIME_DIRECTORY:path.join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:path.join(privateRoot,'state')};delete env.ELECTRON_RUN_AS_NODE
  const lines=[],result=await runProbeProcess(electron,[path.join(fixture,'main.cjs'),path.join(output,'index.html'),privateRoot,folder,variant],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>lines.push(line)})
  await fs.writeFile(path.join(folder,'process.log'),lines.join('\n'))
  const actual=JSON.parse(await fs.readFile(path.join(folder,'actual.json'),'utf8'));receipt.actual.scenes.push({variant,result,...actual});receipt.actual.controls.push(...actual.controls)
  assert.equal(result.timedOut,false)
  if(variant==='baseline'||variant==='vertical-scroll-addendum'){assert.equal(result.exitCode,0,actual.failure?.message);assert.equal(actual.passed,true);assert.ok(actual.frames.length>=(scrollAddendum?1:2));receipt.frames=actual.frames;for(const frame of actual.frames)receipt.images.push({path:path.join(variant,frame.image),width:frame.width,sha256:hash(await fs.readFile(path.join(folder,frame.image)))})}
  else if(variant.endsWith('-exact-restore')){assert.equal(result.exitCode,0,actual.failure?.message);assert.equal(actual.passed,true);assert.ok(actual.frames.length>0);const original=receipt.mutations.find(item=>item.mutation===variant.slice(0,-'-exact-restore'.length));assert.ok(original);original.exactRestored=true;original.restore={variant,result,frames:actual.frames};}
  else{assert.notEqual(result.exitCode,0);assert.equal(actual.failure?.name,'AssertionError');const owner=loaded.find(item=>item.mutation===variant);assert.ok(owner);assert.notEqual(owner.sha256,owner.originalSHA256);receipt.mutations.push({mutation:variant,failureName:actual.failure.name,failedAssertions:1,loadedOwner:owner,exactRestored:false})}
 }
 assert.deepEqual(await binding(),receipt.inputs); assert.deepEqual(await validationBinding(),receipt.validationInputs); assert.deepEqual(receipt.actual.controls,[])
 // Each CSS mutation has a later, actually compiled unmodified geometry GREEN.
 assert.ok(receipt.mutations.length===(scrollAddendum?0:2));for(const mutation of receipt.mutations)assert.equal(mutation.exactRestored,true)
 receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
 const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={remainingOwnedProcesses:remaining,ownedPrivateRootsRemoved:false}
 if(!remaining.length){await fs.rm(privateRoot,{recursive:true,force:true});receipt.cleanup.ownedPrivateRootsRemoved=true}
 receipt.sourceAfter = await binding(); receipt.validationAfter = await validationBinding(); await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
}
console.log(JSON.stringify({passed:receipt.passed,receipt:path.relative(root,path.join(evidence,'receipt.json'))}));assert.equal(receipt.passed,true,receipt.failure?.message);assert.equal(receipt.cleanup.ownedPrivateRootsRemoved,true)

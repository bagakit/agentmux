import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/focus-project-history')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-retired-history-renderer-scene-${Date.now()}`))
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-rhist-'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const paths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx','apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx','apps/desktop/src/renderer/src/lib/focus-history-sources.ts','apps/desktop/src/renderer/src/lib/focus-history-timeline.ts','apps/desktop/scripts/fixtures/focus-project-history/retired-main.ts','apps/desktop/scripts/fixtures/focus-project-history/retired-entry.mjs','apps/desktop/scripts/fixtures/focus-project-history/retired-index.html','apps/desktop/src/preload/index.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/main/runtime-controller.ts']
const binding = async()=>Object.fromEntries(await Promise.all(paths.map(async file=>[file,hash(await fs.readFile(path.join(root,file)))])))
const files = async directory => (await Promise.all((await fs.readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]))).flat()
const receipt={schema:'agentmux.focus-retired-history-renderer-scene-delivery.v1',passed:false,sourceRoot:root,candidate:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),privateRoot,inputs:await binding(),compiled:{},actual:null,cleanup:null,
  boundary:'Read-only Renderer Source/caller qualification; actual Core/FileStore, production Main registered IPC and preload/API. Only host preparation and visual scene shell are isolated. No Runtime daemon, Run launch/resume/stop/input, user App/profile, closing/restart or installation qualification.',independentVisualReview:'pending'}
await fs.mkdir(evidence,{recursive:true})
try{
  const freshness=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`],{cwd:root,encoding:'utf8'})
  await fs.writeFile(path.join(evidence,'freshness.log'),freshness.stdout+freshness.stderr);assert.equal(freshness.status,0,'Unmodified normal Core/Demand dist freshness')
  await fs.mkdir(path.join(privateRoot,'node_modules/@agentmux'),{recursive:true})
  for(const name of ['core','demand','layout'])await fs.symlink(path.join(root,'packages',name),path.join(privateRoot,'node_modules/@agentmux',name))
  // Only package resolution links are private. The compiled artifacts bind the
  // same ordinary workspace producer and never modify shared node_modules.
  await fs.symlink(path.join(root,'node_modules/.pnpm'),path.join(privateRoot,'node_modules/.pnpm'))
  const loaded=[]
  for(const name of await fs.readdir(path.join(desktop,'node_modules')))if(!name.startsWith('.')&&name!=='@agentmux')await fs.symlink(path.join(desktop,'node_modules',name),path.join(privateRoot,'node_modules',name))
  const bindLoaded={name:'actual-retired-renderer-module-binding',enforce:'pre',transform(code,id){const file=id.split('?')[0];if(file.startsWith(`${root}/apps/desktop/src/`)&&/\.[cm]?[jt]sx?$/.test(file))loaded.push({path:path.relative(root,file),sha256:hash(code),bytes:Buffer.byteLength(code)})}}
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',plugins:[bindLoaded],define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},build:{target:'esnext',outDir:path.join(privateRoot,'renderer'),emptyOutDir:true,rollupOptions:{input:path.join(fixture,'retired-index.html')}}})
  await build({configFile:false,root:fixture,logLevel:'error',plugins:[bindLoaded],build:{ssr:path.join(fixture,'retired-main.ts'),target:'node22',outDir:path.join(privateRoot,'main'),emptyOutDir:true,rollupOptions:{external:['electron','@agentmux/core','@agentmux/demand','@agentmux/layout',/^@agentmux\/core\//],output:{format:'es',entryFileNames:'main.mjs'}}}})
  await build({configFile:false,root:fixture,logLevel:'error',plugins:[bindLoaded],build:{ssr:path.join(desktop,'src/preload/index.ts'),target:'node22',outDir:path.join(privateRoot,'preload'),emptyOutDir:true,rollupOptions:{external:['electron'],output:{format:'cjs',entryFileNames:'index.cjs',inlineDynamicImports:true}}}})
  receipt.actualLoadedModules=loaded;assert.ok(loaded.some(module=>module.path.endsWith('/RecentFocusTimeline.tsx')));assert.ok(loaded.some(module=>module.path==='apps/desktop/src/main/ipc.ts'))
  receipt.compiled=Object.fromEntries(await Promise.all((await files(privateRoot)).filter(file=>!/node_modules/.test(file)).map(async file=>[path.relative(privateRoot,file),hash(await fs.readFile(file))])))
  const env={...process.env,AGENTMUX_RUNTIME_DIRECTORY:path.join(privateRoot,'runtime'),AGENTMUX_STATE_DIRECTORY:path.join(privateRoot,'state'),AGENTMUX_MESSAGE_QUEUE_PATH:path.join(privateRoot,'messages.ndjson')};delete env.ELECTRON_RUN_AS_NODE
  const lines=[];receipt.exit=await runProbeProcess(electron,[path.join(privateRoot,'main/main.mjs'),path.join(privateRoot,'renderer/retired-index.html'),privateRoot,path.join(privateRoot,'preload/index.cjs'),evidence],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:85000,onLine:line=>lines.push(line)})
  await fs.writeFile(path.join(evidence,'stderr.log'),lines.join('\n'))
  receipt.actual=JSON.parse(await fs.readFile(path.join(evidence,'scene.json'),'utf8'));assert.equal(receipt.exit.timedOut,false);assert.equal(receipt.exit.exitCode,0,receipt.actual.failure?.message);assert.equal(receipt.actual.passed,true);assert.deepEqual(receipt.actual.controls,[])
  receipt.inputsAfter=await binding();assert.deepEqual(receipt.inputsAfter,receipt.inputs,'Own source and consumed Main IPC bytes remain exact')
  receipt.images=await Promise.all(receipt.actual.frames.map(async frame=>({path:path.relative(evidence,path.join(evidence,frame.image)),sha256:hash(await fs.readFile(path.join(evidence,frame.image))),width:frame.width})))
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack}}
finally{
  const remaining=await listProbeProcesses(-1,privateRoot);receipt.cleanup={remaining,privateRootRemoved:false}
  if(!remaining.length){await fs.rm(privateRoot,{recursive:true,force:true});receipt.cleanup.privateRootRemoved=true}
  await fs.writeFile(path.join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
}
assert.equal(receipt.passed,true,receipt.failure?.message);assert.equal(receipt.cleanup.privateRootRemoved,true);console.log(JSON.stringify({passed:true,receipt:path.relative(root,path.join(evidence,'receipt.json')),images:receipt.images}))

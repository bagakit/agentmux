import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, copyFile, realpath } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const repo=resolve(import.meta.dirname,'../../..'),require=createRequire(join(repo,'apps/desktop/package.json'))
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild'),electron=require('electron'),work=await mkdtemp('/tmp/amux-browser-touch-')
const outRoot=join(repo,'.local/browser-touch/proof');await mkdir(outRoot,{recursive:true});const output=await mkdtemp(join(outRoot,'attempt-'))
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),owner='apps/desktop/src/main/browser-page-dispatch.ts',source=await readFile(join(repo,owner),'utf8')
await symlink(join(repo,'apps/desktop/node_modules'),join(work,'node_modules'),'dir')
const inputPaths=[owner,'packages/core/src/browser-page-capability.ts','packages/core/dist/browser-page-capability.js','apps/desktop/src/main/browser-task-assets.ts','apps/desktop/src/main/browser-replay-compiler.ts','apps/desktop/src/main/browser-view-manager.ts','apps/desktop/src/main/browser-operation-step.ts','apps/desktop/src/main/browser-operation-journal.ts','apps/desktop/src/main/browser-own-dispatch.ts','apps/desktop/src/main/browser-page-input-scripts.ts','apps/desktop/src/renderer/src/store.ts','apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx','apps/desktop/src/renderer/src/components/BrowserTaskGestureEditor.tsx','apps/desktop/src/renderer/src/components/BrowserTaskStepFailure.tsx','apps/desktop/src/renderer/src/styles/browser-task-assets.css','apps/desktop/src/shared/browser-task-assets.ts','apps/desktop/src/shared/browser-operation.ts',...['main.ts','preload.ts','renderer.tsx'].map(name=>'apps/desktop/scripts/fixtures/browser-touch/'+name),'apps/desktop/scripts/verify-browser-touch.mjs']
const inputs=Object.fromEntries(await Promise.all(inputPaths.map(async path=>[path,hash(await readFile(join(repo,path)))])))
const receipt={schema:'agentmux.browser-touch.proof.v1',candidateHead:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),inputs,electron:{version:require('electron/package.json').version,path:await realpath(electron),sha256:hash(await readFile(electron))},runs:[],passed:false,output}
const common={absWorkingDir:repo,bundle:true,logLevel:'silent',metafile:true,jsx:'automatic'}
const mutations=process.argv.includes('--mutations')?[
 {label:'native-end-omitted',from:"await touch('touchEnd', [])",to:'/* production native end omitted */',expected:'The native tap must end once on the original target'},
 {label:'unknown-misreported-unsent',from:"No interrupted gesture is automatically replayed.', 'locator-changed', 'unknown')",to:"No interrupted gesture is automatically replayed.', 'locator-changed', 'not-dispatched')",expected:'An interrupted original native touch must retain unknown effects'}
]:[]
console.log('touch-proof-output:',output)
try{
 for(const variant of [{label:'source'},...mutations,...(mutations.length?[{label:'restored-source'}]:[])]){
  const root=join(work,String(receipt.runs.length));await mkdir(root)
  const plugins=variant.from?[{name:'production-touch-mutation',setup(bundler){bundler.onLoad({filter:/browser-page-dispatch\.ts$/},args=>{assert.equal(args.path,join(repo,owner));assert.equal(source.split(variant.from).length-1,1);return{contents:source.replace(variant.from,variant.to),loader:'ts',resolveDir:dirname(args.path)}})}}]:[]
  const main=await build({...common,plugins,platform:'node',format:'esm',packages:'external',external:['electron'],entryPoints:['apps/desktop/scripts/fixtures/browser-touch/main.ts'],outfile:join(root,'main.mjs')})
  for(const path of [owner,'apps/desktop/src/main/browser-view-manager.ts','apps/desktop/src/main/browser-task-assets.ts','apps/desktop/src/main/browser-replay-compiler.ts','apps/desktop/src/main/browser-task-control.ts'])assert.ok(Object.hasOwn(main.metafile.inputs,path),'Native bundle consumes original '+path)
  await build({...common,platform:'node',format:'cjs',external:['electron'],entryPoints:['apps/desktop/scripts/fixtures/browser-touch/preload.ts'],outfile:join(root,'preload.cjs')})
  const renderer=await build({...common,platform:'browser',format:'iife',conditions:['browser'],define:{__AGENTMUX_WEB_PREVIEW__:'false','process.env.NODE_ENV':'"production"'},entryPoints:['apps/desktop/scripts/fixtures/browser-touch/renderer.tsx'],outfile:join(root,'renderer.js')})
  assert.ok(Object.hasOwn(renderer.metafile.inputs,'apps/desktop/src/renderer/src/components/BrowserTaskGestureEditor.tsx'))
  await writeFile(join(root,'index.html'),'<!doctype html><link rel="stylesheet" href="renderer.css"><style>body{margin:0;width:390px;padding:12px;overflow:auto}.browser-task-asset{width:100%}</style><div id="root"></div><script src="renderer.js"></script>')
  await writeFile(join(root,'bootstrap.cjs'),`const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(root)};for(const key of['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(join(root,'main.mjs'))})).catch(error=>{fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('AGENTMUX_')&&!key.startsWith('CTXMUX_')&&key!=='ELECTRON_RUN_AS_NODE'))
  Object.assign(env,{AGENTMUX_TOUCH_ROOT:root,AGENTMUX_TOUCH_SOURCE:repo,AGENTMUX_TOUCH_NODE:process.execPath,AGENTMUX_RUNTIME_DIRECTORY:root,AGENTMUX_STATE_DIRECTORY:join(root,'state'),AGENTMUX_AGENT_SESSION_STORE:join(root,'sessions.json'),AGENTMUX_MESSAGE_QUEUE_PATH:join(root,'messages.ndjson'),NODE_PATH:[join(repo,'apps/desktop/node_modules'),join(repo,'packages/core/node_modules'),join(repo,'node_modules')].join(':')})
  for(const phase of variant.label==='source'?['seed','restart']:['seed']){
   const lines=[],file=variant.label+'-'+phase,row={label:variant.label,phase,result:'unconfirmed',original:file+'.json',process:null,remaining:null,bundleSha256:hash(await readFile(join(root,'main.mjs'))),rendererSha256:hash(await readFile(join(root,'renderer.js')))}
   receipt.runs.push(row)
   const processResult=await runProbeProcess(electron,[join(root,'bootstrap.cjs')],{cwd:root,env:{...env,AGENTMUX_TOUCH_PHASE:phase},timeoutMs:180000,onSpawn:identity=>{row.originalPid=identity.originalPid;writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)).catch(()=>{})},onLine:line=>{lines.push(line);console.log(`[${variant.label}/${phase}] ${line}`)}})
   row.process=processResult
   await stopProbeProcesses(processResult.originalPid,root);const remaining=await listProbeProcesses(processResult.originalPid,root);row.remaining=remaining
   await writeFile(join(output,file+'.log'),lines.join('\n'));await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2))
   const native=JSON.parse(await readFile(join(root,'receipt.json'),'utf8'))
   await writeFile(join(output,file+'.json'),JSON.stringify({native,process:processResult,remaining},null,2));row.result=variant.from?'RED':'GREEN'
   await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2))
   assert.equal(processResult.timedOut,false,'A timeout is not a semantic red/green result');assert.equal(processResult.exitConfirmed,true);assert.deepEqual(remaining,[])
   if(variant.from){assert.equal(processResult.exitCode,1);assert.equal(native.passed,false);assert.match(native.failure?.message??'',new RegExp(variant.expected))}
   else{
    assert.equal(processResult.exitCode,0,lines.join('\n')+'\n'+JSON.stringify(native.failure));assert.equal(native.passed,true);assert.equal(native.cases.length,phase==='restart'?1:11)
    if(phase==='seed')for(const mode of['dark','light'])for(const width of[390,310]){const name=`task-touch-${mode}-${width}.png`;await copyFile(join(root,name),join(output,variant.label+'-'+name));receipt.runs.at(-1).images??=[];const bytes=await readFile(join(root,name));receipt.runs.at(-1).images.push({path:variant.label+'-'+name,sha256:hash(bytes)})}
   }
  }
  for(const name of['tasks.json','task-descriptor.json']){try{await copyFile(join(root,name),join(output,variant.label+'-'+name))}catch(error){if(error.code!=='ENOENT')throw error}}
  await rm(root,{recursive:true,force:true})
 }
 for(const [path,before]of Object.entries(inputs))assert.equal(hash(await readFile(join(repo,path))),before,'Native input source drift: '+path)
 receipt.passed=true
}finally{receipt.diagnosticWork=receipt.passed?null:work;await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));if(receipt.passed)await rm(work,{recursive:true,force:true});console.log('touch-proof-receipt:',join(output,'receipt.json'))}

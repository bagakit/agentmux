import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'
import { laneSourceBinding, sourcePaths, sha } from './source-binding.mjs'
const fixture = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(fixture,'../../../../..')
const desktop = path.join(root,'apps/desktop'), require = createRequire(path.join(desktop,'package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const directory = path.join(root,`.tmp/focus-lane-disconnected-gui-${Date.now()}`)
await fs.mkdir(directory,{recursive:true})
const privateRoot = await fs.mkdtemp(path.join(os.tmpdir(),'agentmux-focus-lane-probe-'))
const css = await fs.readFile(path.join(root,'apps/desktop/src/renderer/src/styles/focus.css'),'utf8')
const prefix = css.slice(0,css.indexOf('/* One scroll canvas'))
const match = /@container \(max-width: (\d+)px\)/.exec(prefix)
assert.ok(match,'Actual lane container threshold must be found')
const threshold = Number(match[1]), widths = [320,640,threshold-1,threshold+1,1440]
const receipt = { schema:'agentmux.focus-lane-disconnected-gui.v1', passed:false, before:laneSourceBinding(root), phases:[], scenes:[], images:[], compile:{}, actualThreshold:threshold, boundary:'Renderer-only esbuild fixture and two ordinary private Electron GUI processes. Actual Global/Workbench/SessionPane/xterm and public web-preview typed transport; durable Tab/Region/layout/draft and exact Session/Run control values retained. No true Core/PTY Run/PID continuity assertion; no package/install/user App/Run/Runtime control.' }
try {
 const output=path.join(privateRoot,'renderer');await fs.mkdir(output,{recursive:true})
 receipt.compile.workers={}
 // Preserve Vite's ?worker module semantics with actual bundled worker code,
 // rather than substituting Editor/Workbench components or no-op Workers.
 const workerPlugin={name:'actual-worker-modules',setup(builder){
  builder.onResolve({filter:/\?worker$/},args=>({path:createRequire(args.importer).resolve(args.path.slice(0,-7)),namespace:'actual-worker'}))
  builder.onLoad({filter:/.*/,namespace:'actual-worker'},async args=>{
   const name='worker-'+sha(args.path).slice(0,12)+'.js'
   const worker=await build({absWorkingDir:root,entryPoints:[args.path],outfile:path.join(output,name),bundle:true,format:'esm',platform:'browser',target:'esnext',metafile:true,logLevel:'error'})
   receipt.compile.workers[name]={entry:args.path,metafile:worker.metafile}
   return {contents:`export default class extends Worker { constructor(options) { super(new URL('./${name}',import.meta.url),{...options,type:'module'}); } }`,loader:'js'}
  })
 }}
 const built=await build({absWorkingDir:root,entryPoints:[path.join(fixture,'entry.mjs')],outdir:output,bundle:true,format:'esm',platform:'browser',target:'esnext',jsx:'automatic',metafile:true,logLevel:'error',plugins:[workerPlugin],define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},loader:{'.woff2':'file','.woff':'file','.ttf':'file','.svg':'file','.png':'file','.jpg':'file'}})
 await fs.writeFile(path.join(output,'index.html'),'<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="./entry.css"></head><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>')
 const consumed = {}
 for(const file of sourcePaths){assert.ok(Object.hasOwn(built.metafile.inputs,file),`Nonempty compiled metafile contains ${file}`);consumed[file]=sha(await fs.readFile(path.join(root,file)))}
 for(const file of sourcePaths)assert.equal(consumed[file],receipt.before[file],`Actual compiled Source ${file}`)
 receipt.compile.consumed=consumed
 receipt.compile.fixture=Object.fromEntries(await Promise.all(['entry.mjs','main.cjs','index.html','capture.mjs','source-binding.mjs'].map(async file=>[file,sha(await fs.readFile(path.join(fixture,file)))])))
 receipt.compile.metafile=built.metafile
 receipt.compile.assets=Object.fromEntries(await Promise.all((await fs.readdir(output)).map(async file=>[file,sha(await fs.readFile(path.join(output,file)))])))
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 for(const phase of ['seed','restore']) {
  const stderr=[]
  const exit=await runProbeProcess(require('electron'),[path.join(fixture,'main.cjs'),path.join(privateRoot,'renderer/index.html'),privateRoot,phase,JSON.stringify(phase==='seed'?widths:[1440])],{temporaryRoot:privateRoot,cwd:root,env,timeoutMs:60000,onLine:line=>stderr.push(line)})
  const actual=JSON.parse(await fs.readFile(path.join(privateRoot,phase+'-result.json'),'utf8'))
  receipt.phases.push({pid:actual.pid,exit,stderr,actual})
  for(const image of actual.images){await fs.copyFile(path.join(privateRoot,image),path.join(directory,image));receipt.images.push(path.relative(root,path.join(directory,image)))}
  receipt.scenes.push(...actual.scenes)
  assert.equal(exit.timedOut,false);assert.equal(exit.exitCode,0,actual.error?.message);assert.equal(actual.passed,true)
 }
 assert.notEqual(receipt.phases[0].pid,receipt.phases[1].pid)
 assert.deepEqual(receipt.phases[1].actual.restored,receipt.phases[0].actual.final)
 receipt.after=laneSourceBinding(root);assert.deepEqual(receipt.after,receipt.before)
 receipt.passed=true
}catch(error){receipt.error={name:error.name,message:error.message,stack:error.stack}}
finally{
 receipt.cleanup={remaining:await listProbeProcesses(-1,privateRoot),rootRemoved:false}
 if(receipt.cleanup.remaining.length===0){await fs.rm(privateRoot,{recursive:true,force:true});receipt.cleanup.rootRemoved=true}
 await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
}
console.log(path.relative(root,path.join(directory,'receipt.json')))
assert.equal(receipt.passed,true,receipt.error?.message)
assert.equal(receipt.cleanup.rootRemoved,true);assert.deepEqual(receipt.cleanup.remaining,[])

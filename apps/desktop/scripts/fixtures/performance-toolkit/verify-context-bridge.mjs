import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
const root=resolve(import.meta.dirname,'../../../../..')
const evidence=process.env.AGENTMUX_TOOLKIT_EVIDENCE
assert.ok(evidence,'Context bridge qualification requires its own evidence directory')
await mkdir(evidence,{recursive:true})
const require=createRequire(resolve(root,'apps/desktop/package.json')),coreRequire=createRequire(resolve(root,'packages/core/package.json'))
const {build}=coreRequire('esbuild'),electron=require('electron')
const aliases=new Map()
for(const name of ['core','demand','layout']){
  const dir=resolve(root,'packages',name),pkg=JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'))
  for(const [key,value]of Object.entries(pkg.exports)){
    const target=typeof value==='string'?value:value.import
    const path=resolve(dir,target.replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/u,'.ts'))
    assert.ok((await readFile(path)).length);aliases.set('@agentmux/'+name+(key==='.'?'':key.slice(1)),path)
  }
}
const sha=bytes=>createHash('sha256').update(bytes).digest('hex'),loaded=[],mutant=process.env.AGENTMUX_TOOLKIT_BRIDGE_MUTANT??'baseline'
const dir=resolve(evidence,'compiled');await mkdir(dir,{recursive:true})
await symlink(resolve(root,'packages/core/node_modules'),resolve(dir,'node_modules'),'dir')
const preload=resolve(dir,'preload.cjs'),main=resolve(dir,'main.mjs')
for(const [entry,outfile]of [['apps/desktop/src/preload/index.ts',preload],['apps/desktop/src/main/toolkit-ipc.ts',main]]){
  await build({entryPoints:[resolve(root,entry)],outfile,bundle:true,platform:'node',format:outfile===main?'esm':'cjs',target:'node24',packages:'external',logLevel:'silent',
    plugins:[{name:'current-WT-bridge-source',setup(builder){
      builder.onResolve({filter:/^@agentmux\//},args=>aliases.has(args.path)?{path:aliases.get(args.path)}:undefined)
      builder.onLoad({filter:/\.ts$/},async args=>{
        if(!args.path.startsWith(root+'/apps/')&&!args.path.startsWith(root+'/packages/'))return
        const path=relative(root,args.path),bytes=await readFile(args.path)
        let code=bytes.toString()
        if(mutant==='early-release'&&path==='apps/desktop/src/preload/index.ts'){
          const anchor="void ipcRenderer.invoke('toolkit:release', id).catch"
          assert.equal(code.split(anchor).length-1,1,'Actual preload release anchor must be uniquely present')
          code=code.replace(anchor,'void Promise.resolve().catch')
        }
        if(mutant==='node-crypto'&&path==='apps/desktop/src/preload/index.ts'){
          const anchor='globalThis.crypto.randomUUID()'
          assert.equal(code.split(anchor).length-1,1,'Actual preload UUID call must be uniquely present')
          code="import { randomUUID } from 'node:crypto'\n"+code.replace(anchor,'randomUUID()')
        }
        loaded.push({path,originalSHA256:sha(bytes),consumedSHA256:sha(code),mutant,bytes:Buffer.byteLength(code)})
        return {contents:code,loader:'ts'}
      })
    }}]})
}
assert.ok(loaded.some(v=>v.path==='apps/desktop/src/preload/index.ts'))
assert.ok(loaded.some(v=>v.path==='apps/desktop/src/main/toolkit-ipc.ts'))
await writeFile(resolve(evidence,'loaded-source.jsonl'),loaded.map(v=>JSON.stringify(v)+'\n').join(''))
const env={...process.env,AGENTMUX_TOOLKIT_BRIDGE_PRELOAD:preload,AGENTMUX_TOOLKIT_BRIDGE_MAIN:main};delete env.ELECTRON_RUN_AS_NODE
let exitCode=0,stdout='',stderr=''
try{const output=await promisify(execFile)(electron,[resolve(root,'apps/desktop/scripts/fixtures/performance-toolkit/context-bridge.cjs')],{
  cwd:root,env,timeout:120000,maxBuffer:1024*1024});stdout=output.stdout;stderr=output.stderr}
catch(error){exitCode=typeof error.code==='number'?error.code:-1;stdout=error.stdout??'';stderr=error.stderr??''}
await writeFile(resolve(evidence,'run.log'),stdout+stderr)
const failure=await readFile(resolve(evidence,'bridge-failure.json'),'utf8').catch(()=>null)
let collected,passedCases
if(mutant==='early-release'||mutant==='node-crypto'){
  assert.notEqual(exitCode,0);assert.ok(failure,'Actual isolated bridge must collect a specific failure')
  const f=JSON.parse(failure);assert.equal(f.name,'AssertionError')
  assert.match(f.message,mutant==='early-release'?/Establishment close must release/u:/Actual sandboxed product preload must publish its public bridge/u)
  assert.equal(f.preferences.sandbox,true);assert.equal(f.preferences.contextIsolation,true);assert.equal(f.preferences.nodeIntegration,false)
  assert.equal(f.collected,1);assert.equal(f.passedCases,0)
  if(mutant==='early-release')assert.ok(f.events.some(e=>e.event==='entered')&&f.events.some(e=>e.event==='returned'))
  else assert.ok(f.consoleMessages.some(e=>String(e.error).includes('node:crypto')),'Old Node-only dependency must fail in the actual sandbox')
  assert.ok(loaded.some(v=>v.originalSHA256!==v.consumedSHA256))
  collected=f.collected;passedCases=f.passedCases
}else{
  assert.equal(exitCode,0,`Actual isolated bridge GREEN required; inspect ${evidence}/run.log`)
  const result=JSON.parse(await readFile(resolve(evidence,'bridge-result.json'),'utf8'))
  assert.equal(result.collected,3);assert.equal(result.passedCases,3);assert.ok(result.earlyEvents.length>0)
  assert.equal(result.contextIsolation,true);assert.equal(result.nodeIntegration,false);assert.equal(result.sandbox,true)
  collected=result.collected;passedCases=result.passedCases
}
for(const value of loaded)assert.equal(sha(await readFile(resolve(root,value.path))),value.originalSHA256,'No actual tree Source mutation')
const receipt={completed:true,mutant,exitCode,collected,passedCases,contextIsolation:true,nodeIntegration:false,sandbox:true,
  sourceWriterUsed:false,scope:'Actual Electron/preload/Main IPC transport only; no App, user Runtime or mock Native completion claim',
  loadedSHA256:sha(await readFile(resolve(evidence,'loaded-source.jsonl'))),compiled:{preload:sha(await readFile(preload)),main:sha(await readFile(main))},electron,
  originalFailure:failure?JSON.parse(failure):null}
await writeFile(resolve(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
await rm(resolve(evidence,'electron-userdata'),{recursive:true,force:true})
console.log(`${mutant}: ${failure?'AssertionRED':'GREEN'} (${collected} actual sandboxed bridge cases reached, ${passedCases} passed)`)

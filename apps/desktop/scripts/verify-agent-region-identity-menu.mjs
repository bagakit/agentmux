import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { listProbeProcesses, stopProbeProcesses, runProbeProcess } from './probe-process.mjs'
import { reapDetachedRuns } from './probe-owned-run.mjs'

const desktop=resolve(import.meta.dirname,'..'), repository=resolve(desktop,'../..')
const require=createRequire(import.meta.url), exec=promisify(execFile), {build}=await import('vite'), ts=require('typescript')
const privateRoot=await mkdtemp('/tmp/amx-identity-menu-')
const evidence=join(repository,'.tmp/agent-region-identity-menu',`attempt-${Date.now()}`), fixture=join(desktop,'scripts/fixtures/agent-region-identity-menu')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const result={schema:'agentmux.region-identity-menu-delivery.v1',passed:false,sourceBefore:{},sourceAfter:{},mutations:[],callers:[],cleanup:{},userRunTouched:false}
const sourceFiles=(await exec('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:repository,maxBuffer:32*1024*1024})).stdout.split('\0').filter(Boolean)
assert.ok(sourceFiles.length>0)
async function sources(){return Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,hash(await readFile(join(repository,name)))])))}
async function compiled(directory){
  const entries=await readdir(directory,{recursive:true,withFileTypes:true}),files={}
  for(const entry of entries){if(!entry.isFile())continue;const path=join(entry.parentPath,entry.name);files[path.slice(directory.length+1)]=hash(await readFile(path))}
  assert.ok(Object.keys(files).length>0,'The actual private renderer outputs are nonempty');return files
}
async function renderer(label,probe='complete'){
  const directory=join(evidence,label), outDir=join(privateRoot,label);await mkdir(directory,{recursive:true})
  const xtermFile=require.resolve('@xterm/xterm'), wrapper=join(privateRoot,'record-xterm.mjs')
  await writeFile(wrapper,`import xterm from ${JSON.stringify(xtermFile)};
    export class Terminal extends xterm.Terminal { constructor(...args){super(...args);const entries=globalThis.identityTerminals??=[];this.probeIdentity={id:entries.length,terminal:this,disposed:false};entries.push(this.probeIdentity)}
      dispose(){this.probeIdentity.disposed=true;return super.dispose()} }
  `)
  await build({configFile:false,root:fixture,base:'./',logLevel:'error',resolve:{alias:[{find:/^@xterm\/xterm$/,replacement:wrapper}]},
    define:{__AGENTMUX_WEB_PREVIEW__:'true','process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},
    build:{outDir,emptyOutDir:true,commonjsOptions:{include:[/node_modules/,/xterm-locked-925/]}}})
  const compiledFiles=await compiled(outDir),terminalWrapperSha256=hash(await readFile(wrapper))
  await writeFile(join(directory,'compiled.json'),JSON.stringify({compiledFiles,terminalWrapperSha256},null,2))
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  const log=[]
  const outcome=await runProbeProcess(require('electron'),[join(fixture,'main.cjs'),join(outDir,'index.html'),privateRoot,directory,probe],{
    temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:90000,onLine:line=>log.push(line)})
  await writeFile(join(directory,'process.log'),log.join('\n'))
  const rendered=JSON.parse(await readFile(join(directory,'render.json'),'utf8'))
  assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
  return{outcome,rendered,directory,compiledFiles,terminalWrapperSha256}
}
async function mutation(label,file,from,to,probe,message){
  const original=await readFile(file),text=original.toString()
  assert.equal(text.split(from).length,2,'Exactly one real source mutation anchor')
  const altered=Buffer.from(text.replace(from,to));let red
  await writeFile(join(evidence,`${label}-original.tsx`),original)
  await writeFile(join(evidence,`${label}-mutated.tsx`),altered)
  try{
    await writeFile(file,altered);red=await renderer(`${label}-red`,probe)
    assert.equal(red.outcome.exitCode,1);assert.equal(red.rendered.passed,false)
    assert.equal(red.rendered.failure.name,'AssertionError');assert.match(red.rendered.failure.message,message)
  }finally{await writeFile(file,original);assert.equal(hash(await readFile(file)),hash(original))}
  const control=await renderer(`${label}-restored`,probe)
  assert.equal(control.outcome.exitCode,0);assert.equal(control.rendered.passed,true)
  result.mutations.push({label,file,originalSha256:hash(original),mutatedSha256:hash(altered),red,control,restoredExactly:true})
}
async function productionCallers(){
  const contracts=[
    {symbol:'AgentRegionHeader',definition:'components/AgentRegionHeader.tsx',caller:'components/SessionPane.tsx',kind:'jsx'},
    {symbol:'useRegionMenuEntries',definition:'components/RegionContextMenu.tsx',caller:'components/AgentRegionHeader.tsx',kind:'call'},
    {symbol:'RegionMenuEntryView',definition:'components/RegionContextMenu.tsx',caller:'components/AgentRegionHeader.tsx',kind:'jsx'},
    {symbol:'agentDisplayName',definition:'lib/workbench-tabs.ts',caller:'components/SessionPane.tsx',kind:'call'},
    {symbol:'closeRegion',definition:'store.ts',caller:'components/WorkspaceWorkbench.tsx',kind:'call'}
  ]
  for(const contract of contracts){
    assert.notEqual(contract.definition,contract.caller)
    const file=join(desktop,'src/renderer/src',contract.caller),text=await readFile(file,'utf8'),source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),hits=[]
    const visit=node=>{
      if(contract.kind==='call'&&ts.isCallExpression(node)&&node.expression.getText(source)===contract.symbol)hits.push(node.getText(source))
      if(contract.kind==='jsx'&&(ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&node.tagName.getText(source)===contract.symbol)hits.push(node.getText(source))
      ts.forEachChild(node,visit)
    };visit(source);assert.ok(hits.length>0,'Non-definition, non-import production caller '+contract.symbol)
    result.callers.push({...contract,hits,sourceSha256:hash(text)})
  }
}
async function restart(){
  const directory=join(privateRoot,'restart');await mkdir(directory)
  const receiptPath=join(evidence,'restart-raw-receipt.json')
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
  let outcome,detachedRuns;const log=[]
  try{outcome=await runProbeProcess(process.execPath,[join(desktop,'scripts/verify-workbench-persistence-restart.mjs'),'--identity-menu',`--probe-root=${directory}`,`--receipt-path=${receiptPath}`],{
    temporaryRoot:privateRoot,cwd:repository,env,timeoutMs:125000,onLine:line=>log.push(line)})}
  finally{detachedRuns=await reapDetachedRuns(directory);await writeFile(join(evidence,'restart.log'),log.join('\n'))}
  assert.equal(outcome.exitCode,0);assert.equal(outcome.timedOut,false);assert.equal(outcome.interruption,null)
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'))
  assert.equal(receipt.passed,true);assert.equal(receipt.regionClose,false);assert.equal(receipt.identityMenu.passed,true)
  assert.equal(receipt.second.visibleRegions.length,2);assert.equal(receipt.sameRunPid,true);assert.equal(receipt.privateInputAccepted,true)
  await writeFile(join(evidence,'restart.json'),JSON.stringify(receipt,null,2))
  return{outcome,detachedRuns,receipt}
}
try{
  await mkdir(evidence,{recursive:true});result.sourceCommit=(await exec('git',['rev-parse','HEAD'],{cwd:repository})).stdout.trim();result.sourceBefore=await sources()
  result.render=await renderer('fixed');assert.equal(result.render.outcome.exitCode,0,JSON.stringify(result.render.rendered.failure));assert.equal(result.render.rendered.passed,true)
  if(!process.argv.includes('--render-only')){
    await mutation('name',join(desktop,'src/renderer/src/components/AgentRegionHeader.tsx'),'>{name}</strong>',">{''}</strong>",'name',/Actual Agent name is nonempty/)
    await mutation('target',join(desktop,'src/renderer/src/components/WorkspaceWorkbench.tsx'),
      'split: (direction) => splitRegion(tab.workspaceId, tab.id, node.regionId, direction)',
      'split: (direction) => splitRegion(tab.workspaceId, tab.id, tab.layout.activeRegionId, direction)','target',/^Expected values to be strictly deep-equal:/)
    await productionCallers();result.restart=await restart()
  }else result.diagnosticOnly=true
  result.sourceAfter=await sources();assert.deepEqual(result.sourceAfter,result.sourceBefore);result.passed=true
}catch(error){result.failure={name:error.name,message:error.message}}
finally{
  await stopProbeProcesses(process.pid+1000000000,privateRoot);result.cleanup.remaining=await listProbeProcesses(process.pid+1000000000,privateRoot);assert.deepEqual(result.cleanup.remaining,[])
  await rm(privateRoot,{recursive:true});result.cleanup.rootRemoved=true
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(result,null,2))
}
console.log(JSON.stringify({passed:result.passed,diagnosticOnly:result.diagnosticOnly,frames:result.render?.rendered.frames.length,receipt:join(evidence,'receipt.json'),failure:result.failure}))
if(!result.passed)process.exitCode=1

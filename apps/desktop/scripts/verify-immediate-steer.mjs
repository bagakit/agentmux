import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const root=resolve(import.meta.dirname,'../../..'), exec=promisify(execFile), require=createRequire(import.meta.url)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const privateRoot=await realpath(await mkdtemp(join(tmpdir(),'amx-immediate-steer-')))
const evidence=join(root,'.tmp/immediate-steer',String(globalThis.crypto.randomUUID()))
await mkdir(evidence,{recursive:true})
const store='apps/desktop/src/renderer/src/store.ts',service='packages/core/src/public-rpc-service.ts',main='apps/desktop/src/main/runtime-controller.ts',client='packages/core/src/client.ts',queue='packages/core/src/agent-global-message-queue.ts',cli='packages/core/src/agentmux-cli-commands.ts'
const composer='apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx'
const owned=[store,service,main,client,queue,cli,composer,'apps/desktop/src/shared/contracts.ts','apps/desktop/src/renderer/src/lib/service-window-notice.ts','packages/core/src/control-codec.ts','packages/core/src/public-rpc.ts','packages/core/src/control.ts']
const originals=new Map(await Promise.all(owned.map(async p=>[p,await readFile(join(root,p),'utf8')])))
const receipt={schema:'agentmux.immediate-steer-proof.v1',passed:false,userRunTouched:false,sharedSourceWritten:false,sourceHashes:Object.fromEntries([...originals].map(([p,b])=>[p,sha(b)])),mutations:[]}

async function source(){
 const ts=require('typescript'),readConfig=p=>{const json=ts.readConfigFile(p,ts.sys.readFile);assert.equal(json.error,undefined);return ts.parseJsonConfigFileContent(json.config,ts.sys,resolve(p,'..'))}
 const desktop=readConfig(join(root,'apps/desktop/tsconfig.json')),shared=readConfig(join(root,'packages/client-ui/tsconfig.json'))
 const paths={...desktop.options.paths,'@agentmux/layout':['packages/layout/src/index.ts'],'@agentmux/demand':['packages/demand/src/index.ts']}
 for(const pkg of ['core','demand','client-ui']){
  const entries=JSON.parse(await readFile(join(root,'packages',pkg,'package.json'),'utf8')).exports
  for(const [key,target] of Object.entries(entries))if(target?.import)paths['@agentmux/'+pkg+(key==='.'?'':key.slice(1))]=['packages/'+pkg+'/'+target.import.replace('./dist/','./src/').replace(/\.js$/,'.ts')]
 }
 const roots=[...new Set([...desktop.fileNames,...shared.fileNames])],options={...desktop.options,configFilePath:join(root,'apps/desktop/tsconfig.json'),baseUrl:root,paths},host=ts.createCompilerHost(options),read=host.readFile
 host.readFile=p=>originals.get(relative(root,p))??read(p)
 host.getSourceFile=(p,v)=>{const text=host.readFile(p);return text===undefined?undefined:ts.createSourceFile(p,text,v,true)}
 const program=ts.createProgram(roots,options,host)
 const diagnostics=ts.getPreEmitDiagnostics(program).map(d=>({file:d.file?relative(root,d.file.fileName):'<config>',code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))
 receipt.source={roots:roots.length,consumedSources:program.getSourceFiles().length,diagnostics,callers:[]}
 assert.ok(roots.length>1&&program.getSourceFiles().length>100)
 await writeFile(join(evidence,'source.json'),JSON.stringify(receipt.source,null,2))
 assert.deepEqual(diagnostics,[],'Complete production TypeScript program must compile')
 for(const [path,needle] of [[composer,'agentSteerExecution'],[store,'agentSteerExecution'],[store,'api.sessions.submitPrompt'],[store,'api.sessions.submitMessage'],[main,'client.submitAgentPrompt'],[service,'recipientOwner.client.submitAgentMessage']]){
  const file=program.getSourceFile(join(root,path));assert.ok(file)
  const calls=[]
  function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(file)===needle)calls.push({line:file.getLineAndCharacterOfPosition(n.pos).line+1,text:n.getText(file)});ts.forEachChild(n,visit)}
  visit(file);assert.ok(calls.length,path+' external production consumer '+needle);receipt.source.callers.push({path,needle,calls})
 }
 // The external consumer must fail under an actual incompatible owner signature.
 const target='apps/desktop/src/shared/contracts.ts',original=originals.get(target),changed=original.replace('execution?: AgentPromptExecution','execution?: number');assert.notEqual(changed,original)
 const mutationHost=ts.createCompilerHost(options),mutationRead=mutationHost.readFile
 mutationHost.readFile=p=>relative(root,p)===target?changed:originals.get(relative(root,p))??mutationRead(p)
 mutationHost.getSourceFile=(p,v)=>{const text=mutationHost.readFile(p);return text===undefined?undefined:ts.createSourceFile(p,text,v,true)}
 const red=ts.getPreEmitDiagnostics(ts.createProgram(roots,options,mutationHost)).filter(d=>d.file&&relative(root,d.file.fileName)===store).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))
 assert.ok(red.some(d=>d.code===2322||d.code===2345),'Real Store/API execution consumer rejects incompatible public argument')
 receipt.source.signatureMutation={sha256:sha(changed),red};await writeFile(join(evidence,'source.json'),JSON.stringify(receipt.source,null,2))
}
async function prepare(){
 for(const directory of ['apps/desktop/src','apps/desktop/test','apps/desktop/browser-extension','apps/desktop/scripts/fixtures','packages/core/src','packages/core/test','packages/core/dist','packages/core/bin','packages/demand/src','packages/client-ui/src','packages/layout/src'])await cp(join(root,directory),join(privateRoot,directory),{recursive:true})
 for(const path of ['package.json','tsconfig.base.json','tsconfig.shared.json','vitest.setup.ts','apps/desktop/package.json','apps/desktop/tsconfig.json',...['core','demand','client-ui','layout'].flatMap(p=>['package.json','tsconfig.json','tsconfig.build.json'].map(n=>'packages/'+p+'/'+n))]){
  try{await cp(join(root,path),join(privateRoot,path))}catch(e){if(e.code!=='ENOENT')throw e}
 }
 for(const directory of ['node_modules','apps/desktop/node_modules',...['core','demand','client-ui','layout'].map(p=>'packages/'+p+'/node_modules')])await symlink(join(root,directory),join(privateRoot,directory),'dir')
 for(const [p,b] of originals)await writeFile(join(privateRoot,p),b)
 // Recompile the actual public CLI sources in the private tree. No shared dist mutation.
 const built=await exec(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','packages/core/tsconfig.build.json'],{cwd:privateRoot,maxBuffer:4*1024*1024})
 await writeFile(join(evidence,'private-core-build.log'),built.stdout+built.stderr)
}
async function mounted(label,red=false){
 let code=0,output=''
 const report=join(privateRoot,label+'.json')
 try{const r=await exec(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/immediate-steer/vitest.config.mts','--maxWorkers=1','--reporter=json','--outputFile='+report],{cwd:privateRoot,maxBuffer:4*1024*1024,timeout:60000});output=r.stdout+r.stderr}catch(e){code=e.code;output=(e.stdout??'')+(e.stderr??'')}
 await writeFile(join(evidence,label+'.log'),output)
 const discovery=JSON.parse(await readFile(report,'utf8'))
 await writeFile(join(evidence,label+'.json'),JSON.stringify(discovery,null,2))
 assert.ok(discovery.numTotalTests>=16,'Owning test discovery must be nonempty')
 assert.equal(discovery.testResults.length,2);assert.deepEqual(discovery.testResults.map(item=>relative(privateRoot,item.name)).sort(),['apps/desktop/test/agent-explicit-steer.test.tsx','packages/core/test/public-immediate-message.test.ts'].sort())
 if(red){assert.notEqual(code,0);assert.ok(discovery.numFailedTests>0);assert.ok(discovery.testResults.some(suite=>suite.assertionResults.some(item=>item.status==='failed'&&item.failureMessages.some(message=>/AssertionError|promise resolved .*instead of rejecting/s.test(message)))))}else{assert.equal(code,0,output);assert.equal(discovery.numFailedTests,0)}
 return{code,tests:discovery.numTotalTests,failed:discovery.numFailedTests,log:label+'.log'}
}
async function mutations(){
 const cases=[
  [store,'explicit-capability-lost',"explicitAttempt ? agentSteerExecution(pending, fresh.capabilities) : 'default'","'default'"],
  [store,'ordinary-input-interrupts',"explicitAttempt ? agentSteerExecution(pending, fresh.capabilities) : 'default'","agentSteerExecution(pending, fresh.capabilities)"],
  [main,'Main-drops-execution',"          ...(!automation && choice?.execution !== undefined ? { execution: choice.execution } : {}),",''],
  [service,'public-RPC-loses-execution',"agentSessionId: recipientId, envelope: queued.envelope, condition: promptCondition,\n        execution,","agentSessionId: recipientId, envelope: queued.envelope, condition: promptCondition,\n        execution: 'default',"],
  [queue,'changed-mode-reuses-delivered-id',/ \|\| \(existing\.execution \?\? 'default'\) !== execution/g,''],
  [client,'SDK-does-not-freeze-mode',/const queued = await this\.messageQueue\.append\(\{ \.\.\.envelope,\s*\.\.\.\(input\.execution === undefined \? \{\} : \{ execution: input\.execution \}\) \}\)/,"const queued = await this.messageQueue.append(envelope)"],
  [cli,'CLI-discards-explicit-mode',"...(execution === undefined ? {} : { execution }),",'']
 ]
 for(const [path,name,from,to] of cases){
  const original=originals.get(path),changed=original.replace(from,to);assert.notEqual(changed,original,name+' must mutate actual production source')
  await writeFile(join(privateRoot,path),changed)
  if(path===cli)await exec(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','packages/core/tsconfig.build.json'],{cwd:privateRoot,maxBuffer:4*1024*1024})
  try{receipt.mutations.push({name,path,mutatedSha256:sha(changed),...(await mounted(name,true))})}finally{
    await writeFile(join(privateRoot,path),original)
    if(path===cli)await exec(process.execPath,[require.resolve('typescript/bin/tsc'),'-p','packages/core/tsconfig.build.json'],{cwd:privateRoot,maxBuffer:4*1024*1024})
  }
 }
 receipt.restored=await mounted('restored-green')
}
try{await source();await prepare();receipt.baseline=await mounted('original-green');await mutations();receipt.passed=true}
catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{receipt.sourceChangesDuringProof=[];for(const [p,b]of originals){const current=sha(await readFile(join(root,p)));if(current!==sha(b))receipt.sourceChangesDuringProof.push({path:p,captured:sha(b),current})}await rm(privateRoot,{recursive:true,force:true});receipt.privateRootRemoved=true;await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,evidence:relative(root,evidence),failure:receipt.failure?.message}))}

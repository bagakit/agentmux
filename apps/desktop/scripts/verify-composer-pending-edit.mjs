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
const privateRoot=await realpath(await mkdtemp(join(tmpdir(),'amx-pending-edit-')))
const evidence=join(root,'.tmp/composer-pending-edit',String(globalThis.crypto.randomUUID()))
await mkdir(evidence,{recursive:true})
const store='apps/desktop/src/renderer/src/store.ts',service='packages/core/src/public-rpc-service.ts'
const composer='apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx'
const owned=[store,service,composer,'packages/core/src/pending-message-control.ts','packages/core/src/control-codec.ts','packages/core/src/rpc-business-codec.ts','packages/core/src/public-rpc.ts','packages/core/src/control.ts','packages/core/src/agentmux-cli-commands.ts']
const originals=new Map(await Promise.all(owned.map(async p=>[p,await readFile(join(root,p),'utf8')])))
const receipt={schema:'agentmux.composer-pending-edit-proof.v1',passed:false,userRunTouched:false,sharedSourceWritten:false,sourceHashes:Object.fromEntries([...originals].map(([p,b])=>[p,sha(b)])),mutations:[]}

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
 for(const [path,needle] of [[composer,'useAppStore.getState().editQueuedAgentSteer'],[store,'get().editQueuedAgentSteer'],[store,'get().sendQueuedAgentSteer'],[service,'parseAgentMuxControlRequest']]){
  const file=program.getSourceFile(join(root,path));assert.ok(file)
  const calls=[]
  function visit(n){if(ts.isCallExpression(n)&&n.expression.getText(file)===needle)calls.push({line:file.getLineAndCharacterOfPosition(n.pos).line+1,text:n.getText(file)});ts.forEachChild(n,visit)}
  visit(file);assert.ok(calls.length,path+' external production consumer '+needle);receipt.source.callers.push({path,needle,calls})
 }
 // The external consumer must fail under an actual incompatible owner signature.
 const original=originals.get(store),changed=original.replace('nextText: string): void','nextText: number): void');assert.notEqual(changed,original)
 const mutationHost=ts.createCompilerHost(options),mutationRead=mutationHost.readFile
 mutationHost.readFile=p=>relative(root,p)===store?changed:originals.get(relative(root,p))??mutationRead(p)
 mutationHost.getSourceFile=(p,v)=>{const text=mutationHost.readFile(p);return text===undefined?undefined:ts.createSourceFile(p,text,v,true)}
 const red=ts.getPreEmitDiagnostics(ts.createProgram(roots,options,mutationHost)).filter(d=>d.file&&relative(root,d.file.fileName)===composer).map(d=>({code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,'\n')}))
 assert.ok(red.some(d=>d.code===2345),'Definition-external production Composer caller rejects incompatible edit owner argument')
 receipt.source.signatureMutation={sha256:sha(changed),red};await writeFile(join(evidence,'source.json'),JSON.stringify(receipt.source,null,2))
}
async function prepare(){
 for(const directory of ['apps/desktop/src','apps/desktop/test','apps/desktop/scripts/fixtures','packages/core/src','packages/core/test/helpers','packages/core/dist','packages/core/bin','packages/demand/src','packages/client-ui/src','packages/layout/src'])await cp(join(root,directory),join(privateRoot,directory),{recursive:true})
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
 try{const r=await exec(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/composer-pending-edit/vitest.config.mts','--maxWorkers=1','--reporter=json','--outputFile='+report],{cwd:privateRoot,maxBuffer:4*1024*1024,timeout:60000});output=r.stdout+r.stderr}catch(e){code=e.code;output=(e.stdout??'')+(e.stderr??'')}
 await writeFile(join(evidence,label+'.log'),output)
 const discovery=JSON.parse(await readFile(report,'utf8'))
 await writeFile(join(evidence,label+'.json'),JSON.stringify(discovery,null,2))
 assert.ok(discovery.numTotalTests>=8,'Owning test discovery must be nonempty')
 assert.equal(discovery.testResults.length,1);assert.ok(discovery.testResults[0].name.endsWith('/composer-pending-edit.test.ts'))
 if(red){assert.notEqual(code,0);assert.ok(discovery.numFailedTests>0);assert.ok(discovery.testResults[0].assertionResults.some(item=>item.status==='failed'&&item.failureMessages.some(message=>/AssertionError/.test(message))))}else{assert.equal(code,0,output);assert.equal(discovery.numFailedTests,0)}
 return{code,tests:discovery.numTotalTests,failed:discovery.numFailedTests,log:label+'.log'}
}
async function mutations(){
 const cases=[
  [store,'remove-expected-text-CAS',/      if \(entry\.text !== expectedText\) \{\n        throw controlFailure\([^\n]+\n      \}\n/,''],
  [store,'edit-unknown-original-input','entry.promptCondition === null && entry.operationId !== inFlightId','entry.operationId !== inFlightId'],
  [store,'edit-preparing-message','entry.promptCondition === null && entry.operationId !== inFlightId','entry.promptCondition === null'],
  [store,'retarget-original-Run','? { ...item, text: nextText } : item','? { ...item, text: nextText, runId: "new-wrong-run" } : item'],
  [store,'save-grants-execution','// Saving changes only the original intent. It never grants execution or wakes its consumer.','void get().flushAgentSteerQueue(sessionId, operationId)'],
  [store,'queue-absence-fakes-input-ack','const disposition = await get().sendQueuedAgentSteer(session.id, request.pendingId)','await get().sendQueuedAgentSteer(session.id, request.pendingId)\n      const disposition = get().agentSteerQueues[session.id]?.some(item=>item.operationId===request.pendingId) ? "unconfirmed" : "submitted"'],
  [service,'managed-caller-can-mutate-human-input','if (context.caller !== undefined || !context.principal ||\n          ![\'user\', \'device\'].includes(context.principal.kind)','if (!context.principal ||\n          ![\'user\', \'device\'].includes(context.principal.kind)']
 ]
 for(const [path,name,from,to] of cases){
  const original=originals.get(path),changed=original.replace(from,to);assert.notEqual(changed,original,name+' must mutate actual production source')
  await writeFile(join(privateRoot,path),changed)
  try{receipt.mutations.push({name,path,mutatedSha256:sha(changed),...(await mounted(name,true))})}finally{await writeFile(join(privateRoot,path),original)}
 }
 receipt.restored=await mounted('restored-green')
}
async function restart(){
 const path=join(evidence,'restart.json')
 const candidate=(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim()
 const r=await exec(process.execPath,[join(root,'apps/desktop/scripts/verify-workbench-persistence-restart.mjs'),'--pending-edit','--pending-edit-source-ref=HEAD','--receipt-path='+path],{cwd:root,maxBuffer:4*1024*1024})
 await writeFile(join(evidence,'restart.log'),r.stdout+r.stderr)
 const result=JSON.parse(await readFile(path,'utf8'))
 assert.equal(result.passed,true);assert.equal(result.pendingEdit?.passed,true)
 assert.equal(result.sourceCommit,candidate,'Actual restarted Desktop consumes the exact gated commit')
 assert.equal(result.pendingEdit.saveGrantedNoExecution,true)
 assert.equal(result.pendingEdit.exactFlag,'--pending-edit')
 assert.equal(result.pendingEdit.automaticallyAttachedSameRun,true)
 const run=result.pendingEdit.originalRun
 assert.ok(Number.isSafeInteger(run?.pid)&&run.pid>0)
 assert.ok(Number.isSafeInteger(run?.inputBefore)&&Number.isSafeInteger(run?.inputAfter))
 assert.equal(run.inputAfter,run.inputBefore)
 assert.equal(run.pid,result.fixture.runPid)
 assert.ok(result.pendingEdit.publicAfter.messages.length>=3)
 assert.equal(result.second.exactMovedQueueRestored,true);assert.equal(result.second.exactDraftRestored,true)
 assert.equal(result.second.exactWorkbenchRestored,true);assert.equal(result.second.exactAgentFocusRestored,true)
 receipt.restart={sourceCommit:result.sourceCommit,receiptPath:relative(root,path),sha256:sha(await readFile(path)),passed:true,
  exactDraftRestored:result.second.exactDraftRestored,exactWorkbenchRestored:result.second.exactWorkbenchRestored,
  exactMovedQueueRestored:result.second.exactMovedQueueRestored,noAutomaticInput:true}
}
try{await source();await prepare();receipt.baseline=await mounted('original-green');await mutations();await restart();receipt.passed=true}
catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{receipt.sourceChangesDuringProof=[];for(const [p,b]of originals){const current=sha(await readFile(join(root,p)));if(current!==sha(b))receipt.sourceChangesDuringProof.push({path:p,captured:sha(b),current})}await rm(privateRoot,{recursive:true,force:true});receipt.privateRootRemoved=true;await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,evidence:relative(root,evidence),failure:receipt.failure?.message}))}

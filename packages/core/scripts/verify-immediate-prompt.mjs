import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { qualifySharedMainSource } from './qualify-shared-main-source.mjs'
const exec=promisify(execFile),root=fileURLToPath(new URL('../../../',import.meta.url)),core=join(root,'packages/core')
const args=process.argv.slice(2);assert(args.every(a=>a==='--native'||a==='--no-mutations'),'Unknown immediate proof option')
const evidence=join(root,'.tmp','verify-immediate-prompt');await mkdir(evidence,{recursive:true})
const report={schema:'agentmux.immediate-prompt-verification.v1',passed:false,callers:[],mutations:[]}
const run=async(argv,options={})=>exec(process.execPath,argv,{cwd:root,env:{...process.env,pnpm_config_verify_deps_before_run:'false'},maxBuffer:8*1024*1024,...options})
const tests=()=>run([join(root,'node_modules/vitest/vitest.mjs'),'run','--config',join(core,'scripts/immediate-prompt.vitest.config.mts')])
const selectedSource=['packages/core/src','packages/core/scripts/build.mjs','packages/core/package.json','packages/core/tsconfig.json','packages/core/tsconfig.build.json','tsconfig.base.json']
try{
 report.sourceQualification=await qualifySharedMainSource(root,selectedSource)
 await run([join(core,'scripts/build.mjs')]);report.build=true
 // All witnesses are outside the symbol's defining file; an empty set is a failure.
 for(const [file,expressions]of[
  ['packages/core/src/client.ts',[/planPromptInput\(outbound,[^\n]*execution/u,/submitInputPlan\([\s\S]*?input\.execution\)/u,/submitPromptInternal\([\s\S]*?execution: input\.execution/u]],
  ['packages/core/src/prompt-submission.ts',[/inspectPromptExecution\?\.\(screen\.snapshot\(\)\)/u,/readPromptExecutionEvidence\(nativeContext\)/u,/this\.applyInput\(session, submissionId/u,/screen\.geometryRevision !== frameRefresh\.resizeRevision/u,/frameRefresh: \{ \.\.\.frozen, acknowledged: true \}/u]],
  ['packages/core/src/screen-evidence.ts',[/for \(const step of terminalContinuationSteps\(observation\)\)/u,/\}, 'terminal'\)/u,/built\.seedFrameEvidence\(chunks, fence\)/u]],
  ['packages/core/src/agent-session-store.ts',[/prepare\.refresh === undefined/u,/terminalInputPhase\(refresh, 'prompt native frame refresh'\)/u]],
  ['packages/core/src/providers/codex.ts',[/refresh: '\\u001b\[I'/u,/readPromptExecutionEvidence: readCodexPromptExecutionEvidence/u,/inspectPromptExecution: inspectCodexPromptExecution/u]]
 ]){const source=await readFile(join(root,file),'utf8');for(const expression of expressions)assert(expression.test(source),`Missing production caller ${file} ${expression}`);report.callers.push({file,witnesses:expressions.length})}
 assert(report.callers.length>=3)
 const typeConfig=join(evidence,'typecheck.json');await writeFile(typeConfig,JSON.stringify({extends:join(core,'tsconfig.json'),compilerOptions:{noEmit:true,composite:false,rootDir:root},include:[join(core,'test/immediate-prompt.test.ts'),join(core,'test/immediate-provider.test.ts'),join(core,'test/immediate-screen-recovery.test.ts')],exclude:[]},null,2))
 await run([join(root,'node_modules/typescript/bin/tsc'),'--project',typeConfig]);report.owningTypes=true
 const green=await tests();await writeFile(join(evidence,'tests.log'),green.stdout+green.stderr);assert(/30 passed/.test(green.stdout));report.tests=30
 if(!args.includes('--no-mutations')){
 const mutations=[
  ['skip-prepare','packages/core/src/prompt-submission.ts','if (plan.prepare && submission.prepare &&','if (false && plan.prepare && submission.prepare &&'],
  ['execution-conflict','packages/core/src/prompt-submission.ts',"(previous.intent.execution ?? 'default') !== execution","false"],
  ['native-turn-binding','packages/core/src/prompt-submission.ts','evidence.sourceId !== prepared.nativeSourceId || evidence.nativeTurnId !== prepared.nativeTurnId','false'],
  ['full-draft','packages/core/src/providers/codex-prompt-execution.ts',"if (composer.cells.slice(markerColumn + 2).some(cell => cell.chars.trim() && !cell.dim)) return 'unavailable'","if (false) return 'unavailable'"],
  ['native-session-binding','packages/core/src/providers/codex-prompt-execution-evidence.ts',"if (meta.type !== 'session_meta' || (meta.payload?.session_id ?? meta.payload?.id) !== handle.sessionId) return null","if (meta.type !== 'session_meta') return null"],
  ['checkpoint-screen-attributes','packages/core/src/screen-evidence.ts','else built.accept(step)',"else if (step.type !== 'restore') built.accept(step)"],
  ['checkpoint-frame-proof','packages/core/src/screen-evidence.ts','built.seedFrameEvidence(chunks, fence)','/* deliberately omit the real frame proof */'],
  ['transport-source-binding','packages/core/src/prompt-submission.ts','provider.verifyPromptExecutionTransport && transportEvidence?.sourceId !== nativeEvidence?.sourceId','false'],
  ['transport-boundary','packages/core/src/prompt-submission.ts','provider.verifyPromptExecutionTransport && !await provider.verifyPromptExecutionTransport({ ...nativeContext,','false && !await provider.verifyPromptExecutionTransport({ ...nativeContext,'],
  ['cold-resize-old-frame','packages/core/src/screen-evidence.ts','frameFence?.resizeRevision === continuation.checkpoint.resizeRevision','true'],
  ['external-resize-generation','packages/core/src/screen-evidence.ts','if (evidence && !evidence.failed) this.generations.set','if (false) this.generations.set'],
  ['ordinary-after-refresh-recovery','packages/core/src/prompt-submission.ts','(!refreshOnlySettled && !submitRejected)','(!submitRejected)'],
  ['refresh-ack-persistence','packages/core/src/prompt-submission.ts','frameRefresh: { ...frozen, acknowledged: true }','frameRefresh: { ...frozen, acknowledged: false }']
 ]
 assert(mutations.length>=7)
 for(const [name,file,before,after]of mutations){await qualifySharedMainSource(root,selectedSource,report.sourceQualification?.commit);const path=join(root,file),source=await readFile(path,'utf8');assert.equal(source.split(before).length-1,1,`Mutation must have one exact production target: ${name}`)
  let red
  try{await writeFile(path,source.replace(before,after));red=await tests().then(result=>({...result,code:0}),error=>error);assert.notEqual(red.code,0,`Survived production mutation ${name}`);assert(/\d+ failed|FAIL\s+packages\/core\/test\/immediate/u.test(red.stdout+red.stderr),`Mutation did not reach an owning assertion ${name}`)}finally{await writeFile(path,source)}
  const restored=await tests();assert(/30 passed/.test(restored.stdout));report.mutations.push({name,result:'RED/restore GREEN'});await writeFile(join(evidence,name+'.log'),(red.stdout??'')+(red.stderr??''))
 }
 }
 // Restore source build identity after mutations; compilation is also the production
 // package consumed by the isolated native fixture.
 await qualifySharedMainSource(root,selectedSource,report.sourceQualification?.commit)
 await run([join(core,'scripts/build.mjs')])
 if(args.includes('--native')){
  const native=await run([join(core,'test/fixtures/immediate-native-worker.mjs'),evidence],{timeout:90_000});await writeFile(join(evidence,'native.log'),native.stdout+native.stderr);const proof=JSON.parse(await readFile(join(evidence,'native-proof.json'),'utf8'));assert(proof.passed&&proof.cleanup.privateRunStopped&&proof.cleanup.privateDaemonStopped);report.native=proof
  const remoteEvidence=join(evidence,'native-remote-daemon');await mkdir(remoteEvidence,{recursive:true})
  const remote=await run([join(core,'test/fixtures/immediate-native-worker.mjs'),remoteEvidence],{timeout:90_000,env:{...process.env,AGENTMUX_PROBE_PRIVATE_DAEMON:'1'}});await writeFile(join(remoteEvidence,'native.log'),remote.stdout+remote.stderr)
  const remoteProof=JSON.parse(await readFile(join(remoteEvidence,'native-proof.json'),'utf8'));assert(remoteProof.passed&&remoteProof.cleanup.privateRunStopped&&remoteProof.cleanup.privateDaemonStopped&&remoteProof.cleanup.privateCodexDaemonStopped);report.remoteNative=remoteProof
 }
 report.passed=true
}catch(error){report.failure={message:error.message,...(error.stdout?{output:error.stdout}:{}),...(error.stderr?{stderr:error.stderr}:{})};throw error}
finally{await writeFile(join(evidence,'verification.json'),JSON.stringify(report,null,2)+'\n')}
console.log(JSON.stringify({passed:report.passed,tests:report.tests,mutations:report.mutations.length,native:!!report.native,evidence}))

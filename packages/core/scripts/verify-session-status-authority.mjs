import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, '.local/state/session-status-diagnosis/status-implementation')
await mkdir(evidence, { recursive: true })
const config = resolve(evidence, 'source-vitest.config.mts')
await writeFile(config, `import { defineConfig } from 'vitest/config';import { readFileSync,existsSync } from 'node:fs';import { resolve } from 'node:path';
const pkg=JSON.parse(readFileSync('packages/core/package.json','utf8'));
const alias=Object.entries(pkg.exports).flatMap(([key,value])=>{const replacement=resolve('packages/core',value.import.replace('./dist/','src/').replace(/\\.js$/,'.ts'));return existsSync(replacement)?[{find:key==='.'?'@agentmux/core':'@agentmux/core'+key.slice(1),replacement}]:[]}).sort((a,b)=>b.find.length-a.find.length);alias.unshift({find:'@agentmux/demand/goals',replacement:resolve('packages/demand/src/goals.ts')});
export default defineConfig({resolve:{alias},define:{__AGENTMUX_WEB_PREVIEW__:'true'},test:{include:['packages/core/test/session-status-authority.test.ts','packages/core/test/hook-after-turn-end.test.ts','packages/core/test/agent-semantic-state-entry.test.ts'],setupFiles:[resolve('vitest.setup.ts')],testTimeout:20000}});`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const cases = [
  { id:'retired-target-evidence', path:'packages/core/src/agent-session-store.ts', old:'...(observed === undefined ? {} : { observedNativeHandle: observed })', next:'...{}', test:'retirement preserves a known locator mismatch' },
  { id:'consumed-idle-projection', path:'packages/core/src/agent-status-freshness.ts', old:"if (status.state === 'done' && status.idleEvidenceConsumed)", next:"if (false && status.state === 'done' && status.idleEvidenceConsumed)", test:'consumes current idle' },
  { id:'child-activity-clock', path:'packages/core/src/client.ts', old:'aggregateActivityAt: normalized.status.observedAt', next:'aggregateActivityAt: 0', test:'fresh child work contributes' },
  { id:'child-membership', path:'packages/core/src/providers/codex.ts', old:"childId !== main.sessionId && context.processNativeChildSessionIds?.includes(childId) ? 'child'", next:"childId !== main.sessionId ? 'child'", test:'an unconfirmed child' },
  { id:'resume-target-protection', path:'packages/core/src/client.ts', old:"const protectedTarget = session.reopenedFrom !== undefined || session.nativeBinding?.source === 'semantic-resume-target'", next:'const protectedTarget = false', test:'never redirects an explicit Level B' },
  { id:'legacy-locator-retention', path:'packages/core/src/client.ts', old:"const canPromoteLocator = !witnessTargetMismatch || (!protectedTarget && session.nativeBinding?.source === 'native-hook' && sameRun(session.nativeBinding.run, session.run))", next:'const canPromoteLocator = true', test:'process witness admits the actual main' },
  { id:'renderer-consumption', path:'apps/desktop/src/renderer/src/lib/session-state.ts', old:' || currentActivityAdvanced', next:'', test:'first child activity followed by ACK' },
  { id:'main-consumption', path:'apps/desktop/src/main/runtime-controller.ts', old:'const semantic = currentAgentSemanticStatus(semanticFacts)', next:'const semantic = semanticFacts', test:'actual Main snapshot and Renderer' },
  { id:'public-hook-decision', path:'packages/core/src/agent-session-store.ts', old:'...(source.decision === undefined ? {} : { decision:', next:'...(true ? {} : { decision:', test:'consumes current idle' }
]
const reviewCases = [
  { id:'locator-success-diagnostic', path:'packages/core/src/client.ts', old:'if (witness.handle && next.nativeHandle && witness.handle.sessionId !== next.nativeHandle.sessionId)', next:'if (witnessTargetMismatch)', test:'public locator provenance' },
  { id:'foreign-locator-observation', path:'packages/core/src/client.ts', old:'witness.handle && witnessTargetMismatch && !(canPromoteLocator && normalized.nativeHandle)', next:'witness.handle && !canPromoteLocator', test:'public locator provenance' },
  { id:'current-activity-input-order', path:'packages/core/src/agent-semantic-state.ts', old:'currentActivityRevision: (status.currentActivityRevision ?? 0) + 1', next:'currentActivityRevision: status.currentActivityRevision ?? 0', test:'first child activity followed by ACK' },
  { id:'current-activity-child-order', path:'packages/core/src/client.ts', old:'currentActivityRevision: (current.semanticStatus?.currentActivityRevision ?? 0) + 1', next:'...{}', test:'first child activity followed by ACK' },
  { id:'current-activity-main-order', path:'packages/core/src/agent-semantic-state.ts', old:'currentActivityRevision: previous.currentActivityRevision + 1', next:'currentActivityRevision: previous.currentActivityRevision', test:'first child activity followed by ACK' },
  { id:'current-activity-stale-order', path:'apps/desktop/src/renderer/src/lib/session-state.ts', old:'if (sameRun(session.control.run, incoming.run) &&\n    (incoming.semanticStatus?.currentActivityRevision ?? 0) < (session.semanticStatus?.currentActivityRevision ?? 0)) return false', next:'if (false) return false', test:'first child activity followed by ACK' },
  { id:'public-current-activity-order', path:'packages/core/src/agent-session-store.ts', old:"...(source.currentActivityRevision === undefined ? {} : { currentActivityRevision: positiveInteger(source.currentActivityRevision, 'semanticStatus.currentActivityRevision') }),", next:'...{},', test:'first child activity followed by ACK' },
  { id:'native-binding-lifecycle-clock', path:'packages/core/src/client.ts', old:"nativeBinding: { source: 'semantic-resume-target', run: runRef(run.runId), observedAt: nativeBindingObservedAt }", next:"nativeBinding: { source: 'semantic-resume-target', run: runRef(run.runId), observedAt: current.updatedAt }", test:'public lifecycle target provenance' },
  { id:'native-binding-reconcile-clock', path:'packages/core/src/client.ts', old:"nativeBinding: { source: 'semantic-resume-target' as const, run: runRef(run.runId), observedAt: nativeBindingObservedAt }", next:"nativeBinding: { source: 'semantic-resume-target' as const, run: runRef(run.runId), observedAt: retirement.observedAt }", test:'public lifecycle target provenance' },
  { id:'first-witness-cancellation', path:'packages/core/src/client.ts', old:'const before = await this.observeHookRun(session.run.runId, signal)', next:'const before = await this.kernel.status(session.run.runId)', test:'abandoned witness status 1' },
  { id:'second-witness-cancellation', path:'packages/core/src/client.ts', old:'const after = await this.observeHookRun(session.run.runId, signal)', next:'const after = await this.kernel.status(session.run.runId)', test:'abandoned witness status 2' }
]
const providerCases = [
  { id:'native-subject-basis-honesty', path:'packages/core/src/hook-normalizer.ts', old:"currentHandle ? 'native-session-match' : 'native-session-first-observation'", next:"currentHandle ? 'declared-main-subject' : 'declared-main-subject'", test:'native identity changes require declared membership' },
  { id:'known-native-transition-qualification', path:'packages/core/src/hook-normalizer.ts', old:'specification.matchesNativeSession?.(eventName, rawPayload, context) ?? !knownLocatorChanged', next:'specification.matchesNativeSession?.(eventName, rawPayload, context) ?? true', test:'native identity changes require declared membership' },
  { id:'protected-native-target-normalization', path:'packages/core/src/hook-normalizer.ts', old:'const nativeSessionMatches = !protectedTargetMismatch && (declaredSubject', next:'const nativeSessionMatches = (declaredSubject', test:'explicit Provider native transitions' },
  { id:'protected-native-target-context', path:'packages/core/src/client.ts', old:'...(protectedTarget ? { protectedNativeTarget: true } : {}),', next:'...{},', test:'explicit Provider native transitions' },
  { id:'protected-native-target-provenance', path:'packages/core/src/client.ts', old:"source: protectedTarget ? 'semantic-resume-target' as const : witness.handle ? 'process-witness' as const : 'native-hook' as const", next:"source: witness.handle ? 'process-witness' as const : 'native-hook' as const", test:'native identity changes require declared membership' },
  { id:'same-native-path-preservation', path:'packages/core/src/client.ts', old:"...(normalized.nativeHandle.kind === 'provider' && current.nativeHandle?.kind === 'provider' &&\n              normalized.nativeHandle.sessionId === current.nativeHandle.sessionId && normalized.nativeHandle.transcriptPath === undefined &&\n              current.nativeHandle.transcriptPath ? { transcriptPath: current.nativeHandle.transcriptPath } : {})", next:'...{}', test:'explicit Provider native transitions' },
  { id:'protected-native-adapter-output', path:'packages/core/src/client.ts', old:'if (protectedTarget && normalized.nativeHandle && session.nativeHandle && (', next:'if (false && protectedTarget && normalized.nativeHandle && session.nativeHandle && (', test:'Core rejects adapter output' },
  { id:'explicit-provider-transition-preserved', path:'packages/core/src/hook-normalizer.ts', old:'specification.matchesNativeSession?.(eventName, rawPayload, context) ?? !knownLocatorChanged', next:'!knownLocatorChanged', test:'explicit Provider native transitions' }
]

const allCases = [...cases, ...reviewCases, ...providerCases]

const paths = [...new Set(allCases.map(item=>item.path).concat(['packages/core/src/types.ts','packages/core/src/agent-provider.ts','packages/core/src/hook-normalizer.ts','packages/core/src/agent-semantic-state.ts','packages/core/src/providers/codex-native-session.ts','packages/core/test/session-status-authority.test.ts','packages/core/test/agent-semantic-state-entry.test.ts','packages/core/scripts/verify-session-status-authority.mjs']))]
const originals = new Map(await Promise.all(paths.map(async path=>[path,await readFile(resolve(root,path))])))
const sourceHashes = Object.fromEntries([...originals].map(([path,bytes])=>[path,hash(bytes)]))
const proofPrefix=process.argv.includes('--provider-delta')?'provider-delta-':''
async function run(id, target) {
  const report=resolve(evidence,`${proofPrefix}${id}.json`), log=resolve(evidence,`${proofPrefix}${id}.log`)
  const args=['node_modules/vitest/vitest.mjs','run','--config',config,'--maxWorkers=1','--reporter=json','--outputFile='+report,...(target?['-t',target]:[])]
  const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',env:{...process.env,AGENTMUX_STATUS_PROOF_FILE:resolve(evidence,proofPrefix+id+'-process.json')},timeout:60000,maxBuffer:8*1024*1024})
  await writeFile(log,(result.stdout??'')+(result.stderr??''))
  if (result.error) throw result.error
  const json=JSON.parse(await readFile(report,'utf8'))
  const assertions=json.testResults.flatMap(file=>file.assertionResults??[])
  const collected=assertions.filter(item=>item.status==='passed'||item.status==='failed')
  const failed=collected.filter(item=>item.status==='failed')
  return { command:[process.execPath,...args], exitCode:result.status, collected:collected.length, assertions:failed.map(item=>({name:item.fullName,messages:item.failureMessages})), passed:result.status===0&&collected.length>0&&json.numPassedTests===collected.length&&json.numFailedTests===0 }
}
const reasonOnly = process.argv.includes('--reason-only')
const reviewDelta = process.argv.includes('--review-delta')
const providerDelta = process.argv.includes('--provider-delta')
let inherited
if (reasonOnly) {
  const previous = JSON.parse(await readFile(resolve(evidence,'before-reason-source-mutations.json'),'utf8'))
  const delta = JSON.parse(await readFile(resolve(evidence,'reason-delta.json'),'utf8'))
  if (!previous.passed || previous.mutations.length !== cases.length || !previous.mutations.every(item=>item.red&&item.green&&item.restored)) throw new Error('Prior proof incomplete')
  for (const [path,sha] of Object.entries(previous.sourceHashes)) {
    const bytes = await readFile(resolve(root,path)), change = delta.files[path]
    if (!change) { if (hash(bytes)!==sha) throw new Error('Changed branch outside reason delta: '+path); continue }
    const text=bytes.toString('utf8')
    if (hash(bytes)!==change.afterSha256 || change.beforeSha256!==sha || text.split(change.new).length!==2 ||
      hash(Buffer.from(text.replace(change.new,change.old)))!==sha) throw new Error('Reason delta does not reconstruct qualified source: '+path)
  }
  inherited={previousReceipt:'before-reason-source-mutations.json', previousReceiptSha256:hash(await readFile(resolve(evidence,'before-reason-source-mutations.json'))), delta,
    explanation:'Prior nine actual assertion RED/restored GREEN receipts are retained; exact reverse of the only decision-reason/test delta reconstructs every old qualified source byte. The affected public decision branch is additionally mutated on current source.', mutations:previous.mutations}
}
if (reviewDelta || providerDelta) {
  const previousFile=providerDelta?'before-provider-source-mutations.json':'before-provenance-source-mutations.json'
  const previousBytes=await readFile(resolve(evidence,previousFile))
  const previous=JSON.parse(previousBytes), delta=JSON.parse(await readFile(resolve(evidence,providerDelta?'provider-delta.json':'review-delta.json'),'utf8'))
  if (!previous.passed || previous.mutations.length!==(providerDelta?26:10) || !previous.mutations.every(item=>item.red&&item.green&&item.restored)) throw new Error('Prior review baseline is incomplete')
  for (const [path,sha] of Object.entries(previous.sourceHashes)) {
    const bytes=await readFile(resolve(root,path)), change=delta.files[path]
    if (!change) { if(hash(bytes)!==sha) throw new Error('Source changed outside review delta: '+path); continue }
    if (hash(bytes)!==change.afterSha256 || change.beforeSha256!==sha) throw new Error('Review delta SHA mismatch: '+path)
    let restored=bytes
    for(const edit of [...change.edits].sort((a,b)=>b.afterStartByte-a.afterStartByte)) {
      const next=Buffer.from(edit.newBase64,'base64'), old=Buffer.from(edit.oldBase64,'base64'), start=edit.afterStartByte
      if(!restored.subarray(start,start+next.length).equals(next)) throw new Error('Review delta byte range mismatch: '+path)
      restored=Buffer.concat([restored.subarray(0,start),old,restored.subarray(start+next.length)])
    }
    if(hash(restored)!==sha) throw new Error('Review delta cannot reconstruct prior qualified source: '+path)
  }
  inherited={previousReceipt:previousFile,previousReceiptSha256:hash(previousBytes),delta,mutations:previous.mutations,
    explanation:providerDelta?'Retain prior 26 real assertion RED/exact restored GREEN receipts through exact byte reversal. Re-execute the affected existing resume guard and the eight new cross-Provider qualification/provenance/output branches; unchanged activity/witness guards are not repeated.':'Retain prior ten real assertion RED/exact restored GREEN receipts. Exact byte reversal binds current reviewed deltas to every qualified source SHA. Re-execute the five affected original guards plus each newly reviewed production branch; unchanged guards are not repeated.'}
}
const affected=new Set(['consumed-idle-projection','child-activity-clock','resume-target-protection','legacy-locator-retention','renderer-consumption'])
const selectedCases=providerDelta ? [...cases.filter(item=>item.id==='resume-target-protection'),...providerCases] : reviewDelta ? [...cases.filter(item=>affected.has(item.id)),...reviewCases] : reasonOnly ? cases.filter(item=>item.id==='public-hook-decision').map(item=>({...item,test:'public observation explains neutral main'})) : allCases
const mutations=[]
let baseline
try {
  baseline=await run('baseline')
  if(!baseline.passed) throw new Error('Baseline is not nonempty GREEN')
  for(const item of selectedCases) {
    const original=originals.get(item.path), text=original.toString('utf8')
    if(text.split(item.old).length!==2) throw new Error(`Mutation anchor must occur once: ${item.id}`)
    let red,green,restored
    try {
      await writeFile(resolve(root,item.path),text.replace(item.old,item.next))
      const mutatedSha=hash(await readFile(resolve(root,item.path)))
      red=await run(item.id+'-red',item.test)
      if(red.exitCode===0||red.collected===0||red.assertions.length===0||!red.assertions.every(assertion=>assertion.messages.some(message=>/AssertionError|expected .* to|toMatchObject|toBe\(/s.test(message)))) throw new Error(`No actual assertion RED: ${item.id}`)
      red.sourceSha256=mutatedSha
    } finally {
      await writeFile(resolve(root,item.path),original)
      restored=hash(await readFile(resolve(root,item.path)))===sourceHashes[item.path]
      if(!restored) throw new Error(`Exact byte restore failed: ${item.id}`)
    }
    green=await run(item.id+'-green',item.test)
    if(!green.passed) throw new Error(`Restored behavior is not GREEN: ${item.id}`)
    mutations.push({id:item.id,path:item.path,red:true,green:true,restored,originalSha256:sourceHashes[item.path],redReceipt:red,greenReceipt:green})
  }
  const final=await run('restored-final')
  const processProof=JSON.parse(await readFile(resolve(evidence,proofPrefix+'restored-final-process.json'),'utf8'))
  if(processProof.userRuntimeTouched!==false||processProof.privateFixtures.length===0||processProof.cleanup.remaining.length!==0) throw new Error('Private process proof/cleanup incomplete')
  if(!final.passed) throw new Error('Restored suite is not GREEN')
  const callers=[
    {producer:'client.acceptHookEvent',consumer:'statusAgent',proof:'authenticated HTTP/native OS process fixture → public semantic observation'},
    {producer:'Provider native identity normalization',consumer:'client.acceptHookEvent → public Session/RPC receipt',proof:'actual Claude snake/Copilot camel ingress: unknown target change preserves main permission/usage/activity/locator and raw input; Pi declared ordinary transition stays legal, explicit target and invalid adapter output are refused'},
    {producer:'Provider.discoverNativeSession',consumer:'Codex.resolveSubject',proof:'real private opened main/descendant native record membership; no user Runtime'},
    {producer:'client.writeAgent',consumer:'invalidateAgentIdleEvidence → currentAgentSemanticStatus',proof:'ACK cannot manufacture working; main completion identity retained'},
    {producer:'prompt-submission.claimInput',consumer:'invalidateAgentIdleEvidence',proof:'agent-semantic-state-entry public typed first claim / failed claim / newer epoch'},
    {producer:'AgentSessionStore',consumer:'parseRpcAgentSession',proof:'public accepted receipt subject/decision retained through normalization'},
    {producer:'Core Session facts',consumer:'RuntimeController.snapshot → projectRuntimeEvent',proof:'actual loaded cold/live Stop→child→ACK and repeated consumed→child→ACK; equal native clock, older activity revisions and disconnected remain protected; original layouts retained'}
  ]
  const restored=await Promise.all(paths.map(async path=>hash(await readFile(resolve(root,path)))===sourceHashes[path]))
  if(mutations.length!==selectedCases.length||!restored.every(Boolean)||!callers.length) throw new Error('Incomplete qualification')
  await writeFile(resolve(evidence,'source-mutations.json'),JSON.stringify({passed:true,userRuntimeTouched:false,sourceMode:'actual source modules; SDK Run receipts are private fixture boundary; OS witness is real',sourceHashes,baseline,final,processProof,callers,inheritedProof:inherited,mutations:inherited ? [...inherited.mutations, ...mutations.map(item=>({...item,id:item.id+(providerDelta?'-provider-delta':reviewDelta?'-review-delta':'-reason-delta')}))] : mutations,cleanup:{privateProcessFixtures:'all owned processes terminated by test finally; temporary native records removed',sourceRestored:true}},null,2)+'\n')
  console.log(JSON.stringify({passed:true,tests:final.collected,mutations:(inherited?.mutations.length??0)+mutations.length,callers:callers.length,receipt:resolve(evidence,'source-mutations.json')}))
} finally {
  for(const path of new Set(allCases.map(item=>item.path))) await writeFile(resolve(root,path),originals.get(path))
}

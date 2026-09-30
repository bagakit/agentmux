import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const root=path.resolve(import.meta.dirname,'../../..')
const index=process.argv.indexOf('--proof');assert.ok(index>0,'--proof required')
const file=path.resolve(root,process.argv[index+1]);const read=p=>JSON.parse(fs.readFileSync(path.resolve(root,p),'utf8'))
const proof=read(file),hash=p=>createHash('sha256').update(fs.readFileSync(path.resolve(root,p))).digest('hex')
assert.equal(proof.schema,'agentmux.conversation-native-reasoning-qualification.v1')
assert.ok(Object.keys(proof.sources).length>0)
for(const [p,sha] of Object.entries(proof.sources))assert.equal(hash(p),sha,'Stable owned input '+p)
const importing=fs.readFileSync(path.resolve(root,proof.styleImport.path),'utf8');assert.equal(importing.split(proof.styleImport.text).length,2,'Unique actual style import')
function assertions(p){const result=read(p);const cases=result.testResults.flatMap(x=>x.assertionResults);assert.ok(cases.length>0,'Nonempty collected cases '+p);return {result,cases}}
for(const p of Object.values(proof.tests)){const {result,cases}=assertions(p);assert.equal(result.success,true,p);assert.equal(cases.filter(x=>x.status==='passed').length,cases.length,p)}
const baseline=assertions(proof.tests.baseline).cases.map(x=>x.fullName);assert.ok(baseline.length>0)
assert.deepEqual(assertions(proof.tests.restored).cases.map(x=>x.fullName),baseline,'Exact restored collection')
assert.ok(proof.mutants.length>=4)
for(const mutation of proof.mutants){const {result,cases}=assertions(mutation.report);assert.equal(result.success,false,mutation.name);assert.deepEqual(cases.map(x=>x.fullName),baseline);const failures=cases.filter(x=>x.status==='failed');assert.ok(failures.length>0);for(const failed of failures)assert.ok(failed.failureMessages.some(x=>x.includes('AssertionError')),'Not runtime/setup RED '+mutation.name);const loaded=fs.readFileSync(path.resolve(root,mutation.loaded),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.ok(loaded.length>0);const changed=loaded.filter(x=>x.mutation===mutation.name);assert.equal(changed.length,1,'Exactly one actual consumed mutant '+mutation.name);assert.notEqual(changed[0].sha256,changed[0].originalSHA256);assert.equal(changed[0].originalSHA256,proof.sources[changed[0].path],'Owned actual mutant input')}
for(const p of proof.types){const r=read(p);assert.equal(r.exitCode,0,p);assert.equal(r.cwd,root);assert.ok(r.argv.includes('--noEmit'));assert.ok(r.argv.includes('-p'));assert.ok(fs.existsSync(path.resolve(root,r.log)))}
assert.ok(proof.callers.length>0)
for(const caller of proof.callers){const source=fs.readFileSync(path.resolve(root,caller.path),'utf8');assert.ok(!caller.path.includes('/test/'));if(caller.symbol==='useSessionUserMessages')assert.ok(source.includes('} = useSessionUserMessages('));else if(caller.symbol==='ConversationNativeReasoning'||caller.symbol==='ConversationReasoningTrace')assert.ok(source.includes('<'+caller.symbol));else assert.ok(source.includes(caller.symbol))}
const compiled=read(proof.compiled);assert.ok(compiled.loaded.length>0);for(const p of ['apps/desktop/src/renderer/src/components/ActivityView.tsx','apps/desktop/src/renderer/src/components/ConversationNativeReasoning.tsx','apps/desktop/src/renderer/src/styles/conversation-native-reasoning.css'])assert.ok(compiled.loaded.some(x=>x.path===p&&x.sha256===proof.sources[p]),'Actual compiled owned input '+p)
const actions=read(proof.actions);assert.equal(actions.passed,true);assert.equal(actions.frames.length,8);for(const frame of actions.frames){assert.equal(Math.round(frame.reading.width),frame.name.startsWith('wide')?1000:332);assert.deepEqual(frame.controls,[]);assert.equal(frame.draft,'Keep the original unsent reply draft.')}
const review=read(proof.visualReview);assert.equal(review.passed,true);assert.ok(review.reviewer);assert.equal(proof.images.length,8);assert.equal(review.images.length,8)
for(const p of proof.images){assert.ok(fs.statSync(path.resolve(root,p)).size>0);assert.ok(review.images.some(x=>x.path===p&&x.sha256===hash(p)),'Actual viewed image '+p)}
console.log(JSON.stringify({passed:true,sourceInputs:Object.keys(proof.sources).length,owning:baseline.length,mutants:proof.mutants.length,compiledInputs:compiled.loaded.length,images:proof.images.length,scope:proof.scope},null,2))

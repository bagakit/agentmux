import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
const root=path.resolve(import.meta.dirname,'../../..'),index=process.argv.indexOf('--proof')
assert.ok(index>0,'--proof required')
const read=p=>JSON.parse(fs.readFileSync(path.resolve(root,p),'utf8'))
const hash=p=>createHash('sha256').update(fs.readFileSync(path.resolve(root,p))).digest('hex')
const digest=text=>createHash('sha256').update(text).digest('hex')
const proof=read(process.argv[index+1]);assert.equal(proof.schema,'agentmux.conversation-workflow-observation-qualification.v1')
assert.ok(Object.keys(proof.sources).length>0)
for(const [p,sha]of Object.entries(proof.sources))assert.equal(hash(p),sha,'Stable owning input '+p)
const activity=fs.readFileSync(path.resolve(root,proof.activityOwnership.path),'utf8')
function fragment(source,from,to){const start=source.indexOf(from),end=source.indexOf(to,start);assert.ok(start>=0&&end>start,'Nonempty actual owning source span');return source.slice(start,end)}
for(const owned of proof.activityOwnership.fragments)assert.equal(digest(fragment(activity,owned.from,owned.to)),owned.sha256,'Stable owned Activity span')
assert.ok(activity.length>1000);assert.ok(!activity.includes('timelineRows'))
for(const p of proof.removed)assert.equal(fs.existsSync(path.resolve(root,p)),false,'Removed false dedup helper '+p)
function cases(p){const d=read(p),xs=d.testResults.flatMap(x=>x.assertionResults);assert.ok(xs.length>0,'Actual nonempty collection '+p);return{d,xs}}
for(const p of Object.values(proof.tests)){const{d,xs}=cases(p);assert.equal(d.success,true,p);assert.deepEqual(xs.map(x=>x.status),Array(xs.length).fill('passed'),p)}
const names=cases(proof.tests.baseline).xs.map(x=>x.fullName);assert.deepEqual(cases(proof.tests.restored).xs.map(x=>x.fullName),names)
assert.ok(proof.mutants.length>=3)
for(const mutant of proof.mutants){const{d,xs}=cases(mutant.report);assert.equal(d.success,false,mutant.name);assert.deepEqual(xs.map(x=>x.fullName),names);const failures=xs.filter(x=>x.status==='failed');assert.ok(failures.length>0);for(const item of failures)assert.ok(item.failureMessages.some(x=>x.includes('AssertionError')),'Actual assertion, not setup/runtime '+mutant.name);const loaded=fs.readFileSync(path.resolve(root,mutant.loaded),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.ok(loaded.length>0);const changed=loaded.filter(x=>x.mutation===mutant.name);assert.equal(changed.length,1);assert.notEqual(changed[0].sha256,changed[0].originalSHA256);if(changed[0].path===proof.activityOwnership.path)assert.equal(changed[0].ownedSHA256,proof.activityOwnership.fragments.find(x=>x.label==='Row/Run').sha256);else assert.equal(changed[0].originalSHA256,proof.sources[changed[0].path])}
for(const p of proof.types){const r=read(p);assert.equal(r.exitCode,0);assert.equal(r.cwd,root);assert.ok(r.argv.includes('--noEmit')&&r.argv.includes('-p'));assert.ok(fs.existsSync(path.resolve(root,r.log)))}
assert.ok(proof.callers.length>0)
for(const call of proof.callers){assert.notEqual(call.path,call.definition);assert.ok(!call.path.includes('/test/'));const source=fs.readFileSync(path.resolve(root,call.path),'utf8');assert.ok(source.includes('<'+call.symbol),'Actual non-definition caller '+call.symbol)}
const compiled=read(proof.compiled);assert.ok(compiled.loaded.length>0)
for(const p of ['apps/desktop/src/renderer/src/components/workflow/WorkflowCard.tsx','apps/desktop/src/renderer/src/components/workflow/WorkflowToolRow.tsx','apps/desktop/src/renderer/src/styles/workflow.css'])assert.ok(compiled.loaded.some(x=>x.path===p&&x.sha256===proof.sources[p]),'Actual compiled source '+p)
const compiledActivity=fs.readFileSync(path.resolve(root,proof.compiledActivity),'utf8');assert.ok(compiled.loaded.some(x=>x.path===proof.activityOwnership.path&&x.sha256===digest(compiledActivity)))
for(const owned of proof.activityOwnership.fragments)assert.equal(digest(fragment(compiledActivity,owned.from,owned.to)),owned.sha256,'Actual compiled owned span '+owned.label)
const sample=read(proof.publicSample);assert.ok(sample.snapshot.items.length>0);const rawIds=sample.snapshot.items.filter(x=>x.kind==='tool_call').map(x=>x.id);assert.ok(rawIds.length>10)
const actions=read(proof.actions);assert.equal(actions.passed,true);assert.equal(actions.frames.length,8)
for(const frame of actions.frames){assert.equal(Math.round(frame.reading.width),frame.name.startsWith('wide')?1000:332);assert.deepEqual(frame.controls,[]);assert.equal(frame.draft,'Keep the original unsent reply draft.')}
for(const name of ['wide-all','narrow-all'])assert.deepEqual(actions.frames.find(x=>x.name===name).ids,rawIds,'Exact all raw IDs in original order '+name)
const review=read(proof.visualReview);assert.equal(review.passed,true);assert.ok(review.reviewer);assert.equal(proof.images.length,8);assert.equal(review.images.length,8)
for(const p of proof.images){assert.ok(fs.statSync(path.resolve(root,p)).size>0);assert.ok(review.images.some(x=>x.path===p&&x.sha256===hash(p)),'Actual independently viewed PNG '+p)}
console.log(JSON.stringify({passed:true,owning:names.length,mutants:proof.mutants.length,sourceInputs:Object.keys(proof.sources).length,compiledInputs:compiled.loaded.length,images:proof.images.length,scope:proof.scope},null,2))

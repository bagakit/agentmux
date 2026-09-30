import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
const root=path.resolve(import.meta.dirname,'../../..')
const index=process.argv.indexOf('--proof');assert.ok(index>0,'--proof required')
const resolve=p=>path.resolve(root,p),read=p=>JSON.parse(fs.readFileSync(resolve(p),'utf8'))
const hash=p=>createHash('sha256').update(fs.readFileSync(resolve(p))).digest('hex')
const proof=read(process.argv[index+1]);assert.equal(proof.schema,'agentmux.conversation-native-record-order-qualification.v1')
assert.ok(Object.keys(proof.sources).length>0,'Nonempty owned source inputs')
for(const [file,sha] of Object.entries(proof.sources))assert.equal(hash(file),sha,'Exact owned input '+file)
assert.ok(Array.isArray(proof.sourceSeams)&&proof.sourceSeams.length>0,'Nonempty owned notice seams')
const seamReview=read(proof.seamReview);assert.equal(seamReview.passed,true);assert.ok(seamReview.reviewer)
for(const seam of proof.sourceSeams){
 const tested=fs.readFileSync(resolve(seam.testedSource),'utf8'),current=fs.readFileSync(resolve(seam.path),'utf8')
 assert.equal(hash(seam.testedSource),seam.testedFileSHA256,'Original actually tested full Source retained')
 const slice=source=>{const start=source.indexOf(seam.start),end=source.indexOf(seam.end,start);assert.ok(start>=0&&end>start,'Real nonempty notice anchors');assert.equal(source.indexOf(seam.start,start+1),-1,'Unique notice start');assert.equal(source.indexOf(seam.end,end+1),-1,'Unique notice end');return source.slice(start,end)}
 const original=slice(tested),owned=slice(current);assert.ok(owned.length>0);assert.equal(owned,original,'Exact tested native notice fields')
 assert.equal(createHash('sha256').update(owned).digest('hex'),seam.sha256)
 const fields=[...owned.matchAll(/^\s+(\w+):/gm)].map(match=>match[1]);assert.equal(fields.length,seam.fieldCount);assert.ok(fields.length>0);assert.deepEqual(fields,seam.fields)
 assert.equal(seamReview.testedCommit,seam.testedCommit);assert.equal(seamReview.ownedSeamSHA256,seam.sha256)
}
assert.equal(fs.readFileSync(resolve(proof.styleImport.path),'utf8').split(proof.styleImport.text).length,2,'Unique real CSS import')
function cases(file){const report=read(file),tests=report.testResults.flatMap(result=>result.assertionResults);assert.ok(tests.length>0,'Nonempty collected '+file);return {report,tests}}
for(const file of Object.values(proof.tests)){const {report,tests}=cases(file);assert.equal(report.success,true,file);assert.equal(tests.filter(test=>test.status==='passed').length,tests.length,file)}
const baseline=cases(proof.tests.baseline).tests.map(test=>test.fullName)
assert.deepEqual(cases(proof.tests.restored).tests.map(test=>test.fullName),baseline,'Exact restored collection')
assert.ok(proof.mutants.length>=3)
for(const mutant of proof.mutants){
 const {report,tests}=cases(mutant.report);assert.equal(report.success,false,mutant.name);assert.deepEqual(tests.map(test=>test.fullName),baseline,'Exact mutant collection '+mutant.name)
 const failures=tests.filter(test=>test.status==='failed');assert.ok(failures.length>0,mutant.name)
 for(const failure of failures)assert.ok(failure.failureMessages.some(message=>message.includes('AssertionError')),'Actual semantic AssertionRED '+mutant.name)
 const loaded=fs.readFileSync(resolve(mutant.loaded),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(loaded.length>0)
 const changed=loaded.filter(item=>item.mutation===mutant.name);assert.equal(changed.length,1,'One actual consumed mutant '+mutant.name)
 assert.notEqual(changed[0].sha256,changed[0].originalSHA256);assert.equal(changed[0].originalSHA256,proof.sources[changed[0].path],'Exact actual input '+mutant.name)
}
const loaded=fs.readFileSync(resolve(proof.loadedBaseline),'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.ok(loaded.length>0)
for(const file of proof.requiredLoaded){assert.ok(loaded.some(item=>item.path===file&&item.bytes>0),'Actual production reader/caller '+file)}
for(const type of proof.types){const result=read(type);assert.equal(result.exitCode,0);assert.equal(result.cwd,root);assert.ok(result.argv.includes('--noEmit'));assert.ok(result.argv.includes('-p'));assert.ok(fs.existsSync(resolve(result.log)))}
assert.ok(proof.callers.length>0)
for(const caller of proof.callers){assert.notEqual(caller.path,caller.definition);assert.ok(!caller.path.includes('/test/'));assert.ok(fs.readFileSync(resolve(caller.path),'utf8').includes(caller.call),'Nondefinition production call '+caller.call)}
const compiled=read(proof.compiled);assert.ok(compiled.loaded.length>0)
for(const file of proof.requiredCompiled)assert.ok(compiled.loaded.some(item=>item.path===file&&item.sha256===proof.sources[file]),'Exact compiled product '+file)
const actions=read(proof.actions);assert.equal(actions.passed,true);assert.equal(actions.frames.length,6)
for(const frame of actions.frames){const state=frame.state;assert.equal(Math.round(state.width),frame.name.startsWith('wide')?1000:332);assert.deepEqual(state.order,['u-before','a-before','u-after','a-after']);assert.deepEqual(state.controls,[]);assert.equal(state.draft,'Keep the original unsent reply draft.');if(!frame.name.endsWith('default')){assert.equal(state.selection,'First');assert.equal(state.rangeSame,true);assert.equal(state.copies.length,1);assert.deepEqual(state.links,['https://example.test/context'])}}
const review=read(proof.visualReview);assert.equal(review.passed,true);assert.ok(review.reviewer);assert.equal(review.images.length,proof.images.length);assert.equal(proof.images.length,6)
for(const file of proof.images){assert.ok(fs.statSync(resolve(file)).size>0);assert.ok(review.images.some(item=>item.path===file&&item.sha256===hash(file)),'Actually viewed image '+file)}
console.log(JSON.stringify({passed:true,owning:baseline.length,mutants:proof.mutants.length,images:proof.images.length,loadedInputs:loaded.length,compiledInputs:compiled.loaded.length,scope:proof.scope},null,2))

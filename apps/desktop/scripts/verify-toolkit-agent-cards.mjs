import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, join } from 'node:path'
const args = process.argv.slice(2)
assert.ok(args.length === 2 && args[0] === '--scope' && ['public','cards','performance'].includes(args[1]), 'Use --scope public|cards|performance')
const scope=args[1], driver=resolve(import.meta.dirname,`verify-toolkit-agent-cards-${scope}.mjs`)
const qualification=process.env.AGENTMUX_TOOLKIT_AGENT_CARDS_QUALIFICATION
if (!qualification) {
  // The scope driver, rather than this dispatcher, is the executable spec bound by the proof helper.
  process.argv[1]=driver
  await import(driver)
} else {
  // Tracker may join immutable completed proofs instead of repeating their mutation matrices.
  const root=resolve(import.meta.dirname,'../../..'), sha=bytes=>createHash('sha256').update(bytes).digest('hex')
  const read=file=>JSON.parse(readFileSync(file,'utf8')), current=file=>sha(readFileSync(resolve(root,file)))
  const manifest=read(qualification), entry=manifest.scopes[scope]
  assert.equal(manifest.schema,'agentmux.toolkit.agent-cards.qualification.v1')
  const receipt=read(entry.receipt), directory=dirname(entry.receipt)
  assert.equal(receipt.passed,true);assert.equal(receipt.userRunTouched,false)
  assert.equal(receipt.verifierSHA256,current(driver));assert.equal(receipt.helperSHA256,current('apps/desktop/scripts/performance-owner-proof.mjs'))
  for(const hashes of [receipt.sourceSHA256,receipt.testSHA256,entry.inputs])
    for(const [file,hash]of Object.entries(hashes))assert.equal(current(file),hash,file)
  for(const input of receipt.driverInputs??[]) {
    assert.equal(input.beforeSHA256,input.afterSHA256,input.path)
    assert.equal(current(input.path),input.beforeSHA256,input.path)
  }
  assert.equal(receipt.runs.length,({public:24,cards:19,performance:9})[scope])
  assert.equal(receipt.runs[0].name,'normal')
  for(const run of receipt.runs) {
    const raw=read(join(directory,run.name+'.json')), loaded=read(join(directory,run.name+'.loaded.json'))
    assert.equal(raw.numTotalTests,run.tests);assert.ok(raw.numTotalTests>=1);assert.equal(raw.numPendingTests,0)
    assert.deepEqual(loaded,run.loadedSources)
    if(run.name==='normal') {assert.equal(raw.numFailedTests,0);assert.ok(raw.numTotalTests>=({public:63,cards:53,performance:7})[scope])}
    else assert.ok(raw.testResults.flatMap(suite=>suite.assertionResults).some(test=>test.status==='failed'&&test.failureMessages.some(message=>message.includes('AssertionError'))),'Executed assertion mutant missing: '+run.name)
  }
  for(const caller of receipt.callers) {
    const source=readFileSync(resolve(root,caller.path),'utf8')
    assert.equal(source.split(caller.anchor).length-1,caller.count,caller.path)
    if(current(caller.path)!==caller.sha256) {
      assert.equal(caller.path,'apps/desktop/src/main/runtime-controller.ts')
      assert.equal(entry.reviewedMainCallerSHA256,current(caller.path))
    }
  }
  const custom=read(manifest.custom.file)
  assert.equal(current(manifest.custom.file),manifest.custom.sha256)
  assert.equal(custom.executionProof.privateChildExited,true);assert.equal(custom.executionProof.userRunTouched,false)
  assert.equal(custom.executionProof.outputSHA256,sha(custom.snapshot.latestConfirmed.text))
  const sourceReview=read(manifest.sourceReview.file)
  assert.equal(current(manifest.sourceReview.file),manifest.sourceReview.sha256)
  assert.equal(sourceReview.approved,true);assert.equal(sourceReview.independent,true)
  for(const [file,hash]of Object.entries(sourceReview.files))assert.equal(current(file),hash,file)
  if(scope!=='public') {
    const visual=read(manifest.visualReview.file), capture=read(manifest.capture.file)
    assert.equal(current(manifest.visualReview.file),manifest.visualReview.sha256)
    assert.equal(current(manifest.capture.file),manifest.capture.sha256)
    assert.equal(visual.approved,true);assert.equal(visual.independent,true)
    assert.equal(visual.sourceIdentity,capture.sourceIdentity)
    for(const [file,hash]of Object.entries(visual.files)) {
      assert.equal(current(file),hash,file)
      assert.equal(capture.inputs[file]?.sha256,hash,file)
    }
    assert.equal(capture.completed,true);assert.equal(capture.sourceCurrentReadbackExact,true)
    assert.equal(capture.frames.length,8);assert.deepEqual(capture.remainingPrivateProcesses,[])
    for(const frame of capture.frames)assert.equal(current(join(dirname(manifest.capture.file),frame.file)),frame.sha256)
    const consumed=read(manifest.customConsumer.file)
    assert.equal(current(manifest.customConsumer.file),manifest.customConsumer.sha256)
    assert.equal(consumed.passed,true);assert.equal(consumed.artifactSHA256,manifest.custom.sha256)
  }
  console.log(JSON.stringify({passed:true,scope,mode:'verified-existing-proofs',receipt:entry.receipt,qualification:resolve(qualification)}))
}

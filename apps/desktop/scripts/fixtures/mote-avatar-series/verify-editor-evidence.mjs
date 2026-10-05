import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const root=path.resolve(import.meta.dirname,'../../../../..')
const pointer=JSON.parse(await fs.readFile(path.join(root,'.local/state/mote-avatar-series/ui-verification.json'),'utf8'))
const artifacts=pointer.artifactRoot
assert.ok(path.isAbsolute(artifacts),'Choose the actual source-bound review directory')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
async function file(name,expected) {
  const bytes=await fs.readFile(name)
  if (expected) assert.equal(sha(bytes),expected,'Evidence bytes changed: '+name)
  return bytes
}
const candidateBytes=await file(path.join(artifacts,'ui-candidate.json'))
const candidate=JSON.parse(candidateBytes)
const review=JSON.parse(await file(path.join(artifacts,'ui-independent-review.identity.json')))
assert.equal(review.status,'approved');assert.equal(review.task,'T-002');assert.ok(review.reviewer)
assert.equal(review.candidateManifestSha256,sha(candidateBytes),'Independent approval must bind the exact candidate')
await file(path.join(artifacts,review.report),review.reportSha256)
assert.equal(Object.keys(candidate.owned).length,8)
for (const [name,digest] of Object.entries(candidate.owned)) await file(path.join(root,name),digest)
const baseline=JSON.parse(await file(path.join(candidate.baseline.directory,'receipt.json'),candidate.baseline.receiptSha256))
assert.equal(baseline.passed,true);assert.deepEqual(baseline.sourceDrift,[])
assert.equal(baseline.process.exitCode,0);assert.equal(baseline.process.timedOut,false)
assert.equal(baseline.renderer.passed,true);assert.deepEqual(baseline.renderer.errors,[]);assert.equal(baseline.renderer.writes,0)
assert.ok(baseline.renderer.operations.length>=40 && baseline.renderer.sourceCalls.length>=20)
assert.ok(baseline.renderer.firstFrame.bytes>0)
assert.ok(baseline.renderer.operations.some(operation=>operation.facts?.sizes?.map(size=>size.width).join(',')==='24,34,48,104'))
const delta=JSON.parse(await file(path.join(candidate.visualDelta.directory,'receipt.json'),candidate.visualDelta.receiptSha256))
assert.equal(delta.passed,true);assert.deepEqual(delta.sourceDrift,[])
assert.equal(delta.source['apps/desktop/src/main/mote-avatar-series.ts'],sha(await file(path.join(root,'apps/desktop/src/main/mote-avatar-series.ts'))))
assert.ok(review.images.length>=10 && review.images.every(item=>item.actuallyViewedFullImage))
for (const item of review.images) await file(path.join(artifacts,item.path),item.sha256)
assert.equal(candidate.mutations.length,4)
assert.deepEqual(candidate.mutations.map(item=>item.id).sort(),['reused-target','skip-dispose','stale-frame','stale-source'])
for (const item of candidate.mutations) {
  assert.equal(item.originalSha256,candidate.owned[item.file])
  const receipt=JSON.parse(await file(path.join(item.directory,'receipt.json'),item.receiptSha256))
  assert.equal(receipt.passed,false);assert.equal(receipt.renderer.passed,false)
  assert.equal(receipt.mutation.id,item.id);assert.equal(receipt.mutation.originalSha256,item.originalSha256)
  assert.notEqual(receipt.mutation.originalSha256,receipt.mutation.effectiveSha256)
  assert.ok(receipt.renderer.operations.length>0 && receipt.renderer.sourceCalls.length>0)
  const reviewed=review.mutationsReviewed.find(mutation=>mutation.id===item.id)
  assert.ok(reviewed?.expectedFailureObserved && reviewed.originalBoundaryMatchesOwnedCandidate)
  assert.equal(reviewed.receiptSha256,item.receiptSha256)
}
console.log(JSON.stringify({scope:'editor',passed:true,candidateSha256:sha(candidateBytes),reviewer:review.reviewer,actualFullBaseline:candidate.baseline.directory,actualVisualDelta:candidate.visualDelta.directory,mutants:4,boundary:'Reuses source-bound real product interactions and independent complete-image approval; does not fabricate a fresh execution or claim save/restart.'}))

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, relative } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'), directory=resolve(root,'.tmp/mobile-loading-review')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=async file=>JSON.parse(await readFile(resolve(root,file),'utf8'))
const current=async source=>{assert.ok(Object.keys(source).length>0);for(const[file,digest]of Object.entries(source))assert.equal(sha(await readFile(resolve(root,file))),digest,'Current source: '+file)}
const result={passed:false,boundary:'Consumes exact original main/owner tests, evaluated counterexamples, standard build and complete independent startup images. No replay of tests, build, publication, user page or business operation.'}
try {
 const author=await json('.tmp/mobile-loading-review/author/receipt.json')
 assert.equal(author.passed,true);await current(author.sourceSHA256)
 const names=['baseline','connection-awaits-product','update-before-module-ready','metadata-cancel-does-not-abort','late-metadata-clears-new-observation','setup-retains-stale-metadata-pending','restored','related']
 assert.deepEqual(author.runs.map(run=>run.name),names)
 for(const run of author.runs){
  const report=await readFile(resolve(root,run.report)),trace=await readFile(resolve(root,run.trace))
  assert.equal(sha(report),run.reportSHA256);assert.equal(sha(trace),run.traceSHA256)
  const data=JSON.parse(report),tests=data.testResults.flatMap(file=>file.assertionResults).filter(test=>['passed','failed'].includes(test.status))
  const rows=trace.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(row=>row.phase==='evaluated')
  assert.ok(rows.length>0);assert.ok(data.testResults.every(file=>!file.message),'No collection failure')
  for(const row of rows)assert.equal(sha(await readFile(resolve(root,row.file))),row.originalSHA256,'Actual evaluated source remains current: '+row.file)
  assert.equal(tests.length,run.executed)
  const mutant=!['baseline','restored','related'].includes(run.name)
  if(mutant){
   assert.equal(run.status,1);assert.equal(tests.length,1);assert.equal(data.numFailedTests,1)
   assert.equal(tests[0].status,'failed');assert.ok(tests[0].failureMessages.length>0)
   assert.ok(tests[0].failureMessages.every(message=>message.includes('AssertionError')))
   assert.ok(tests[0].failureMessages.some(message=>message.includes('AssertionError')),'Actual assertion counterexample')
   assert.ok(rows.some(row=>row.file==='apps/mobile/src/connection/MobileConnectionRoot.tsx'&&row.mutation===run.name&&row.originalSHA256===author.sourceSHA256[row.file]&&row.loadedSHA256!==row.originalSHA256&&/^[a-f0-9]{64}$/.test(row.loadedSHA256)),'Original evaluated mutation')
  }else{
   assert.equal(run.status,0);assert.equal(data.numFailedTests,0);assert.equal(tests.length,run.name==='related'?34:6)
   assert.ok(tests.every(test=>test.status==='passed'))
   assert.ok(rows.some(row=>row.file==='apps/mobile/src/MobileApp.tsx'),'Real product consumer evaluated')
  }
 }
 result.author='.tmp/mobile-loading-review/author/receipt.json'
 const build=await json('.tmp/mobile-loading-review/build.json')
 assert.equal(build.passed,true);assert.equal(build.typecheck.exitCode,0);await current(build.source)
 assert.ok(build.staticChunks.length>0);assert.ok(!build.staticChunks.includes(build.appDynamicChunk))
 assert.ok(build.graph[build.appDynamicChunk].modules.includes('apps/mobile/src/MobileApp.tsx'))
 assert.ok(!build.staticChunks.some(name=>build.graph[name].modules.includes('apps/mobile/src/MobileApp.tsx')))
 const release=await json('apps/mobile/dist/mobile-release.json');assert.equal(release.digest,build.release.digest)
 assert.ok(release.files.length>0);assert.deepEqual(release.files.map(file=>file.path).sort(),Object.keys(build.emitted).sort())
 for(const file of release.files){const bytes=await readFile(resolve(root,'apps/mobile/dist',file.path));assert.equal(sha(bytes),build.emitted[file.path].sha256);assert.equal('sha256:'+sha(bytes),file.digest)}
 result.build='.tmp/mobile-loading-review/build.json'
 const accepted=await json('.tmp/mobile-loading-review/acceptance.json')
 const bytes=await readFile(resolve(root,accepted.receipt)),capture=JSON.parse(bytes)
 assert.equal(sha(bytes),accepted.sha256);assert.equal(capture.passed,true);await current(capture.source)
 assert.deepEqual(Object.keys(capture.assets).sort(),release.files.map(file=>file.path).sort())
 assert.equal(capture.build.sha256,sha(await readFile(resolve(directory,'build.json'))))
 assert.equal(capture.process.exitCode,0);assert.equal(capture.process.exitSignal,null);assert.equal(capture.process.exitConfirmed,true)
 assert.equal(capture.process.originalPid,capture.renderer.pid);assert.ok(Number.isSafeInteger(capture.renderer.pid)&&capture.renderer.pid>0)
 assert.equal(Object.keys(capture.images).length,5)
 const reviewBytes=await readFile(resolve(root,accepted.review)),review=JSON.parse(reviewBytes)
 assert.equal(sha(reviewBytes),accepted.reviewSHA256);assert.equal(review.verdict,'deliverable');assert.ok(review.reviewer&&review.reviewer!=='/root')
 assert.equal(review.receipt,accepted.receipt);assert.equal(review.receiptSHA256,accepted.sha256);assert.equal(review.images.length,5)
 assert.deepEqual(Object.fromEntries(review.images.map(item=>{assert.ok(item.conclusion?.length>0);return[item.file,item.sha256]})),capture.images)
 for(const[file,digest]of Object.entries(capture.images))assert.equal(sha(await readFile(resolve(dirname(resolve(root,accepted.receipt)),file))),digest,'Actual full image')
 await current(author.sourceSHA256);await current(build.source);await current(capture.source)
 result.capture=accepted;result.initialJavaScriptBytes=build.initialJavaScriptBytes;result.passed=true
}catch(error){result.error={name:error.name,message:error.message};process.exitCode=1}
finally{await writeFile(resolve(directory,'gate.json'),JSON.stringify(result,null,2)+'\n');console.log(relative(root,resolve(directory,'gate.json')))}

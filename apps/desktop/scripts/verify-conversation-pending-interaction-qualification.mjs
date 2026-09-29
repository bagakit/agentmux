import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
assert.equal(process.argv[2],'--proof');assert.equal(process.argv.length,4)
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const bytes=path=>readFile(resolve(root,path))
const json=async path=>JSON.parse(await bytes(path))
async function bound(ref){const value=await bytes(ref.path);assert.equal(hash(value),ref.sha256,ref.path);return value}
const proof=await json(process.argv[3])
assert.equal(proof.schema,'agentmux.conversation-pending-interaction-qualification.v1')
assert.equal(Object.keys(proof.source).length,6,'six declared owning Source inputs required')
for(const [path,identity]of Object.entries(proof.source))assert.equal(hash(await bytes(path)),identity.sha256,`current Source differs: ${path}`)

async function command(ref,exit){
  const receipt=JSON.parse(await bound(ref.receipt))
  assert.equal(receipt.schema,'agentmux.pending-interaction-command.v1')
  assert.equal(receipt.exit,exit);assert.equal(receipt.error,null);assert.equal(receipt.signal,null)
  assert.ok(receipt.cwd.endsWith('/conversation-chat-clarity-qualification-20261004'),'declared isolated qualification tree')
  assert.deepEqual(receipt.sourceBefore,receipt.sourceAfter,'Source changed during command')
  assert.deepEqual(receipt.coreBefore,receipt.coreAfter,'Core changed during command')
  assert.equal(Object.keys(receipt.coreBefore).length,14,'actual Core source/compiled producer inputs must be nonempty')
  // DOM/TS runs do not import agent.css. Its actual parsed input is bound separately by Renderer evidence.
  for(const [path,identity]of Object.entries(proof.source).filter(([path])=>!path.endsWith('/agent.css')))assert.equal(receipt.sourceBefore[path]?.sha256,identity.sha256,path)
  for(const [path,identity]of Object.entries(proof.core))assert.equal(receipt.coreBefore[path]?.sha256,identity.sha256,path)
  assert.equal(receipt.originalAppRuntimeRunControls,0)
  const stdout=(await bound(receipt.stdout)).toString(),stderr=(await bound(receipt.stderr)).toString()
  return{receipt,stdout,stderr}
}
async function report(ref){const value=JSON.parse(await bound(ref));assert.equal(value.numTotalTests,17);assert.equal(value.testResults.length,1);assert.equal(value.testResults[0].assertionResults.length,17);return value}
const owning=await command(proof.owning,0),ownReport=await report(proof.owning.report)
assert.equal(ownReport.numPassedTests,17);assert.equal(ownReport.numFailedTests,0)
const loaded=(await bound(owning.receipt.loaded)).toString().trim().split('\n').map(line=>JSON.parse(line))
assert.ok(loaded.length>0,'actual transform set must be nonempty')
for(const path of ['apps/desktop/src/renderer/src/components/SessionPane.tsx','apps/desktop/src/renderer/src/components/AgentInteractionCard.tsx']){
  const rows=loaded.filter(row=>row.path===path);assert.equal(rows.length,1,path);assert.equal(rows[0].sha256,proof.source[path].sha256)
}
assert.deepEqual(proof.mutations.map(pair=>pair.name).sort(),['detachConversation','earlyUnlock','readonly','wrongOption'])
for(const pair of proof.mutations){
  const red=await command(pair.red,1),restore=await command(pair.restore,0)
  const redReport=await report(pair.red.report),restoreReport=await report(pair.restore.report)
  assert.ok(redReport.numFailedTests>0,'mutation needs actual AssertionRED')
  const failures=redReport.testResults.flatMap(file=>file.assertionResults.flatMap(test=>test.failureMessages??[]))
  assert.ok(failures.some(message=>message.includes('AssertionError')),'setup/runtime errors are not semantic RED')
  const failed=redReport.testResults.flatMap(file=>file.assertionResults).filter(test=>test.status!=='passed')
  const assertionCount=failed.filter(test=>test.failureMessages.some(message=>message.includes('AssertionError'))).length
  assert.equal(pair.assertionFailures,assertionCount)
  assert.equal(pair.runtimeFailures,failed.length-assertionCount,'runtime errors must be counted separately')
  assert.equal(restoreReport.numPassedTests,17);assert.equal(restoreReport.numFailedTests,0)
  const transformed=(await bound(red.receipt.loaded)).toString().trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.mutant===pair.name)
  assert.equal(transformed.length,1,'exactly one actual loaded product transform')
  assert.notEqual(transformed[0].sha256,transformed[0].originalSHA256)
  assert.equal(transformed[0].originalSHA256,proof.source[transformed[0].path].sha256)
  assert.equal(restore.receipt.env.AGENTMUX_PENDING_INTERACTION_MUTANT,undefined)
}
const adjacent=await command(proof.adjacent,0)
assert.match(adjacent.stdout,/Tests\s+\d+ passed/u)
assert.equal(proof.types.length,2)
for(const ref of proof.types)await command(ref,0)
const callers=JSON.parse(await bound(proof.callers))
assert.ok(callers.matches.length>0)
for(const path of ['apps/desktop/src/renderer/src/components/SessionPane.tsx','apps/desktop/src/renderer/src/components/AttentionRequestPanel.tsx']){
  const matches=callers.matches.filter(row=>row.path===path&&row.symbol==='AgentInteractionCard')
  assert.ok(matches.length>0,`missing non-definition product caller: ${path}`)
  for(const row of matches)assert.ok((await bytes(path)).toString().includes(row.text))
}
const sourceReview=JSON.parse(await bound(proof.sourceReview)),visualReview=JSON.parse(await bound(proof.visualReview))
assert.equal(sourceReview.decision,'PASS');assert.equal(visualReview.decision,'PASS')
assert.ok(visualReview.images.length>=4,'wide/narrow/readonly/unsupported request review required')
assert.equal(visualReview.actual_view_tool,'view_image')
const visual=JSON.parse(await bound(proof.visualManifest))
assert.equal(visual.passed,true);assert.equal(visual.originalAppRuntimeRunControls,0)
assert.ok(visual.scenes.some(scene=>scene.name.includes('wide')))
assert.ok(visual.scenes.some(scene=>scene.name.includes('narrow')))
for(const [path,identity]of Object.entries(proof.source).filter(([path])=>path.includes('/src/renderer/')))assert.equal(visual.source[path]?.sha256,identity.sha256,path)
assert.equal(visual.cssImported,true,'actual product CSS must be parsed in the Renderer')
for(const scene of visual.scenes){await bound(scene.image);assert.ok(scene.requestId,'nonempty actual current request');assert.ok(scene.optionCount>0||scene.unsupported===true)}
assert.equal(proof.originalAppRuntimeRunControls,0)
console.log(JSON.stringify({result:'PASS',owning:17,loadedSemanticMutations:4,boundary:'Current typed request/private public Core producer/Store/DOM/compiled UI; no vendor Writer, installed App, restart or full Terminal qualification'}))

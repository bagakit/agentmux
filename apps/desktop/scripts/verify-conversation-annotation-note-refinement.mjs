import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..')
assert.equal(process.argv[2],'--proof');assert.equal(process.argv.length,4)
const bytes=path=>readFile(resolve(root,path)),hash=b=>createHash('sha256').update(b).digest('hex')
async function bound(ref){const b=await bytes(ref.path);assert.equal(hash(b),ref.sha256,ref.path);return b}
const proof=JSON.parse(await bytes(process.argv[3]))
assert.equal(proof.schema,'agentmux.annotation-note-refinement-qualification.v1')
assert.equal(Object.keys(proof.source).length,4,'four owning JS/fixture/config inputs')
for(const [path,input]of Object.entries(proof.source))assert.equal(hash(await bytes(path)),input.sha256,path)
const css=(await bytes(proof.annotationCSS.path)).toString(),start=css.indexOf('.log-turn__annotation {'),end=css.indexOf('/* "Continue from here"',start)
assert.ok(start>=0);assert.ok(end>start);const annotationCSS=css.slice(start,end);assert.ok(annotationCSS.length>0)
assert.equal(hash(annotationCSS),proof.annotationCSS.sha256,'exact current annotation CSS scope')
async function command(ref,exit){
 const r=JSON.parse(await bound(ref.receipt));assert.equal(r.exit,exit);assert.equal(r.error,null);assert.equal(r.signal,null)
 assert.deepEqual(r.sourceBefore,r.sourceAfter)
 for(const [path,input]of Object.entries(proof.source))assert.equal(r.sourceBefore[path]?.sha256,input.sha256,path)
 assert.equal(r.annotationCSSBefore.sha256,r.annotationCSSAfter.sha256,'annotation CSS unchanged during run')
 assert.equal(r.cssNotImportedByDOMOrTS,true,'CSS qualified by actual Renderer separately')
 assert.equal(r.originalAppRuntimeRunControls,0)
 await bound(r.stdout);await bound(r.stderr)
 return r
}
async function report(ref){const r=JSON.parse(await bound(ref));assert.equal(r.numTotalTests,21);assert.equal(r.testResults.length,1);assert.equal(r.testResults[0].assertionResults.length,21);return r}
const own=await command(proof.owning,0),ownReport=await report(proof.owning.report);assert.equal(ownReport.numPassedTests,21);assert.equal(ownReport.numFailedTests,0)
const ownLoaded=(await bound(own.loaded)).toString().trim().split('\n').map(line=>JSON.parse(line));assert.ok(ownLoaded.length>0)
const note='apps/desktop/src/renderer/src/components/ConversationAnnotationNote.tsx'
assert.equal(ownLoaded.filter(row=>row.path===note).length,1);assert.equal(ownLoaded.find(row=>row.path===note).sha256,proof.source[note].sha256)
assert.deepEqual(proof.mutations.map(pair=>pair.name).sort(),['close-discards','failure-clears-note','truncate-passage'])
for(const pair of proof.mutations){
 const red=await command(pair.red,1),restore=await command(pair.restore,0),r=await report(pair.red.report),g=await report(pair.restore.report)
 const failed=r.testResults[0].assertionResults.filter(test=>test.status==='failed')
 const assertions=failed.filter(test=>test.failureMessages.some(message=>message.includes('AssertionError')))
 assert.ok(assertions.length>0,'actual semantic AssertionRED required');assert.equal(pair.assertionFailures,assertions.length);assert.equal(pair.runtimeFailures,failed.length-assertions.length)
 assert.equal(g.numPassedTests,21);assert.equal(g.numFailedTests,0)
 const loaded=(await bound(red.loaded)).toString().trim().split('\n').map(line=>JSON.parse(line)).filter(row=>row.mutation===pair.name)
 assert.equal(loaded.length,1);assert.equal(loaded[0].path,note);assert.equal(loaded[0].originalSHA256,proof.source[note].sha256);assert.notEqual(loaded[0].originalSHA256,loaded[0].sha256)
 assert.equal(restore.mutation,null)
}
await command(proof.adjacent,0);assert.equal(proof.types.length,2);for(const run of proof.types)await command(run,0)
const callers=JSON.parse(await bound(proof.callers));assert.ok(callers.matches.length>0)
assert.ok(callers.matches.some(hit=>hit.path==='apps/desktop/src/renderer/src/components/SessionPane.tsx'&&hit.symbol==='ConversationAnnotationNote'))
for(const hit of callers.matches){assert.ok(!hit.path.includes('/test/')&&!hit.path.endsWith('/ConversationAnnotationNote.tsx'));assert.ok(hit.text.startsWith('<ConversationAnnotationNote '),'a type reference is not a product consumer');assert.ok((await bytes(hit.path)).toString().includes(hit.text))}
const review=JSON.parse(await bound(proof.sourceReview)),visualReview=JSON.parse(await bound(proof.visualReview));assert.equal(review.decision,'PASS');assert.equal(visualReview.decision,'PASS')
assert.equal(review.source[note].sha256,proof.source[note].sha256);assert.equal(review.annotationCSS.sha256,proof.annotationCSS.sha256)
assert.equal(visualReview.actual_view_tool,'view_image');assert.ok(visualReview.images.length>=4)
const visual=JSON.parse(await bound(proof.visualManifest));assert.equal(visual.passed,true);assert.equal(visual.originalAppRuntimeRunControls,0)
assert.equal(visual.source[note].sha256,proof.source[note].sha256);assert.equal(visual.annotationCSS.sha256,proof.annotationCSS.sha256)
assert.ok(visual.scenes.length>=4);assert.ok(visual.scenes.some(scene=>scene.name.includes('wide')));assert.ok(visual.scenes.some(scene=>scene.name.includes('narrow')))
for(const scene of visual.scenes){await bound(scene.image);assert.ok(scene.state.rangeRects.length>0);assert.equal(scene.state.sameContext,true);assert.equal(scene.state.sameFirstNode,true);assert.deepEqual(scene.state.controls,[])}
const styles=JSON.parse(await bound(visual.actualStyles));assert.ok(styles.length>0);assert.ok(styles.some(style=>style.text.includes(annotationCSS)),'actual Renderer must contain whole annotation scope')
const longPassage=JSON.parse(await bound(proof.longPassageVisual));assert.equal(longPassage.passed,true);assert.equal(longPassage.originalAppRuntimeRunControls,0)
assert.equal(longPassage.source[note].sha256,proof.source[note].sha256);assert.equal(longPassage.annotationCSS.sha256,proof.annotationCSS.sha256);assert.equal(longPassage.scenes.length,2)
for(const scene of longPassage.scenes){await bound(scene.image);assert.equal(scene.state.passage,scene.state.quote);assert.ok(scene.state.quote.length>100);assert.ok(scene.state.rangeRects.length>1);assert.equal(scene.state.sameContext,true);assert.equal(scene.state.sameFirstNode,true);assert.deepEqual(scene.state.controls,[])}
const actionScene=longPassage.scenes.find(scene=>scene.name==='final-long-passage-action');assert.ok(actionScene);assert.ok(actionScene.state.inputRect.bottom<=actionScene.state.addRect.top);assert.ok(actionScene.state.addRect.bottom<=actionScene.state.noteRect.bottom)
assert.equal(proof.originalAppRuntimeRunControls,0)
console.log(JSON.stringify({result:'PASS',owning:21,loadedSemanticMutations:3,boundary:'Modern retained Range note/private actual SessionPane and Renderer; no installed App, system Clipboard, vendor writer or restart qualification'}))

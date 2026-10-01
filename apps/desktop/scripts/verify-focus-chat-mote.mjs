import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chatSourceBinding, sha } from './fixtures/focus-chat-mote/source-binding.mjs'
const root = fileURLToPath(new URL('../../../', import.meta.url))
const args = process.argv.slice(2), source = args.includes('--source'), consume = args.includes('--consume')
assert.notEqual(source, consume, 'Select exactly source or consume.')
const out = path.join(root, (".tmp/focus-chat-mote-" + (source ? 'source' : 'consume') + "-" + (globalThis.crypto.randomUUID()) + ""))
mkdirSync(out, {recursive:true})
const receipt = {schema:'agentmux.focus-chat-mote-qualification.v1', before:chatSourceBinding(root), phases:[], passed:false, installed:false}
function run(name, argv, env={}) {
 const result = spawnSync(argv[0],argv.slice(1),{cwd:root,env:{...process.env,...env},encoding:'utf8',maxBuffer:8*1024*1024})
 writeFileSync(path.join(out,name+'.stdout.log'),result.stdout??'');writeFileSync(path.join(out,name+'.stderr.log'),result.stderr??'')
 receipt.phases.push({name,argv,exit:result.status,signal:result.signal,error:result.error?.message})
 console.log(`${name}: ${result.status}`);return result
}
function tests(name, config, mutation) {
 const output=path.join(out,name+'.json'),loaded=path.join(out,name+'.loaded.ndjson')
 const result=run(name,['node','node_modules/vitest/vitest.mjs','run','--config',config,'--reporter=json',`--outputFile=${output}`],mutation?{AGENTMUX_FOCUS_CHAT_MUTATION:mutation,AGENTMUX_FOCUS_CHAT_MUTATION_LOG:loaded}:{})
 assert.ok(!result.error&&!result.signal,`${name} completes`)
 const report=JSON.parse(readFileSync(output,'utf8'));assert.ok(report.numTotalTests>0,`${name} non-empty collection`)
 if(mutation){assert.notEqual(result.status,0);assert.ok(report.numFailedTests>0&&report.testResults.some(file=>file.assertionResults.some(test=>test.failureMessages.some(message=>message.includes('AssertionError')))),`${name} actual product AssertionRED`)
 const records=readFileSync(loaded,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(records.length,1);assert.notEqual(records[0].originalSha,records[0].transformedSha);return {total:report.numTotalTests,failed:report.numFailedTests,loaded:records}}
 assert.equal(result.status,0,`${name} GREEN`);assert.equal(report.numFailedTests,0);return {total:report.numTotalTests,passed:report.numPassedTests}
}
try {
 if(source){
 const config='apps/desktop/scripts/fixtures/focus-chat-mote/vitest.owning.config.mts'
 receipt.owning=tests('owning',config);receipt.mutations=[]
 for(const key of ['ignore-choice','drop-durable-choice','selection-sends']){
 const red=tests(key,'apps/desktop/scripts/fixtures/focus-chat-mote/vitest.mutation.config.mts',key);assert.equal(red.total,receipt.owning.total)
 receipt.mutations.push({key,red,restored:tests(key+'-restored',config)})}
 receipt.adjacent=tests('adjacent','apps/desktop/scripts/fixtures/focus-chat-mote/vitest.adjacent.config.mts')
 for(const [name,project] of [['production-types','apps/desktop/tsconfig.json'],['owning-types','apps/desktop/scripts/fixtures/focus-chat-mote/tsconfig.owning.json']])assert.equal(run(name,['node','--max-old-space-size=1536','node_modules/typescript/bin/tsc','--noEmit','-p',project]).status,0)
 const callers={FocusToolbar:['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','<FocusToolbar'],FloatingPreference:['apps/desktop/src/renderer/src/components/FocusToolbar.tsx','setFloating({ focusChatTopicId: mote.id })'],DiscussionOwner:['apps/desktop/src/renderer/src/components/FocusToolbar.tsx','state.openScratchTopic(topicId, SCRATCH_WORKSPACE_ID']}
 receipt.callers=Object.fromEntries(Object.entries(callers).map(([symbol,[file,invocation]])=>{const text=readFileSync(path.join(root,file),'utf8'),index=text.indexOf(invocation);assert.ok(index>=0,`${symbol} actual non-definition caller`);return [symbol,{file,line:text.slice(0,index).split('\n').length,invocation}]}))
 } else {
 const file=process.env.AGENTMUX_FOCUS_CHAT_RECEIPT ?? args[args.indexOf('--consume')+1];assert.ok(file,'Exact reviewed Chat delivery receipt required')
 const bytes=readFileSync(path.resolve(root,file)),delivery=JSON.parse(bytes)
 assert.equal(delivery.schema,'agentmux.focus-chat-mote-delivery.v1');assert.equal(delivery.passed,true);assert.deepEqual(delivery.source,receipt.before)
 const guiBytes=readFileSync(path.resolve(root,delivery.gui.path)),gui=JSON.parse(guiBytes);assert.equal(sha(guiBytes),delivery.gui.sha256);assert.equal(gui.passed,true)
 assert.deepEqual(gui.before,receipt.before);assert.deepEqual(gui.after,receipt.before)
 assert.equal(gui.phases.length,2);assert.notEqual(gui.phases[0].pid,gui.phases[1].pid);assert.equal(gui.phases[1].seedCount,0)
 assert.equal(gui.restartPreserved,true);assert.equal(gui.selectionSideEffects,false);assert.equal(gui.preferenceRestored,true)
 assert.equal(gui.cleanup.rootRemoved,true);assert.deepEqual(gui.cleanup.remaining,[])
 assert.ok(gui.scenes.length>=3);assert.ok(gui.scenes.every(scene=>scene.horizontalOverflow===false))
 const reviewBytes=readFileSync(path.resolve(root,delivery.review.path)),review=JSON.parse(reviewBytes);assert.equal(sha(reviewBytes),delivery.review.sha256)
 assert.equal(review.verdict,'pass');assert.equal(review.guiReceiptSha256,sha(guiBytes));assert.ok(review.reviewerAgentId)
 assert.equal(review.viewedImages.length,gui.images.length)
 for(const image of gui.images){const imageBytes=readFileSync(path.resolve(root,image));assert.ok(review.viewedImages.some(viewed=>viewed.path===image&&viewed.sha256===sha(imageBytes)&&viewed.observation?.trim()),'Exact PNG independently viewed')}
 receipt.delivery={file,sha256:sha(bytes)};receipt.visualRestartQualified=true
 }
 receipt.after=chatSourceBinding(root);assert.deepEqual(receipt.after,receipt.before,'Exact owning source unchanged')
 receipt.passed=true
} catch(error){receipt.error={name:error.name,message:error.message};console.error(error.message);process.exitCode=1}
writeFileSync(path.join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(path.relative(root,path.join(out,'receipt.json')))

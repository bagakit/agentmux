import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
const root=resolve(import.meta.dirname,'../../..'), output=resolve(root,`.tmp/focus-retired-history-renderer-qualification-${Date.now()}`)
mkdirSync(output,{recursive:true})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'), sourcePaths=['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx','apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx','apps/desktop/src/renderer/src/lib/focus-history-sources.ts','apps/desktop/src/renderer/src/lib/focus-history-timeline.ts','apps/desktop/test/focus-retired-history-renderer.test.tsx','apps/desktop/scripts/fixtures/focus-project-history/vitest.renderer-history.config.mts']
const binding=()=>Object.fromEntries(sourcePaths.map(file=>[file,hash(readFileSync(resolve(root,file)))]))
const receipt={schema:'agentmux.focus-retired-history-renderer-qualification.v1',passed:false,sourcePass:false,taskDone:false,before:binding(),output:relative(root,output),stages:[],boundary:'T005 read-only Renderer Source/caller/cost and finite compiled presentation only; not ordinary closing/restart, T003, user installation, provider Writer or physical Terminal qualification.'}
function run(label,args,mutation,cwd=root){
  const env={...process.env,AGENTMUX_STATE_DIRECTORY:resolve(output,'private-state'),AGENTMUX_RUNTIME_DIRECTORY:resolve(output,'private-runtime')};delete env.AGENTMUX_RETIRED_FOCUS_MUTATION
  if(mutation)env.AGENTMUX_RETIRED_FOCUS_MUTATION=mutation
  const report=resolve(output,`${label}.json`),loaded=resolve(output,`${label}.loaded.jsonl`)
  env.AGENTMUX_RETIRED_FOCUS_LOADED_SOURCE=loaded
  const command=args??[process.execPath,'node_modules/vitest/vitest.mjs','run','--config','apps/desktop/scripts/fixtures/focus-project-history/vitest.renderer-history.config.mts','--maxWorkers=1','--reporter=json',`--outputFile=${report}`]
  const result=spawnSync(command[0],command.slice(1),{cwd,env,encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024})
  writeFileSync(resolve(output,`${label}.log`),(result.stdout??'')+(result.stderr??''))
  const stage={label,command,cwd,exitCode:result.status,signal:result.signal,error:result.error?.message,mutation:mutation??null}
  if(!args){const data=JSON.parse(readFileSync(report,'utf8')),bytes=readFileSync(loaded),modules=bytes.toString().trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)), assertions=data.testResults.flatMap(file=>file.assertionResults)
    assert.ok(assertions.length>0,'Literal nonempty owning tests');assert.ok(modules.length>0,'Actual loaded Source')
    const target=mutation==='current-members-only'?sourcePaths[3]:sourcePaths[0],owner=modules.find(item=>item.path===target);assert.ok(owner,'Actual mutated product module is consumed');assert.equal(owner.originalSHA256,receipt.before[target])
    const failed=assertions.filter(item=>item.status==='failed'),assertionFailures=failed.filter(item=>item.failureMessages.some(message=>message.includes('AssertionError')))
    Object.assign(stage,{tests:data.numTotalTests,passed:data.numPassedTests,failed:data.numFailedTests,assertionFailures:assertionFailures.length,otherFailures:failed.length-assertionFailures.length,loadedOwner:owner,reportSHA256:hash(readFileSync(report)),loadedSHA256:hash(bytes)})
    if(mutation){assert.notEqual(result.status,0);assert.equal(owner.mutation,mutation);assert.notEqual(owner.sha256,owner.originalSHA256);assert.ok(assertionFailures.length>0,'Loaded actual behavior AssertionRED');assert.equal(failed.length,assertionFailures.length)}else{assert.equal(result.status,0);assert.equal(data.success,true);assert.equal(owner.sha256,owner.originalSHA256)}
  }else assert.equal(result.status,0,`${label} failed; original log preserved`)
  receipt.stages.push(stage);writeFileSync(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(`${label}: actual ${stage.tests??'command'} exit ${result.status}`);return stage
}
try{
  const baseline=run('baseline')
  for(const mutation of ['readonly-disconnected','current-members-only','equal-body-merge']){const red=run(mutation,undefined,mutation);assert.equal(red.tests,baseline.tests);const green=run(`${mutation}-exact-restore`);assert.equal(green.tests,baseline.tests)}
  run('production-types',[process.execPath,'node_modules/typescript/bin/tsc','--noEmit','-p','apps/desktop/tsconfig.json'])
  run('owning-types',[process.execPath,'node_modules/typescript/bin/tsc','--noEmit','-p','apps/desktop/scripts/fixtures/focus-project-history/tsconfig.renderer-history.json'])
  // Run the exact normal Desktop build scripts directly. pnpm 11 may auto-install
  // on a partial proof root; that must never rewrite borrowed workspace links.
  const desktop=resolve(root,'apps/desktop')
  run('build-workspace-move-helper',[process.execPath,'scripts/build-workspace-move-helper.mjs'],undefined,desktop)
  run('production-electron-vite-build',[process.execPath,'node_modules/electron-vite/bin/electron-vite.js','build'],undefined,desktop)
  run('production-renderer-release',[process.execPath,'scripts/build-renderer-release.mjs'],undefined,desktop)
  const callers={historySources:['apps/desktop/src/renderer/src/lib/focus-history-sources.ts','api.sessions.historySources()'],historyPage:['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx','api.sessions.historyPage(control,'],timeline:['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx','api.sessions.timeline(control)'],useFocusHistorySources:['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx','useFocusHistorySources(mode']}
  receipt.callers=Object.fromEntries(Object.entries(callers).map(([symbol,[file,needle]])=>{const text=readFileSync(resolve(root,file),'utf8'),index=text.indexOf(needle);assert.ok(index>=0,`${symbol} non-definition product caller`);return[symbol,{file,line:text.slice(0,index).split('\n').length,needle}]}))
  receipt.after=binding();assert.deepEqual(receipt.after,receipt.before,'Owning Source remains exact');receipt.sourcePass=true
  if(!process.argv.includes('--source-only')){
    const accepted='docs/reviews/evidence/focus-retired-history-renderer-2026-10-03/accepted/scene-r8'
    const sceneFile=process.env.AGENTMUX_RETIRED_FOCUS_SCENE_RECEIPT??`${accepted}/receipt.json`,reviewFile=process.env.AGENTMUX_RETIRED_FOCUS_VISUAL_REVIEW??`${accepted}/visual-review.json`
    const sceneBytes=readFileSync(resolve(root,sceneFile)),scene=JSON.parse(sceneBytes),reviewBytes=readFileSync(resolve(root,reviewFile)),review=JSON.parse(reviewBytes)
    assert.equal(scene.schema,'agentmux.focus-retired-history-renderer-scene-delivery.v1');assert.equal(scene.passed,true);assert.deepEqual(scene.actual.controls,[]);assert.equal(scene.cleanup.privateRootRemoved,true);assert.ok(scene.images.length>=5)
    for(const file of sourcePaths.slice(0,4))assert.equal(scene.inputs[file],receipt.before[file])
    assert.equal(review.verdict,'pass');assert.ok(typeof review.reviewerAgentId==='string'&&review.reviewerAgentId.length>0);assert.equal(review.sceneReceiptSHA256,hash(sceneBytes))
    for(const image of scene.images){assert.equal(hash(readFileSync(resolve(dirname(resolve(root,sceneFile)),image.path))),image.sha256);assert.ok(review.viewedImages.some(item=>item.path===image.path&&item.sha256===image.sha256&&typeof item.observation==='string'&&item.observation.trim().length>0),'Every actual wide/narrow image independently viewed')}
    receipt.scene={file:sceneFile,sha256:hash(sceneBytes),compiled:scene.compiled,actualPID:scene.actual.pid,images:scene.images};receipt.visualReview={file:reviewFile,sha256:hash(reviewBytes),reviewerAgentId:review.reviewerAgentId};receipt.taskDone=true
  }
  receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{writeFileSync(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({sourcePass:receipt.sourcePass,passed:receipt.passed,taskDone:receipt.taskDone,receipt:relative(root,resolve(output,'receipt.json'))}))}

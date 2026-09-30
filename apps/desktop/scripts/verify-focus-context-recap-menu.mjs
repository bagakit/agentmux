import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
const root=resolve(import.meta.dirname,'../../..'),args=process.argv.slice(2)
assert.ok(args.length===2&&args[0]==='--slice'&&['source','scene'].includes(args[1]),'Use --slice source|scene')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const files=['apps/desktop/src/renderer/src/lib/focus-context.ts','apps/desktop/src/renderer/src/components/FocusContextRow.tsx','apps/desktop/src/renderer/src/components/FocusContextMenu.tsx','apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/src/renderer/src/lib/launcher-resume.ts','apps/desktop/src/renderer/src/lib/session-recency.ts','apps/desktop/src/renderer/src/lib/agent-roster-menu.ts','apps/desktop/src/renderer/src/lib/agent-address.ts','apps/desktop/src/renderer/src/lib/clipboard-copy.ts','apps/desktop/src/renderer/src/components/RegionContextMenu.tsx','apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx',
  'apps/desktop/test/focus-context-recap-menu.test.tsx','apps/desktop/test/focus-card-information.test.tsx','apps/desktop/test/focus-lane-information.test.tsx','apps/desktop/test/focus-context-cost.test.ts','apps/desktop/scripts/fixtures/focus-context-recap-menu/vitest.owning.config.mts','apps/desktop/scripts/fixtures/focus-context-recap-menu/vitest.adjacent.config.mts','apps/desktop/scripts/fixtures/focus-context-recap-menu/tsconfig.owning.json',
  'apps/desktop/scripts/fixtures/focus-context-recap-menu/entry.mjs','apps/desktop/scripts/fixtures/focus-context-recap-menu/main.cjs','apps/desktop/scripts/capture-focus-context-recap-menu.mjs','apps/desktop/scripts/verify-focus-context-recap-menu.mjs']
const bindings=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(join(root,file)))])))
if(args[1]==='scene'){
  const path=process.env.AGENTMUX_FOCUS_RECAP_SCENE_RECEIPT;assert.ok(path,'Source-bound actual scene receipt required')
  const scene=JSON.parse(await readFile(path,'utf8')),reviewPath=process.env.AGENTMUX_FOCUS_RECAP_VISUAL_REVIEW??join(resolve(path,'..'),'visual-review.json'),review=JSON.parse(await readFile(reviewPath,'utf8'))
  assert.equal(scene.capturedPass,true);assert.equal(review.verdict,'pass');assert.equal(review.sceneReceiptSHA256,hash(await readFile(path)))
  for(const[file,sha]of Object.entries(scene.inputs))assert.equal(hash(await readFile(join(root,file))),sha,'Current exact scene input '+file)
  assert.deepEqual(scene.sourceAfter,scene.inputs);assert.equal(scene.frames.length,5);assert.equal(review.viewedImages.length,5)
  for(const frame of scene.frames){assert.ok(review.viewedImages.some(image=>image.path===frame.file&&image.sha256===frame.sha256&&image.viewed));assert.equal(hash(await readFile(join(resolve(path,'..'),frame.file))),frame.sha256)}
  assert.equal(scene.cleanup.removed,true);assert.deepEqual(scene.cleanup.remaining,[])
  console.log(JSON.stringify({passed:true,scene:path,review:reviewPath,boundary:'Card presentation/Session copy only; no Native/PTY/Run lifecycle/Writer/installation',sourceBindings:await bindings()}));process.exit(0)
}
const out=join(root,'.tmp',`focus-context-recap-menu-source-${Date.now()}`);await mkdir(out,{recursive:true})
const before=await bindings(),receipt={schema:'agentmux.focus-context-recap-menu-source.v1',passed:false,sourceBefore:before,owning:null,mutations:[],adjacent:null,types:[],callers:{},boundary:'Mounted original Store/projection/Global/Row/menu/clipboard. Typed Session/control facts only; no Native/PTY/Writer/restart/installation/full Focus.'}
const run=async(label,command,params,env={})=>{
  let result;try{const actual=await promisify(execFile)(command,params,{cwd:root,env:{...process.env,...env},timeout:120000,maxBuffer:8*1024*1024});result={code:0,signal:null,output:actual.stdout+actual.stderr}}catch(error){result={code:error.code,signal:error.signal,output:(error.stdout??'')+(error.stderr??'')}}
  await writeFile(join(out,label+'.log'),result.output);return{code:result.code,signal:result.signal,log:label+'.log'}
}
try{
  const test=async(label,mutation)=>{
    const report=join(out,label+'.json'),loaded=join(out,label+'-loaded.jsonl'),execution=await run(label,process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/focus-context-recap-menu/vitest.owning.config.mts','--maxWorkers=1','--reporter=json','--outputFile='+report],{AGENTMUX_FOCUS_RECAP_LOADED:loaded,...(mutation?{AGENTMUX_FOCUS_RECAP_MUTATION:mutation}:{})})
    const result=JSON.parse(await readFile(report,'utf8')),modules=(await readFile(loaded,'utf8')).trim().split('\n').map(line=>JSON.parse(line));assert.equal(result.numTotalTests,16);assert.ok(modules.length>0)
    for(const file of files.slice(0,4)){const observed=modules.filter(item=>item.path===file);assert.ok(observed.length>0,'Actual product loaded '+file);assert.ok(observed.every(item=>item.sourceSHA256===before[file]))}
    const changed=modules.filter(item=>item.mutated),failed=result.testResults.flatMap(file=>file.assertionResults).filter(item=>item.status==='failed')
    if(mutation){assert.equal(changed.length,1);assert.equal(changed[0].mutation,mutation);assert.notEqual(changed[0].sourceSHA256,changed[0].loadedSHA256);assert.ok(execution.code>0&&execution.signal===null);assert.ok(failed.length>0);assert.ok(failed.every(item=>item.failureMessages.some(message=>message.includes('AssertionError'))),'Loaded semantic AssertionRED, not preparation/type failure')}
    else{assert.equal(execution.code,0);assert.equal(result.numPassedTests,16);assert.equal(result.numFailedTests,0);assert.deepEqual(changed,[])}
    return{...execution,collected:16,passed:result.numPassedTests,failed:result.numFailedTests,report:relative(out,report),loaded:relative(out,loaded),loadedCount:modules.length,changed}
  }
  receipt.owning=await test('baseline')
  for(const mutation of ['drop-recap','cover-critical','wrong-session','discard-new-prompt','hide-retained-result','hide-service-explanation'])receipt.mutations.push({mutation,red:await test(mutation+'-red',mutation),green:await test(mutation+'-restored')})
  const report=join(out,'adjacent.json');receipt.adjacent=await run('adjacent',process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/focus-context-recap-menu/vitest.adjacent.config.mts','--maxWorkers=1','--reporter=json','--outputFile='+report]);const actual=JSON.parse(await readFile(report,'utf8'));receipt.adjacent={...receipt.adjacent,collected:actual.numTotalTests,passed:actual.numPassedTests,failed:actual.numFailedTests,report:relative(out,report)};assert.ok(actual.numTotalTests>0);assert.equal(actual.numFailedTestSuites,0);assert.equal(receipt.adjacent.code,0);assert.equal(actual.numFailedTests,0)
  for(const[label,config]of [['production','apps/desktop/tsconfig.json'],['owning','apps/desktop/scripts/fixtures/focus-context-recap-menu/tsconfig.owning.json']]){const result=await run(label+'-types',join(root,'node_modules/.bin/tsc'),['--noEmit','-p',config]);receipt.types.push({label,...result});assert.equal(result.code,0,await readFile(join(out,result.log),'utf8'))}
  for(const[symbol,file,pattern]of [['launcherTimelineRecap',files[0],/launcherTimelineRecap\(timeline\)/],['agentRosterMenuActions',files[2],/agentRosterMenuActions\(\{ sessionId,/],['copyTextToClipboard',files[2],/await copyTextToClipboard\(text, error => useAppStore\.getState\(\)\.reportError\(error\)\)/],['FocusContextMenu',files[1],/<FocusContextMenu sessionId=\{context\.id\}/],['RegionMenuEntryView',files[2],/<RegionMenuEntryView\b/]]){const source=await readFile(join(root,file),'utf8');assert.match(source,pattern,'Non-definition actual production caller '+symbol);receipt.callers[symbol]=[file]}
  receipt.sourceAfter=await bindings();assert.deepEqual(receipt.sourceAfter,before);receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:receipt.passed,evidence:out,failure:receipt.failure?.message,wholeTaskDone:false}))}

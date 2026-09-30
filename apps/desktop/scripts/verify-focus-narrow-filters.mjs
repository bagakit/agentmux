import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import { join,resolve,relative } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'),args=process.argv.slice(2)
assert.ok(args.length===2&&args[0]==='--slice'&&['source','scene'].includes(args[1]),'Use --slice source|scene')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const files=['apps/desktop/src/renderer/src/components/GlobalFocusSurface.tsx','apps/desktop/src/renderer/src/styles/focus.css',
  'apps/desktop/src/renderer/src/components/FocusToolbar.tsx','apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx',
  'apps/desktop/test/focus-narrow-filters.test.tsx','apps/desktop/test/fixtures/focus-filter-menu.ts',
  'apps/desktop/scripts/fixtures/focus-narrow-filters/vitest.owning.config.mts','apps/desktop/scripts/fixtures/focus-narrow-filters/vitest.adjacent.config.mts',
  'apps/desktop/scripts/fixtures/focus-narrow-filters/tsconfig.owning.json',
  'apps/desktop/test/focus-context-readability.test.tsx','apps/desktop/test/focus-lane-disconnected.test.tsx','apps/desktop/test/amux-id-search.test.tsx',
  'apps/desktop/test/focus-agent-membership.test.tsx','apps/desktop/test/focus-lane-information.test.tsx',
  'apps/desktop/src/renderer/src/App.tsx','apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/lib/focus-tab-projection.ts','apps/desktop/test/focus-toolbar-focus-return.test.tsx',
  'apps/desktop/scripts/capture-focus-narrow-filters.mjs','apps/desktop/scripts/fixtures/focus-narrow-filters/entry.mjs',
  'apps/desktop/scripts/fixtures/focus-narrow-filters/main.cjs','apps/desktop/scripts/verify-focus-narrow-filters.mjs']
const bindings=async()=>Object.fromEntries(await Promise.all(files.map(async file=>[file,hash(await readFile(join(root,file)))])))
if(args[1]==='scene'){
  const path=process.env.AGENTMUX_FOCUS_FILTER_SCENE_RECEIPT;assert.ok(path,'Exact actual scene receipt required, never substitute old screenshots')
  const scene=JSON.parse(await readFile(path,'utf8')),reviewPath=join(resolve(path,'..'),'visual-review.json'),review=JSON.parse(await readFile(reviewPath,'utf8'))
  assert.equal(scene.capturedPass,true);assert.equal(review.verdict,'pass');assert.equal(review.sceneReceiptSHA256,hash(await readFile(path)))
  const sources=await bindings();for(const [file,sha]of Object.entries(scene.inputs))assert.equal(hash(await readFile(join(root,file))),sha,'Current exact scene input '+file)
  assert.deepEqual(scene.sourceAfter,scene.inputs);assert.ok(scene.frames.length>=5)
  assert.equal(review.viewedImages.length,scene.frames.length)
  for(const frame of scene.frames){assert.ok(review.viewedImages.some(image=>image.path===frame.file&&image.sha256===frame.sha256&&image.viewed));assert.equal(hash(await readFile(join(resolve(path,'..'),frame.file))),frame.sha256)}
  assert.equal(scene.cleanup.removed,true);assert.deepEqual(scene.cleanup.remaining,[])
  console.log(JSON.stringify({passed:true,scene:path,review:reviewPath,boundary:'Scoped filter UI only; not restart/PTY/Writer/full Focus/installation',sourceBindings:sources}));process.exit(0)
}
const out=join(root,'.tmp',`focus-narrow-filter-source-${Date.now()}`);await mkdir(out,{recursive:true})
const before=await bindings(),receipt={schema:'agentmux.focus-narrow-filter-source.v1',passed:false,sourceBefore:before,owning:null,mutations:[],adjacent:null,types:[],callers:{},boundary:'Actual App/Global/Store/shared menu; PTY paint isolated. No Runtime/Writer/restart/installation/full Focus.'}
const run=async(label,command,params,env={})=>{
  let result;try{const out=await promisify(execFile)(command,params,{cwd:root,env:{...process.env,...env},timeout:120000,maxBuffer:8*1024*1024});result={code:0,signal:null,output:out.stdout+out.stderr}}catch(error){result={code:error.code,signal:error.signal,output:(error.stdout??'')+(error.stderr??'')}}
  await writeFile(join(out,label+'.log'),result.output);return{code:result.code,signal:result.signal,log:label+'.log'}
}
try{
  const test=async(label,mutation)=>{
    const report=join(out,label+'.json'),loaded=join(out,label+'-loaded.jsonl'),execution=await run(label,process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/focus-narrow-filters/vitest.owning.config.mts','--maxWorkers=1','--reporter=json','--outputFile='+report],{AGENTMUX_FOCUS_FILTER_LOADED:loaded,...(mutation?{AGENTMUX_FOCUS_FILTER_MUTATION:mutation}:{})})
    const result=JSON.parse(await readFile(report,'utf8')),modules=(await readFile(loaded,'utf8')).trim().split('\n').map(row=>JSON.parse(row));assert.equal(result.numTotalTests,6);assert.ok(modules.length>0)
    for(const file of ['apps/desktop/src/renderer/src/App.tsx',...files.slice(0,1),...files.slice(2,4)]){const found=modules.filter(row=>row.path===file);assert.ok(found.length>0,'Actual product loaded '+file);for(const item of found){assert.ok(before[file],'Source binding present '+file);assert.equal(item.sourceSHA256,before[file])}}
    const changed=modules.filter(row=>row.mutated)
    if(mutation){assert.equal(changed.length,1);assert.equal(changed[0].mutation,mutation);assert.notEqual(changed[0].sourceSHA256,changed[0].loadedSHA256);assert.ok(execution.code>0&&execution.signal===null);assert.ok(result.numFailedTests>0);assert.ok(result.testResults.flatMap(file=>file.assertionResults).some(test=>test.failureMessages.some(message=>message.includes('AssertionError'))),'Real AssertionRED, not preparation failure')}
    else{assert.equal(execution.code,0);assert.equal(result.numPassedTests,6);assert.equal(result.numFailedTests,0);assert.deepEqual(changed,[])}
    return{...execution,collected:6,passed:result.numPassedTests,failed:result.numFailedTests,report:relative(out,report),loaded:relative(out,loaded),loadedCount:modules.length,changed}
  }
  receipt.owning=await test('baseline')
  for(const mutation of ['old-64px-strategy','drop-project-selection','drop-state-selection','steal-later-focus'])receipt.mutations.push({mutation,red:await test(mutation+'-red',mutation),green:await test(mutation+'-restored')})
  const report=join(out,'adjacent.json');receipt.adjacent=await run('adjacent',process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config','apps/desktop/scripts/fixtures/focus-narrow-filters/vitest.adjacent.config.mts','--maxWorkers=1','--reporter=json','--outputFile='+report]);const actual=JSON.parse(await readFile(report,'utf8'));receipt.adjacent={...receipt.adjacent,collected:actual.numTotalTests,passed:actual.numPassedTests,failed:actual.numFailedTests};assert.equal(actual.numTotalTests,56);assert.equal(actual.numFailedTestSuites,0);assert.equal(receipt.adjacent.code,0);assert.equal(actual.numFailedTests,0)
  for(const[label,config]of [['production','apps/desktop/tsconfig.json'],['owning','apps/desktop/scripts/fixtures/focus-narrow-filters/tsconfig.owning.json']]){const check=await run(label+'-types',join(root,'node_modules/.bin/tsc'),['--noEmit','-p',config]);receipt.types.push({label,...check});assert.equal(check.code,0,await readFile(join(out,check.log),'utf8'))}
  const caller=await readFile(join(root,'apps/desktop/src/renderer/src/App.tsx'),'utf8');assert.match(caller,/<GlobalFocusSurface\b/);receipt.callers.GlobalFocusSurface=['apps/desktop/src/renderer/src/App.tsx']
  const product=await readFile(join(root,files[0]),'utf8');assert.match(product,/from '\.\/HoverDropdownMenu'/);assert.match(product,/<FilterMenu\.RadioGroup/);receipt.callers.HoverDropdownMenu=[files[0]]
  receipt.sourceAfter=await bindings();assert.deepEqual(receipt.sourceAfter,before);receipt.passed=true
}catch(error){receipt.failure={name:error.name,message:error.message,stack:error.stack};process.exitCode=1}
finally{await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify({passed:receipt.passed,evidence:out,failure:receipt.failure?.message,wholeTaskDone:false}))}

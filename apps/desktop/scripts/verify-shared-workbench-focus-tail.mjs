import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
assert.equal(process.argv[2], '--evidence'); assert.ok(process.argv[3] && process.argv.length === 4)
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = [
 'apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx',
 'apps/desktop/src/renderer/src/components/StableWorkbenchView.tsx', 'apps/desktop/src/renderer/src/lib/workbench-presentation.ts',
 'apps/desktop/src/renderer/src/lib/focus-tab-projection.ts', 'apps/desktop/test/fixtures/focus-workbench.tsx',
 'apps/desktop/test/session-history-entry-views.test.tsx', 'apps/desktop/test/shared-workbench-presentation.test.tsx',
 'apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.presentation.config.mts',
 'apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.presentation-tail.config.mts',
 'apps/desktop/scripts/fixtures/shared-workbench-bindings/tsconfig.presentation-tail.json'
]
const identities = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, hash(await readFile(join(root,path)))])))
const before = await identities()
const receipt = {schema:'agentmux.shared-workbench-focus-tail.v1',passed:false,sourceBefore:before,checks:[],
 boundary:'Existing typed preview API and actual App/Global/Workbench/SessionPane reader; only declared painting fixtures isolated. Exact Tab slice, not complete T002, Native simultaneity, Runtime/Writer, ordinary restart or user installation.'}
async function run(label, executable, args, env={}) {
 let result
 try { const out=await promisify(execFile)(executable,args,{cwd:root,env:{...process.env,NODE_OPTIONS:'--max-old-space-size=1536',...env},timeout:120000,maxBuffer:8*1024*1024});result={code:0,output:out.stdout+out.stderr} }
 catch(error){ result={code:error.code,output:(error.stdout??'')+(error.stderr??'')} }
 await writeFile(join(evidence,label+'.log'),result.output);return {code:result.code,log:label+'.log'}
}
async function test(label, config, expected, file, env={}, red=false) {
 const report=join(evidence,label+'.json')
 const execution=await run(label,join(root,'node_modules/.bin/vitest'),['run','--config',config,...file?[file]:[], '--reporter=verbose','--reporter=json','--outputFile='+report],env)
 const result=JSON.parse(await readFile(report,'utf8'))
 assert.equal(result.numTotalTests,expected,'Literal nonempty exact collection')
 if(red){assert.ok(typeof execution.code==='number'&&execution.code>0);assert.ok(result.numFailedTests>0);assert.ok(result.testResults.flatMap(f=>f.assertionResults).some(t=>t.failureMessages.some(m=>m.includes('AssertionError'))))}
 else {assert.equal(execution.code,0);assert.equal(result.numPassedTests,expected);assert.equal(result.numFailedTests,0)}
 const check={label,...execution,collected:expected,passed:result.numPassedTests,failed:result.numFailedTests};receipt.checks.push(check);return check
}
try {
 const tail='apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.presentation-tail.config.mts'
 const owner='apps/desktop/scripts/fixtures/shared-workbench-bindings/vitest.presentation.config.mts'
 for(const [label,config,file,count,env] of [
  ['owner-visible-red',tail,'apps/desktop/test/session-history-entry-views.test.tsx',10,{AGENTMUX_FOCUS_TAIL_MUTATION:'original-owner-visible',AGENTMUX_FOCUS_TAIL_LOADED:join(evidence,'owner-visible-loaded.jsonl')}],
  ['context-red',owner,undefined,9,{AGENTMUX_BINDING_PRESENTATION_MUTATION:'drop-presentation-context',AGENTMUX_BINDING_PRESENTATION_LOADED:join(evidence,'context-loaded.jsonl')}]
 ]) {
  await test(label,config,count,file,env,true)
  const loaded=JSON.parse((await readFile(Object.values(env)[1],'utf8')).trim().split('\n').find(line=>JSON.parse(line).mutated))
  assert.equal(loaded.sourceSHA256,before['apps/desktop/src/renderer/src/App.tsx']);assert.notEqual(loaded.loadedSHA256,loaded.sourceSHA256)
  await test(label+'-restored',config,count,file)
 }
 await test('related-current',tail,47)
 await test('browser-current','apps/desktop/scripts/fixtures/browser-app-workspace-cost/vitest.owning.config.mts',4)
 const types=await run('strict-tail-types',join(root,'node_modules/.bin/tsc'),['--noEmit','-p','apps/desktop/scripts/fixtures/shared-workbench-bindings/tsconfig.presentation-tail.json']);assert.equal(types.code,0);receipt.checks.push(types)
 const all=async directory=>(await Promise.all((await readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?all(join(directory,entry.name)):/\.tsx?$/.test(entry.name)?[join(directory,entry.name)]:[]))).flat()
 const product=await all(join(root,'apps/desktop/src/renderer/src'));assert.ok(product.length>0)
 const contents=await Promise.all(product.map(async path=>[path,await readFile(path,'utf8')]))
 receipt.removedLegacySymbols={}
 for(const symbol of ['focusTabId','focusPortalTargetId','focusLayoutForTab']) {const matches=contents.filter(([,text])=>new RegExp('\\b'+symbol+'\\b').test(text)).map(([path])=>path);assert.deepEqual(matches,[]);receipt.removedLegacySymbols[symbol]=matches}
 receipt.callers=contents.filter(([path,text])=>!path.endsWith('/workbench-presentation.ts')&&text.includes('useWorkbenchBrowserPresentation')).map(([path])=>path);assert.ok(receipt.callers.length>0)
 receipt.sourceAfter=await identities();assert.deepEqual(receipt.sourceAfter,before);receipt.passed=true
} finally {await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')}
process.stdout.write(JSON.stringify({passed:receipt.passed,wholeTaskDone:false,receipt:join(evidence,'receipt.json')})+'\n')

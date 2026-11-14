import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), evidence = join(root, '.local/window-return/native-orphan/components')
mkdirSync(evidence, {recursive:true})
const files = ['apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
 'apps/desktop/src/renderer/src/components/BrowserPresentationStage.tsx','apps/desktop/test/workbench-window-return.test.tsx',
 'apps/desktop/test/workbench-browser-primary-stage.test.tsx','apps/desktop/test/workbench-window-presentations.test.tsx',
 'apps/desktop/test/workbench-browser-window-components.config.mts','apps/desktop/test/workbench-window-presentations.config.mts',
 'apps/desktop/scripts/verify-workbench-browser-window-components.mjs','pnpm-lock.yaml']
const sha = value => createHash('sha256').update(value).digest('hex')
const inputs = () => Object.fromEntries(files.map(file => [file,sha(readFileSync(join(root,file)))]))
const source = inputs(), receiptPath = join(evidence,'receipt.json')
try {
 const prior=JSON.parse(readFileSync(receiptPath,'utf8'))
 if(prior.passed && JSON.stringify(prior.source)===JSON.stringify(source) && prior.runs.every(run=>
  sha(readFileSync(run.report))===run.reportSha256 && sha(readFileSync(run.loaded))===run.loadedSha256)){
  console.log('Browser window components: reusing exact source and actual consumer proof '+receiptPath);process.exit(0)
 }
}catch(error){if(error.code!=='ENOENT')throw error}
const receipt={passed:false,source,runs:[]}
const focused='^returns off-surface original|^a cold primary stage|^actual WorkspaceWorkbench|^actual child BrowserPane|^rebinds a nested original workface|^confirms the exact returned original host|^resolves one original Browser Tab'
function run(name, mutation, pattern=focused){
 const report=join(evidence,name+'.json'),loaded=join(evidence,name+'-loaded.jsonl')
 writeFileSync(loaded,'')
 const result=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--config',join(root,'apps/desktop/test/workbench-browser-window-components.config.mts'),
  '-t',pattern,'--reporter=json','--outputFile='+report],{cwd:root,encoding:'utf8',env:{...process.env,
  BROWSER_WINDOW_COMPONENT_MUTATION:mutation??'',BROWSER_WINDOW_COMPONENT_LOADED:loaded}})
 writeFileSync(join(evidence,name+'.log'),result.stdout+result.stderr)
 const proof=JSON.parse(readFileSync(report,'utf8')),graph=readFileSync(loaded,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
 assert.ok(graph.length>0,'The actual product stage graph must be loaded')
 if(mutation){
  assert.equal(result.status,1)
  assert.ok(graph.some(row=>row.mutated),'The actual declared source mutation must be consumed')
  assert.ok(proof.testResults.flatMap(file=>file.assertionResults).some(test=>test.status==='failed'&&test.failureMessages.some(message=>message.includes('AssertionError'))),'A bearing behavior assertion must fail')
 }else{assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(proof.numPassedTests,12);assert.equal(proof.numFailedTests,0)}
 receipt.runs.push({name,mutation:mutation??null,passed:proof.numPassedTests,failed:proof.numFailedTests,report,reportSha256:sha(readFileSync(report)),loaded,loadedSha256:sha(readFileSync(loaded)),graph})
 console.log(name+': '+(mutation?'bearing RED':'GREEN'))
}
try{
 run('baseline')
 run('drop-primary-stage','drop-primary-stage','^returns off-surface original')
 run('drop-window-document','drop-window-document','^returns off-surface original')
 run('eager-cold-stage','eager-cold-stage','^a cold primary stage')
 run('restored')
 assert.deepEqual(inputs(),source,'The exact tested owner sources remain unchanged')
 receipt.passed=true
}finally{writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n')}
console.log('Browser window primary stage components passed: '+receiptPath)

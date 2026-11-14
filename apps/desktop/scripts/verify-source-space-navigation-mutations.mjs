import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'),installedRoot=root.includes('/.worktrees/')?resolve(root,'../..'):root
const evidence=resolve(root,'../..','.local/state/source-space-navigation/T021/mutants'),config=resolve(root,'apps/desktop/test/source-space-navigation-mutations.config.mts')
mkdirSync(evidence,{recursive:true})
const cases=[
  {name:'old-filter',test:'existing explicit mount stays'},
  {name:'independent-mount',test:'Launcher Open original work'},
  {name:'configured-row',test:'configured resource reuses'},
  {name:'local-carrier',test:'ordinary Source Start'},
  {name:'mounted-fallback',test:'a Folder with several original Regions'},
  {name:'second-store',test:'ordinary Source Start'},
  {name:'legacy-selection',test:'confirmed Source snapshot reconciles'},
  {name:'implicit-utility',test:'implicit Source viewing'},
  {name:'ordinary-projection',test:'confirmed Source snapshot reconciles'},
  {name:'unknown-retention',test:'unknown and null Source observations'},
  {name:'implicit-prewarm',test:'implicit Source viewing'},
  {name:'capture-source',test:'Core spatial capture excludes'},
  {name:'local-file-fallback',test:'unconfirmed Source locator'},
  {name:'source-active-reseat',test:'Source active identity remains qualified through UI restore'}
]
if(process.env.AGENTMUX_SOURCE_NAV_SKIP_BUILD!=='1')execFileSync(process.execPath,[resolve(installedRoot,'apps/desktop/node_modules/electron-vite/bin/electron-vite.js'),'build'],{cwd:resolve(root,'apps/desktop'),stdio:'inherit',env:{...process.env,NODE_OPTIONS:'--max-old-space-size=8192'}})
function runCase(name){
  const log=resolve(evidence,`${name}.log`),loaded=resolve(evidence,`${name}-loaded.jsonl`),mutation=name==='control'||name==='restored'?undefined:name
  const expected=cases.find(item=>item.name===name)
  const args=[resolve(installedRoot,'node_modules/vitest/vitest.mjs'),'run','--config',config,...(expected?['-t',expected.test]:[])]
  let output
  try{output=execFileSync(process.execPath,args,{cwd:root,env:{...process.env,CI:'true',AGENTMUX_SOURCE_NAV_SKIP_BUILD:'1',AGENTMUX_SOURCE_NAV_MUTATION:mutation,AGENTMUX_SOURCE_NAV_LOADED:loaded},stdio:'pipe'})}
  catch(error){output=Buffer.concat([error.stdout??Buffer.alloc(0),error.stderr??Buffer.alloc(0)]);writeFileSync(log,output);return{code:error.status??1,log,loaded}}
  writeFileSync(log,output);return{code:0,log,loaded}
}
const receipts=[]
for(const name of ['control',...cases.map(item=>item.name),'restored']){
  const result=runCase(name),text=readFileSync(result.log,'utf8').replace(/\u001b\[[0-9;]*m/g,'')
  assert.match(text,/Test Files\s+\d+ (?:passed|failed)/,`${name}: real Vitest collection required`)
  assert.doesNotMatch(text,/No test files found|Failed to load url|CollectionError/,`${name}: collection errors are not semantic evidence`)
  if(name==='control'||name==='restored'){
    assert.equal(result.code,0,`${name}: focused control must be GREEN; see ${result.log}`)
    assert.match(text,/Test Files\s+7 passed/);assert.match(text,/Tests\s+41 passed/)
  }else{
    const expected=cases.find(item=>item.name===name)
    assert.notEqual(result.code,0,`${name}: semantic mutant unexpectedly GREEN; see ${result.log}`)
    assert.match(text,/Test Files\s+\d+ failed/);assert.match(text,/Tests\s+\d+ failed/)
    assert.ok(text.includes(expected.test),`${name}: expected behavior test ${expected.test} did not fail; see ${result.log}`)
    const loaded=readFileSync(result.loaded,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(loaded.some(entry=>entry.mutated&&entry.mutation===name&&entry.originalSHA256!==entry.loadedSHA256),`${name}: changed production source was not loaded`)
  }
  receipts.push({name,code:result.code,log:result.log,loaded:result.loaded})
}
writeFileSync(resolve(evidence,'receipt.json'),JSON.stringify({schema:'agentmux.source-space-navigation-mutations.v1',passed:true,receipts},null,2)+'\n')
console.log(JSON.stringify({passed:true,cases:receipts.map(({name,code})=>({name,code}))}))

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import { standaloneScenario } from './fixtures/browser-standalone/scenario.mjs'

const repo=resolve(import.meta.dirname,'../../..'),require=createRequire(join(repo,'apps/desktop/package.json'))
const {build}=browserSourceBuild(createRequire(require.resolve('vite'))('esbuild'))
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const output=join(repo,'.local/browser-standalone',process.argv.includes('--endpoint-recovery')?'recovery-native':process.argv.includes('--hold-budget')?'hold-native':process.argv.includes('--gate')?'gate':'proof');await mkdir(output,{recursive:true})
const pageWaits = 'packages/browser/src/browser-page-waits.ts'
const sources=['packages/browser/src/browser-standalone-host.ts','packages/browser/src/browser-owned-cdp-target.ts','packages/browser/src/browser-program-owner.ts','packages/browser/src/browser-page-dispatch.ts',pageWaits,'packages/browser/src/browser-page-input-scripts.ts','packages/browser/src/browser-operation-journal.ts','packages/browser/src/standalone.ts','packages/browser/src/bin.ts','packages/core/src/browser-lifecycle.ts','packages/core/src/control-codec.ts','packages/core/src/public-rpc-service.ts','packages/core/src/rpc-business-codec.ts','packages/core/src/rpc-native-codec.ts','packages/core/dist/control-codec.js','packages/core/dist/public-rpc-service.js','packages/core/dist/rpc-business-codec.js','packages/core/dist/rpc-native-codec.js','packages/browser/src/browser-page-interrupts.ts','packages/browser/src/browser-script-runner.ts','packages/browser/src/browser-operation-store.ts','apps/desktop/scripts/fixtures/browser-standalone/scenario.mjs']
const inputs=Object.fromEntries(await Promise.all(sources.map(async path=>[path,sha(await readFile(join(repo,path)))])))
const receipt={schema:'agentmux.standalone-browser.proof.v1',head:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),inputs,runs:[],passed:false}
const compiled=process.argv.includes('--compiled');assert.ok(!(compiled&&process.argv.includes('--mutations')),'Compiled consumer and source mutants have distinct bounded modes')
const variants=[{label:'source'},...(process.argv.includes('--mutations')?[{label:'wrong-original-target',file:sources[0],from:'const target = this.bindings.get(id)',to:'const target = [...this.bindings.values()][0]',expected:'Driving the first Browser must not touch the second target'},
 {label:'count-redirect-twice',file:pageWaits,from:'activeRequests.add(key)',to:"if (activeRequests.has(key)) activeRequests.add(key + ':redirect'); activeRequests.add(key)",expected:'Network idle must accept the original finished redirect chain'},
 {label:'stop-fence-removed',file:sources[2],from:'active.controller.abort()\n    const stopped = this.bridge.stopOperation',to:'void active.controller\n    const stopped = this.bridge.stopOperation',expected:'Stop must prevent the pending original click'}, {label:'raw-beforeunload-bypass',file:'packages/browser/src/browser-page-dispatch.ts',from:'return await context.interrupts.answerRaw(params.accept, params.promptText as string | undefined)',to:'return await session.sendCommand(method, params)',expected:'Raw beforeunload accept cannot impersonate the person'}, {label:'restored-source'}]:[])]
try{
 for(const variant of variants){
  const work=await mkdtemp(join(tmpdir(),'amux-standalone-')),bundle=compiled?join(repo,'packages/browser/dist/bin.js'):join(output,variant.label+'.mjs')
  await symlink(join(repo,'packages/browser/node_modules'),join(output,'node_modules'),'dir').catch(error=>{if(error.code!=='EEXIST')throw error})
  const row={label:variant.label,cases:[],passed:false,work};receipt.runs.push(row)
  const persist=async()=>{await writeFile(join(output,variant.label+'.json'),JSON.stringify(row,null,2)+'\n');await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')}
  const plugins=variant.file?[{name:'real-production-mutation',setup(builder){builder.onLoad({filter:new RegExp(variant.file.split('/').pop().replaceAll('.','\\.')+'$')},async args=>{assert.equal(args.path,join(repo,variant.file));const code=await readFile(args.path,'utf8');assert.equal(code.split(variant.from).length-1,1,'Mutation must hit exactly one original production block');return{contents:code.replace(variant.from,variant.to),loader:'ts',resolveDir:dirname(args.path)}})}}]:[]
  if(!compiled){
  const built=await build({absWorkingDir:repo,bundle:true,packages:'external',platform:'node',format:'esm',metafile:true,logLevel:'silent',plugins,entryPoints:['packages/browser/src/bin.ts'],outfile:bundle})
  for(const file of sources.filter(file=>file.startsWith('packages/browser/src/')))assert.ok(Object.hasOwn(built.metafile.inputs,file),'Native proof consumes actual source '+file)
  }else{row.compiledDistribution=true;row.distHashes=Object.fromEntries(await Promise.all(sources.filter(file=>file.startsWith('packages/browser/src/')).map(async file=>{const path=file.replace('/src/','/dist/').replace(/\.ts$/,'.js');return[path,sha(await readFile(join(repo,path)))];})));}
  let markerBundle, failureBundle
  if(process.argv.includes('--endpoint-recovery')){
    const faults=[{label:'marker-before-retention',file:'packages/browser/src/browser-standalone-host.ts',from:'this.engine = { profileDirectory, endpoint }; await this.persist()',to:`process.stdout.write(JSON.stringify({testCheckpoint:'native-endpoint-not-retained'})+'\\n'); await new Promise(()=>{}); this.engine = { profileDirectory, endpoint }; await this.persist()`},
      {label:'close-receipt-write-failure',file:'packages/browser/src/browser-operation-store.ts',from:'  async save(changes: BrowserOperationJournalChanges): Promise<void> {',to:`  async save(changes: BrowserOperationJournalChanges): Promise<void> { if(changes.operations.some(change=>change.metadata.lifecycleReceipt?.intent.kind==='close')) throw new Error('Injected close receipt retention failure');`}]
    for(const fault of faults){const path=join(output,fault.label+'.mjs');const source=await readFile(join(repo,fault.file),'utf8');assert.equal(source.split(fault.from).length-1,1);const changed=source.replace(fault.from,fault.to)
      await build({absWorkingDir:repo,bundle:true,packages:'external',platform:'node',format:'esm',logLevel:'silent',entryPoints:['packages/browser/src/bin.ts'],outfile:path,plugins:[{name:fault.label,setup(builder){builder.onLoad({filter:new RegExp(fault.file.split('/').pop().replaceAll('.','\\.')+'$')},args=>{assert.equal(args.path,join(repo,fault.file));return{contents:changed,loader:'ts',resolveDir:dirname(args.path)}})}}]})
      row[fault.label]={originalSha256:sha(source),injectedSha256:sha(changed),bundleSha256:sha(await readFile(path))}
      if(fault.label==='marker-before-retention')markerBundle=path;else failureBundle=path
    }
  }
  row.bundleSha256=sha(await readFile(bundle));await persist()
  try{await standaloneScenario({repo,bundle,work,executablePath:process.env.AGENTMUX_BROWSER_EXECUTABLE ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',receipt:row,persist,holdOnly:process.argv.includes('--hold-budget'),endpointRecovery:process.argv.includes('--endpoint-recovery'),markerBundle,failureBundle});assert.equal(variant.file,undefined,'A production mutation must fail its native witness')}
  catch(error){row.error=String(error?.stack??error);if(!variant.file)throw error;assert.match(row.error,new RegExp(variant.expected,'i'),'RED must come from the intended native witness');row.mutationRejected=true}
  finally{await persist();await rm(join(work,'state','engine-profile'),{recursive:true,force:true,maxRetries:5,retryDelay:200})}
 }
 assert.ok(receipt.runs.length>0);receipt.passed=true
}finally{await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')}
console.log(JSON.stringify({passed:receipt.passed,receipt:join(output,'receipt.json'),runs:receipt.runs.map(row=>({label:row.label,passed:row.passed,mutationRejected:row.mutationRejected}))}))

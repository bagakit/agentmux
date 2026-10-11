import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { mkdirSync,readFileSync,writeFileSync } from 'node:fs'
import { join,relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../../../',import.meta.url)),out=join(root,'.tmp/remote-application-access/proof-'+randomUUID())
mkdirSync(out,{recursive:true})
const sha=value=>createHash('sha256').update(value).digest('hex')
const paths=['packages/core/src/application-access.ts','packages/core/src/application-access-owner.ts','packages/core/src/public-rpc.ts','packages/core/src/public-rpc-service.ts','packages/core/src/rpc-native-codec.ts','packages/core/src/settings-cli.ts','packages/core/src/agentmux-cli-commands.ts','packages/core/src/index.ts','packages/core/package.json','apps/desktop/src/main/application-access-owner.ts','apps/desktop/src/main/index.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/main/ipc-sender-trust.ts','packages/core/test/application-access.test.ts','apps/desktop/test/application-access-main.test.ts','packages/core/test/fixtures/application-access-connector.mjs','packages/core/test/fixtures/application-access-owner-process.mjs','packages/core/test/application-access.vitest.config.mts','packages/core/scripts/verify-application-access.mjs']
const inputs=Object.fromEntries(paths.map(path=>[path,sha(readFileSync(join(root,path)))]))
const environment={node:process.version,platform:process.platform,arch:process.arch}
const compiledPaths=['agentmux.js','application-access.js','application-access-owner.js','public-rpc-service.js','settings-cli.js','agentmux-cli-commands.js'].map(path=>'packages/core/dist/'+path)
function consume(){
  try {
    const latest=JSON.parse(readFileSync(join(root,'.tmp/remote-application-access/latest-domain-proof.json'))),bytes=readFileSync(join(root,latest.receipt));assert.equal(sha(bytes),latest.sha256)
    const p=JSON.parse(bytes);assert.equal(p.schema,'agentmux.application-access-proof.v1');assert.equal(p.passed,true);assert.deepEqual(p.inputs,inputs);assert.deepEqual(p.environment,environment)
    for(const path of compiledPaths)assert.equal(sha(readFileSync(join(root,path))),p.compiled[path])
    const check=(run,red=false)=>{const bytes=readFileSync(join(root,run.report));assert.equal(sha(bytes),run.reportSHA256);const report=JSON.parse(bytes),assertions=report.testResults.flatMap(test=>test.assertionResults);assert.ok(assertions.length>=16);assert.equal(assertions.length,run.total);assert.equal(report.numTotalTests,run.total);assert.equal(report.numFailedTests,run.failed);assert.equal(run.exitCode,red?1:0);assert.equal(run.failed===0,!red);assert.ok(assertions.some(a=>a.fullName.includes('independent service process restart')));if(red)assert.ok(assertions.some(a=>a.status==='failed'&&a.failureMessages.some(m=>m.includes('AssertionError'))));else assert.ok(assertions.every(a=>a.status==='passed'));assert.equal(sha(readFileSync(join(root,run.log))),run.logSHA256);const loadedBytes=readFileSync(join(root,run.loaded));assert.equal(sha(loadedBytes),run.loadedSHA256);const owner=loadedBytes.toString().trim().split('\n').map(line=>JSON.parse(line)).filter(v=>v.path==='packages/core/src/application-access-owner.ts');assert.ok(owner.length>0);assert.ok(owner.every(v=>v.sourceSHA256===inputs[v.path]&&v.applied===red));if(red){assert.equal(sha(readFileSync(join(root,run.transformedOwner))),run.transformedOwnerSHA256);assert.ok(owner.every(v=>v.consumedSHA256===run.transformedOwnerSHA256&&v.consumedSHA256!==v.sourceSHA256))}}
    check(p.baseline);assert.equal(p.mutations.length,2);for(const m of p.mutations){check(m.red,true);check(m.green)}
    assert.ok(p.callers.length>=5);for(const c of p.callers){assert.equal(sha(readFileSync(join(root,c.path))),c.sha256);assert.ok(readFileSync(join(root,c.path),'utf8').includes(c.symbol))}
    console.log(JSON.stringify({passed:true,consumedCurrentProof:true,receipt:latest.receipt,tests:p.baseline.total,mutations:p.mutations.length}));return true
  } catch {return false}
}
if(consume())process.exit(0)
if(process.argv.includes('--consume-only'))throw new Error('The exact current application access proof could not be consumed. Run the domain verifier to produce fresh evidence.')
function command(name,args){const run=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024});writeFileSync(join(out,name+'.log'),run.stdout+run.stderr);assert.equal(run.status,0,name+' failed; see '+join(out,name+'.log'));return {log:relative(root,join(out,name+'.log')),sha256:sha(run.stdout+run.stderr)}}
const build=command('core-build',['node_modules/typescript/bin/tsc','-p','packages/core/tsconfig.build.json','--pretty','false'])
const compiled=Object.fromEntries(compiledPaths.map(path=>[path,sha(readFileSync(join(root,path)))]))
function run(name,mutant,red=false){
  const dir=join(out,name);mkdirSync(dir,{recursive:true})
  const report=join(dir,'report.json'),r=spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','packages/core/test/application-access.vitest.config.mts','--reporter=json','--outputFile='+report],{cwd:root,env:{...process.env,AGENTMUX_APPLICATION_ACCESS_EVIDENCE:dir,AGENTMUX_APPLICATION_ACCESS_MUTANT:mutant},encoding:'utf8',maxBuffer:8*1024*1024})
  writeFileSync(join(dir,'run.log'),r.stdout+r.stderr)
  const result=JSON.parse(readFileSync(report)),assertions=result.testResults.flatMap(test=>test.assertionResults)
  assert.ok(assertions.length>=16&&assertions.length===result.numTotalTests,'Nonempty actual consumer assertions')
  assert.equal(r.status,red?1:0);assert.equal(result.numFailedTests===0,!red)
  if(red)assert.ok(assertions.some(a=>a.status==='failed'&&a.failureMessages.some(message=>message.includes('AssertionError'))),'Mutation red must be a semantic assertion')
  const loaded=readFileSync(join(dir,'loaded-source.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  const owner=loaded.filter(item=>item.path==='packages/core/src/application-access-owner.ts');assert.ok(owner.length>0,'Actual domain owner loaded')
  assert.ok(owner.every(item=>item.sourceSHA256===inputs[item.path]&&item.applied===red));if(red)assert.ok(owner.every(item=>item.consumedSHA256!==item.sourceSHA256))
  return {log:relative(root,join(dir,'run.log')),logSHA256:sha(readFileSync(join(dir,'run.log'))),name,mutant,passed:!red,exitCode:r.status,total:assertions.length,failed:result.numFailedTests,report:relative(root,report),reportSHA256:sha(readFileSync(report)),loaded:relative(root,join(dir,'loaded-source.jsonl')),loadedSHA256:sha(readFileSync(join(dir,'loaded-source.jsonl'))),...(red?{transformedOwner:relative(root,join(dir,'loaded-owner.ts')),transformedOwnerSHA256:sha(readFileSync(join(dir,'loaded-owner.ts')))}:{})}
}
const baseline=run('baseline','baseline'),mutations=[]
for(const mutant of ['verification','reconciliation']){const red=run(mutant+'-red',mutant,true),green=run(mutant+'-restored','baseline');mutations.push({mutant,red,green})}
for(const [path,hash] of Object.entries(inputs))assert.equal(sha(readFileSync(join(root,path))),hash,'Accepted source changed: '+path)
for(const [path,hash] of Object.entries(compiled))assert.equal(sha(readFileSync(join(root,path))),hash,'Compiled CLI candidate changed: '+path)
const callers=[['packages/core/src/public-rpc-service.ts','this.ports.applicationAccess.call'],['packages/core/src/agentmux-cli-commands.ts',"settings('settings.applications.apply'"],['apps/desktop/src/main/index.ts','createDesktopApplicationAccessOwner(runtime'],['apps/desktop/src/main/ipc.ts',"handleWithEvent('applications:call'"],['apps/desktop/src/main/ipc.ts','applicationAccess: args.applicationAccess']].map(([path,symbol])=>{assert.ok(readFileSync(join(root,path),'utf8').includes(symbol));return {path,symbol,sha256:inputs[path]}})
const receipt={schema:'agentmux.application-access-proof.v1',passed:true,inputs,compiled,environment,build,baseline,mutations,callers,conditions:'Private Unix public RPC, actual built CLI, controlled real child-process connector, independent service process SIGKILL/restart with original SQLite and endpoint, independent Main registered-handler/resolver consumption. Does not claim an external application login or a real remote SSH acceptance.'}
writeFileSync(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');writeFileSync(join(root,'.tmp/remote-application-access/latest-domain-proof.json'),JSON.stringify({receipt:relative(root,join(out,'receipt.json')),sha256:sha(readFileSync(join(out,'receipt.json')))},null,2)+'\n')
console.log(JSON.stringify({passed:true,receipt:relative(root,join(out,'receipt.json')),tests:baseline.total,mutations:mutations.length}))

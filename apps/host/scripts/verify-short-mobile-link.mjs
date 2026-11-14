import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
const root=resolve(import.meta.dirname,'../../..'), require=createRequire(join(root,'apps/mobile/package.json'))
const output=resolve(process.argv[2]??join(root,'.tmp/short-mobile-link',randomUUID())), vitest=require.resolve('vitest/vitest.mjs')
await mkdir(output,{recursive:true})
const sha=value=>createHash('sha256').update(value).digest('hex'), hashes=async files=>Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(join(root,file)))])))
const owned=[
  'packages/relay/src/connection-offer.ts','packages/relay/test/connection-offer.test.ts',
  'packages/core/src/agentmux.ts','packages/core/src/public-rpc-client.ts','packages/core/src/public-rpc-device.ts','packages/core/src/mobile-web-codec.ts',
  'apps/host/src/host.ts','packages/core/src/device-administration.ts','apps/host/src/mobile-assets-owner.ts','apps/host/src/mobile-page-response.ts',
  'apps/mobile/src/main.tsx','apps/mobile/src/connection/MobileConnectionRoot.tsx','apps/mobile/src/mobile-web/page-identity.ts','apps/mobile/src/mobile-web/update-safety.ts',
  'apps/host/test/mobile-link.test.ts','apps/host/test/short-mobile-http.test.ts','apps/mobile/test/short-connection-entry.test.tsx','apps/mobile/test/short-mobile-link.config.mts',
  'apps/mobile/test/mobile-update-safety.test.tsx','apps/desktop/test/toolkit-phone-result-chain.test.tsx',
  'apps/host/scripts/verify-short-mobile-link.mjs','apps/host/scripts/fixtures/short-mobile-link/capture.mjs','apps/host/scripts/fixtures/short-mobile-link/main.cjs'
]
const inputs=await hashes(owned), runs=[], receipt={passed:false,inputs,runs,boundary:'Actual private Host/public RPC/compiled CLI, Toolkit owner/product UI, actual Mobile main/Root, private same-origin Chromium processes and loaded-source assertions. No user App, physical phone, user Session or installation claim.'}
const env={...process.env,VITEST_MAX_THREADS:'2',VITEST_MAX_FORKS:'2'}
for(const key of ['SHORT_MOBILE_MUTATION','SHORT_MOBILE_LOADED','SHORT_LINK_HELLO_MUTATION','SHORT_LINK_HELLO_LOADED','AGENTMUX_CONNECTION_LINK_MUTANT','AGENTMUX_CONNECTION_LINK_LOADED','AGENTMUX_TEST_OBJECT_CLI','AGENTMUX_PHONE_CONNECTION_MUTATION'])delete env[key]
async function command(label,args,{cwd=root,extra={},exit=0}={}){
  const child=spawn(process.execPath,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let log=''
  child.stdout.on('data',bytes=>{log+=bytes});child.stderr.on('data',bytes=>{log+=bytes})
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve)})
  await writeFile(join(output,label+'.log'),log);assert.equal(code,exit,label+': '+log.slice(-4000))
  return code
}
function assertions(report,{executed,red=false,pending}={}){
  const tests=report.testResults.flatMap(suite=>suite.assertionResults), ran=tests.filter(test=>test.status==='passed'||test.status==='failed'),failed=ran.filter(test=>test.status==='failed')
  assert.ok(ran.length>0,'Actual behavioral tests must execute');if(executed!==undefined)assert.equal(ran.length,executed)
  if(pending!==undefined)assert.equal(report.numPendingTests,pending)
  assert.equal(report.numFailedTests,red?1:0);assert.equal(failed.length,red?1:0);assert.equal(report.numRuntimeErrorTestSuites??0,0)
  if(red)assert.ok(failed[0].failureMessages.some(message=>message.includes('AssertionError')),'The actual consumer assertion must bear the mutation')
  return {executed:ran.length,failed:failed.length,pending:report.numPendingTests,failures:failed.map(test=>({name:test.fullName,messages:test.failureMessages}))}
}
async function test(label,config,{extra={},filter,files=[],executed,red=false,pending}={}){
  const report=join(output,label+'.json'),args=[vitest,'run','--config',config,...files,'--reporter=json','--outputFile='+report]
  if(filter)args.push('-t',filter)
  const exitCode=await command(label,args,{extra,exit:red?1:0}),result=assertions(JSON.parse(await readFile(report,'utf8')),{executed,red,pending})
  runs.push({label,exitCode,report:relative(root,report),...result});console.log(label+': '+(red?'expected assertion red':'green'))
}
const lines=async file=>(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
async function sourceLoads(file,mutation){
  const loaded=await lines(file);assert.ok(loaded.length>0,'Actual production modules must load')
  for(const row of loaded){assert.equal(row.sourceSHA256,sha(await readFile(join(root,row.file))));if(row.mutation)assert.notEqual(row.loadedSHA256,row.sourceSHA256);else assert.equal(row.loadedSHA256,row.sourceSHA256)}
  const changed=loaded.filter(row=>row.mutation);assert.equal(new Set(changed.map(row=>row.file)).size,mutation?1:0)
  if(mutation)assert.ok(changed.every(row=>row.mutation===mutation))
}
async function consumeHello(){
  const path=join(root,'.tmp/mobile-next/hello/current-receipt.json'), value=JSON.parse(await readFile(path,'utf8'))
  assert.equal(value.passed,true);assert.equal(Object.keys(value.inputs).length,7);assert.deepEqual(await hashes(Object.keys(value.inputs)),value.inputs,'Original encrypted identity evidence must bind the exact current owners')
  assert.equal(value.runs.length,4)
  for(const run of value.runs){
    const red=run.label.startsWith('skip-'), summary=assertions(JSON.parse(await readFile(resolve(root,run.report),'utf8')),{executed:red?1:3,red,pending:red?2:0})
    if(red)assert.ok(summary.failures[0].name.includes(run.label==='skip-hello-host'?'foreign encrypted hello Host':'raw RPC hello refuses a foreign Host'))
    assert.equal(run.exitCode,red?1:0);const loaded=await lines(resolve(root,run.loaded));assert.ok(loaded.length>0)
    const changed=loaded.filter(row=>row.originalSHA256!==row.loadedSHA256);assert.equal(new Set(changed.map(row=>row.path)).size,red?1:0)
    for(const row of loaded)assert.equal(row.originalSHA256,value.inputs[row.path])
    receipt.hello??={receipt:relative(root,path),sha256:sha(await readFile(path)),inputs:value.inputs,runs:[]};receipt.hello.runs.push({...run,...summary})
  }
}
try{
  await consumeHello()
  await command('relay-build',[join(root,'packages/relay/node_modules/typescript/bin/tsc'),'-p','packages/relay/tsconfig.json'])
  await command('core-build',['scripts/build.mjs'],{cwd:join(root,'packages/core')})
  await command('host-types',[join(root,'apps/host/node_modules/typescript/bin/tsc'),'--noEmit','-p','apps/host/tsconfig.json'])
  await command('mobile-types',[join(root,'apps/mobile/node_modules/typescript/bin/tsc'),'--noEmit','-p','apps/mobile/tsconfig.json'])
  await command('mobile-build',[join(root,'apps/mobile/node_modules/vite/bin/vite.js'),'build'],{cwd:join(root,'apps/mobile')})
  const config='apps/mobile/test/short-mobile-link.config.mts'
  let loaded=join(output,'baseline-loaded.jsonl')
  await test('baseline',config,{extra:{SHORT_MOBILE_LOADED:loaded},executed:37,pending:0});await sourceLoads(loaded)
  for(const mutation of ['metadata-key','digest-active','page-digest']){
    loaded=join(output,mutation+'-loaded.jsonl');await test(mutation,config,{extra:{SHORT_MOBILE_MUTATION:mutation,SHORT_MOBILE_LOADED:loaded},executed:1,red:true});await sourceLoads(loaded,mutation)
  }
  loaded=join(output,'restored-loaded.jsonl');await test('restored',config,{extra:{SHORT_MOBILE_LOADED:loaded},executed:37,pending:0});await sourceLoads(loaded)
  await test('toolkit-short-chain','apps/desktop/test/vitest.phone-connection.config.mts',{files:['apps/desktop/test/toolkit-phone-result-chain.test.tsx'],filter:'official external-cwd Phone producer',executed:3,pending:2})
  await test('retention-and-io','apps/host/test/mobile-web-owner.config.mts',{extra:{MOBILE_WEB_OWNER_LOADED:join(output,'retention-loaded.jsonl')},executed:4,pending:0})
  await test('entry-update','apps/mobile/test/mobile-update-safety.config.mts',{files:['apps/mobile/test/mobile-update-safety.test.tsx'],filter:'opens the same-origin root',executed:2,pending:31})
  await test('original-connection-handoff','apps/mobile/test/mobile-update-safety.config.mts',{files:['apps/mobile/test/mobile-update-connection.test.tsx'],executed:7,pending:0})
  await command('same-origin-processes',['apps/host/scripts/fixtures/short-mobile-link/capture.mjs',join(output,'processes')])
  const capture=JSON.parse(await readFile(join(output,'processes/receipt.json'),'utf8'));assert.equal(capture.passed,true);assert.equal(capture.metadataReads,1);receipt.processes={receipt:relative(root,join(output,'processes/receipt.json')),sha256:sha(await readFile(join(output,'processes/receipt.json')))}
  const {connectionOfferUrl,connectionLinkUrl}=await import('../../../packages/relay/dist/connection-offer.js'),{mobileAssetNamespace}=await import('../../../packages/core/dist/mobile-web-codec.js')
  const origin='http://10.0.0.44:8443',offer={v:2,serverId:'11111111-1111-4111-8111-111111111111',daemonPublicKeyB64:Buffer.alloc(32,7).toString('base64'),relay:{endpoint:'10.0.0.44:8443',useTls:false}},digest='sha256:'+'a'.repeat(64)
  receipt.lengths={controlled:true,fullShare:connectionOfferUrl(origin+'/',offer).length,shortShare:connectionLinkUrl(origin+'/',offer).length,fullDocument:(origin+'/mobile/'+'b'.repeat(32)+'/'+digest.slice(7)+'/index.html').length,shortDocument:(origin+mobileAssetNamespace(digest)).length,publicKeyBytes:32,digestBytes:32}
  assert.ok(receipt.lengths.shortShare<receipt.lengths.fullShare);assert.ok(receipt.lengths.shortDocument<receipt.lengths.fullDocument)
  assert.deepEqual(await hashes(owned),inputs,'Owned source must remain the same throughout verification');receipt.passed=true
}catch(error){receipt.error={message:error.message,stack:error.stack};process.exitCode=1}
finally{await writeFile(join(output,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:receipt.passed,receipt:relative(root,join(output,'receipt.json'))}))}

import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync, execFileSync } from 'node:child_process'

const root=resolve(import.meta.dirname,'../../..'),directory=resolve(root,'.tmp/mobile-asset-transfer','run-'+randomUUID())
mkdirSync(directory,{recursive:true})
const observed=['apps/host/src/mobile-assets-owner.ts','apps/host/src/mobile-assets.ts','apps/host/src/mobile-page-response.ts','apps/host/test/mobile-asset-transfer.test.ts']
const inputs=[...observed,'apps/host/test/mobile-asset-transfer.config.mts','apps/host/test/mobile-asset-transfer-mutations.mjs','apps/host/test/fixtures/mobile-asset-transfer-browser.cjs']
const sha=value=>createHash('sha256').update(value).digest('hex'),sourceSHA256=Object.fromEntries(inputs.map(file=>[file,sha(readFileSync(resolve(root,file)))]))
const receipt={schema:'agentmux.mobile-asset-transfer-proof.v1',passed:false,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSHA256,runs:[],boundary:'Actual MobileAssetsOwner activation/HTTP → isolated Chromium ordinary navigation; original gzip producer and transport cancellation. No user Browser, live Session/Run, App, package or install operation.'}
function unchanged(){for(const [file,digest] of Object.entries(sourceSHA256))assert.equal(sha(readFileSync(resolve(root,file))),digest,'Source changed during original transfer proof: '+file)}
function run(name,mutation,bearing){
  unchanged()
  const out=resolve(directory,name);mkdirSync(out)
  const report=resolve(out,'tests.json'),loaded=resolve(out,'loaded.jsonl')
  const args=['exec','vitest','run','--config','apps/host/test/mobile-asset-transfer.config.mts','--reporter=json','--outputFile',report,'--maxWorkers=1']
  if(bearing)args.push('-t',bearing)
  const result=spawnSync('pnpm',args,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024,env:{...process.env,VITEST_MAX_FORKS:'1',VITEST_MAX_THREADS:'1',MOBILE_ASSET_TRANSFER_EVIDENCE:out,MOBILE_ASSET_TRANSFER_LOADED:loaded,MOBILE_ASSET_TRANSFER_MUTANT:mutation??''}})
  writeFileSync(resolve(out,'command.log'),(result.stdout??'')+(result.stderr??''))
  assert.equal(result.signal,null)
  assert.ok(readFileSync(report).byteLength>0,'Nonempty original test report')
  const tests=JSON.parse(readFileSync(report,'utf8')),proofs=readFileSync(loaded,'utf8').trim().split('\n').map(line=>JSON.parse(line))
  for(const file of observed)assert.ok(proofs.some(row=>row.file===file&&row.originalSHA256===sourceSHA256[file]),'Original owner/test actually evaluated: '+file)
  const failures=tests.testResults.flatMap(file=>file.assertionResults.filter(test=>test.status==='failed'))
  if(mutation){
    assert.notEqual(result.status,0,'A loaded original-owner mutation must fail')
    assert.equal(tests.numFailedTests,1);assert.equal(failures.length,1)
    assert.ok(failures[0].fullName.includes(bearing)&&failures[0].failureMessages.some(message=>message.includes('AssertionError')),'The mutation fails its actual HTTP/browser behavior assertion')
    assert.ok(proofs.some(row=>row.file===observed[0]&&row.originalSHA256!==row.loadedSHA256&&row.mutation===mutation),'The actual evaluated owner contains the mutation')
  }else{
    assert.equal(result.status,0,'Inspect the original command log: '+out)
    assert.equal(tests.success,true);assert.equal(tests.numPassedTests,4);assert.equal(tests.numFailedTests,0);assert.equal(tests.numPendingTests,0)
    const browser=JSON.parse(readFileSync(resolve(out,'browser/receipt.json'),'utf8'))
    assert.equal(browser.sourceSHA256,sourceSHA256['apps/host/test/fixtures/mobile-asset-transfer-browser.cjs'],'The actual Chromium fixture bytes match this candidate')
  }
  unchanged()
  receipt.runs.push({name,mutation:mutation??null,exitCode:result.status,passed:tests.numPassedTests,failed:tests.numFailedTests,discovered:tests.numTotalTests,bearing:failures.map(test=>test.fullName),report:relative(root,report),loaded:relative(root,loaded),reportSHA256:sha(readFileSync(report)),loadedSHA256:sha(readFileSync(loaded))})
  writeFileSync(resolve(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  process.stdout.write(JSON.stringify({name,passed:tests.numPassedTests,failed:tests.numFailedTests})+'\n')
}
try{
  run('baseline')
  run('disable-compression','disable-compression','negotiates gzip through original HTTP')
  run('disable-cache','disable-cache','ordinary Chromium document navigations')
  run('restored')
  receipt.passed=true
}catch(error){receipt.error={message:error.message,stack:error.stack};process.exitCode=1}
writeFileSync(resolve(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
process.stdout.write(JSON.stringify({passed:receipt.passed,receipt:relative(root,resolve(directory,'receipt.json'))})+'\n')

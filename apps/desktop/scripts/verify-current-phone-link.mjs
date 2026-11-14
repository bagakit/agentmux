import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {dirname,resolve,relative} from 'node:path'
import {captureCraft} from './fixtures/toolkit-visual-craft/capture.mjs'
const root=resolve(import.meta.dirname,'../../..'),require=createRequire(resolve(root,'apps/desktop/package.json'))
const vitest=resolve(dirname(require.resolve('vitest/package.json')),'vitest.mjs')
const output=resolve(root,'.tmp/current-phone-link','run-'+randomUUID());await mkdir(output,{recursive:true})
const files=['apps/desktop/src/renderer/src/components/toolkit/MobileConnectionResult.tsx','apps/desktop/src/renderer/src/components/settings/DeviceManagementSettings.tsx',
 'apps/desktop/src/renderer/src/styles/mobile-connection.css',
 'apps/desktop/src/main/toolkit-owner.ts','apps/desktop/src/main/toolkit-custom-owner.ts','apps/desktop/src/main/device-management-ipc.ts',
 'apps/desktop/resources/toolkit/mobile-connection/query.mjs','apps/host/src/host.ts','apps/host/src/device-administration.ts','apps/host/src/mobile-link-candidates.ts',
 'apps/desktop/test/mobile-connection-toolkit.test.tsx','apps/desktop/test/settings-direct-actions.test.tsx','apps/desktop/test/toolkit-phone-result-chain.test.tsx',
 'apps/desktop/test/vitest.phone-connection.config.mts','apps/host/test/mobile-link.test.ts','apps/host/test/mobile-link.config.mts',
 'apps/desktop/scripts/verify-current-phone-link.mjs','apps/desktop/scripts/fixtures/toolkit-visual-craft/capture.mjs',
 'apps/desktop/scripts/fixtures/toolkit-visual-craft/phone-entry.tsx','apps/desktop/scripts/fixtures/toolkit-visual-craft/phone-main.cjs','apps/desktop/scripts/fixtures/toolkit-visual-craft/phone.html']
const sha=v=>createHash('sha256').update(v).digest('hex'),inputs=Object.fromEntries(await Promise.all(files.map(async file=>[file,sha(await readFile(resolve(root,file)))])))
const receipt={schema:'agentmux.current-phone-link-verification.v1',passed:false,inputs,runner:{execPath:process.execPath,vitest},runs:[]}
try{
 const cases=[['baseline-ui','ui'],['baseline-host','host'],['phone-cached-current-copy','ui','apps/desktop/src/renderer/src/components/settings/DeviceManagementSettings.tsx'],
  ['phone-premature-current-copy','ui','apps/desktop/src/renderer/src/components/toolkit/MobileConnectionResult.tsx'],['frozen-interfaces','host','apps/host/src/host.ts'],['restored-ui','ui'],['restored-host','host']]
 for(const[label,kind,mutationFile]of cases){
  const report=resolve(output,label+'-tests.json'),loaded=resolve(output,label+'-loaded.jsonl');await writeFile(loaded,'')
  const env={...process.env,VITEST_MAX_THREADS:'2',VITEST_MAX_FORKS:'2'};delete env.AGENTMUX_PHONE_CONNECTION_MUTATION;delete env.AGENTMUX_MOBILE_LINK_MUTANT
  if(kind==='ui'){env.AGENTMUX_PHONE_CONNECTION_LOADED=loaded;if(mutationFile)env.AGENTMUX_PHONE_CONNECTION_MUTATION=label}
  else{env.AGENTMUX_CURRENT_PHONE_LINK_LOADED=loaded;if(mutationFile)env.AGENTMUX_MOBILE_LINK_MUTANT=label}
  const args=[vitest,'run','--config',kind==='ui'?'apps/desktop/test/vitest.phone-connection.config.mts':'apps/host/test/mobile-link.config.mts','--reporter=json','--outputFile='+report]
  if(kind==='host')args.push('-t','changed NIC candidates')
  const run=await new Promise((accept,reject)=>{const child=spawn(process.execPath,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});let log='';child.stdout.on('data',v=>{log+=v});child.stderr.on('data',v=>{log+=v});child.on('error',reject);child.on('close',(code,signal)=>accept({code,signal,log}))})
  await writeFile(resolve(output,label+'.log'),run.log);assert.equal(run.signal,null)
  const result=JSON.parse(await readFile(report,'utf8')),tests=result.testResults.flatMap(v=>v.assertionResults).filter(v=>!['pending','skipped'].includes(v.status))
  const records=(await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(v=>JSON.parse(v))
  const required=kind==='ui'?['apps/desktop/src/renderer/src/components/toolkit/MobileConnectionResult.tsx','apps/desktop/src/renderer/src/components/settings/DeviceManagementSettings.tsx','apps/desktop/src/main/toolkit-custom-owner.ts','apps/desktop/test/toolkit-phone-result-chain.test.tsx']:['apps/host/src/host.ts','apps/host/src/device-administration.ts','apps/host/test/mobile-link.test.ts']
  for(const file of mutationFile?[mutationFile,kind==='host'?'apps/host/test/mobile-link.test.ts':label==='phone-premature-current-copy'?'apps/desktop/test/toolkit-phone-result-chain.test.tsx':'apps/desktop/test/settings-direct-actions.test.tsx']:required)assert.ok(records.some(v=>v.file===file),'Actual evaluated owner/consumer required: '+file)
  if(mutationFile){assert.notEqual(run.code,0);assert.equal(tests.length,1);assert.equal(result.numFailedTests,1);assert.equal(result.numPassedTests,0);assert.ok(tests[0].failureMessages.some(v=>v.includes('AssertionError')),'Mutation must bear a real assertion, not import/timeout');assert.ok(records.some(v=>v.file===mutationFile&&v.mutation===label&&v.originalSHA256===inputs[mutationFile]&&v.loadedSHA256!==v.originalSHA256),'Changed production source must evaluate')}
  else{assert.equal(run.code,0,run.log);assert.ok(tests.length>0);assert.equal(result.numFailedTests,0);assert.equal(result.numPassedTests,tests.length);assert.ok(records.every(v=>v.originalSHA256===v.loadedSHA256))}
  for(const[file,hash]of Object.entries(inputs))assert.equal(sha(await readFile(resolve(root,file))),hash,'Source remains unchanged: '+file)
  receipt.runs.push({label,code:run.code,tests:tests.map(v=>({name:v.fullName,status:v.status})),evaluated:records});process.stdout.write(JSON.stringify({label,passed:result.numPassedTests,failed:result.numFailedTests})+'\n')
 }
 if(!process.argv.includes('--no-capture')){
  const evidence=resolve(output,'visual');await mkdir(evidence,{recursive:true})
  receipt.visual=await captureCraft({root,evidence,bind:file=>readFile(resolve(root,file)),proofFiles:files,mode:'current-phone-link'})
 }
 receipt.passed=true
}catch(error){receipt.error={message:error.message,stack:error.stack};process.exitCode=1}
await writeFile(resolve(output,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');process.stdout.write(JSON.stringify({passed:receipt.passed,receipt:relative(root,resolve(output,'receipt.json'))})+'\n')

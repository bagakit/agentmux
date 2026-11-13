import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { mkdir,mkdtemp,readFile,writeFile,rm } from 'node:fs/promises'
import { resolve,join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { standaloneScenario } from './fixtures/browser-standalone/scenario.mjs'
import { listProbeProcesses } from './probe-process.mjs'
const repo=resolve(import.meta.dirname,'../../..'),require=createRequire(join(repo,'packages/browser/package.json')),puppeteer=require('puppeteer-core').default
const executablePath=process.env.AGENTMUX_BROWSER_TEST_EXECUTABLE??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),root=join(repo,'.local/browser-task-prompt');await mkdir(root,{recursive:true})
const out=await mkdtemp(join(root,'attempt-')),work=await mkdtemp('/tmp/amux-task-prompt-')
const receipt={schema:'agentmux.browser-task-prompt.protocol.v1',passed:false,cases:[],dialogs:[],inputs:{},boundary:'Compiled public browser.run through the original standalone Chrome/Node BrowserProgramOwner. This proves its native prompt protocol and fresh answer, not a Node public task.run owner or Electron prompt support.'}
const persist=()=>writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
for(const file of ['packages/core/dist/agentmux.js','packages/core/src/control-browser-targets.ts','packages/browser/src/browser-page-interrupts.ts','packages/browser/dist/browser-page-interrupts.js','packages/browser/src/browser-owned-cdp-target.ts','packages/browser/dist/browser-owned-cdp-target.js','packages/browser/src/browser-program-owner.ts','packages/browser/dist/browser-program-owner.js','packages/browser/dist/bin.js','apps/desktop/scripts/fixtures/browser-standalone/scenario.mjs','apps/desktop/scripts/verify-browser-task-prompt.mjs'])receipt.inputs[file]=hash(await readFile(join(repo,file)))
try{
 await standaloneScenario({repo,bundle:join(repo,'packages/browser/dist/bin.js'),work,executablePath,receipt,persist,exercise:async({one,client,cli,observe})=>{
  await observe('compiled-cli-original-chrome-prompt-protocol-and-fresh-answer',async()=>{
   const saved=JSON.parse(await readFile(join(work,'state/browser-targets.json'),'utf8')),binding=saved.targets.find(target=>target.id===one.id)
   assert.ok(binding?.targetId,'Original public Browser has one durable native target identity')
   const engine=await puppeteer.connect({browserWSEndpoint:saved.engine.endpoint,protocolTimeout:15000,defaultViewport:null})
   let observer
   try{
    // Query only this private engine's protocol identities; select the exact saved target ID.
    for(const target of engine.targets().filter(target=>target.type()==='page')){
     const session=await target.createCDPSession(),{targetInfo}=await session.send('Target.getTargetInfo')
     if(targetInfo.targetId===binding.targetId){assert.equal(observer,undefined);observer=session}else await session.detach()
    }
    assert.ok(observer);observer.on('Page.javascriptDialogOpening',event=>receipt.dialogs.push({event:'opening',type:event.type}));observer.on('Page.javascriptDialogClosed',event=>receipt.dialogs.push({event:'closed',accepted:event.result}));await observer.send('Page.enable')
    const fresh='private-current-prompt-value'
    const code=`try{await js(${JSON.stringify("window.taskPromptValue=window.prompt('Native protocol fixture')")})}catch{};const answer=await acceptDialog(${JSON.stringify(fresh)});return {type:answer.type,accepted:answer.accepted,matched:await js(${JSON.stringify('window.taskPromptValue==='+JSON.stringify(fresh))})}`
    const result=await cli(['browser','run','--browser',one.id],code)
    assert.equal(result.outcome.kind,'completed',result.outcome.message);assert.deepEqual(result.result,{type:'prompt',accepted:true,matched:true})
    assert.deepEqual(receipt.dialogs,[{event:'opening',type:'prompt'},{event:'closed',accepted:true}])
    assert.ok(result.runOperation.steps.some(step=>step.method==='acceptDialog'&&step.status==='completed'))
    assert.equal(JSON.stringify(result.runOperation).includes(fresh),false,'The native answer is not replayed or journaled')
    const target=(await client.call('browser.targets',{})).targets.find(target=>target.id===one.id);assert.ok(target.dialogTypes.includes('prompt'))
   }finally{await observer?.detach();await engine.disconnect()}
  })
  await observe('standalone-task-owner-remains-accurately-unsupported',async()=>{
   const endpoint=await client.call('system.endpoint',{});assert.equal(endpoint.methods.some(method=>method.startsWith('browser.task.')),false)
   await assert.rejects(client.call('browser.task.run',{browserId:one.id,assetId:'not-a-node-task-owner',version:1,parameters:{}}),error=>error.code==='HOST_CAPABILITY_UNAVAILABLE')
  })
 }})
 assert.equal(receipt.cases.length,3);assert.equal(receipt.hostProcess?.exitConfirmed,true)
 for(const[file,before]of Object.entries(receipt.inputs))assert.equal(hash(await readFile(join(repo,file))),before,'Protocol input drift: '+file)
 const end=Date.now()+3000
 do{receipt.remaining=await listProbeProcesses(receipt.hostPid,work);if(!receipt.remaining.length)break;await delay(50)}while(Date.now()<end)
 assert.deepEqual(receipt.remaining,[]);receipt.passed=true
}catch(error){
 receipt.passed=false
 throw error
}finally{
 if(!receipt.remaining)receipt.remaining=await listProbeProcesses(receipt.hostPid??-1,work)
 if(!receipt.remaining.length){await rm(work,{recursive:true,force:true});receipt.privateEngineProfileRemoved=true}
 await persist();console.log(JSON.stringify({passed:receipt.passed,receipt:join(out,'receipt.json')}))
}

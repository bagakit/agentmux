import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root=resolve(import.meta.dirname,'../../..')
const result=await new Promise((done,fail)=>{
  const child=spawn(process.execPath,[join(import.meta.dirname,'verify-browser-recovery-restart.mjs'),'--case-structured-output'],{cwd:root,stdio:'inherit'})
  child.once('error',fail);child.once('exit',(code,signal)=>done({code,signal}))
})
const receipt=JSON.parse(await readFile(join(root,'.tmp/browser-structured-output-last.json'),'utf8'))
const evidence=await mkdtemp(join(root,'.tmp/browser-structured-output-proof-'))
await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
for(const frame of receipt.visual?.frames??[]){
  await copyFile(frame.file,join(evidence,frame.label+'.png'))
  await copyFile(frame.nativePage.file,join(evidence,frame.label+'-native-page.png'))
}
for(const frame of receipt.visual?.osFrames??[]){
  await copyFile(frame.file,join(evidence,frame.label+'-os-compositor.png'))
  await copyFile(frame.stateFile,join(evidence,frame.label+'-os-state.json'))
}
console.log(JSON.stringify({receipt:join(evidence,'receipt.json')}))
assert.equal(result.code,0,JSON.stringify(receipt.failure));assert.equal(result.signal,null)
assert.equal(receipt.case,'structured-output');assert.equal(receipt.completeGate,true)
assert.equal(receipt.structured?.complete,true)
assert.equal(receipt.structured.navigationKeptArtifact,true);assert.equal(receipt.structured.sameArtifactAfterRestart,true)
assert.equal(receipt.structured.physicalDeviceTested,false)
assert.equal(receipt.structured.firstRaw.noReexecution,true);assert.equal(receipt.structured.rawAfterRestart.noReexecution,true)
assert.ok(receipt.structured.firstRaw.chunks.length>1)
assert.equal(receipt.visual.frames.filter(frame=>/^(normal|narrow|short)-structured-fields-top$/.test(frame.label)).length,3)
assert.equal(receipt.visual.frames.filter(frame=>/^(normal|narrow|short)-structured-bounded-recorded-json$/.test(frame.label)).length,3)
assert.equal(receipt.structured.fieldsTop.length,3);assert.equal(receipt.structured.rawSizeFacts.length,3)
assert.equal(receipt.structured.expandedPreview.visible,true)
assert.equal(receipt.structured.rawUiReads[0].keyboard.after.event.trusted,true)
assert.deepEqual(receipt.identityBefore,receipt.identityAfter)
assert.equal(receipt.cleanup.privateProcessesReaped,true)
if(process.env.AGENTMUX_VISUAL_ORCA_CLI)assert.ok(receipt.visual.osFrames?.length>0)
const index=process.argv.indexOf('--publish-evidence')
if(index>=0){assert.ok(process.argv[index+1]);const published=resolve(root,process.argv[index+1]);await mkdir(resolve(published,'..'),{recursive:true});await mkdir(published);await cp(evidence,published,{force:false,errorOnExist:true})}
console.log(JSON.stringify({passed:true,evidence,aestheticReview:'not-performed',physicalDeviceTested:false}))

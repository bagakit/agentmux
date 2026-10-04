#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
const args=process.argv.slice(2),provider=process.env.AGENTMUX_PROVIDER_ID ?? 'codex'
if(args.includes('--version')) { console.log('private native protocol 1');process.exit(0) }
if(args.includes('app-server')) {
  createInterface({input:process.stdin}).on('line',line=>{
    const r=JSON.parse(line); if(!r.id)return
    fs.appendFileSync(process.env.PRIVATE_NATIVE_REQUESTS,JSON.stringify(r)+'\n')
    const send=result=>process.stdout.write(JSON.stringify({id:r.id,result})+'\n')
    if(r.method==='initialize')send({userAgent:'private-read-only'})
    else if(r.method==='hooks/list')send({hooks:[],warnings:[]})
    else if(r.method==='thread/read')send({thread:{id:r.params.threadId,historyMode:'paginated'}})
    else if(r.method==='thread/items/list') {
      const id=r.params.threadId,older=!!r.params.cursor
      send({data:[{turnId:id+'-turn',item:{type:older?'agentMessage':'userMessage',id:id+(older?'-older':'-user'),...(older?{text:'Earlier history '+id,phase:'final_answer'}:{content:[{type:'text',text:'Original history '+id}]})}}],nextCursor:older?null:'private-cursor-'+id})
    } else process.stdout.write(JSON.stringify({id:r.id,error:{code:-32601,message:'Unexpected private readonly method'}})+'\n')
  });process.stdin.on('end',()=>process.exit(0))
} else {
  const sid=process.env.AGENTMUX_AGENT_SESSION_ID,root=process.env.PRIVATE_NATIVE_DIRECTORY
  if(!sid||!root)throw new Error('Missing private Core-issued native context')
  let handle='original-'+sid,fd,extraFd,currentCommand=''
  const transcript=id=>path.join(root,provider==='codex'?'rollout-'+id+'.jsonl':id+'.jsonl')
  const record=id=>provider==='codex'?{type:'session_meta',payload:{id,source:'cli'}}:{type:'user',sessionId:id,isSidechain:false,uuid:id+'-user',timestamp:new Date().toISOString(),message:{role:'user',content:'Original history '+id}}
  const open=id=>{const file=transcript(id);if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify(record(id))+'\n');return fs.openSync(file,provider==='codex'?'r':'a+')}
  fd=open(handle)
  const hook=async(eventName,id=handle)=>{
    const receiptId=randomUUID()
    const body=JSON.stringify({receiptId,eventName,payload:{hook_event_name:eventName,source:'clear',session_id:id,transcript_path:fs.realpathSync(transcript(id)),tool_name:'request_user_input',tool_use_id:'original-tool'}})
    let failure
    // The declared hook command retries delivery with the same receipt identity.
    for(let attempt=0;attempt<2;attempt++) {
      fs.appendFileSync(path.join(root,sid+'.hooks.jsonl'),JSON.stringify({eventName,id,receiptId,attempt,stage:'before'})+'\n')
      try {
        const response=await fetch(process.env.AGENTMUX_HOOK_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.AGENTMUX_HOOK_TOKEN,'content-type':'application/json'},body,signal:AbortSignal.timeout(2000)})
        const responseBody=await response.text()
        fs.appendFileSync(path.join(root,sid+'.hooks.jsonl'),JSON.stringify({eventName,id,receiptId,attempt,stage:'returned',status:response.status,responseBody})+'\n')
        if(response.ok)return
        failure=new Error('Private actual Hook ingress rejected '+eventName+': '+response.status)
      } catch(cause) { failure=cause }
    }
    // Hook delivery failure does not terminate a healthy private CLI.
    process.stderr.write('[private Hook] '+failure.message+'\n')
  }
  fs.writeFileSync(path.join(root,sid+'.launch.json'),JSON.stringify({pid:process.pid,sid,provider,nativeId:handle,file:transcript(handle),args}))
  process.stdin.setRawMode?.(true)
  process.stdout.write('\x1b[?u\x1b[?1;2c\x1b[?2004hPrivate native terminal · '+provider+'\r\n')
  let inputCount=0
  process.stdin.on('data',data=>{inputCount++;fs.appendFileSync(path.join(root,sid+'.inputs.jsonl'),JSON.stringify({inputCount,bytes:[...data]})+'\n');process.stdout.write('private raw input '+inputCount+'\r\n')})
  while(!fs.existsSync(path.join(root,sid+'.core-ready')))await new Promise(resolve=>setTimeout(resolve,25))
  await hook('SessionStart');await hook('PermissionRequest')
  setInterval(async()=>{
    let command;try { command=fs.readFileSync(path.join(root,sid+'.control.json'),'utf8') } catch{return}
    if(command===currentCommand)return;currentCommand=command
    const next=JSON.parse(command)
    if(fd!==undefined){fs.closeSync(fd);fd=undefined}if(extraFd!==undefined){fs.closeSync(extraFd);extraFd=undefined}
    if(next.mode!=='unknown'){handle=next.id;fd=open(handle);if(next.mode==='ambiguous')extraFd=open('other-'+handle)}
    if(next.mode==='unknown'||provider==='claude'&&next.mode==='changed')await hook('SessionStart')
    fs.writeFileSync(path.join(root,sid+'.controlled.json'),JSON.stringify({command:next,pid:process.pid,handle}))
  },25)
}

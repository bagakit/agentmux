import {AgentMuxFileAgentSessionStore}from'../../../src/agent-session-store.js'
import{DatabaseSync}from'node:sqlite'
const [path,raw]=process.argv.slice(2),item=JSON.parse(raw),store=new AgentMuxFileAgentSessionStore(path)
const before=await store.readMetadata(item.agentSessionId)
const result=await store.applyTimelineMutation({type:'upsert',agentSessionId:item.agentSessionId,item})
const records=await store.readCapturedHistory(item.agentSessionId,{afterSequence:0})
const db=new DatabaseSync(path,{readOnly:true});let cut
try{cut=db.prepare('SELECT * FROM captured_retirement_cuts WHERE session_id=? AND epoch=?').get(item.agentSessionId,records.stream.epoch)}finally{db.close()}
process.stdout.write(JSON.stringify({result,records,cut,process:{pid:process.pid,ppid:process.ppid,node:process.execPath,nodeVersion:process.version,entry:import.meta.url},identity:{hostId:before.hostId,agentSessionId:before.agentSessionId,runId:before.run.runId,providerId:before.providerId},sameOriginalMetadata:JSON.stringify(before)===JSON.stringify(await store.readMetadata(item.agentSessionId))})+'\n')

#!/usr/bin/env node
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
if (process.argv.includes('--version')) { process.stdout.write('origin-fixture 1\n'); process.exit(0) }
const root=process.env.ORIGIN_PROFILE_ROOT,secret=process.env.ORIGIN_PRIVATE_SENTINEL
if(!root||!secret)throw Error('Original private invocation unavailable')
const args=process.argv.slice(2),at=args.indexOf('resume'),sid=at<0?'native-'+process.env.AGENTMUX_AGENT_SESSION_ID:args[at+1]
mkdirSync(root,{recursive:true});mkdirSync('.origin-protocol',{recursive:true})
const history=join(root,sid+'.json'),records=existsSync(history)?JSON.parse(readFileSync(history,'utf8')).records:[]
if(at>=0&&!existsSync(history))throw Error('Original native identity absent')
const persist=()=>writeFileSync(history,JSON.stringify({sid,secret,records}))
const prompt=at<0?args.at(-1):args[at+2]
if(prompt&&prompt!=='original-argument')records.push({id:'launch-'+records.length,kind:'user-message',contentParts:[{kind:'text',text:prompt}]})
persist()
writeFileSync(join('.origin-protocol',process.pid+'.json'),JSON.stringify({pid:process.pid,sid,root:resolve(root),command:resolve(process.argv[1]),sessionId:process.env.AGENTMUX_AGENT_SESSION_ID}))
process.stdout.write('origin-private-process-ready\n')
process.stdin.setRawMode(true)
process.stdin.on('data',data=>{records.push({id:'input-'+records.length,kind:'user-message',contentParts:[{kind:'text',text:String(data)}]});persist();process.stdout.write('origin-private-input-recorded\n')})
setInterval(()=>{},1000)

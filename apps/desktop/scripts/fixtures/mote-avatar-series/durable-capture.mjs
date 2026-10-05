import { fixturePath as _reshape_fixturePath } from "../../lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createRequire} from 'node:module'
import {createHash,randomUUID} from 'node:crypto'
import {spawn} from 'node:child_process'
const fixture=import.meta.dirname,root=path.resolve(fixture,'../../../../..')
const require=createRequire(path.join(root,'apps/desktop/package.json')),{build}=createRequire(require.resolve('vite'))('esbuild')
const directory=path.join(root,'.local/state/mote-avatar-durable',randomUUID()),compiled=path.join(directory,'compiled'),runtimeRoot=_reshape_fixturePath("private/tmp/amx-avwrite-")+randomUUID().slice(0,8)
await fs.mkdir(compiled,{recursive:true});await fs.mkdir(path.join(directory,'home'));await fs.mkdir(runtimeRoot)
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const receipt={passed:false,source:{},calls:[],processes:[],boundary:'Actual original ScratchTopics/ConfigStore/ConfigOwner/PNG and native business factory, isolated Electron nativeImage -> production default Node Host -> actual amux CLI, real process restart. No installed App, user work surface or Provider Session claim.'}
const mutation=process.argv[2]??null
assert.ok(mutation===null||['writer-disconnected','source-version-ignored','baseline-ignored','request-replaced'].includes(mutation))
let stage='setup'
const productionMutation={name:'bounded-native-write-mutation',setup(plugin){plugin.onLoad({filter:/\.ts$/},async args=>{
  const file=path.relative(root,args.path),original=await fs.readFile(args.path,'utf8')
  let changed=original
  if(mutation==='writer-disconnected'&&file==='apps/desktop/src/main/mote-avatar-control.ts')changed=original.replace('private readonly writer?: MoteAvatarWriter','_writer?: MoteAvatarWriter')
  if(mutation==='source-version-ignored'&&file==='apps/desktop/src/main/mote-avatar-writer.ts')changed=original.replaceAll('expectedRevision:revision','expectedRevision:undefined')
  if(mutation==='baseline-ignored'&&file==='apps/desktop/src/main/mote-avatar-writer.ts')changed=original.replaceAll('if (moteAvatarRevision(config,target)!==input.beforeRevision)','if (false)').replaceAll('if (moteAvatarRevision(current,target)!==input.beforeRevision)','if (false)')
  if(mutation==='request-replaced'&&file==='apps/desktop/src/main/mote-avatar-writer.ts')changed=original.replace('if (operation && operation.requestHash!==requestHash)','if (false)')
  if(changed!==original){receipt.mutation={name:mutation,file,originalSha:sha(original),effectiveSha:sha(changed)};return{contents:changed,loader:'ts'}}
})}}
const env={...process.env,AGENTMUX_RUNTIME_DIRECTORY:runtimeRoot,AGENTMUX_STATE_DIRECTORY:path.join(directory,'state'),AGENTMUX_SPATIAL_STATE_STORE:path.join(directory,'spatial.json'),AGENTMUX_AGENT_SESSION_STORE:path.join(directory,'sessions.json'),AGENTMUX_MESSAGE_QUEUE_PATH:path.join(directory,'messages.ndjson')}
for(const name of ['ELECTRON_RUN_AS_NODE','AGENTMUX_RPC_ENDPOINT','AGENTMUX_AGENT_SESSION_ID','AGENTMUX_AGENT_CAPABILITY'])delete env[name]
const children=[],logs=[]
function run(file,args){const child=spawn(file,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.push(child);const log={file,args,pid:child.pid,stdout:'',stderr:'',exitCode:null};logs.push(log);child.stdout.on('data',bytes=>{log.stdout+=bytes});child.stderr.on('data',bytes=>{log.stderr+=bytes});const ended=new Promise(resolve=>child.on('exit',(code,signal)=>{log.exitCode=code;log.signal=signal;resolve(log)}));child.on('error',error=>{log.error=String(error)});return{child,ended,log}}
async function ready(file,process){for(let i=0;i<400;i++){try{return JSON.parse(await fs.readFile(file,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}if(process.child.exitCode!==null)throw Error('Original process exited before ready: '+process.log.stderr);await new Promise(resolve=>setTimeout(resolve,50))}throw Error('Original process readiness was not confirmed')}
async function stop(process){if(process.child.exitCode===null)process.child.kill('SIGTERM');await process.ended}
async function cli(args,error=false){const result=await run(process.execPath,[path.join(root,'packages/core/bin/amux'),...args]).ended;receipt.calls.push({args,exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr});if(error){assert.notEqual(result.exitCode,0);return result}assert.equal(result.exitCode,0,result.stderr);const wire=JSON.parse(result.stdout);assert.equal(wire.ok,true);return wire.result}
async function input(method,data,error=false){const file=path.join(directory,'request-'+randomUUID()+'.json');await fs.writeFile(file,JSON.stringify(data));return cli(['space','mote','avatar',method,'--input',file],error)}
const workspaceModules={name:'original-exports',setup(plugin){plugin.onResolve({filter:/^@agentmux\//},args=>{const parts=args.path.split('/'),folder=path.join(root,'packages',parts[1]),manifest=require(path.join(folder,'package.json')),key=parts.length>2?'./'+parts.slice(2).join('/'):'.';let target=manifest.exports[key],capture='';if(!target)for(const [pattern,value]of Object.entries(manifest.exports)){const [prefix,suffix]=pattern.split('*');if(suffix!==undefined&&key.startsWith(prefix)&&key.endsWith(suffix)){target=value;capture=key.slice(prefix.length,key.length-suffix.length);break}}const source=typeof target==='string'?target:target?.import??target?.browser;assert.ok(source);return{path:path.join(folder,source.replace('*',capture)),external:parts[1]!=='client-ui'}});plugin.onResolve({filter:/\.mjs$/},args=>args.path.startsWith('.')?{path:path.resolve(args.resolveDir,args.path),external:true}:undefined)}}
try{
  const personal=path.join(directory,'avatars','personal');await fs.mkdir(personal,{recursive:true});await fs.copyFile(path.join(root,'apps/desktop/resources/avatar-series/lowpoly/lowpoly-owl.png'),path.join(personal,'owl.png'))
  for(const [entry,format]of[['writer-entry.ts','cjs'],['host-entry.ts','esm']]){const result=await build({absWorkingDir:root,entryPoints:[path.join(fixture,entry)],outfile:path.join(compiled,entry.replace('.ts',format==='cjs'?'.cjs':'.mjs')),platform:'node',format,bundle:true,target:'node24',external:['electron'],plugins:[productionMutation,workspaceModules],metafile:true,logLevel:'error'});for(const file of Object.keys(result.metafile.inputs))receipt.source[file]=sha(await fs.readFile(path.resolve(root,file)))}
  const host=run(process.execPath,[path.join(compiled,'host-entry.mjs'),directory]);receipt.processes.push(await ready(path.join(directory,'host-ready.json'),host))
  let main=run(require('electron'),[path.join(fixture,'durable-main.cjs'),compiled,directory,path.join(root,'apps/desktop/resources/avatar-series'),runtimeRoot]);receipt.processes.push(await ready(path.join(directory,'durable-ready.json'),main))
  stage='consumer'
  const snapshot=await cli(['app','snapshot','--include','motes']);assert.ok(snapshot.motes.length>=4);assert.deepEqual(snapshot.unavailable,[])
  const targets=snapshot.motes.map(mote=>({workspaceId:mote.workspaceId,topicId:mote.topicId,objectKey:mote.spaceId}));assert.ok(targets.every(target=>typeof target.objectKey==='string'))
  const target=targets.find(target=>target.topicId==='launcher:leader');assert.ok(target)
  const legacy={};for(const original of targets.filter(target=>target.topicId.startsWith('launcher:legacy-')))legacy[original.topicId]=await input('read',{target:original})
  assert.equal(legacy['launcher:legacy-glyph'].choice,'rocket');assert.equal(legacy['launcher:legacy-face'].choice.kind,'face');assert.equal(legacy['launcher:legacy-image'].image.width,256)
  const before=await input('read',{target}),prepared=await input('preview',{source:{origin:'user',seriesId:'personal',entryId:'owl.png'}})
  const frozen={target,operationId:randomUUID(),beforeRevision:before.revision,source:prepared.source,definition:prepared.definition,parameters:{kind:'image',zoom:1,offsetX:0,offsetY:0},pngDataUrl:'data:image/png;base64,'+(await fs.readFile(path.join(directory,'caller-frame.png'))).toString('base64')}
  const invalidVersion=await input('save',{...frozen,operationId:randomUUID(),source:{...frozen.source,revision:'sha256:'+'0'.repeat(64)}});assert.equal(invalidVersion.state,'refused','A different source version cannot publish the selected frame')
  const invalidBaseline=await input('save',{...frozen,operationId:randomUUID(),beforeRevision:'sha256:'+'0'.repeat(64)});assert.equal(invalidBaseline.state,'refused','The exact original appearance baseline must be checked')
  const wrong=targets.find(item=>item.topicId==='launcher:legacy-face');assert.ok(wrong)
  await input('read',{target:{...target,objectKey:wrong.objectKey}},true)
  const saved=await input('save',frozen);assert.equal(saved.state,'saved');assert.equal(saved.current.choice.kind,'series');assert.equal(saved.current.source.state,'available');assert.deepEqual(saved.operation.choice,saved.current.choice)
  const savedChoice=saved.current.choice,savedPng=saved.current.image.dataUrl,configSha=sha(await fs.readFile(path.join(directory,'config.json')))
  const retry=await input('save',frozen);assert.equal(retry.state,'saved');assert.equal(sha(await fs.readFile(path.join(directory,'config.json'))),configSha)
  const refused=await input('save',{...frozen,parameters:{...frozen.parameters,zoom:2}});assert.equal(refused.state,'refused');assert.equal(sha(await fs.readFile(path.join(directory,'config.json'))),configSha)
  await stop(main);await fs.unlink(path.join(directory,'durable-ready.json'))
  main=run(require('electron'),[path.join(fixture,'durable-main.cjs'),compiled,directory,path.join(root,'apps/desktop/resources/avatar-series'),runtimeRoot]);receipt.processes.push(await ready(path.join(directory,'durable-ready.json'),main))
  const restarted=await input('read',{target,operationId:frozen.operationId});assert.deepEqual(restarted.choice,savedChoice);assert.equal(restarted.image.dataUrl,savedPng);assert.equal(restarted.operation.durability,'confirmed')
  for(const original of targets.filter(target=>target.topicId.startsWith('launcher:legacy-'))){const current=await input('read',{target:original});assert.deepEqual(current.choice,legacy[original.topicId].choice);assert.equal(current.image?.dataUrl,legacy[original.topicId].image?.dataUrl)}
  await fs.rename(personal,path.join(directory,'retained-personal-source'))
  const absent=await input('read',{target,operationId:frozen.operationId});assert.equal(absent.source.state,'unavailable');assert.deepEqual(absent.choice,savedChoice);assert.equal(absent.image.dataUrl,savedPng)
  await fs.rename(path.join(directory,'retained-personal-source'),personal)
  const restored=await input('read',{target});assert.equal(restored.source.state,'available');assert.deepEqual(restored.choice,savedChoice)
  const sessions=await cli(['agent','ls']);assert.ok(Array.isArray(sessions.sessions));assert.equal(sessions.sessions.length,0)
  receipt.saved={target,choice:savedChoice,operationId:frozen.operationId,imageSha:sha(savedPng),realNativeRestartPids:receipt.processes.filter(process=>process.actualNativeImage).map(process=>process.pid),legacyChoicesRetained:3,modLossRetainsChoiceAndImage:true}
  assert.equal(new Set(receipt.saved.realNativeRestartPids).size,2);receipt.passed=!mutation
  if(mutation)throw Object.assign(Error('Native write mutation escaped its real consumer'),{code:'MUTATION_ESCAPED'})
}catch(error){receipt.error={code:error.code,message:error.message,stack:error.stack};if(mutation&&stage==='consumer'&&receipt.mutation&&receipt.processes.length>=2&&error.code==='ERR_ASSERTION'){receipt.passed=true;receipt.mutationDetected=true}}
finally{for(const child of children)if(child.exitCode===null)child.kill('SIGTERM');await Promise.all(children.filter(child=>child.exitCode===null).map(child=>new Promise(resolve=>child.on('exit',resolve))));await fs.rm(runtimeRoot,{recursive:true,force:true})}
receipt.logs=logs;await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(path.join(directory,'receipt.json'));if(!receipt.passed){console.error(receipt.error);process.exitCode=1}

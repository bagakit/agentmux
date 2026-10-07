import { appendFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { AgentMuxControlServer } from '@agentmux/core'
import { ConnectionHost } from '@agentmux/connectors'
import { DesktopConnectorSecrets } from '../../../../apps/desktop/src/main/connector-secrets.ts'
import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto'

const root=process.argv[2],mode=process.argv[3],key=Buffer.alloc(32,7),database=new DatabaseSync(join(root,'connections.sqlite'))
const secrets=new DesktopConnectorSecrets(database,{isEncryptionAvailable:()=>true,encryptString:v=>{const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv),body=Buffer.concat([c.update(v,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body])},decryptString:v=>{const c=createDecipheriv('aes-256-gcm',key,v.subarray(0,12));c.setAuthTag(v.subarray(12,28));return Buffer.concat([c.update(v.subarray(28)),c.final()]).toString()}})
const effect=async(kind,config,request)=>{
  await appendFile(join(root,'effects'),kind+':'+config.connectionId+'\n');process.send({kind:'effect-applied'})
  if(mode===kind)return await new Promise(()=>{})
  throw new Error('A recovered effect must not be replayed')
}
const owner=new ConnectionHost({database,secrets,adapters:[{adapterId:'signed-profile',test:async()=>{throw new Error('No runtime test')},profile:{
  prepareUpload:(config,pngDataUrl)=>({format:'child-image-v1',body:JSON.stringify({app:config.application,pngDataUrl})}),
  upload:(...args)=>effect('upload',...args),preparePatch:(config,desired)=>({format:'child-profile-v1',body:JSON.stringify({app:config.application,desired})}),patch:(...args)=>effect('patch',...args),
  get:async(config,revision)=>({connectionId:config.connectionId,connectionRevision:revision,application:config.application,language:null,state:'unknown',profile:null,metadata:null,botId:null,onlineVersionId:null,reviewingVersionId:null,version:null,reason:'online-unconfirmed'})
}}]})
if(!(await owner.inspect({connectionId:'child-connection'})).connection){const stored=await secrets.store({operationId:'child-secret',secret:'private-child-credential'});await owner.configure({operationId:'child-configure',expectedRevision:null,connection:{connectionId:'child-connection',adapterId:'signed-profile',application:{domain:'signed.example',appId:'child-app'},label:'Child profile',enabled:true,credentialRef:stored.credentialRef}})}
const server=new AgentMuxControlServer({socketPath:join(root,'owner.sock'),connections:owner,coreClients:()=>[]})
await server.start();process.send({kind:'ready'})
